/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD  (remote.js)
   MQTT over WebSocket using Paho 1.1.0
═══════════════════════════════════════════════════ */

/* ── STORAGE ── */
const SK = 'relayctrl_v1';
function load() { try { return JSON.parse(localStorage.getItem(SK) || '{}'); } catch { return {}; } }
function save(d) { localStorage.setItem(SK, JSON.stringify(d)); }

/* ── STATE ── */
let client     = null;
let connected  = false;
let pingTimers = {};
let devices    = [];
let activeId   = null;

const stored   = load();
const broker   = stored.broker   || { host:'', port:9001, user:'', pass:'', ssl:false };
devices        = (stored.devices || []).map(d => ({ ...d, status:'offline', relays:[] }));

/* ── CLOCK ── */
setInterval(() => { document.getElementById('clock').textContent = new Date().toTimeString().slice(0,8); }, 1000);

/* ── TOAST ── */
let toastT;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' '+type : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.className = '', 2800);
}

/* ══════════════════════════════════════════
   MQTT
══════════════════════════════════════════ */
function mqttConnect() {
  // Guard: Paho must be loaded
  if (typeof Paho === 'undefined') {
    showError('Paho MQTT library not loaded. Check your internet connection and reload the page.');
    return;
  }

  const host = document.getElementById('b-host').value.trim();
  const port = parseInt(document.getElementById('b-port').value) || 9001;
  const user = document.getElementById('b-user').value.trim();
  const pass = document.getElementById('b-pass').value;
  const ssl  = location.protocol === 'https:' ? true : document.getElementById('b-ssl').checked;

  if (!host) { toast('Enter broker host', 'r'); return; }
  clearError();

  // Save broker config
  broker.host = host; broker.port = port;
  broker.user = user; broker.pass = pass; broker.ssl = ssl;
  persist();

  // Disconnect any existing client cleanly
  if (client) {
    try { client.disconnect(); } catch {}
    client = null;
  }
  connected = false;

  const clientId = 'relayctrl-' + Math.random().toString(36).slice(2, 9);

  // Paho namespace differs by CDN build: try Paho.MQTT.Client, fall back to Paho.Client
  const PahoClient = (Paho.MQTT && Paho.MQTT.Client) ? Paho.MQTT.Client : Paho.Client;
  client = new PahoClient(host, port, clientId);

  client.onConnectionLost = function(resp) {
    connected = false;
    setConnUI(false);
    devices.filter(d => (d.type||'mqtt')==='mqtt').forEach(d => d.status = 'offline');
    renderSidebar();
    if (activeId) renderDevice(activeId);
    Object.values(pingTimers).forEach(clearInterval);
    pingTimers = {};
    if (resp.errorCode !== 0) {
      toast('Disconnected: ' + resp.errorMessage, 'r');
      showError('Lost connection: ' + resp.errorMessage);
    }
  };

  client.onMessageArrived = onMessage;

  const opts = {
    useSSL: ssl,
    keepAliveInterval: 30,
    // *** FIX: no 'reconnect' key — not supported in Paho 1.1.0 ***
    onSuccess: function() {
      connected = true;
      clearError();
      setConnUI(true);
      toast('Connected to ' + host, 'g');
      devices.forEach(d => { if ((d.type||'mqtt') === 'mqtt') { subscribeDevice(d); publishPresence(d, true); startPing(d); } });
      // Request state from any online WLED devices too
      devices.forEach(d => { if (d.type === 'wled') pingDevice(d.id); });
    },
    onFailure: function(err) {
      connected = false;
      setConnUI(false);
      const msg = err.errorMessage || ('Error code ' + err.errorCode);
      toast('Connect failed: ' + msg, 'r');
      showError('Failed to connect: ' + msg + '\nCheck host, port, credentials, and that the broker has WebSocket enabled.');
    }
  };

  if (user) { opts.userName = user; opts.password = pass; }

  try {
    client.connect(opts);
  } catch(e) {
    toast('Connect error: ' + e.message, 'r');
    showError(e.message);
  }
}

function mqttDisconnect() {
  Object.values(pingTimers).forEach(clearInterval);
  pingTimers = {};
  devices.filter(d => (d.type||'mqtt')==='mqtt').forEach(d => publishPresence(d, false));
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false;
  setConnUI(false);
  devices.filter(d => (d.type||'mqtt')==='mqtt').forEach(d => d.status = 'offline');
  renderSidebar();
  if (activeId) renderDevice(activeId);
}

