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
    devices.forEach(d => d.status = 'offline');
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
      devices.forEach(d => { subscribeDevice(d); pingDevice(d.id); startPing(d); });
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
  devices.forEach(d => publishPresence(d, false));
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false;
  setConnUI(false);
  devices.forEach(d => d.status = 'offline');
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
    client.subscribe(dev.prefix + '/state');       // full JSON dump
    client.subscribe(dev.prefix + '/+/state');     // per-relay
    client.subscribe(dev.prefix + '/status');      // LWT
  } catch(e) { console.warn('Subscribe error', e); }
}

function unsubscribeDevice(dev) {
  if (!connected) return;
  try { client.unsubscribe(dev.prefix + '/state'); } catch {}
  try { client.unsubscribe(dev.prefix + '/+/state'); } catch {}
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
  const dev     = devices.find(d => topic.startsWith(d.prefix + '/'));
  if (!dev) return;

  const suffix = topic.slice(dev.prefix.length + 1);

  // Full JSON state
  if (suffix === 'state') {
    try {
      const data = JSON.parse(payload);
      if (Array.isArray(data.relays)) {
        dev.relays   = data.relays;
        dev.status   = 'online';
        dev.lastSeen = Date.now();
        renderSidebar();
        if (activeId === dev.id) renderDevice(dev.id);
      }
    } catch {}
    return;
  }

  // Device LWT
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

  // Per-relay  {id}/state
  const m = suffix.match(/^(\d+)\/state$/);
  if (m) {
    const id = parseInt(m[1]);
    if (!dev.relays) dev.relays = [];
    let r = dev.relays.find(r => r.id === id);
    if (!r) { r = { id, name:'Relay '+(id+1), state:false }; dev.relays.push(r); dev.relays.sort((a,b)=>a.id-b.id); }
    r.state      = payload.trim().toUpperCase() === 'ON';
    dev.status   = 'online';
    dev.lastSeen = Date.now();
    if (activeId === dev.id) updateCard(dev, r);
    renderSidebar();
    return;
  }
}

/* ── RELAY CONTROL ── */
function toggleRelay(devId, relayId, on) {
  const dev = getDevice(devId);
  if (!dev) return;
  publishJSON(dev.prefix + '/' + relayId + '/set', { state: on });
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.state = on; updateCard(dev, r); updateMeta(dev); }
}

function pulseRelay(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const ms = parseInt(document.getElementById('pm-'+devId+'-'+relayId).value) || 500;
  publishJSON(dev.prefix + '/' + relayId + '/set', { pulse: ms });
  toast('Pulse '+ms+'ms → '+dev.name+' R'+(relayId+1));
}

function timerRelay(devId, relayId) {
  const dev = getDevice(devId); if (!dev) return;
  const s = parseInt(document.getElementById('ts-'+devId+'-'+relayId).value) || 30;
  publishJSON(dev.prefix + '/' + relayId + '/set', { timer: s });
  toast('Timer '+s+'s → '+dev.name+' R'+(relayId+1));
}

function allOff(devId) {
  const dev = getDevice(devId); if (!dev) return;
  publish(dev.prefix + '/alloff', '1');
  dev.relays?.forEach(r => { r.state = false; updateCard(dev, r); });
  updateMeta(dev);
  toast('All OFF — '+dev.name, 'r');
}

function allOn(devId) {
  const dev = getDevice(devId); if (!dev) return;
  publish(dev.prefix + '/allon', '1');
  dev.relays?.forEach(r => { r.state = true; updateCard(dev, r); });
  updateMeta(dev);
  toast('All ON — '+dev.name);
}

function sendCmd(devId) {
  const dev = getDevice(devId); if (!dev) return;
  const raw = document.getElementById('cmd-'+devId).value.trim();
  if (!raw) return;
  try { JSON.parse(raw); } catch(e) { toast('Invalid JSON: '+e.message, 'r'); return; }
  publish(dev.prefix + '/cmd', raw);
  toast('Sent', 'g');
}

function pingDevice(id) {
  const dev = getDevice(id); if (!dev) return;
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
    el.innerHTML = `
      <div class="dev-left">
        <span class="dev-dot ${dev.status||'offline'}"></span>
        <span class="dev-name">${esc(dev.name)}</span>
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
        <div class="dev-title">${esc(dev.name)}<span class="sub">${esc(dev.prefix)}</span></div>
        <div class="dev-meta">
          <span class="pill ${online?'pill-g':'pill-r'}" id="pill-status-${dev.id}">${online?'ONLINE':'OFFLINE'}</span>
          <span class="pill pill-a" id="pill-count-${dev.id}">${relays.length} relays</span>
          <span class="pill ${active>0?'pill-a':'pill-d'}" id="pill-active-${dev.id}">${active} active</span>
          <span class="last-seen" id="last-seen-${dev.id}">${dev.lastSeen?'seen '+ago(dev.lastSeen):''}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
        <button class="btn btn-ghost btn-sm" onclick="pingDevice('${dev.id}');toast('Ping sent')">↻ Ping</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditDevice('${dev.id}')">✎ Edit</button>
        <button class="btn btn-red btn-sm" onclick="allOff('${dev.id}')">⬛ All Off</button>
        <button class="btn btn-amber btn-sm" onclick="allOn('${dev.id}')">■ All On</button>
      </div>
    </div>

    <div class="cmd-bar">
      <div class="cmd-row">
        <span class="cmd-lbl">JSON CMD</span>
        <input class="cmd-input" id="cmd-${dev.id}" placeholder='{"id":0,"state":true}  ·  {"id":"all","state":false}'
          onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
        <button class="btn btn-teal btn-sm" onclick="sendCmd('${dev.id}')">Send</button>
      </div>
      <div class="cmd-hints">
        Single: <code>{"id":0,"state":true}</code> ·
        All: <code>{"id":"all","state":false}</code> ·
        Pulse: <code>{"id":1,"pulse":500}</code> ·
        Timer: <code>{"id":2,"timer":30}</code> ·
        Array: <code>[{"id":0,"state":true},{"id":1,"pulse":500}]</code>
      </div>
    </div>

    <div class="relay-grid" id="grid-${dev.id}">
      ${relays.length ? relays.map(r => cardHTML(dev, r)).join('') : emptyHTML('🔌','No relay data yet','Make sure the device is online.<br>Click ↻ Ping to request state.')}
    </div>`;
}

