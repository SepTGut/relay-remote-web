/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD  (remote.js)
   MQTT over WebSocket (broker must expose WS port)
═══════════════════════════════════════════════════ */

// ── MQTT lib loaded from CDN in remote.html ──────────
// Uses Paho MQTT JS client

/* ══════════════════════════════════════════
   PERSISTENCE
══════════════════════════════════════════ */
const STORAGE_KEY = 'relayctrl_remote_cfg';

function loadStorage() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
let mqttClient = null;
let mqttConnected = false;
let pingTimers = {};          // deviceId → setInterval handle

// devices: [ { id, name, prefix, pingInterval, status, lastSeen, relays:[] } ]
let devices = [];
let activeDeviceId = null;

const stored = loadStorage();
const brokerCfg = stored.broker || { host: '', port: 9001, user: '', pass: '', useSSL: false };
devices = stored.devices || [];

/* ══════════════════════════════════════════
   CLOCK
══════════════════════════════════════════ */
function updateClock() {
  document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8);
}
setInterval(updateClock, 1000);
updateClock();

/* ══════════════════════════════════════════
   TOAST
══════════════════════════════════════════ */
let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 2500);
}

/* ══════════════════════════════════════════
   MQTT CONNECTION
══════════════════════════════════════════ */
function mqttConnect() {
  const host = document.getElementById('b-host').value.trim();
  const port = parseInt(document.getElementById('b-port').value) || 9001;
  const user = document.getElementById('b-user').value.trim();
  const pass = document.getElementById('b-pass').value;
  const ssl  = document.getElementById('b-ssl').checked;

  if (!host) { toast('Enter broker host', 'red'); return; }

  brokerCfg.host = host; brokerCfg.port = port;
  brokerCfg.user = user; brokerCfg.pass = pass;
  brokerCfg.useSSL = ssl;
  persistAll();

  if (mqttClient && mqttClient.isConnected()) mqttClient.disconnect();

  const clientId = 'relayctrl-remote-' + Math.random().toString(36).slice(2, 8);
  mqttClient = new Paho.Client(host, port, clientId);

  mqttClient.onConnectionLost = (res) => {
    mqttConnected = false;
    setConnUI(false);
    devices.forEach(d => d.status = 'offline');
    renderDeviceList();
    if (activeDeviceId) renderDevice(activeDeviceId);
    if (res.errorCode !== 0) toast('MQTT disconnected: ' + res.errorMessage, 'red');
    // stop pings
    Object.values(pingTimers).forEach(clearInterval);
    pingTimers = {};
  };

  mqttClient.onMessageArrived = onMessage;

  const opts = {
    useSSL: ssl,
    keepAliveInterval: 30,
    reconnect: true,
    onSuccess: onConnected,
    onFailure: (err) => { toast('MQTT connect failed: ' + err.errorMessage, 'red'); setConnUI(false); }
  };
  if (user) { opts.userName = user; opts.password = pass; }

  try { mqttClient.connect(opts); }
  catch (e) { toast('Connect error: ' + e.message, 'red'); }
}

function mqttDisconnect() {
  if (mqttClient && mqttClient.isConnected()) mqttClient.disconnect();
  Object.values(pingTimers).forEach(clearInterval);
  pingTimers = {};
  mqttConnected = false;
  setConnUI(false);
  devices.forEach(d => d.status = 'offline');
  renderDeviceList();
}

function onConnected() {
  mqttConnected = true;
  setConnUI(true);
  toast('MQTT connected', 'green');

  // Subscribe to all device state topics
  devices.forEach(d => subscribeDevice(d));
  // Ping all devices
  devices.forEach(d => {
    announcePresence(d, true);
    schedulePing(d);
  });
}

function subscribeDevice(dev) {
  if (!mqttConnected) return;
  const p = dev.prefix;
  mqttClient.subscribe(p + '/state');        // full JSON state dump
  mqttClient.subscribe(p + '/+/state');      // per-relay state
  mqttClient.subscribe(p + '/status');       // device LWT
}

function unsubscribeDevice(dev) {
  if (!mqttConnected) return;
  const p = dev.prefix;
  try { mqttClient.unsubscribe(p + '/state'); } catch {}
  try { mqttClient.unsubscribe(p + '/+/state'); } catch {}
  try { mqttClient.unsubscribe(p + '/status'); } catch {}
}

function announcePresence(dev, online) {
  publish(dev.prefix + '/presence', online ? 'online' : 'offline', false);
}