function publish(topic, payload, retained=false) {
  if (!connected || !client) { toast('Not connected', 'r'); return false; }
  try {
    const PahoMessage = (Paho.MQTT && Paho.MQTT.Message) ? Paho.MQTT.Message : Paho.Message;
    const msg = new PahoMessage(String(payload));
    msg.destinationName = topic;
    msg.retained = retained;
    msg.qos = 1;
    client.send(msg);
    return true;
  } catch(e) { toast('Publish error: ' + e.message, 'r'); return false; }
}

function publishJSON(topic, obj, retained=false) {
  return publish(topic, JSON.stringify(obj), retained);
}

function subscribeDevice(dev) {
  if (!connected) return;
  try {
    client.subscribe(dev.prefix + '/v');           // full JSON state
    client.subscribe(dev.prefix + '/relay/+/v');   // per-relay state
    client.subscribe(dev.prefix + '/status');      // LWT
  } catch(e) { console.warn('Subscribe error', e); }
}

function unsubscribeDevice(dev) {
  if (!connected) return;
  try { client.unsubscribe(dev.prefix + '/v'); } catch {}
  try { client.unsubscribe(dev.prefix + '/relay/+/v'); } catch {}
  try { client.unsubscribe(dev.prefix + '/status'); } catch {}
}

function publishPresence(dev, online) {
  publish(dev.prefix + '/presence', online ? 'online' : 'offline', false);
}

function startPing(dev) {
  if (pingTimers[dev.id]) clearInterval(pingTimers[dev.id]);
  const iv = (dev.pingInterval || 10) * 1000;
  pingTimers[dev.id] = setInterval(() => {
    if (connected) publish(dev.prefix + '/ping', '1', false);
  }, iv);
}

/* ── INCOMING MESSAGES ── */
function onMessage(msg) {
  const topic   = msg.destinationName;
  const payload = msg.payloadString;
  const dev     = devices.find(d => topic.startsWith(d.prefix + '/') || topic === d.prefix);
  if (!dev) return;

  const suffix = topic.slice(dev.prefix.length + 1);   // strip "prefix/"

  // ── {prefix}/v  →  full JSON state ─────────────────────
  if (suffix === 'v') {
    try {
      const data = JSON.parse(payload);
      if (Array.isArray(data.relays)) {
        // map {on:true} → {state:true} for UI consistency
        dev.relays   = data.relays.map(r => ({ ...r, state: r.on }));
        dev.status   = 'online';
        dev.lastSeen = Date.now();
        renderSidebar();
        if (activeId === dev.id) renderDevice(dev.id);
      }
    } catch(e) { console.warn('Parse /v error', e, payload); }
    return;
  }

  // ── {prefix}/status  →  LWT ─────────────────────────────
  if (suffix === 'status') {
    const wasOnline = dev.status === 'online';
    dev.status   = payload.trim().toLowerCase() === 'online' ? 'online' : 'offline';
    dev.lastSeen = Date.now();
    if (dev.status === 'online' && !wasOnline)
      setTimeout(() => publish(dev.prefix + '/ping', '1', false), 400);
    renderSidebar();
    if (activeId === dev.id) renderDevice(dev.id);
    return;
  }

  // ── {prefix}/relay/N/v  →  per-relay state ──────────────
  const m = suffix.match(/^relay\/(\d+)\/v$/);
  if (m) {
    const id = parseInt(m[1]);
    if (!dev.relays) dev.relays = [];
    let r = dev.relays.find(r => r.id === id);
    if (!r) { r = { id, name:'Relay '+(id+1), on:false, state:false }; dev.relays.push(r); dev.relays.sort((a,b)=>a.id-b.id); }
    r.on     = payload.trim().toLowerCase() === 'on';
    r.state  = r.on;
    dev.status   = 'online';
    dev.lastSeen = Date.now();
    if (activeId === dev.id) updateCard(dev, r);
    renderSidebar();
    return;
  }
}

/* ── RELAY CONTROL (routes to MQTT or WLED) ── */
function isWled(dev) { return (dev?.type || 'mqtt') === 'wled'; }

function toggleRelay(devId, relayId, on) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { toggleRelayWled(devId, relayId, on); return; }
  publishJSON(dev.prefix + '/relay/' + relayId + '/api', { on });
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.on = on; r.state = on; updateCard(dev, r); updateMeta(dev); }
}