function cardHTML(dev, r) {
  const did = dev.id, rid = r.id;
  return `
    <div class="rcard ${r.state?'on':''}" id="rcard-${did}-${rid}">
      <div class="rc-head">
        <div class="rc-left">
          <span class="rc-num">${String(rid+1).padStart(2,'0')}</span>
          <span class="rc-name">${esc(r.name||'Relay '+(rid+1))}</span>
        </div>
        <div class="rc-right">
          <span class="spill ${r.state?'on':'off'}" id="rsp-${did}-${rid}">${r.state?'ON':'OFF'}</span>
          <label class="itoggle">
            <input type="checkbox" ${r.state?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)">
            <div class="itrack"><div class="ithumb"></div></div>
          </label>
        </div>
      </div>
      <div class="rc-body">
        <div class="rc-actions">
          <div class="act-group">
            <input class="act-input" id="pm-${did}-${rid}" value="500" title="ms">
            <button class="act-btn" onclick="pulseRelay('${did}',${rid})">Pulse</button>
          </div>
          <div class="act-group">
            <input class="act-input" id="ts-${did}-${rid}" value="30" title="sec">
            <button class="act-btn" onclick="timerRelay('${did}',${rid})">Timer</button>
          </div>
          <span class="timer-badge ${r.timer>0?'v':''}" id="tbadge-${did}-${rid}">${r.timer>0?r.timer+'s':''}</span>
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

/* ── DEVICE MANAGEMENT ── */
function getDevice(id) { return devices.find(d => d.id === id); }

function openAddDevice() {
  document.getElementById('modal-title').textContent = 'Add Device';
  document.getElementById('dm-id').value     = '';
  document.getElementById('dm-name').value   = '';
  document.getElementById('dm-prefix').value = '';
  document.getElementById('dm-ping').value   = '10';
  document.getElementById('add-modal').classList.add('open');
  setTimeout(() => document.getElementById('dm-name').focus(), 100);
}

function openEditDevice(id) {
  const dev = getDevice(id); if (!dev) return;
  document.getElementById('modal-title').textContent = 'Edit Device';
  document.getElementById('dm-id').value     = dev.id;
  document.getElementById('dm-name').value   = dev.name;
  document.getElementById('dm-prefix').value = dev.prefix;
  document.getElementById('dm-ping').value   = dev.pingInterval || 10;
  document.getElementById('add-modal').classList.add('open');
}

function closeModal() { document.getElementById('add-modal').classList.remove('open'); }

function saveDevice() {
  const existingId = document.getElementById('dm-id').value;
  const name   = document.getElementById('dm-name').value.trim()   || 'Device';
  const prefix = document.getElementById('dm-prefix').value.trim().replace(/\/+$/,'') || 'home/relay';
  const ping   = parseInt(document.getElementById('dm-ping').value) || 10;

  if (existingId) {
    const dev = getDevice(existingId);
    if (dev) {
      unsubscribeDevice(dev);
      dev.name = name; dev.prefix = prefix; dev.pingInterval = ping;
      if (connected) { subscribeDevice(dev); }
      if (pingTimers[dev.id]) { clearInterval(pingTimers[dev.id]); if (connected) startPing(dev); }
    }
  } else {
    const dev = { id:'dev-'+Date.now(), name, prefix, pingInterval:ping, status:'offline', lastSeen:null, relays:[] };
    devices.push(dev);
    if (connected) { subscribeDevice(dev); publishPresence(dev, true); startPing(dev); }
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
  unsubscribeDevice(dev);
  publishPresence(dev, false);
  if (pingTimers[id]) { clearInterval(pingTimers[id]); delete pingTimers[id]; }
  devices = devices.filter(d => d.id !== id);
  if (activeId === id) activeId = devices[0]?.id || null;
  persist();
  renderSidebar();
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected','Add a device in the sidebar.');
}

/* ── HELPERS ── */
function persist() {
  save({ broker, devices: devices.map(({id,name,prefix,pingInterval}) => ({id,name,prefix,pingInterval})) });
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

  if (!activeId && devices.length) activeId = devices[0].id;
  if (activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML = emptyHTML('📡','No Device Selected','Connect to your MQTT broker,<br>then add a device using + Add Device.');
})();