function schedulePing(dev) {
  if (pingTimers[dev.id]) clearInterval(pingTimers[dev.id]);
  const iv = (dev.pingInterval || 10) * 1000;
  // immediate ping
  publish(dev.prefix + '/ping', '1', false);
  pingTimers[dev.id] = setInterval(() => {
    if (!mqttConnected) return;
    publish(dev.prefix + '/ping', '1', false);
  }, iv);
}

/* ══════════════════════════════════════════
   INCOMING MESSAGES
══════════════════════════════════════════ */
function onMessage(msg) {
  const topic = msg.destinationName;
  const payload = msg.payloadString;

  // Match device by prefix
  const dev = devices.find(d => topic.startsWith(d.prefix + '/'));
  if (!dev) return;

  const suffix = topic.slice(dev.prefix.length + 1);

  // ── Full JSON state dump ─────────────────────────────
  if (suffix === 'state') {
    try {
      const data = JSON.parse(payload);
      if (Array.isArray(data.relays)) {
        dev.relays = data.relays;
        dev.status = 'online';
        dev.lastSeen = Date.now();
        renderDeviceList();
        if (activeDeviceId === dev.id) renderDevice(dev.id);
      }
    } catch {}
    return;
  }

  // ── Device LWT ──────────────────────────────────────
  if (suffix === 'status') {
    const wasOnline = dev.status === 'online';
    dev.status = payload.trim().toLowerCase() === 'online' ? 'online' : 'offline';
    if (dev.status === 'online' && !wasOnline) {
      // freshly online - request full state
      setTimeout(() => publish(dev.prefix + '/ping', '1', false), 500);
    }
    dev.lastSeen = Date.now();
    renderDeviceList();
    if (activeDeviceId === dev.id) renderDevice(dev.id);
    return;
  }

  // ── Per-relay state ──────────────────────────────────
  // {prefix}/{id}/state
  const m = suffix.match(/^(\d+)\/state$/);
  if (m) {
    const id = parseInt(m[1]);
    if (!dev.relays) dev.relays = [];
    let relay = dev.relays.find(r => r.id === id);
    if (!relay) { relay = { id, name: 'Relay ' + (id + 1), state: false }; dev.relays.push(relay); dev.relays.sort((a,b) => a.id - b.id); }
    relay.state = payload.trim().toUpperCase() === 'ON';
    dev.status = 'online';
    dev.lastSeen = Date.now();
    if (activeDeviceId === dev.id) updateRelayCard(dev, relay);
    renderDeviceList();
    return;
  }
}

/* ══════════════════════════════════════════
   PUBLISH HELPERS
══════════════════════════════════════════ */
function publish(topic, payload, retained = false) {
  if (!mqttConnected) { toast('Not connected to MQTT', 'red'); return false; }
  const msg = new Paho.Message(String(payload));
  msg.destinationName = topic;
  msg.retained = retained;
  msg.qos = 1;
  try { mqttClient.send(msg); return true; } catch (e) { toast('Publish failed', 'red'); return false; }
}

function publishJSON(topic, obj, retained = false) {
  return publish(topic, JSON.stringify(obj), retained);
}

/* ══════════════════════════════════════════
   RELAY CONTROL
══════════════════════════════════════════ */
function toggleRelay(dev, relayId, on) {
  // Use JSON payload
  publishJSON(dev.prefix + '/' + relayId + '/set', { state: on });
  // Optimistic update
  const r = dev.relays?.find(r => r.id === relayId);
  if (r) { r.state = on; updateRelayCard(dev, r); updateDeviceHeader(dev); }
}

function pulseRelay(dev, relayId, ms) {
  publishJSON(dev.prefix + '/' + relayId + '/set', { pulse: ms });
  toast('Pulse ' + ms + 'ms → ' + dev.name + ' R' + (relayId + 1));
}

function timerRelay(dev, relayId, sec) {
  publishJSON(dev.prefix + '/' + relayId + '/set', { timer: sec });
  toast('Timer ' + sec + 's → ' + dev.name + ' R' + (relayId + 1));
}

function allOff(dev) {
  publish(dev.prefix + '/alloff', '1');
  if (dev.relays) dev.relays.forEach(r => { r.state = false; updateRelayCard(dev, r); });
  updateDeviceHeader(dev);
  toast('All OFF — ' + dev.name, 'red');
}

function allOn(dev) {
  publish(dev.prefix + '/allon', '1');
  if (dev.relays) dev.relays.forEach(r => { r.state = true; updateRelayCard(dev, r); });
  updateDeviceHeader(dev);
  toast('All ON — ' + dev.name, 'amber');
}