function pulseRelay(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { pulseRelayWled(devId, relayId); return; }
  const ms = parseInt(document.getElementById('pm-'+devId+'-'+relayId).value) || 500;
  publishJSON(dev.prefix + '/relay/' + relayId + '/api', { pulse: ms });
  toast('Pulse '+ms+'ms → '+dev.name+' R'+(relayId+1));
}

function timerRelay(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { timerRelayWled(devId, relayId); return; }
  const s = parseInt(document.getElementById('ts-'+devId+'-'+relayId).value) || 30;
  publishJSON(dev.prefix + '/relay/' + relayId + '/api', { timer: s });
  toast('Timer '+s+'s → '+dev.name+' R'+(relayId+1));
}

function allOff(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { allOffWled(devId); return; }
  publishJSON(dev.prefix + '/api', { on: false });
  dev.relays?.forEach(r => { r.on = false; r.state = false; updateCard(dev, r); });
  updateMeta(dev);
  toast('All OFF — '+dev.name, 'r');
}

function allOn(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { allOnWled(devId); return; }
  publishJSON(dev.prefix + '/api', { on: true });
  dev.relays?.forEach(r => { r.on = true; r.state = true; updateCard(dev, r); });
  updateMeta(dev);
  toast('All ON — '+dev.name);
}

function sendCmd(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { sendCmdWled(devId); return; }
  const raw = document.getElementById('cmd-'+devId).value.trim();
  if (!raw) return;
  try { JSON.parse(raw); } catch(e) { toast('Invalid JSON: '+e.message, 'r'); return; }
  publish(dev.prefix + '/api', raw);
  toast('Sent', 'g');
}

function pingDevice(id) {
  const dev = getDevice(id); if (!dev) return;
  if (isWled(dev)) {
    const ws = wledSockets[dev.id];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({v:true}));
    return;
  }
  publish(dev.prefix + '/ping', '1', false);
}

/* ══════════════════════════════════════════
   UI
══════════════════════════════════════════ */
function setConnUI(on) {
  document.getElementById('conn-dot').className   = 'cdot' + (on?' on':'');
  document.getElementById('conn-label').textContent = on ? 'online' : 'offline';
  const ts = document.getElementById('tb-status');
  ts.textContent = on ? 'CONNECTED' : 'DISCONNECTED';
  ts.className   = 'tb-val ' + (on ? 'g' : 'r');
  document.getElementById('btn-connect').style.display    = on ? 'none' : '';
  document.getElementById('btn-disconnect').style.display = on ? '' : 'none';
}

function showError(msg) {
  const el = document.getElementById('conn-error');
  el.textContent = msg; el.style.display = 'block';
}
function clearError() {
  const el = document.getElementById('conn-error');
  el.textContent = ''; el.style.display = 'none';
}

function renderSidebar() {
  const list = document.getElementById('device-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div style="padding:12px 14px;font-size:10px;color:var(--dim)">No devices yet.</div>';
  }
  devices.forEach(dev => {
    const el = document.createElement('div');
    el.className = 'device-item' + (dev.id === activeId ? ' active' : '');
    const badge = (dev.type||'mqtt') === 'wled' ? '<span class="dev-badge wled">WLED</span>' : '';
    el.innerHTML = `
      <div class="dev-left">
        <span class="dev-dot ${dev.status||'offline'}"></span>
        <span class="dev-name">${esc(dev.name)}</span>
        ${badge}
      </div>
      <button class="dev-remove" onclick="removeDevice('${dev.id}',event)">✕</button>`;
    el.onclick = e => { if (e.target.closest('.dev-remove')) return; selectDevice(dev.id); };
    list.appendChild(el);
  });
  const el = document.getElementById('tb-devices');
  if (el) el.textContent = devices.length;
}

function selectDevice(id) {
  activeId = id;
  renderSidebar();
  renderDevice(id);
}

