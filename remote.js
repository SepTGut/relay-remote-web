/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD  (remote.js)
   MQTT over WebSocket (Paho) for relay controllers.
   Direct WebSocket for WLED devices — HTTP only..
═══════════════════════════════════════════════════ */

/* ── STORAGE ── */
const SK = 'relayctrl_v2';
function load() { try { return JSON.parse(localStorage.getItem(SK) || '{}'); } catch { return {}; } }
function save(d) { localStorage.setItem(SK, JSON.stringify(d)); }

/* ── STATE ── */
let client     = null;
let connected  = false;
let pingTimers = {};
let wledSockets = {};   // devId → WebSocket
let wledPollers = {};   // devId → setInterval for reconnect
let devices    = [];
let activeId   = null;

const stored   = load();
const broker   = stored.broker || { host:'', port:9001, user:'', pass:'', ssl:false };
devices = (stored.devices || []).map(d => ({ ...d, status:'offline', relays:[] }));

/* ── HTTPS DETECTION ── */
const IS_HTTPS = location.protocol === 'https:';

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
   MQTT  (relay controllers only)
══════════════════════════════════════════ */
function mqttConnect() {
  if (typeof Paho === 'undefined') {
    showError('Paho MQTT library not loaded. Check your internet connection and reload.');
    return;
  }
  const host = document.getElementById('b-host').value.trim();
  const port = parseInt(document.getElementById('b-port').value) || 9001;
  const user = document.getElementById('b-user').value.trim();
  const pass = document.getElementById('b-pass').value;
  const ssl  = IS_HTTPS ? true : document.getElementById('b-ssl').checked;
  if (!host) { toast('Enter broker host', 'r'); return; }
  clearError();
  broker.host = host; broker.port = port; broker.user = user; broker.pass = pass; broker.ssl = ssl;
  persist();
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false;
  const clientId = 'relayctrl-' + Math.random().toString(36).slice(2, 9);
  const PahoClient = (Paho.MQTT && Paho.MQTT.Client) ? Paho.MQTT.Client : Paho.Client;
  client = new PahoClient(host, port, clientId);
  client.onConnectionLost = function(resp) {
    connected = false;
    setConnUI(false);
    devices.filter(d => (d.type||'mqtt') === 'mqtt').forEach(d => d.status = 'offline');
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
    onSuccess: function() {
      connected = true;
      clearError();
      setConnUI(true);
      toast('Connected to ' + host, 'g');
      // Only subscribe relay controller (mqtt) devices — WLED uses direct WebSocket
      devices.filter(d => (d.type||'mqtt') === 'mqtt').forEach(d => {
        subscribeDevice(d); publishPresence(d, true); startPing(d);
      });
    },
    onFailure: function(err) {
      connected = false;
      setConnUI(false);
      const msg = err.errorMessage || ('Error code ' + err.errorCode);
      toast('Connect failed: ' + msg, 'r');
      showError('Failed: ' + msg + '\nCheck host, port, and that broker has WebSocket enabled.');
    }
  };
  if (user) { opts.userName = user; opts.password = pass; }
  try { client.connect(opts); } catch(e) { toast('Connect error: ' + e.message, 'r'); showError(e.message); }
}

function mqttDisconnect() {
  Object.values(pingTimers).forEach(clearInterval);
  pingTimers = {};
  devices.filter(d => (d.type||'mqtt') === 'mqtt').forEach(d => publishPresence(d, false));
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false;
  setConnUI(false);
  devices.filter(d => (d.type||'mqtt') === 'mqtt').forEach(d => d.status = 'offline');
  renderSidebar();
  if (activeId) renderDevice(activeId);
}