/* ── Global JSON/CMD publish ── */
function sendCmd(dev, jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    publish(dev.prefix + '/cmd', JSON.stringify(obj), false);
    toast('CMD sent', 'green');
  } catch (e) { toast('Invalid JSON: ' + e.message, 'red'); }
}

/* ══════════════════════════════════════════
   UI — CONN STATUS
══════════════════════════════════════════ */
function setConnUI(connected) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  const btnC  = document.getElementById('btn-connect');
  const btnD  = document.getElementById('btn-disconnect');
  const tbS   = document.getElementById('tb-status');
  dot.className   = 'conn-dot' + (connected ? ' online' : '');
  label.textContent = connected ? 'online' : 'offline';
  tbS.textContent   = connected ? 'CONNECTED' : 'DISCONNECTED';
  tbS.className     = 'tb-val ' + (connected ? 'green' : 'red');
  btnC.style.display = connected ? 'none' : '';
  btnD.style.display = connected ? '' : 'none';
}

/* ══════════════════════════════════════════
   UI — DEVICE LIST (SIDEBAR)
══════════════════════════════════════════ */
function renderDeviceList() {
  const list = document.getElementById('device-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div style="padding:14px 16px;font-size:10px;color:var(--dim)">No devices added yet.</div>';
  }
  devices.forEach(dev => {
    const item = document.createElement('div');
    item.className = 'device-item' + (dev.id === activeDeviceId ? ' active' : '');
    item.innerHTML = `
      <div class="device-item-left">
        <span class="device-dot ${dev.status || 'offline'}"></span>
        <span class="device-name">${dev.name}</span>
      </div>
      <button class="device-remove" onclick="removeDevice('${dev.id}',event)" title="Remove">✕</button>`;
    item.onclick = (e) => { if (e.target.closest('.device-remove')) return; selectDevice(dev.id); };
    list.appendChild(item);
  });
  // topbar device count
  const el = document.getElementById('tb-devices');
  if (el) el.textContent = devices.length;
}

function selectDevice(id) {
  activeDeviceId = id;
  renderDeviceList();
  renderDevice(id);
}