function renderDevice(id) {
  const main = document.getElementById('main');
  const dev  = getDevice(id);
  if (!dev) { main.innerHTML = emptyHTML('📡','No Device Selected','Add a device in the sidebar and connect to your broker.'); return; }

  const relays  = dev.relays || [];
  const online  = dev.status === 'online';
  const active  = relays.filter(r => r.state).length;

  main.innerHTML = `
    <div class="dev-header">
      <div>
        <div class="dev-title">${esc(dev.name)}<span class="sub">${isWled(dev) ? esc(dev.host||'') : esc(dev.prefix)}</span></div>
        <div class="dev-meta">
          <span class="pill ${online?'pill-g':'pill-r'}" id="pill-status-${dev.id}">${online?'ONLINE':'OFFLINE'}</span>
          ${isWled(dev) ? '<span class="pill" style="background:var(--teal);color:#000">WLED WS</span>' : '<span class="pill pill-d">MQTT</span>'}
          ${isWled(dev) && dev.wledInfo ? `<span class="pill pill-d">v${esc(dev.wledInfo.ver||'')}</span>` : ''}
          <span class="pill pill-a" id="pill-count-${dev.id}">${relays.length} ${isWled(dev)?'segs':'relays'}</span>
          <span class="pill ${active>0?'pill-a':'pill-d'}" id="pill-active-${dev.id}">${active} active</span>
          <span class="last-seen" id="last-seen-${dev.id}">${dev.lastSeen?'seen '+ago(dev.lastSeen):''}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-ghost btn-sm" onclick="pingDevice('${dev.id}')">↻ Ping</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditDevice('${dev.id}')">✎ Edit</button>
        <button class="btn btn-red btn-sm" onclick="allOff('${dev.id}')">⬛ All Off</button>
        <button class="btn btn-amber btn-sm" onclick="allOn('${dev.id}')">■ All On</button>
      </div>
    </div>

    ${isWled(dev) ? `
    <div class="wled-global">
      <div class="wg-row">
        <span class="wg-lbl">MASTER</span>
        <label class="itoggle" style="margin-right:4px">
          <input type="checkbox" ${dev.wledState?.on ? 'checked' : ''} onchange="wledMasterToggle('${dev.id}',this.checked)">
          <div class="itrack"><div class="ithumb"></div></div>
        </label>
        <span class="wg-lbl">BRI</span>
        <input type="range" min="0" max="255" value="${dev.wledState?.bri ?? 128}"
          class="bri-slider" id="bri-master-${dev.id}"
          oninput="document.getElementById('bri-val-${dev.id}').textContent=this.value"
          onchange="wledBriCommit('${dev.id}',this.value)">
        <span class="bri-val" id="bri-val-${dev.id}">${dev.wledState?.bri ?? 128}</span>
        ${!dev.isRelayCtrl && dev.wledEffects ? `
        <span class="wg-lbl" style="margin-left:8px">FX</span>
        <select class="fx-select" onchange="wledFxChange('${dev.id}',this.value)">
          ${dev.wledEffects.filter(n=>n!=='RSVD'&&n!=='-').map((n,i)=>`<option value="${i}" ${(dev.relays?.[0]?.fx??0)===i?'selected':''}>${esc(n)}</option>`).join('')}
        </select>
        <span class="wg-lbl" style="margin-left:4px">SPD</span>
        <input type="range" min="0" max="255" value="${dev.relays?.[0]?.sx ?? 128}"
          class="bri-slider" style="width:70px"
          onchange="wledSpeedChange('${dev.id}',this.value)">` : ''}
      </div>
    </div>` : ''}

    <div class="cmd-bar">
      <div class="cmd-row">
        <span class="cmd-lbl">JSON CMD</span>
        <input class="cmd-input" id="cmd-${dev.id}" placeholder='${isWled(dev) ? '{"on":true}  ·  {"bri":128}  ·  {"seg":[{"id":0,"fx":73}]}' : '{"on":true}  ·  {"relay":0,"on":true}'}'
          onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
        <button class="btn btn-teal btn-sm" onclick="sendCmd('${dev.id}')">Send</button>
      </div>
      <div class="cmd-hints" id="cmdhint-${dev.id}">
        ${isWled(dev) ?
          `WLED JSON state: <code>{"on":true}</code> · <code>{"on":false}</code> · <code>{"on":"t"}</code><br>
          Segment: <code>{"seg":[{"id":0,"on":true}]}</code> · Effect: <code>{"seg":[{"id":0,"fx":73,"sx":128}]}</code><br>
          Brightness: <code>{"seg":[{"id":0,"bri":128}]}</code> · Preset: <code>{"ps":1}</code>` :
          `All on/off: <code>{"on":true}</code> · <code>{"on":false}</code> · Toggle: <code>{"on":"t"}</code><br>
          Single relay: <code>{"relay":0,"on":true}</code> · Pulse: <code>{"relay":1,"pulse":500}</code> · Timer: <code>{"relay":2,"timer":30}</code><br>
          Multi: <code>{"relays":[{"id":0,"on":true},{"id":1,"pulse":500}]}</code> ·
          Pattern: <code>{"pattern":{"steps":[{"mask":3,"duration_ms":500}],"repeat":-1}}</code>`
        }
      </div>
    </div>

    <div class="relay-grid" id="grid-${dev.id}">
      ${relays.length ? relays.map(r => cardHTML(dev, r)).join('') : emptyHTML('🔌','No data yet', online ? 'Click ↻ Ping to request state.' : 'Device is offline.')}
    </div>`;
}