function publish(topic, payload, retained=false) {
  if (!connected || !client) { toast('Not connected to broker', 'r'); return false; }
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

function publishJSON(topic, obj, retained=false) { return publish(topic, JSON.stringify(obj), retained); }

function subscribeDevice(dev) {
  if (!connected || (dev.type||'mqtt') !== 'mqtt') return;
  try {
    client.subscribe(dev.prefix + '/v');
    client.subscribe(dev.prefix + '/relay/+/v');
    client.subscribe(dev.prefix + '/sensor/+/v');
    client.subscribe(dev.prefix + '/status');
  } catch(e) { console.warn('Subscribe error', e); }
}

function unsubscribeDevice(dev) {
  if (!connected || (dev.type||'mqtt') !== 'mqtt') return;
  try { client.unsubscribe(dev.prefix + '/v'); } catch {}
  try { client.unsubscribe(dev.prefix + '/relay/+/v'); } catch {}
  try { client.unsubscribe(dev.prefix + '/sensor/+/v'); } catch {}
  try { client.unsubscribe(dev.prefix + '/status'); } catch {}
}

function publishPresence(dev, online) { publish(dev.prefix + '/presence', online ? 'online' : 'offline', false); }

function startPing(dev) {
  if (pingTimers[dev.id]) clearInterval(pingTimers[dev.id]);
  const iv = (dev.pingInterval || 10) * 1000;
  pingTimers[dev.id] = setInterval(() => { if (connected) publish(dev.prefix + '/ping', '1', false); }, iv);
}

/* ── INCOMING MQTT MESSAGES (relay controllers only) ── */
function onMessage(msg) {
  const topic   = msg.destinationName;
  const payload = msg.payloadString;
  // Match only mqtt-type devices
  const dev = devices.find(d => (d.type||'mqtt') === 'mqtt' && d.prefix && (topic === d.prefix || topic.startsWith(d.prefix + '/')));
  if (!dev) return;
  const suffix = topic.slice(dev.prefix.length + 1);

  if (suffix === 'v') {
    try {
      const data = JSON.parse(payload);
      let changed = false;
      if (Array.isArray(data.relays)) {
        dev.relays = data.relays.map(r => ({ ...r, state: r.on }));
        dev.status = 'online'; dev.lastSeen = Date.now(); changed = true;
      }
      if (Array.isArray(data.sensors)) {
        const prev = dev.sensors || [];
        dev.sensors = data.sensors;
        if (prev.length !== data.sensors.length) { changed = true; }
        else { data.sensors.forEach(s => updateSensorCard(dev, s)); }
      }
      if (changed) { renderSidebar(); if (activeId === dev.id) renderDevice(dev.id); }
    } catch(e) { console.warn('/v parse err', e); }
    return;
  }

  if (suffix === 'status') {
    const wasOnline = dev.status === 'online';
    dev.status = payload.trim().toLowerCase() === 'online' ? 'online' : 'offline';
    dev.lastSeen = Date.now();
    if (dev.status === 'online' && !wasOnline) setTimeout(() => publish(dev.prefix + '/ping', '1', false), 400);
    renderSidebar(); if (activeId === dev.id) renderDevice(dev.id); return;
  }

  const mRel = suffix.match(/^relay\/(\d+)\/v$/);
  if (mRel) {
    const id = parseInt(mRel[1]);
    if (!dev.relays) dev.relays = [];
    let r = dev.relays.find(r => r.id === id);
    if (!r) { r = { id, name:'Relay '+(id+1), on:false, state:false }; dev.relays.push(r); dev.relays.sort((a,b)=>a.id-b.id); }
    r.on = payload.trim().toLowerCase() === 'on'; r.state = r.on;
    dev.status = 'online'; dev.lastSeen = Date.now();
    if (activeId === dev.id) updateCard(dev, r); renderSidebar(); return;
  }

  const mSen = suffix.match(/^sensor\/(\d+)\/v$/);
  if (mSen) {
    const id = parseInt(mSen[1]);
    if (!dev.sensors) dev.sensors = [];
    let s = dev.sensors.find(s => s.id === id);
    const active = payload.trim().toLowerCase() === 'active';
    if (!s) {
      s = { id, name:'Sensor '+(id+1), active };
      dev.sensors.push(s); dev.sensors.sort((a,b) => a.id - b.id);
      dev.status = 'online'; dev.lastSeen = Date.now();
      if (activeId === dev.id) renderDevice(dev.id);
    } else {
      s.active = active; dev.status = 'online'; dev.lastSeen = Date.now();
      updateSensorCard(dev, s);
    }
    return;
  }
}

/* ── RELAY CONTROL (mqtt type) ── */
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
  toast('Pulse '+ms+'ms → '+dev.name);
}