/* ══════════════════════════════════════════
   UI — DEVICE MAIN VIEW
══════════════════════════════════════════ */
function renderDevice(id) {
  const main = document.getElementById('main');
  const dev = devices.find(d => d.id === id);
  if (!dev) { main.innerHTML = noDeviceHTML(); return; }

  const relays = dev.relays || [];
  const online = dev.status === 'online';
  const activeCount = relays.filter(r => r.state).length;

  main.innerHTML = `
    <div class="device-view-header">
      <div>
        <div class="device-view-title">${dev.name} <span class="sub">${dev.prefix}</span></div>
        <div class="device-meta" style="margin-top:6px">
          <span class="pill ${online ? 'pill-green' : 'pill-red'}">${online ? 'ONLINE' : 'OFFLINE'}</span>
          <span class="pill pill-amber">${relays.length} relays</span>
          <span class="pill ${activeCount > 0 ? 'pill-amber' : 'pill-dim'}">${activeCount} active</span>
          ${dev.lastSeen ? `<span class="last-seen">seen ${fmtAgo(dev.lastSeen)}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="pingDevice('${dev.id}')">↻ Ping</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditDevice('${dev.id}')">✎ Edit</button>
        <button class="btn btn-red btn-sm" onclick="allOff(getDevice('${dev.id}'))">⬛ All Off</button>
        <button class="btn btn-amber btn-sm" onclick="allOn(getDevice('${dev.id}'))">⬛ All On</button>
      </div>
    </div>

    <!-- Global CMD bar -->
    <div class="cmd-bar">
      <span class="cmd-bar-label">CMD</span>
      <input class="cmd-input" id="cmd-input" placeholder='{"id":0,"state":true}  or  {"id":"all","state":false}' onkeydown="if(event.key==='Enter')sendCmdActive()">
      <button class="btn btn-teal btn-sm" onclick="sendCmdActive()">Send JSON</button>
      <div class="cmd-hint">
        Single: <code>{"id":0,"state":true}</code> ·
        All: <code>{"id":"all","state":false}</code> ·
        Pulse: <code>{"id":2,"pulse":500}</code> ·
        Array: <code>[{"id":0,"state":true},{"id":1,"timer":30}]</code>
      </div>
    </div>

    <!-- Relay grid -->
    <div class="relay-grid" id="relay-grid-${dev.id}">
      ${relays.length ? relays.map(r => relayCardHTML(dev, r)).join('') : emptyRelaysHTML()}
    </div>
  `;
}

function updateDeviceHeader(dev) {
  // lightweight refresh of just the pills
  if (activeDeviceId !== dev.id) return;
  const relays = dev.relays || [];
  const activeCount = relays.filter(r => r.state).length;
  const pills = document.querySelectorAll('.device-meta .pill');
  if (pills[1]) pills[1].textContent = relays.length + ' relays';
  if (pills[2]) { pills[2].textContent = activeCount + ' active'; pills[2].className = 'pill ' + (activeCount > 0 ? 'pill-amber' : 'pill-dim'); }
}

function relayCardHTML(dev, r) {
  return `
    <div class="relay-card ${r.state ? 'on' : ''}" id="rcard-${dev.id}-${r.id}">
      <div class="rc-head">
        <div class="rc-left">
          <span class="rc-num">${String(r.id + 1).padStart(2, '0')}</span>
          <span class="rc-name">${r.name || 'Relay ' + (r.id + 1)}</span>
        </div>
        <div class="rc-right">
          <span class="state-pill ${r.state ? 'on' : 'off'}" id="rsp-${dev.id}-${r.id}">${r.state ? 'ON' : 'OFF'}</span>
          <label class="ind-toggle">
            <input type="checkbox" ${r.state ? 'checked' : ''} onchange="toggleRelay(getDevice('${dev.id}'),${r.id},this.checked)">
            <div class="ind-track"><div class="ind-thumb"></div></div>
          </label>
        </div>
      </div>
      <div class="rc-body">
        <div class="rc-actions">
          <div class="act-group">
            <input class="act-num-input" id="pm-${dev.id}-${r.id}" value="500" title="ms">
            <button class="act-exec" onclick="pulseRelay(getDevice('${dev.id}'),${r.id},parseInt(document.getElementById('pm-${dev.id}-${r.id}').value)||500)">Pulse</button>
          </div>
          <div class="act-group">
            <input class="act-num-input" id="ts-${dev.id}-${r.id}" value="30" title="sec">
            <button class="act-exec" onclick="timerRelay(getDevice('${dev.id}'),${r.id},parseInt(document.getElementById('ts-${dev.id}-${r.id}').value)||30)">Timer</button>
          </div>
          <span class="timer-badge${r.timer > 0 ? ' visible' : ''}" id="tbadge-${dev.id}-${r.id}">${r.timer > 0 ? r.timer + 's' : ''}</span>
        </div>
      </div>
    </div>`;
}

function updateRelayCard(dev, r) {
  const card = document.getElementById(`rcard-${dev.id}-${r.id}`);
  if (!card) return;
  card.className = 'relay-card' + (r.state ? ' on' : '');
  const cb = card.querySelector('input[type=checkbox]');
  if (cb) cb.checked = r.state;
  const sp = document.getElementById(`rsp-${dev.id}-${r.id}`);
  if (sp) { sp.textContent = r.state ? 'ON' : 'OFF'; sp.className = 'state-pill ' + (r.state ? 'on' : 'off'); }
}

function emptyRelaysHTML() {
  return `<div class="empty-state" style="padding:40px 20px">
    <div class="empty-icon">🔌</div>
    <div class="empty-title">No relay data yet</div>
    <div class="empty-sub">Make sure the device is online and MQTT is configured.<br>Click ↻ Ping to request current state.</div>
  </div>`;
}

function noDeviceHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">📡</div>
    <div class="empty-title">No Device Selected</div>
    <div class="empty-sub">Add a device in the sidebar and connect to your MQTT broker.<br>Each device needs a topic prefix matching its firmware config.</div>
  </div>`;
}

/* ══════════════════════════════════════════
   DEVICE MANAGEMENT
══════════════════════════════════════════ */
function getDevice(id) { return devices.find(d => d.id === id); }

function openAddDevice() {
  document.getElementById('add-modal-title').textContent = 'Add Device';
  document.getElementById('dm-id').value = '';
  document.getElementById('dm-name').value = '';
  document.getElementById('dm-prefix').value = '';
  document.getElementById('dm-ping').value = '10';
  document.getElementById('add-modal').classList.add('open');
  document.getElementById('dm-name').focus();
}