function cardHTML(dev, r) {
  const did = dev.id, rid = r.id;
  const isOn = !!(r.on || r.state);
  const showBri   = isWled(dev) && !dev.isRelayCtrl;
  const showPulse = !isWled(dev) || dev.isRelayCtrl;
  const fxName    = showBri && dev.wledEffects ? (dev.wledEffects[r.fx ?? 0] || null) : null;
  const colArr    = Array.isArray(r.col) && Array.isArray(r.col[0]) ? r.col[0] : null;
  const colHex    = colArr ? '#' + colArr.slice(0,3).map(v => (v||0).toString(16).padStart(2,'0')).join('') : null;
  const label     = r.name || (isWled(dev) ? 'Seg '+rid : 'Relay '+(rid+1));

  return `
    <div class="rcard ${isOn?'on':''}" id="rcard-${did}-${rid}">
      <div class="rc-head">
        <div class="rc-left">
          <span class="rc-num">${String(rid+1).padStart(2,'0')}</span>
          ${colHex ? `<span class="col-swatch" style="background:${colHex}" title="${colHex}"></span>` : ''}
          <span class="rc-name">${esc(label)}</span>
        </div>
        <div class="rc-right">
          ${fxName && fxName !== 'Solid' ? `<span class="fx-badge">${esc(fxName)}</span>` : ''}
          <span class="spill ${isOn?'on':'off'}" id="rsp-${did}-${rid}">${isOn?'ON':'OFF'}</span>
          <label class="itoggle">
            <input type="checkbox" ${isOn?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)">
            <div class="itrack"><div class="ithumb"></div></div>
          </label>
        </div>
      </div>
      ${showBri ? `
      <div class="rc-bri">
        <span class="wg-lbl">BRI</span>
        <input type="range" min="0" max="255" value="${r.bri??128}" class="bri-slider"
          oninput="this.nextElementSibling.textContent=this.value"
          onchange="wledSegBri('${did}',${rid},this.value)">
        <span class="bri-val">${r.bri??128}</span>
      </div>` : ''}
      <div class="rc-body">
        <div class="rc-actions">
          ${showPulse ? `
          <div class="act-group">
            <input class="act-input" id="pm-${did}-${rid}" value="500" title="ms">
            <button class="act-btn" onclick="pulseRelay('${did}',${rid})">Pulse</button>
          </div>
          <div class="act-group">
            <input class="act-input" id="ts-${did}-${rid}" value="30" title="sec">
            <button class="act-btn" onclick="timerRelay('${did}',${rid})">Timer</button>
          </div>
          <span class="timer-badge ${r.timer>0?'v':''}" id="tbadge-${did}-${rid}">${r.timer>0?r.timer+'s':''}</span>
          ` : ''}
        </div>
      </div>
    </div>`;
}

function updateCard(dev, r) {
  const card = document.getElementById('rcard-'+dev.id+'-'+r.id);
  if (!card) return;
  card.className = 'rcard' + (r.state?' on':'');
  const cb = card.querySelector('input[type=checkbox]');
  if (cb) cb.checked = r.state;
  const sp = document.getElementById('rsp-'+dev.id+'-'+r.id);
  if (sp) { sp.textContent = r.state?'ON':'OFF'; sp.className = 'spill '+(r.state?'on':'off'); }
}

function updateMeta(dev) {
  if (activeId !== dev.id) return;
  const relays = dev.relays || [];
  const active = relays.filter(r => r.state).length;
  const pa = document.getElementById('pill-active-'+dev.id);
  if (pa) { pa.textContent = active+' active'; pa.className = 'pill '+(active>0?'pill-a':'pill-d'); }
}

/* ══════════════════════════════════════════
   WLED DIRECT WEBSOCKET
══════════════════════════════════════════ */
const wledSockets = {};    // devId → WebSocket
const wledPollers = {};    // devId → setInterval