function timerRelay(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { timerRelayWled(devId, relayId); return; }
  const s = parseInt(document.getElementById('ts-'+devId+'-'+relayId).value) || 30;
  publishJSON(dev.prefix + '/relay/' + relayId + '/api', { timer: s });
  toast('Timer '+s+'s → '+dev.name);
}

function allOff(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { allOffWled(devId); return; }
  publishJSON(dev.prefix + '/api', { on: false });
  dev.relays?.forEach(r => { r.on = false; r.state = false; updateCard(dev, r); });
  updateMeta(dev); toast('All OFF — '+dev.name, 'r');
}

function allOn(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { allOnWled(devId); return; }
  publishJSON(dev.prefix + '/api', { on: true });
  dev.relays?.forEach(r => { r.on = true; r.state = true; updateCard(dev, r); });
  updateMeta(dev); toast('All ON — '+dev.name);
}

function sendCmd(devId) {
  const dev = getDevice(devId); if (!dev) return;
  if (isWled(dev)) { sendCmdWled(devId); return; }
  const raw = document.getElementById('cmd-'+devId).value.trim();
  if (!raw) return;
  try { JSON.parse(raw); } catch(e) { toast('Invalid JSON: '+e.message, 'r'); return; }
  publish(dev.prefix + '/api', raw); toast('Sent', 'g');
}

function pingDevice(id) {
  const dev = getDevice(id); if (!dev) return;
  if (isWled(dev)) { wledRequestState(dev); return; }
  publish(dev.prefix + '/ping', '1', false);
}

/* ══════════════════════════════════════════
   UI
══════════════════════════════════════════ */
function setConnUI(on) {
  document.getElementById('conn-dot').className    = 'cdot'+(on?' on':'');
  document.getElementById('conn-label').textContent = on ? 'online' : 'offline';
  const ts = document.getElementById('tb-status');
  ts.textContent = on ? 'CONNECTED' : 'DISCONNECTED'; ts.className = 'tb-val '+(on?'g':'r');
  document.getElementById('btn-connect').style.display    = on ? 'none' : '';
  document.getElementById('btn-disconnect').style.display = on ? '' : 'none';
}

function showError(msg) { const el=document.getElementById('conn-error'); el.textContent=msg; el.style.display='block'; }
function clearError()   { const el=document.getElementById('conn-error'); el.textContent='';  el.style.display='none';  }

function renderSidebar() {
  const list = document.getElementById('device-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div style="padding:12px 14px;font-size:10px;color:var(--dim)">No devices yet.</div>';
  }
  devices.forEach(dev => {
    const el = document.createElement('div');
    el.className = 'device-item' + (dev.id === activeId ? ' active' : '');
    const wledOk = isWled(dev) && !IS_HTTPS;
    const wledBadge = isWled(dev)
      ? `<span class="dev-badge wled">${wledOk ? (dev.hasMultiRelay ? 'WLED+R' : 'WLED') : 'WLED⚠'}</span>`
      : '';
    el.innerHTML = `
      <div class="dev-left">
        <span class="dev-dot ${dev.status||'offline'}"></span>
        <span class="dev-name">${esc(dev.name)}</span>
        ${wledBadge}
      </div>
      <button class="dev-remove" onclick="removeDevice('${dev.id}',event)">✕</button>`;
    el.onclick = e => { if (e.target.closest('.dev-remove')) return; selectDevice(dev.id); };
    list.appendChild(el);
  });
  const el = document.getElementById('tb-devices');
  if (el) el.textContent = devices.length;
}

function selectDevice(id) { activeId = id; renderSidebar(); renderDevice(id); }