function openEditDevice(id) {
  const dev = getDevice(id);
  if (!dev) return;
  document.getElementById('add-modal-title').textContent = 'Edit Device';
  document.getElementById('dm-id').value = dev.id;
  document.getElementById('dm-name').value = dev.name;
  document.getElementById('dm-prefix').value = dev.prefix;
  document.getElementById('dm-ping').value = dev.pingInterval || 10;
  document.getElementById('add-modal').classList.add('open');
}

function closeAddModal() { document.getElementById('add-modal').classList.remove('open'); }

function saveDevice() {
  const existingId = document.getElementById('dm-id').value;
  const name   = document.getElementById('dm-name').value.trim() || 'Device';
  const prefix = document.getElementById('dm-prefix').value.trim().replace(/\/+$/, '') || 'home/relay';
  const ping   = parseInt(document.getElementById('dm-ping').value) || 10;

  if (existingId) {
    // Edit
    const dev = getDevice(existingId);
    if (dev) {
      unsubscribeDevice(dev);
      dev.name = name; dev.prefix = prefix; dev.pingInterval = ping;
      subscribeDevice(dev);
      if (pingTimers[dev.id]) { clearInterval(pingTimers[dev.id]); schedulePing(dev); }
    }
  } else {
    // Add
    const dev = {
      id: 'dev-' + Date.now(),
      name, prefix, pingInterval: ping,
      status: 'offline', lastSeen: null, relays: []
    };
    devices.push(dev);
    subscribeDevice(dev);
    if (mqttConnected) { announcePresence(dev, true); schedulePing(dev); }
    selectDevice(dev.id);
  }

  persistAll();
  renderDeviceList();
  closeAddModal();
  toast('Device saved', 'green');
}

function removeDevice(id, event) {
  if (event) event.stopPropagation();
  const dev = getDevice(id);
  if (!dev) return;
  if (!confirm(`Remove "${dev.name}"?`)) return;
  unsubscribeDevice(dev);
  announcePresence(dev, false);
  if (pingTimers[id]) { clearInterval(pingTimers[id]); delete pingTimers[id]; }
  devices = devices.filter(d => d.id !== id);
  if (activeDeviceId === id) {
    activeDeviceId = devices[0]?.id || null;
  }
  persistAll();
  renderDeviceList();
  if (activeDeviceId) renderDevice(activeDeviceId);
  else document.getElementById('main').innerHTML = noDeviceHTML();
}

function pingDevice(id) {
  const dev = getDevice(id);
  if (!dev) return;
  publish(dev.prefix + '/ping', '1', false);
  toast('Ping sent → ' + dev.name);
}

/* ══════════════════════════════════════════
   ACTIVE DEVICE SHORTCUTS
══════════════════════════════════════════ */
function sendCmdActive() {
  const dev = getDevice(activeDeviceId);
  if (!dev) { toast('No device selected', 'red'); return; }
  const input = document.getElementById('cmd-input');
  sendCmd(dev, input.value);
}

/* ══════════════════════════════════════════
   PERSISTENCE
══════════════════════════════════════════ */
function persistAll() {
  saveStorage({
    broker: brokerCfg,
    devices: devices.map(d => ({
      id: d.id, name: d.name, prefix: d.prefix,
      pingInterval: d.pingInterval
    }))
  });
}

/* ══════════════════════════════════════════
   UTILS
══════════════════════════════════════════ */
function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return s + 's ago';
  return Math.floor(s / 60) + 'm ago';
}

setInterval(() => {
  if (activeDeviceId) {
    const el = document.querySelector('.last-seen');
    const dev = getDevice(activeDeviceId);
    if (el && dev?.lastSeen) el.textContent = 'seen ' + fmtAgo(dev.lastSeen);
  }
}, 5000);

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
(function init() {
  // Restore broker fields
  document.getElementById('b-host').value  = brokerCfg.host || '';
  document.getElementById('b-port').value  = brokerCfg.port || 9001;
  document.getElementById('b-user').value  = brokerCfg.user || '';
  document.getElementById('b-pass').value  = brokerCfg.pass || '';
  document.getElementById('b-ssl').checked = brokerCfg.useSSL || false;

  renderDeviceList();
  setConnUI(false);

  if (activeDeviceId === null && devices.length > 0) activeDeviceId = devices[0].id;
  if (activeDeviceId) renderDevice(activeDeviceId);
  else document.getElementById('main').innerHTML = noDeviceHTML();

  // Auto-connect if broker was saved
  if (brokerCfg.host) {
    setTimeout(mqttConnect, 300);
  }
})();