function wledConnect(dev) {
  if (wledSockets[dev.id]) { try { wledSockets[dev.id].close(); } catch {} }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = dev.host || dev.prefix || '192.168.1.1';
  const url  = `${protocol}://${host}/ws`;
  let ws;
  try { ws = new WebSocket(url); } catch(e) { toast('WS error: '+e.message, 'r'); return; }
  wledSockets[dev.id] = ws;

  ws.onopen = () => {
    dev.status = 'online'; dev.lastSeen = Date.now();
    renderSidebar();
    if (activeId === dev.id) renderDevice(dev.id);
    ws.send(JSON.stringify({v:true}));  // request full state
    toast('Connected to '+dev.name, 'g');
    // Fetch effects list via HTTP (one-time, if not already cached)
    if (!dev.wledEffects) {
      const protocol = location.protocol === 'https:' ? 'https' : 'http';
      fetch(`${protocol}://${dev.host}/json/eff`)
        .then(r => r.json())
        .then(arr => { if (Array.isArray(arr)) { dev.wledEffects = arr; if (activeId === dev.id) renderDevice(dev.id); } })
        .catch(() => {});  // CORS may block this — that's OK
    }
    // Poll if configured
    if ((dev.pollInterval||0) > 0) {
      wledPollers[dev.id] = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({v:true}));
      }, dev.pollInterval * 1000);
    }
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      wledHandleState(dev, data);
    } catch(e) { console.warn('[WLED] parse error', e); }
  };

  ws.onclose = () => {
    dev.status = 'offline';
    renderSidebar();
    if (activeId === dev.id) renderDevice(dev.id);
    // Auto-reconnect after 5s
    setTimeout(() => {
      if (devices.find(d => d.id === dev.id)) wledConnect(dev);
    }, 5000);
  };

  ws.onerror = (e) => {
    dev.status = 'offline';
    renderSidebar();
    console.warn('[WLED] WS error', e);
  };
}

function wledDisconnect(dev) {
  if (wledPollers[dev.id]) { clearInterval(wledPollers[dev.id]); delete wledPollers[dev.id]; }
  if (wledSockets[dev.id]) {
    const ws = wledSockets[dev.id];
    ws.onclose = null;  // prevent auto-reconnect
    try { ws.close(); } catch {}
    delete wledSockets[dev.id];
  }
  dev.status = 'offline';
}

function wledSend(dev, payload) {
  const ws = wledSockets[dev.id];
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('WLED not connected', 'r'); return false; }
  ws.send(JSON.stringify(payload));
  return true;
}

/* ── WLED global controls ── */
function wledMasterToggle(devId, on) {
  const dev = getDevice(devId); if (!dev) return;
  if (dev.wledState) dev.wledState.on = on;
  wledSend(dev, { on });
}

function wledBriCommit(devId, val) {
  const dev = getDevice(devId); if (!dev) return;
  const bri = parseInt(val);
  if (dev.wledState) dev.wledState.bri = bri;
  wledSend(dev, { bri });
}

function wledFxChange(devId, fx) {
  const dev = getDevice(devId); if (!dev) return;
  wledSend(dev, { seg: [{ id: 0, fx: parseInt(fx) }] });
}

function wledSpeedChange(devId, sx) {
  const dev = getDevice(devId); if (!dev) return;
  wledSend(dev, { seg: [{ id: 0, sx: parseInt(sx) }] });
}

function wledSegBri(devId, segId, val) {
  const dev = getDevice(devId); if (!dev) return;
  const bri = parseInt(val);
  const r = dev.relays?.find(r => r.id === segId);
  if (r) r.bri = bri;
  wledSend(dev, { seg: [{ id: segId, bri }] });
}

function wledHandleState(dev, data) {
  // WLED sends {"state":{...},"info":{...}} on connect/change
  const state = data.state || data;
  if (!state) return;

  dev.lastSeen = Date.now();
  dev.status   = 'online';

  // Track global state (bri, on, transition)
  dev.wledState = {
    on:  state.on,
    bri: state.bri ?? 128,
    transition: state.transition ?? 7
  };

  // Map WLED segments → relay-like objects
  if (Array.isArray(state.seg)) {
    dev.relays = state.seg
      .filter(s => s && typeof s.id === 'number')
      .map(s => ({
        id:    s.id,
        name:  s.n || ('Seg ' + s.id),
        on:    !!s.on,
        state: !!s.on,
        bri:   s.bri ?? (s.on ? 255 : 0),
        timer: s.timer || 0,
        fx:    s.fx ?? 0,
        sx:    s.sx ?? 128,
        col:   s.col
      }));
  }

  if (data.info) {
    dev.wledInfo = {
      ver:   data.info.ver,
      name:  data.info.name,
      brand: data.info.brand,
      leds:  data.info.leds
    };
    // Detect if this is our relay controller or a real WLED device
    dev.isRelayCtrl = (data.info.brand === 'WLED-Relay');
  }

  // Cache effects list (sent once on connect via GET /json/eff)
  if (Array.isArray(data.effects)) dev.wledEffects = data.effects;

  renderSidebar();
  if (activeId === dev.id) renderDevice(dev.id);
}