function renderDevice(id) {
  const main = document.getElementById('main');
  const dev  = getDevice(id);
  if (!dev) { main.innerHTML = emptyHTML('📡','No Device Selected','Add a device in the sidebar.'); return; }

  const relays  = dev.relays || [];
  const sensors = dev.sensors || [];
  const online  = dev.status === 'online';
  const active  = relays.filter(r => r.state).length;

  // HTTPS warning for WLED
  const httpsWarn = isWled(dev) && IS_HTTPS ? `
    <div class="wled-https-warn">
      ⚠ <b>WLED WebSocket is blocked on HTTPS.</b><br>
      GitHub Pages forces HTTPS, which prevents <code>ws://</code> connections to local devices.<br>
      <b>Solutions:</b><br>
      • Open <code>index.html</code> directly from your filesystem (drag into browser)<br>
      • Run a local HTTP server: <code>npx serve .</code> or VS Code Live Server (<code>http://127.0.0.1:5500</code>)<br>
      • Or host on any plain <b>HTTP</b> server on your network.
    </div>` : '';

  main.innerHTML = `
    ${httpsWarn}
    <div class="dev-header">
      <div>
        <div class="dev-title">${esc(dev.name)}<span class="sub">${isWled(dev) ? esc(dev.host||'') : esc(dev.prefix)}</span></div>
        <div class="dev-meta">
          <span class="pill ${online?'pill-g':'pill-r'}" id="pill-status-${dev.id}">${online?'ONLINE':'OFFLINE'}</span>
          ${isWled(dev) ? `<span class="pill" style="background:var(--teal);color:#000">${dev.hasMultiRelay?'WLED+Relays':'WLED'}</span>` : '<span class="pill pill-d">MQTT</span>'}
          <span class="pill pill-a" id="pill-count-${dev.id}">${relays.length} ${isWled(dev)?'relays':'relays'}</span>
          <span class="pill ${active>0?'pill-a':'pill-d'}" id="pill-active-${dev.id}">${active} active</span>
          ${!isWled(dev) && sensors.length ? `<span class="pill pill-teal">${sensors.length} sensors</span>` : ''}
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
        ${dev.wledEffects ? `
        <span class="wg-lbl" style="margin-left:8px">FX</span>
        <select class="fx-select" onchange="wledFxChange('${dev.id}',this.value)">
          ${dev.wledEffects.filter(n=>n!=='RSVD'&&n!=='-').map((n,i)=>`<option value="${i}">${esc(n)}</option>`).join('')}
        </select>` : ''}
      </div>
    </div>` : ''}

    <div class="cmd-bar">
      <div class="cmd-row">
        <span class="cmd-lbl">JSON CMD</span>
        <input class="cmd-input" id="cmd-${dev.id}"
          placeholder='${isWled(dev) ? '{"on":true}  ·  {"bri":128}  ·  {"seg":[{"id":0,"fx":73}]}' : '{"on":true}  ·  {"relay":0,"on":true}'}'
          onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
        <button class="btn btn-teal btn-sm" onclick="sendCmd('${dev.id}')">Send</button>
      </div>
      <div class="cmd-hints">
        ${isWled(dev) ?
          `LED: <code>{"on":true}</code> · <code>{"bri":128}</code> · <code>{"seg":[{"id":0,"fx":73}]}</code><br>
          Relay toggle: click the relay card below` :
          `All: <code>{"on":true}</code> · <code>{"on":false}</code> · Toggle: <code>{"on":"t"}</code><br>
          Single: <code>{"relay":0,"on":true}</code> · Pulse: <code>{"relay":1,"pulse":500}</code>`
        }
      </div>
    </div>

    <div class="relay-grid" id="grid-${dev.id}">
      ${relays.length ? relays.map(r => cardHTML(dev, r)).join('') : emptyHTML('🔌','No data yet', online ? 'Click ↻ Ping to request state.' : (isWled(dev) && IS_HTTPS ? 'HTTPS blocks WebSocket.' : 'Device is offline.'))}
    </div>

    ${!isWled(dev) && sensors.length ? `
    <div class="sensor-section">
      <div class="sensor-section-head">
        <span class="sensor-section-title">⬡ Sensors</span>
        <span class="sensor-section-count">${sensors.length} configured</span>
      </div>
      <div class="sensor-grid" id="sgrid-${dev.id}">
        ${sensors.map(s => sensorCardHTML(dev, s)).join('')}
      </div>
    </div>` : ''}`;
}

function cardHTML(dev, r) {
  const did = dev.id, rid = r.id;
  const isOn = !!(r.on || r.state);
  const showBri   = isWled(dev) && !dev.hasMultiRelay;
  const showPulse = !isWled(dev) || dev.hasMultiRelay;
  const fxName    = showBri && dev.wledEffects ? (dev.wledEffects[r.fx ?? 0] || null) : null;
  const colArr    = Array.isArray(r.col) && Array.isArray(r.col[0]) ? r.col[0] : null;
  const colHex    = colArr ? '#' + colArr.slice(0,3).map(v => (v||0).toString(16).padStart(2,'0')).join('') : null;
  const label     = r.name || (isWled(dev) ? 'Relay '+(rid+1) : 'Relay '+(rid+1));

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
   SENSOR CARDS
══════════════════════════════════════════ */
function sensorCardHTML(dev, s) {
  const active = !!s.active;
  const modeStr = s.trigger_mode && s.trigger_mode !== 'NONE' && s.trigger_relay >= 0
    ? `→ R${s.trigger_relay + 1} · ${s.trigger_mode}` : '';
  return `
    <div class="scrd ${active ? 'active' : ''}" id="scrd-${dev.id}-${s.id}">
      <div class="scrd-head">
        <span class="scrd-num">${String(s.id + 1).padStart(2,'0')}</span>
        <span class="scrd-name">${esc(s.name || ('Sensor '+(s.id+1)))}</span>
        <span class="scrd-pill ${active ? 'active' : 'idle'}" id="scpill-${dev.id}-${s.id}">${active ? 'ACTIVE' : 'IDLE'}</span>
      </div>
      ${s.pin !== undefined ? `<div class="scrd-meta">GPIO ${s.pin}${s.debounce_ms > 0 ? ` · ⏱${s.debounce_ms}ms` : ''}${modeStr ? ` · ${modeStr}` : ''}</div>` : ''}
    </div>`;
}

function updateSensorCard(dev, s) {
  const card = document.getElementById('scrd-'+dev.id+'-'+s.id);
  if (!card) return;
  const active = !!s.active;
  card.className = 'scrd' + (active ? ' active' : '');
  const pill = document.getElementById('scpill-'+dev.id+'-'+s.id);
  if (pill) { pill.textContent = active ? 'ACTIVE' : 'IDLE'; pill.className = 'scrd-pill ' + (active ? 'active' : 'idle'); }
}

/* ══════════════════════════════════════════
   WLED — DIRECT WEBSOCKET
   ─────────────────────────────────────────
   State:   ws://host/ws  (WebSocket)
   Control: http://host/relays?switch=…  (HTTP fetch for relays)
            ws send JSON for LED state
   Polling: periodic {v:1} ping over WS

   ⚠ BLOCKED on HTTPS (GitHub Pages).
     Open via HTTP — local server or filesystem.
     The MQTT broker section is still used for
     relay controllers only.
══════════════════════════════════════════ */
function isWled(dev) { return (dev?.type || 'mqtt') === 'wled'; }

function wledConnect(dev) {
  if (!dev.host) { console.warn('[WLED] no host set'); return; }
  if (IS_HTTPS) { dev.status = 'blocked'; renderSidebar(); if (activeId === dev.id) renderDevice(dev.id); return; }
  wledDisconnect(dev);

  let ws;
  try { ws = new WebSocket('ws://' + dev.host + '/ws'); }
  catch(e) { console.warn('[WLED] WS open error', e); scheduleReconnect(dev); return; }

  wledSockets[dev.id] = ws;

  ws.onopen = () => {
    dev.status = 'online'; dev.lastSeen = Date.now();
    renderSidebar(); if (activeId === dev.id) renderDevice(dev.id);
    // Request full state + effects list
    try { ws.send(JSON.stringify({ v: 1 })); } catch {}
  };

  ws.onmessage = (e) => {
    try { handleWledState(dev, JSON.parse(e.data)); } catch {}
  };

  ws.onclose = () => {
    dev.status = 'offline';
    delete wledSockets[dev.id];
    renderSidebar(); if (activeId === dev.id) renderDevice(dev.id);
    scheduleReconnect(dev);
  };

  ws.onerror = () => { dev.status = 'offline'; };

  // Periodic state ping (fallback if WLED doesn't push changes)
  if (wledPollers[dev.id]) clearInterval(wledPollers[dev.id]);
  wledPollers[dev.id] = setInterval(() => {
    const s = wledSockets[dev.id];
    if (s && s.readyState === WebSocket.OPEN) {
      try { s.send(JSON.stringify({ v: 1 })); } catch {}
    }
  }, 5000);
}

function scheduleReconnect(dev) {
  if (wledPollers[dev.id]) clearInterval(wledPollers[dev.id]);
  wledPollers[dev.id] = setTimeout(() => {
    if (devices.find(d => d.id === dev.id)) wledConnect(dev);
  }, 5000);
}

function wledDisconnect(dev) {
  const ws = wledSockets[dev.id];
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} delete wledSockets[dev.id]; }
  if (wledPollers[dev.id]) { clearInterval(wledPollers[dev.id]); clearTimeout(wledPollers[dev.id]); delete wledPollers[dev.id]; }
  dev.status = 'offline';
}

function wledRequestState(dev) {
  const ws = wledSockets[dev.id];
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ v: 1 })); toast('Requesting state…'); } catch {}
  } else if (!IS_HTTPS) {
    toast('Reconnecting…'); wledConnect(dev);
  }
}

function handleWledState(dev, data) {
  dev.lastSeen = Date.now();
  dev.status   = 'online';
  if (!dev.wledState) dev.wledState = {};

  // Effects list (sent once on connect)
  if (data.effects) dev.wledEffects = data.effects;

  // LED global state
  const state = data.state || data;
  if (state.on  !== undefined) dev.wledState.on  = state.on;
  if (state.bri !== undefined) dev.wledState.bri = state.bri;

  // MultiRelay usermod — physical relay states
  const mr = state.MultiRelay || (data.state && data.state.MultiRelay);
  if (mr && Array.isArray(mr.relays)) {
    dev.hasMultiRelay = true;
    // Build/merge relay list preserving order by relay index
    const existing = dev.relays || [];
    dev.relays = mr.relays.map(r => {
      const old = existing.find(x => x.id === r.relay) || {};
      return {
        id:    r.relay,
        name:  old.name || ('Relay ' + (r.relay + 1)),
        on:    !!r.state,
        state: !!r.state,
        bri:   255,
        col:   null,
        timer: 0
      };
    });
  } else if (!dev.hasMultiRelay) {
    // Fall back to LED segments for state display
    const segs = state.seg || [];
    if (segs.length) {
      dev.relays = segs.map(s => ({
        id:    s.id,
        name:  s.n || ('Seg ' + s.id),
        on:    !!s.on,
        state: !!s.on,
        bri:   s.bri ?? 128,
        col:   s.col || null,
        timer: 0
      }));
    } else if (!dev.relays?.length) {
      dev.relays = [{ id:0, name:'Master', on:dev.wledState.on, state:dev.wledState.on, bri:dev.wledState.bri??128, col:null, timer:0 }];
    }
  }

  renderSidebar();
  if (activeId === dev.id) renderDevice(dev.id);
}

/* ── WLED LED control (WebSocket) ── */
function wledWsSend(dev, obj) {
  const ws = wledSockets[dev.id];
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('WLED not connected', 'r'); return false; }
  try { ws.send(JSON.stringify(obj)); return true; } catch(e) { toast('Send error: '+e.message, 'r'); return false; }
}

function wledMasterToggle(devId, on) {
  const dev = getDevice(devId); if (!dev) return;
  if (!dev.wledState) dev.wledState = {};
  dev.wledState.on = on;
  wledWsSend(dev, { on });
}

function wledBriCommit(devId, val) {
  const dev = getDevice(devId); if (!dev) return;
  const bri = parseInt(val);
  if (!dev.wledState) dev.wledState = {};
  dev.wledState.bri = bri;
  wledWsSend(dev, { bri });
}

function wledFxChange(devId, fx) {
  const dev = getDevice(devId); if (!dev) return;
  wledWsSend(dev, { seg: [{ id: 0, fx: parseInt(fx) }] });
}

function wledSegBri(devId, segId, val) {
  const dev = getDevice(devId); if (!dev) return;
  wledWsSend(dev, { seg: [{ id: segId, bri: parseInt(val) }] });
}

/* ── WLED relay control (HTTP /relays endpoint) ── */
async function wledFetch(dev, path, method='GET', body=null) {
  if (IS_HTTPS) { toast('HTTPS blocks HTTP requests to local devices', 'r'); return null; }
  try {
    const opts = { method };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const res = await fetch('http://' + dev.host + path, opts);
    if (res.ok) return res;
    return null;
  } catch(e) {
    dev.status = 'offline'; renderSidebar(); if (activeId === dev.id) renderDevice(dev.id);
    toast('WLED unreachable', 'r'); return null;
  }
}

function buildSwitchStr(dev, overrideId, overrideVal) {
  // Build comma-separated switch string from current relay states
  const relays = dev.relays || [];
  if (!relays.length) return overrideVal ? '1' : '0';
  return relays.map(r => r.id === overrideId ? (overrideVal ? 1 : 0) : (r.on ? 1 : 0)).join(',');
}

function toggleRelayWled(devId, relayId, on) {
  const dev = getDevice(devId); if (!dev) return;
  const sw = buildSwitchStr(dev, relayId, on);
  wledFetch(dev, '/relays?switch=' + sw);
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.on = on; r.state = on; updateCard(dev, r); updateMeta(dev); }
}

function pulseRelayWled(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const ms = parseInt(document.getElementById('pm-'+devId+'-'+relayId).value) || 500;
  const swOn  = buildSwitchStr(dev, relayId, true);
  const swOff = buildSwitchStr(dev, relayId, false);
  wledFetch(dev, '/relays?switch=' + swOn);
  setTimeout(() => wledFetch(dev, '/relays?switch=' + swOff), ms);
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.on = true; r.state = true; updateCard(dev, r); updateMeta(dev); }
  toast('Pulse ' + ms + 'ms → ' + dev.name + ' R' + (relayId + 1));
}

function timerRelayWled(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const s   = parseInt(document.getElementById('ts-'+devId+'-'+relayId).value) || 30;
  const swOn  = buildSwitchStr(dev, relayId, true);
  const swOff = buildSwitchStr(dev, relayId, false);
  wledFetch(dev, '/relays?switch=' + swOn);
  setTimeout(() => wledFetch(dev, '/relays?switch=' + swOff), s * 1000);
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.on = true; r.state = true; updateCard(dev, r); updateMeta(dev); }
  toast('Timer ' + s + 's → ' + dev.name + ' R' + (relayId + 1));
}

function allOffWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  const n = dev.relays?.length || 4;
  wledFetch(dev, '/relays?switch=' + Array(n).fill(0).join(','));
  dev.relays?.forEach(r => { r.on = false; r.state = false; updateCard(dev, r); });
  updateMeta(dev); toast('All OFF — ' + dev.name, 'r');
}

function allOnWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  const n = dev.relays?.length || 4;
  wledFetch(dev, '/relays?switch=' + Array(n).fill(1).join(','));
  dev.relays?.forEach(r => { r.on = true; r.state = true; updateCard(dev, r); });
  updateMeta(dev); toast('All ON — ' + dev.name);
}

function sendCmdWled(devId) {
  const dev = getDevice(devId); if (!dev) return;
  const raw = document.getElementById('cmd-'+devId).value.trim();
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    wledWsSend(dev, obj);
    toast('Sent via WebSocket', 'g');
  } catch(e) { toast('Invalid JSON: ' + e.message, 'r'); }
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
  document.getElementById('dm-id').value       = '';
  document.getElementById('dm-name').value     = '';
  document.getElementById('dm-type').value     = 'mqtt';
  document.getElementById('dm-prefix').value   = '';
  document.getElementById('dm-ping').value     = '10';
  document.getElementById('dm-wled-host').value = '';
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
  setTimeout(() => document.getElementById('dm-name').focus(), 100);
}

function openEditDevice(id) {
  const dev = getDevice(id); if (!dev) return;
  document.getElementById('modal-title').textContent = 'Edit Device';
  document.getElementById('dm-id').value       = dev.id;
  document.getElementById('dm-name').value     = dev.name;
  document.getElementById('dm-type').value     = dev.type || 'mqtt';
  document.getElementById('dm-prefix').value   = dev.prefix || '';
  document.getElementById('dm-ping').value     = dev.pingInterval || 10;
  document.getElementById('dm-wled-host').value = dev.host || '';
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
}

function closeModal() { document.getElementById('add-modal').classList.remove('open'); }

function saveDevice() {
  const existingId = document.getElementById('dm-id').value;
  const name    = document.getElementById('dm-name').value.trim() || 'Device';
  const type    = document.getElementById('dm-type').value || 'mqtt';
  const prefix  = document.getElementById('dm-prefix').value.trim().replace(/\/+$/,'') || 'home/relay';
  const ping    = parseInt(document.getElementById('dm-ping').value) || 10;
  const host    = document.getElementById('dm-wled-host').value.trim();

  if (type === 'wled' && !host) { toast('Enter WLED IP address', 'r'); return; }

  if (existingId) {
    const dev = getDevice(existingId);
    if (dev) {
      if ((dev.type||'mqtt') === 'mqtt') { unsubscribeDevice(dev); if (pingTimers[dev.id]) { clearInterval(pingTimers[dev.id]); delete pingTimers[dev.id]; } }
      else if (dev.type === 'wled') { wledDisconnect(dev); }
      dev.name = name; dev.type = type; dev.prefix = prefix; dev.pingInterval = ping; dev.host = host;
      if (type === 'mqtt' && connected) { subscribeDevice(dev); startPing(dev); }
      if (type === 'wled') wledConnect(dev);
    }
  } else {
    const dev = { id:'dev-'+Date.now(), name, type, prefix, pingInterval:ping, host, status:'offline', lastSeen:null, relays:[] };
    devices.push(dev);
    if (type === 'mqtt' && connected) { subscribeDevice(dev); publishPresence(dev, true); startPing(dev); }
    if (type === 'wled') wledConnect(dev);
    selectDevice(dev.id);
  }

  persist(); renderSidebar(); closeModal(); toast('Saved', 'g');
}

function removeDevice(id, e) {
  if (e) e.stopPropagation();
  const dev = getDevice(id); if (!dev) return;
  if (!confirm('Remove "'+dev.name+'"?')) return;
  if ((dev.type||'mqtt') === 'mqtt') {
    unsubscribeDevice(dev); publishPresence(dev, false);
    if (pingTimers[id]) { clearInterval(pingTimers[id]); delete pingTimers[id]; }
  } else { wledDisconnect(dev); }
  devices = devices.filter(d => d.id !== id);
  if (activeId === id) activeId = devices[0]?.id || null;
  persist(); renderSidebar();
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected','Add a device in the sidebar.');
}

/* ── HELPERS ── */
function persist() {
  save({ broker, devices: devices.map(({id,name,type,prefix,pingInterval,host}) => ({id,name,type:type||'mqtt',prefix,pingInterval,host:host||''})) });
}

function ago(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 5)  return 'just now';
  if (s < 60) return s+'s ago';
  return Math.floor(s/60)+'m ago';
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function emptyHTML(icon, title, sub) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
}

setInterval(() => {
  devices.forEach(dev => {
    const el = document.getElementById('last-seen-'+dev.id);
    if (el && dev.lastSeen) el.textContent = 'seen '+ago(dev.lastSeen);
  });
}, 10000);

/* ── INIT ── */
(function init() {
  const mustSSL = IS_HTTPS;
  document.getElementById('b-host').value  = broker.host || (mustSSL ? 'broker.hivemq.com' : '');
  document.getElementById('b-port').value  = broker.port || (mustSSL ? 8884 : 9001);
  document.getElementById('b-user').value  = broker.user || '';
  document.getElementById('b-pass').value  = broker.pass || '';
  document.getElementById('b-ssl').checked = mustSSL || broker.ssl || false;
  if (mustSSL) {
    document.getElementById('b-ssl').disabled = true;
    document.getElementById('https-note').style.display = '';
  }

  // Show global HTTPS warning banner if needed
  const banner = document.getElementById('https-global-warn');
  if (banner && IS_HTTPS) banner.style.display = '';

  setConnUI(false);
  renderSidebar();

  // Connect WLED devices immediately (WebSocket, no broker needed)
  devices.filter(d => d.type === 'wled').forEach(wledConnect);

  if (!activeId && devices.length) activeId = devices[0].id;
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected',
    'Add a relay controller (needs MQTT broker) or a WLED device (direct WebSocket — HTTP only).');
})();