/* ── WLED relay control (direct WebSocket) ─── */
function toggleRelayWled(devId, relayId, on) {
  const dev = getDevice(devId); if (!dev) return;
  wledSend(dev, { seg: [{ id: relayId, on }] });
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.on = on; r.state = on; updateCard(dev, r); updateMeta(dev); }
}

function pulseRelayWled(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const ms = parseInt(document.getElementById('pm-'+devId+'-'+relayId).value) || 500;
  // WLED has no pulse natively — simulate with on+timer
  wledSend(dev, { seg: [{ id: relayId, on: true }] });
  setTimeout(() => wledSend(dev, { seg: [{ id: relayId, on: false }] }), ms);
  toast('Pulse '+ms+'ms → '+dev.name+' S'+relayId);
}

function timerRelayWled(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const s = parseInt(document.getElementById('ts-'+devId+'-'+relayId).value) || 30;
  wledSend(dev, { seg: [{ id: relayId, on: true }] });
  setTimeout(() => wledSend(dev, { seg: [{ id: relayId, on: false }] }), s * 1000);
  toast('Timer '+s+'s → '+dev.name+' S'+relayId);
}

function allOffWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  wledSend(dev, { on: false });
  dev.relays?.forEach(r => { r.on = false; r.state = false; updateCard(dev, r); });
  updateMeta(dev);
  toast('All OFF — '+dev.name, 'r');
}

function allOnWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  wledSend(dev, { on: true });
  dev.relays?.forEach(r => { r.on = true; r.state = true; updateCard(dev, r); });
  updateMeta(dev);
  toast('All ON — '+dev.name);
}

function sendCmdWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  const raw = document.getElementById('cmd-'+devId).value.trim();
  if (!raw) return;
  try { const obj = JSON.parse(raw); wledSend(dev, obj); toast('Sent', 'g'); }
  catch(e) { toast('Invalid JSON: '+e.message, 'r'); }
}

/* ── Modal type toggle ── */
function onDevTypeChange() {
  const type = document.getElementById('dm-type').value;
  document.getElementById('dm-mqtt-fields').style.display = type === 'mqtt' ? '' : 'none';
  document.getElementById('dm-wled-fields').style.display = type === 'wled' ? '' : 'none';
}

/* ── DEVICE MANAGEMENT ── */
function getDevice(id) { return devices.find(d => d.id === id); }

function openAddDevice() {
  document.getElementById('modal-title').textContent = 'Add Device';
  document.getElementById('dm-id').value     = '';
  document.getElementById('dm-name').value   = '';
  document.getElementById('dm-type').value   = 'mqtt';
  document.getElementById('dm-prefix').value = '';
  document.getElementById('dm-ping').value   = '10';
  document.getElementById('dm-host').value   = '';
  document.getElementById('dm-poll').value   = '0';
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
  setTimeout(() => document.getElementById('dm-name').focus(), 100);
}

function openEditDevice(id) {
  const dev = getDevice(id); if (!dev) return;
  document.getElementById('modal-title').textContent = 'Edit Device';
  document.getElementById('dm-id').value     = dev.id;
  document.getElementById('dm-name').value   = dev.name;
  document.getElementById('dm-type').value   = dev.type || 'mqtt';
  document.getElementById('dm-prefix').value = dev.prefix || '';
  document.getElementById('dm-ping').value   = dev.pingInterval || 10;
  document.getElementById('dm-host').value   = dev.host || '';
  document.getElementById('dm-poll').value   = dev.pollInterval || 0;
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
}

function closeModal() { document.getElementById('add-modal').classList.remove('open'); }

function saveDevice() {
  const existingId = document.getElementById('dm-id').value;
  const name   = document.getElementById('dm-name').value.trim() || 'Device';
  const type   = document.getElementById('dm-type').value || 'mqtt';
  const prefix = document.getElementById('dm-prefix').value.trim().replace(/\/+$/,'') || 'home/relay';
  const ping   = parseInt(document.getElementById('dm-ping').value) || 10;
  const host   = document.getElementById('dm-host').value.trim();
  const poll   = parseInt(document.getElementById('dm-poll').value) || 0;

  if (type === 'wled' && !host) { toast('Enter device host/IP', 'r'); return; }

  if (existingId) {
    const dev = getDevice(existingId);
    if (dev) {
      if (dev.type === 'mqtt') {
        unsubscribeDevice(dev);
        if (pingTimers[dev.id]) { clearInterval(pingTimers[dev.id]); delete pingTimers[dev.id]; }
      } else if (dev.type === 'wled') {
        wledDisconnect(dev);
      }
      dev.name = name; dev.type = type; dev.prefix = prefix; dev.pingInterval = ping;
      dev.host = host; dev.pollInterval = poll;
      if (type === 'mqtt' && connected) { subscribeDevice(dev); startPing(dev); }
      if (type === 'wled') wledConnect(dev);
    }
  } else {
    const dev = { id:'dev-'+Date.now(), name, type, prefix, pingInterval:ping, host, pollInterval:poll, status:'offline', lastSeen:null, relays:[] };
    devices.push(dev);
    if (type === 'mqtt' && connected) { subscribeDevice(dev); publishPresence(dev, true); startPing(dev); }
    if (type === 'wled') wledConnect(dev);
    selectDevice(dev.id);
  }

  persist();
  renderSidebar();
  closeModal();
  toast('Saved', 'g');
}

function removeDevice(id, e) {
  if (e) e.stopPropagation();
  const dev = getDevice(id); if (!dev) return;
  if (!confirm('Remove "'+dev.name+'"?')) return;
  if ((dev.type||'mqtt') === 'mqtt') {
    unsubscribeDevice(dev);
    publishPresence(dev, false);
    if (pingTimers[id]) { clearInterval(pingTimers[id]); delete pingTimers[id]; }
  } else {
    wledDisconnect(dev);
  }
  devices = devices.filter(d => d.id !== id);
  if (activeId === id) activeId = devices[0]?.id || null;
  persist();
  renderSidebar();
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected','Add a device in the sidebar.');
}

/* ── HELPERS ── */
function persist() {
  save({ broker, devices: devices.map(({id,name,type,prefix,pingInterval,host,pollInterval}) => ({id,name,type:type||'mqtt',prefix,pingInterval,host:host||'',pollInterval:pollInterval||0})) });
}

function ago(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 5)  return 'just now';
  if (s < 60) return s+'s ago';
  return Math.floor(s/60)+'m ago';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function emptyHTML(icon, title, sub) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
}

// Refresh "last seen X ago" labels every 10s
setInterval(() => {
  devices.forEach(dev => {
    const el = document.getElementById('last-seen-'+dev.id);
    if (el && dev.lastSeen) el.textContent = 'seen '+ago(dev.lastSeen);
  });
}, 10000);

/* ── INIT ── */
(function init() {
  // If hosted on HTTPS (e.g. GitHub Pages), WSS is required — force it
  const mustSSL = location.protocol === 'https:';

  document.getElementById('b-host').value  = broker.host || '';
  document.getElementById('b-port').value  = broker.port || (mustSSL ? 8084 : 9001);
  document.getElementById('b-user').value  = broker.user || '';
  document.getElementById('b-pass').value  = broker.pass || '';
  document.getElementById('b-ssl').checked = mustSSL || broker.ssl || false;

  if (mustSSL) {
    // Lock the TLS checkbox and show a note
    document.getElementById('b-ssl').disabled = true;
    const note = document.createElement('div');
    note.style.cssText = 'font-size:9px;color:var(--amber);margin-top:6px;line-height:1.6';
    note.innerHTML = '⚠ Page is served over HTTPS — TLS/WSS is required.<br>Broker must support <b>wss://</b> (port 8084 for EMQX/HiveMQ, 8083 for Mosquitto+TLS).';
    document.getElementById('b-ssl').closest('.broker-panel').appendChild(note);
  }

  setConnUI(false);
  renderSidebar();

  // Auto-connect WLED devices (they're direct, no broker needed)
  devices.forEach(dev => {
    if ((dev.type||'mqtt') === 'wled') {
      setTimeout(() => wledConnect(dev), 500);
    }
  });

  if (!activeId && devices.length) activeId = devices[0].id;
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected','Add a device using + Add Device.<br>WLED devices connect directly. MQTT relay controllers need broker connection.');
})();
