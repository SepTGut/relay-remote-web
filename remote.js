/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD  (remote.js)
   MQTT: Paho 1.1.0 over WSS  |  WLED: MQTT or direct WebSocket
═══════════════════════════════════════════════════ */

/* ── STORAGE ── */
const SK = 'relayctrl_v2';
function load() { try { return JSON.parse(localStorage.getItem(SK) || '{}'); } catch { return {}; } }
function save(d) { localStorage.setItem(SK, JSON.stringify(d)); }

/* ── STATE ── */
let client     = null;
let connected  = false;
let pingTimers = {};
let devices    = [];
let activeId   = null;
const wledSockets = {};   // devId → WebSocket  (wled-ws type only)
const wledPollers = {};   // devId → setInterval (wled-ws type only)

const stored = load();
const broker = stored.broker || { host:'broker.hivemq.com', port:8884, user:'', pass:'', ssl:true };
devices = (stored.devices || []).map(d => ({ ...d, status:'offline', relays:[] }));

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
   TYPE HELPERS
══════════════════════════════════════════ */
function isWled(dev)   { return dev?.type === 'wled' || dev?.type === 'wled-ws'; }
function isWledWS(dev) { return dev?.type === 'wled-ws'; }
function isWledMQ(dev) { return dev?.type === 'wled'; }
function isMqttBased(dev) { return dev?.type === 'mqtt' || dev?.type === 'wled'; }

/* ══════════════════════════════════════════
   MQTT CONNECTION
══════════════════════════════════════════ */
function mqttConnect() {
  if (typeof Paho === 'undefined') {
    showError('Paho MQTT library not loaded. Check internet and reload.');
    return;
  }
  const host = document.getElementById('b-host').value.trim();
  const port = parseInt(document.getElementById('b-port').value) || 8884;
  const user = document.getElementById('b-user').value.trim();
  const pass = document.getElementById('b-pass').value;
  const ssl  = location.protocol === 'https:' ? true : document.getElementById('b-ssl').checked;
  if (!host) { toast('Enter broker host', 'r'); return; }
  clearError();
  broker.host = host; broker.port = port; broker.user = user; broker.pass = pass; broker.ssl = ssl;
  persist();
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false;
  const clientId = 'relayctrl-' + Math.random().toString(36).slice(2, 9);
  const PahoClient = (Paho.MQTT?.Client) ? Paho.MQTT.Client : Paho.Client;
  client = new PahoClient(host, port, clientId);

  client.onConnectionLost = function(resp) {
    connected = false;
    setConnUI(false);
    devices.filter(isMqttBased).forEach(d => d.status = 'offline');
    renderSidebar();
    if (activeId) renderDevice(activeId);
    Object.values(pingTimers).forEach(clearInterval);
    pingTimers = {};
    if (resp.errorCode !== 0) { toast('Disconnected: '+resp.errorMessage,'r'); showError('Lost connection: '+resp.errorMessage); }
  };
  client.onMessageArrived = onMessage;

  const opts = {
    useSSL: ssl,
    keepAliveInterval: 30,
    onSuccess() {
      connected = true; clearError(); setConnUI(true);
      toast('Connected to '+host,'g');
      devices.filter(isMqttBased).forEach(d => { subscribeDevice(d); publishPresence(d, true); startPing(d); });
    },
    onFailure(err) {
      connected = false; setConnUI(false);
      const msg = err.errorMessage || ('Code '+err.errorCode);
      toast('Connect failed: '+msg,'r');
      showError('Failed: '+msg+'\nCheck host/port and that broker has WebSocket (WSS) enabled.');
    }
  };
  if (user) { opts.userName = user; opts.password = pass; }
  try { client.connect(opts); } catch(e) { toast('Error: '+e.message,'r'); showError(e.message); }
}

function mqttDisconnect() {
  Object.values(pingTimers).forEach(clearInterval); pingTimers = {};
  devices.filter(isMqttBased).forEach(d => publishPresence(d, false));
  if (client) { try { client.disconnect(); } catch {} client = null; }
  connected = false; setConnUI(false);
  devices.filter(isMqttBased).forEach(d => d.status = 'offline');
  renderSidebar(); if (activeId) renderDevice(activeId);
}

function publish(topic, payload, retained=false) {
  if (!connected || !client) { toast('Not connected to broker','r'); return false; }
  try {
    const PahoMsg = (Paho.MQTT?.Message) ? Paho.MQTT.Message : Paho.Message;
    const msg = new PahoMsg(String(payload));
    msg.destinationName = topic; msg.retained = retained; msg.qos = 1;
    client.send(msg); return true;
  } catch(e) { toast('Publish error: '+e.message,'r'); return false; }
}
function publishJSON(topic, obj, retained=false) { return publish(topic, JSON.stringify(obj), retained); }

/* ── MQTT SUBSCRIPTIONS ── */
function subscribeDevice(dev) {
  if (!connected || !isMqttBased(dev)) return;
  try {
    client.subscribe(dev.prefix+'/v');
    client.subscribe(dev.prefix+'/relay/+/v');
    client.subscribe(dev.prefix+'/status');
    client.subscribe(dev.prefix+'/g');    // WLED brightness
    client.subscribe(dev.prefix+'/c');    // WLED color
    client.subscribe(dev.prefix+'/sensor/+/v');
  } catch(e) { console.warn('Subscribe error',e); }
}
function unsubscribeDevice(dev) {
  if (!connected || !isMqttBased(dev)) return;
  ['/v','/relay/+/v','/status','/g','/c','/sensor/+/v'].forEach(s => {
    try { client.unsubscribe(dev.prefix+s); } catch {}
  });
}
function publishPresence(dev, online) {
  if (!connected || !isMqttBased(dev)) return;
  publish(dev.prefix+'/presence', online?'online':'offline', false);
}
function startPing(dev) {
  if (!isMqttBased(dev)) return;
  if (pingTimers[dev.id]) clearInterval(pingTimers[dev.id]);
  const iv = (dev.pingInterval||10)*1000;
  pingTimers[dev.id] = setInterval(() => {
    if (!connected) return;
    isWledMQ(dev) ? publishJSON(dev.prefix+'/api',{v:true}) : publish(dev.prefix+'/ping','1',false);
  }, iv);
}

/* ── MQTT INCOMING ── */
function onMessage(msg) {
  const topic = msg.destinationName, payload = msg.payloadString;
  const dev = devices.find(d => isMqttBased(d) && (topic.startsWith(d.prefix+'/') || topic===d.prefix));
  if (!dev) return;
  const suffix = topic.slice(dev.prefix.length+1);

  if (suffix==='v') {
    try {
      const data = JSON.parse(payload);
      if (Array.isArray(data.relays)) {
        dev.relays = data.relays.map(r=>({...r,state:r.on}));
        dev.status='online'; dev.lastSeen=Date.now();
        renderSidebar(); if (activeId===dev.id) renderDevice(dev.id);
      } else if (data.state||data.seg) {
        wledHandleState(dev,data);
      }
    } catch(e){console.warn('/v parse error',e);}
    return;
  }
  if (suffix==='g') {
    const bri=parseInt(payload)||0;
    if (!dev.wledState) dev.wledState={on:false,bri:0};
    dev.wledState.bri=bri; dev.wledState.on=bri>0;
    dev.status='online'; dev.lastSeen=Date.now(); renderSidebar();
    if (activeId===dev.id) { const sl=document.getElementById('bri-master-'+dev.id); if(sl)sl.value=bri; const vl=document.getElementById('bri-val-'+dev.id); if(vl)vl.textContent=bri; }
    return;
  }
  if (suffix==='c') {
    if (!dev.wledState) dev.wledState={on:false,bri:0};
    dev.wledState.color=payload.trim();
    if (activeId===dev.id) { const sw=document.getElementById('master-color-'+dev.id); if(sw)sw.style.background=dev.wledState.color; }
    return;
  }
  if (suffix==='status') {
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline'; dev.lastSeen=Date.now();
    if (dev.status==='online'&&!was) setTimeout(()=>publish(dev.prefix+'/ping','1',false),400);
    renderSidebar(); if (activeId===dev.id) renderDevice(dev.id);
    return;
  }
  const rm=suffix.match(/^relay\/(\d+)\/v$/);
  if (rm) {
    const id=parseInt(rm[1]);
    if (!dev.relays) dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if (!r){r={id,name:'Relay '+(id+1),on:false,state:false};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);}
    r.on=payload.trim().toLowerCase()==='on'; r.state=r.on;
    dev.status='online'; dev.lastSeen=Date.now();
    if (activeId===dev.id) updateCard(dev,r); renderSidebar();
    return;
  }
  const sm=suffix.match(/^sensor\/(\d+)\/v$/);
  if (sm) {
    const id=parseInt(sm[1]);
    if (!dev.sensors) dev.sensors=[];
    let s=dev.sensors.find(s=>s.id===id);
    if (!s){s={id,name:'Sensor '+(id+1),state:false};dev.sensors.push(s);}
    s.state=payload.trim().toLowerCase()==='on'||payload.trim().toLowerCase()==='active';
    dev.lastSeen=Date.now();
    if (activeId===dev.id){const dot=document.getElementById('sensor-dot-'+dev.id+'-'+id);if(dot)dot.className='sensor-dot '+(s.state?'active':'');}
    return;
  }
}

/* ══════════════════════════════════════════
   WLED — DIRECT WEBSOCKET  (wled-ws type)
   Same mixed-content rule as fetch() — browser
   asks once, then ws:// works from HTTPS pages.
══════════════════════════════════════════ */
function wledConnect(dev) {
  if (!isWledWS(dev)) return;
  if (wledSockets[dev.id]) { try { wledSockets[dev.id].onclose=null; wledSockets[dev.id].close(); } catch {} }
  const proto = location.protocol==='https:' ? 'wss' : 'ws';
  const url = `${proto}://${dev.host}/ws`;
  let ws;
  try { ws = new WebSocket(url); } catch(e) { toast('WS error: '+e.message,'r'); dev.status='offline'; renderSidebar(); return; }
  wledSockets[dev.id] = ws;

  ws.onopen = () => {
    dev.status='online'; dev.lastSeen=Date.now();
    renderSidebar(); if (activeId===dev.id) renderDevice(dev.id);
    ws.send(JSON.stringify({v:true}));  // request full state
    toast('WS connected → '+dev.name,'g');
    // Fetch effects list via HTTP (one-time)
    if (!dev.wledEffects) {
      const p = location.protocol==='https:'?'https':'http';
      fetch(`${p}://${dev.host}/json/eff`)
        .then(r=>r.json()).then(arr=>{if(Array.isArray(arr)){dev.wledEffects=arr;if(activeId===dev.id)renderDevice(dev.id);}})
        .catch(()=>{});
    }
    if ((dev.pollInterval||0)>0) {
      wledPollers[dev.id]=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({v:true}));},dev.pollInterval*1000);
    }
  };
  ws.onmessage = evt => {
    try { wledHandleState(dev, JSON.parse(evt.data)); } catch(e){console.warn('[WLED WS] parse',e);}
  };
  ws.onclose = () => {
    dev.status='offline'; renderSidebar(); if (activeId===dev.id) renderDevice(dev.id);
    setTimeout(()=>{ if(devices.find(d=>d.id===dev.id)) wledConnect(dev); },5000);
  };
  ws.onerror = () => { dev.status='offline'; renderSidebar(); };
}

function wledDisconnect(dev) {
  if (wledPollers[dev.id]) { clearInterval(wledPollers[dev.id]); delete wledPollers[dev.id]; }
  if (wledSockets[dev.id]) {
    const ws=wledSockets[dev.id]; ws.onclose=null;
    try { ws.close(); } catch {} delete wledSockets[dev.id];
  }
  dev.status='offline';
}

/* ── WLED SEND: routes to WS or MQTT ── */
function wledSend(dev, payload) {
  if (isWledWS(dev)) {
    const ws=wledSockets[dev.id];
    if (!ws||ws.readyState!==WebSocket.OPEN) { toast('WLED WS not connected','r'); return false; }
    ws.send(JSON.stringify(payload)); return true;
  }
  return publishJSON(dev.prefix+'/api', payload);
}

/* ── WLED STATE HANDLER (shared by WS + MQTT) ── */
function wledHandleState(dev, data) {
  const state=data.state||data; if(!state) return;
  dev.lastSeen=Date.now(); dev.status='online';
  dev.wledState={on:state.on, bri:state.bri??128, transition:state.transition??7};
  if (Array.isArray(state.seg)) {
    dev.relays=state.seg.filter(s=>s&&typeof s.id==='number').map(s=>({
      id:s.id, name:s.n||('Seg '+s.id), on:!!s.on, state:!!s.on,
      bri:s.bri??(s.on?255:0), timer:s.timer||0, fx:s.fx??0, sx:s.sx??128, col:s.col
    }));
  }
  if (data.info) {
    dev.wledInfo={ver:data.info.ver,name:data.info.name,brand:data.info.brand,leds:data.info.leds};
    dev.isRelayCtrl=(data.info.brand==='WLED-Relay');
  }
  if (Array.isArray(data.effects)) dev.wledEffects=data.effects;
  renderSidebar(); if (activeId===dev.id) renderDevice(dev.id);
}

/* ── WLED CONTROLS ── */
function wledMasterToggle(devId, on) {
  const dev=getDevice(devId); if(!dev) return;
  if (!dev.wledState) dev.wledState={on:false,bri:128};
  dev.wledState.on=on;
  isWledWS(dev) ? wledSend(dev,{on}) : publish(dev.prefix, on?'ON':'OFF');
  if (activeId===dev.id) renderDevice(dev.id);
}
function wledBriCommit(devId,val) {
  const dev=getDevice(devId); if(!dev) return;
  const bri=parseInt(val); if(!dev.wledState)dev.wledState={on:false,bri:128};
  dev.wledState.bri=bri; wledSend(dev,{bri});
}
function wledFxChange(devId,fx)   { const dev=getDevice(devId);if(!dev)return; wledSend(dev,{seg:[{id:0,fx:parseInt(fx)}]}); }
function wledSpeedChange(devId,sx){ const dev=getDevice(devId);if(!dev)return; wledSend(dev,{seg:[{id:0,sx:parseInt(sx)}]}); }
function wledSegBri(devId,segId,val) {
  const dev=getDevice(devId);if(!dev)return;
  const bri=parseInt(val); const r=dev.relays?.find(r=>r.id===segId); if(r)r.bri=bri;
  wledSend(dev,{seg:[{id:segId,bri}]});
}
function toggleRelayWled(devId,relayId,on) {
  const dev=getDevice(devId);if(!dev)return;
  wledSend(dev,{seg:[{id:relayId,on}]});
  const r=dev.relays?.find(r=>r.id===relayId);
  if(r){r.on=on;r.state=on;updateCard(dev,r);updateMeta(dev);}
}
function pulseRelayWled(devId,relayId) {
  const dev=getDevice(devId);if(!dev)return;
  const ms=parseInt(document.getElementById('pm-'+devId+'-'+relayId).value)||500;
  wledSend(dev,{seg:[{id:relayId,on:true}]});
  setTimeout(()=>wledSend(dev,{seg:[{id:relayId,on:false}]}),ms);
  toast('Pulse '+ms+'ms → '+dev.name+' S'+relayId);
}
function timerRelayWled(devId,relayId) {
  const dev=getDevice(devId);if(!dev)return;
  const s=parseInt(document.getElementById('ts-'+devId+'-'+relayId).value)||30;
  wledSend(dev,{seg:[{id:relayId,on:true}]});
  setTimeout(()=>wledSend(dev,{seg:[{id:relayId,on:false}]}),s*1000);
  toast('Timer '+s+'s → '+dev.name+' S'+relayId);
}
function allOffWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  wledSend(dev,{on:false}); if(dev.wledState)dev.wledState.on=false;
  dev.relays?.forEach(r=>{r.on=false;r.state=false;updateCard(dev,r);}); updateMeta(dev);
  toast('All OFF — '+dev.name,'r');
}
function allOnWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  wledSend(dev,{on:true}); if(dev.wledState)dev.wledState.on=true;
  dev.relays?.forEach(r=>{r.on=true;r.state=true;updateCard(dev,r);}); updateMeta(dev);
  toast('All ON — '+dev.name);
}
function sendCmdWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  const raw=document.getElementById('cmd-'+devId).value.trim(); if(!raw)return;
  try{const obj=JSON.parse(raw);wledSend(dev,obj);toast('Sent','g');}
  catch(e){toast('Invalid JSON: '+e.message,'r');}
}

/* ══════════════════════════════════════════
   RELAY CONTROL (routes per device type)
══════════════════════════════════════════ */
function toggleRelay(devId,relayId,on) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){toggleRelayWled(devId,relayId,on);return;}
  publishJSON(dev.prefix+'/relay/'+relayId+'/api',{on});
  const r=dev.relays?.find(r=>r.id===relayId);
  if(r){r.on=on;r.state=on;updateCard(dev,r);updateMeta(dev);}
}
function pulseRelay(devId,relayId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){pulseRelayWled(devId,relayId);return;}
  const ms=parseInt(document.getElementById('pm-'+devId+'-'+relayId).value)||500;
  publishJSON(dev.prefix+'/relay/'+relayId+'/api',{pulse:ms});
  toast('Pulse '+ms+'ms → '+dev.name+' R'+(relayId+1));
}
function timerRelay(devId,relayId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){timerRelayWled(devId,relayId);return;}
  const s=parseInt(document.getElementById('ts-'+devId+'-'+relayId).value)||30;
  publishJSON(dev.prefix+'/relay/'+relayId+'/api',{timer:s});
  toast('Timer '+s+'s → '+dev.name+' R'+(relayId+1));
}
function allOff(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){allOffWled(devId);return;}
  publishJSON(dev.prefix+'/api',{on:false});
  dev.relays?.forEach(r=>{r.on=false;r.state=false;updateCard(dev,r);});updateMeta(dev);
  toast('All OFF — '+dev.name,'r');
}
function allOn(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){allOnWled(devId);return;}
  publishJSON(dev.prefix+'/api',{on:true});
  dev.relays?.forEach(r=>{r.on=true;r.state=true;updateCard(dev,r);});updateMeta(dev);
  toast('All ON — '+dev.name);
}
function sendCmd(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){sendCmdWled(devId);return;}
  const raw=document.getElementById('cmd-'+devId).value.trim();if(!raw)return;
  try{JSON.parse(raw);}catch(e){toast('Invalid JSON: '+e.message,'r');return;}
  publish(dev.prefix+'/api',raw); toast('Sent','g');
}
function pingDevice(id) {
  const dev=getDevice(id);if(!dev)return;
  if(isWledWS(dev)){const ws=wledSockets[dev.id];if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({v:true}));return;}
  if(isWledMQ(dev)){publishJSON(dev.prefix+'/api',{v:true});return;}
  publish(dev.prefix+'/ping','1',false);
}

/* ══════════════════════════════════════════
   MODAL
══════════════════════════════════════════ */
function onDevTypeChange() {
  const type=document.getElementById('dm-type').value;
  const mqttFields=document.getElementById('dm-mqtt-fields');
  const wsFields=document.getElementById('dm-ws-fields');
  const wledNote=document.getElementById('dm-wled-note');
  mqttFields.style.display = (type==='mqtt'||type==='wled') ? '' : 'none';
  wsFields.style.display   = type==='wled-ws' ? '' : 'none';
  wledNote.style.display   = (type==='wled'||type==='wled-ws') ? '' : 'none';
  if (wledNote.style.display!=='none') {
    wledNote.querySelector('.note-mqtt').style.display = type==='wled' ? '' : 'none';
    wledNote.querySelector('.note-ws').style.display   = type==='wled-ws' ? '' : 'none';
  }
  const ph=document.getElementById('dm-prefix');
  const hint=document.getElementById('dm-prefix-hint');
  if (type==='wled') { if(ph&&!ph.value)ph.placeholder='wled/strip1'; if(hint)hint.textContent='Match the MQTT Topic in WLED → Settings → Sync Interfaces → MQTT.'; }
  else { if(ph&&!ph.value)ph.placeholder='home/relay'; if(hint)hint.textContent='Match the prefix in ESP32 firmware config.'; }
}

/* ── DEVICE MANAGEMENT ── */
function getDevice(id) { return devices.find(d=>d.id===id); }

function openAddDevice() {
  document.getElementById('modal-title').textContent='Add Device';
  document.getElementById('dm-id').value='';
  document.getElementById('dm-name').value='';
  document.getElementById('dm-type').value='mqtt';
  document.getElementById('dm-prefix').value='';
  document.getElementById('dm-ping').value='10';
  document.getElementById('dm-host').value='';
  document.getElementById('dm-poll').value='0';
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
  setTimeout(()=>document.getElementById('dm-name').focus(),100);
}
function openEditDevice(id) {
  const dev=getDevice(id);if(!dev)return;
  document.getElementById('modal-title').textContent='Edit Device';
  document.getElementById('dm-id').value=dev.id;
  document.getElementById('dm-name').value=dev.name;
  document.getElementById('dm-type').value=dev.type||'mqtt';
  document.getElementById('dm-prefix').value=dev.prefix||'';
  document.getElementById('dm-ping').value=dev.pingInterval||10;
  document.getElementById('dm-host').value=dev.host||'';
  document.getElementById('dm-poll').value=dev.pollInterval||0;
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
}
function closeModal() { document.getElementById('add-modal').classList.remove('open'); }

function saveDevice() {
  const existingId=document.getElementById('dm-id').value;
  const name  =document.getElementById('dm-name').value.trim()||'Device';
  const type  =document.getElementById('dm-type').value||'mqtt';
  const prefix=document.getElementById('dm-prefix').value.trim().replace(/\/+$/,'')||'home/relay';
  const ping  =parseInt(document.getElementById('dm-ping').value)||10;
  const host  =document.getElementById('dm-host').value.trim();
  const poll  =parseInt(document.getElementById('dm-poll').value)||0;
  if (type==='wled-ws'&&!host){toast('Enter WLED IP/hostname','r');return;}

  if (existingId) {
    const dev=getDevice(existingId); if(!dev) return;
    // Teardown old connection
    if (isWledWS(dev)) wledDisconnect(dev);
    else { unsubscribeDevice(dev); if(pingTimers[dev.id]){clearInterval(pingTimers[dev.id]);delete pingTimers[dev.id];} }
    Object.assign(dev,{name,type,prefix,pingInterval:ping,host,pollInterval:poll});
    // Setup new connection
    if (isWledWS(dev)) wledConnect(dev);
    else if (connected) { subscribeDevice(dev); publishPresence(dev,true); startPing(dev); }
  } else {
    const dev={id:'dev-'+Date.now(),name,type,prefix,pingInterval:ping,host,pollInterval:poll,status:'offline',lastSeen:null,relays:[]};
    devices.push(dev);
    if (isWledWS(dev)) wledConnect(dev);
    else if (connected) { subscribeDevice(dev); publishPresence(dev,true); startPing(dev); }
    selectDevice(dev.id);
  }
  persist(); renderSidebar(); closeModal(); toast('Saved','g');
}

function removeDevice(id,e) {
  if(e)e.stopPropagation();
  const dev=getDevice(id);if(!dev)return;
  if(!confirm('Remove "'+dev.name+'"?'))return;
  if(isWledWS(dev)) wledDisconnect(dev);
  else { unsubscribeDevice(dev); publishPresence(dev,false); if(pingTimers[id]){clearInterval(pingTimers[id]);delete pingTimers[id];} }
  devices=devices.filter(d=>d.id!==id);
  if(activeId===id) activeId=devices[0]?.id||null;
  persist(); renderSidebar();
  if(activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML=emptyHTML('📡','No Device Selected','Add a device in the sidebar.');
}

/* ── PERSIST ── */
function persist() {
  save({broker, devices:devices.map(({id,name,type,prefix,pingInterval,host,pollInterval})=>
    ({id,name,type:type||'mqtt',prefix,pingInterval:pingInterval||10,host:host||'',pollInterval:pollInterval||0}))});
}

/* ══════════════════════════════════════════
   UI
══════════════════════════════════════════ */
function setConnUI(on) {
  document.getElementById('conn-dot').className='cdot'+(on?' on':'');
  document.getElementById('conn-label').textContent=on?'online':'offline';
  const ts=document.getElementById('tb-status');
  ts.textContent=on?'CONNECTED':'DISCONNECTED'; ts.className='tb-val '+(on?'g':'r');
  document.getElementById('btn-connect').style.display=on?'none':'';
  document.getElementById('btn-disconnect').style.display=on?'':'none';
}
function showError(msg){const el=document.getElementById('conn-error');el.textContent=msg;el.style.display='block';}
function clearError(){const el=document.getElementById('conn-error');el.textContent='';el.style.display='none';}

function renderSidebar() {
  const list=document.getElementById('device-list'); list.innerHTML='';
  if(!devices.length){list.innerHTML='<div style="padding:12px 14px;font-size:10px;color:var(--dim)">No devices yet.</div>';}
  devices.forEach(dev=>{
    const el=document.createElement('div');
    el.className='device-item'+(dev.id===activeId?' active':'');
    let badge='';
    if(dev.type==='wled')    badge='<span class="dev-badge wled">WLED·MQ</span>';
    if(dev.type==='wled-ws') badge='<span class="dev-badge wled-ws">WLED·WS</span>';
    el.innerHTML=`<div class="dev-left"><span class="dev-dot ${dev.status||'offline'}"></span><span class="dev-name">${esc(dev.name)}</span>${badge}</div><button class="dev-remove" onclick="removeDevice('${dev.id}',event)">✕</button>`;
    el.onclick=e=>{if(e.target.closest('.dev-remove'))return;selectDevice(dev.id);};
    list.appendChild(el);
  });
  const tbd=document.getElementById('tb-devices'); if(tbd)tbd.textContent=devices.length;
}

function selectDevice(id){activeId=id;renderSidebar();renderDevice(id);}

function renderDevice(id) {
  const main=document.getElementById('main'), dev=getDevice(id);
  if(!dev){main.innerHTML=emptyHTML('📡','No Device Selected','Add a device in the sidebar.');return;}
  const relays=dev.relays||[], online=dev.status==='online', active=relays.filter(r=>r.state).length, sensors=dev.sensors||[];

  let protoBadge='<span class="pill pill-d">MQTT</span>';
  if(dev.type==='wled')    protoBadge='<span class="pill" style="background:rgba(56,184,200,.15);border:1px solid var(--teal);color:var(--teal)">WLED · MQTT</span>';
  if(dev.type==='wled-ws') protoBadge='<span class="pill" style="background:rgba(147,120,232,.15);border:1px solid var(--purple);color:var(--purple)">WLED · WebSocket</span>';

  main.innerHTML=`
    <div class="dev-header">
      <div>
        <div class="dev-title">${esc(dev.name)}<span class="sub">${esc(isWledWS(dev)?dev.host:dev.prefix)}</span></div>
        <div class="dev-meta">
          <span class="pill ${online?'pill-g':'pill-r'}">${online?'ONLINE':'OFFLINE'}</span>
          ${protoBadge}
          ${isWled(dev)&&dev.wledInfo?`<span class="pill pill-d">v${esc(dev.wledInfo.ver||'')}</span>`:''}
          <span class="pill pill-a">${relays.length} ${isWled(dev)?'segs':'relays'}</span>
          <span class="pill ${active>0?'pill-a':'pill-d'}">${active} active</span>
          ${sensors.length?`<span class="pill pill-d">${sensors.length} sensors</span>`:''}
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

    ${isWled(dev)?`
    <div class="wled-global">
      <div class="wg-row">
        <span class="wg-lbl">MASTER</span>
        <label class="itoggle" style="margin-right:4px">
          <input type="checkbox" ${dev.wledState?.on?'checked':''} onchange="wledMasterToggle('${dev.id}',this.checked)">
          <div class="itrack"><div class="ithumb"></div></div>
        </label>
        ${dev.wledState?.color?`<span id="master-color-${dev.id}" style="width:14px;height:14px;border-radius:2px;background:${dev.wledState.color};border:1px solid var(--border);flex-shrink:0"></span>`:`<span id="master-color-${dev.id}"></span>`}
        <span class="wg-lbl">BRI</span>
        <input type="range" min="0" max="255" value="${dev.wledState?.bri??128}" class="bri-slider" id="bri-master-${dev.id}"
          oninput="document.getElementById('bri-val-${dev.id}').textContent=this.value"
          onchange="wledBriCommit('${dev.id}',this.value)">
        <span class="bri-val" id="bri-val-${dev.id}">${dev.wledState?.bri??128}</span>
        ${!dev.isRelayCtrl&&dev.wledEffects?`
        <span class="wg-lbl" style="margin-left:8px">FX</span>
        <select class="fx-select" onchange="wledFxChange('${dev.id}',this.value)">
          ${dev.wledEffects.filter(n=>n!=='RSVD'&&n!=='-').map((n,i)=>`<option value="${i}" ${(dev.relays?.[0]?.fx??0)===i?'selected':''}>${esc(n)}</option>`).join('')}
        </select>
        <span class="wg-lbl" style="margin-left:4px">SPD</span>
        <input type="range" min="0" max="255" value="${dev.relays?.[0]?.sx??128}" class="bri-slider" style="width:70px"
          onchange="wledSpeedChange('${dev.id}',this.value)">`:''}
      </div>
    </div>`:''}

    <div class="cmd-bar">
      <div class="cmd-row">
        <span class="cmd-lbl">JSON CMD</span>
        <input class="cmd-input" id="cmd-${dev.id}" placeholder='${isWled(dev)?'{"on":true}  ·  {"bri":128}  ·  {"seg":[{"id":0,"fx":73}]}':'{"on":true}  ·  {"relay":0,"on":true}'}'
          onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
        <button class="btn btn-teal btn-sm" onclick="sendCmd('${dev.id}')">Send</button>
      </div>
      <div class="cmd-hints">
        ${isWled(dev)?
          `→ <code>${isWledWS(dev)?'WebSocket /ws':''+dev.prefix+'/api'}</code> &nbsp;
          <code>{"on":true}</code> <code>{"on":false}</code> <code>{"on":"t"}</code> <code>{"bri":128}</code><br>
          Seg: <code>{"seg":[{"id":0,"on":true,"bri":200}]}</code> &nbsp; FX: <code>{"seg":[{"id":0,"fx":73,"sx":128}]}</code>`:
          `All: <code>{"on":true}</code> <code>{"on":false}</code> &nbsp; Relay: <code>{"relay":0,"on":true}</code> Pulse: <code>{"relay":1,"pulse":500}</code>`}
      </div>
    </div>

    <div class="relay-grid" id="grid-${dev.id}">
      ${relays.length?relays.map(r=>cardHTML(dev,r)).join(''):emptyHTML('🔌','No data yet',online?'Click ↻ Ping to request state.':'Device is offline.')}
    </div>

    ${sensors.length?`
    <div style="margin-top:16px">
      <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin-bottom:8px">Sensors</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${sensors.map(s=>`<div style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:6px 10px;font-size:11px;display:flex;align-items:center;gap:6px">
          <span class="sensor-dot ${s.state?'active':''}" id="sensor-dot-${dev.id}-${s.id}"></span>${esc(s.name)}</div>`).join('')}
      </div>
    </div>`:''}`;
}

function cardHTML(dev,r) {
  const did=dev.id,rid=r.id,isOn=!!(r.on||r.state);
  const showBri=isWled(dev)&&!dev.isRelayCtrl;
  const showPulse=!isWled(dev)||dev.isRelayCtrl;
  const fxName=showBri&&dev.wledEffects?(dev.wledEffects[r.fx??0]||null):null;
  const colArr=Array.isArray(r.col)&&Array.isArray(r.col[0])?r.col[0]:null;
  const colHex=colArr?'#'+colArr.slice(0,3).map(v=>(v||0).toString(16).padStart(2,'0')).join(''):null;
  const label=r.name||(isWled(dev)?'Seg '+rid:'Relay '+(rid+1));
  return `
    <div class="rcard ${isOn?'on':''}" id="rcard-${did}-${rid}">
      <div class="rc-head">
        <div class="rc-left">
          <span class="rc-num">${String(rid+1).padStart(2,'0')}</span>
          ${colHex?`<span class="col-swatch" style="background:${colHex}" title="${colHex}"></span>`:''}
          <span class="rc-name">${esc(label)}</span>
        </div>
        <div class="rc-right">
          ${fxName&&fxName!=='Solid'?`<span class="fx-badge">${esc(fxName)}</span>`:''}
          <span class="spill ${isOn?'on':'off'}" id="rsp-${did}-${rid}">${isOn?'ON':'OFF'}</span>
          <label class="itoggle">
            <input type="checkbox" ${isOn?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)">
            <div class="itrack"><div class="ithumb"></div></div>
          </label>
        </div>
      </div>
      ${showBri?`<div class="rc-bri"><span class="wg-lbl">BRI</span>
        <input type="range" min="0" max="255" value="${r.bri??128}" class="bri-slider"
          oninput="this.nextElementSibling.textContent=this.value" onchange="wledSegBri('${did}',${rid},this.value)">
        <span class="bri-val">${r.bri??128}</span></div>`:''}
      <div class="rc-body"><div class="rc-actions">
        ${showPulse?`
        <div class="act-group"><input class="act-input" id="pm-${did}-${rid}" value="500" title="ms"><button class="act-btn" onclick="pulseRelay('${did}',${rid})">Pulse</button></div>
        <div class="act-group"><input class="act-input" id="ts-${did}-${rid}" value="30" title="sec"><button class="act-btn" onclick="timerRelay('${did}',${rid})">Timer</button></div>
        <span class="timer-badge ${r.timer>0?'v':''}" id="tbadge-${did}-${rid}">${r.timer>0?r.timer+'s':''}</span>`:''}
      </div></div>
    </div>`;
}

function updateCard(dev,r) {
  const card=document.getElementById('rcard-'+dev.id+'-'+r.id);if(!card)return;
  card.className='rcard'+(r.state?' on':'');
  const cb=card.querySelector('input[type=checkbox]');if(cb)cb.checked=r.state;
  const sp=document.getElementById('rsp-'+dev.id+'-'+r.id);
  if(sp){sp.textContent=r.state?'ON':'OFF';sp.className='spill '+(r.state?'on':'off');}
}
function updateMeta(dev) {
  if(activeId!==dev.id)return;
  const active=(dev.relays||[]).filter(r=>r.state).length;
  const pa=document.getElementById('pill-active-'+dev.id);
  if(pa){pa.textContent=active+' active';pa.className='pill '+(active>0?'pill-a':'pill-d');}
}

/* ── HELPERS ── */
function ago(ts) {
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<5)return'just now';if(s<60)return s+'s ago';return Math.floor(s/60)+'m ago';
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function emptyHTML(icon,title,sub){return`<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;}

setInterval(()=>{
  devices.forEach(dev=>{const el=document.getElementById('last-seen-'+dev.id);if(el&&dev.lastSeen)el.textContent='seen '+ago(dev.lastSeen);});
},10000);

/* ── INIT ── */
(function init(){
  const mustSSL=location.protocol==='https:';
  document.getElementById('b-host').value =broker.host||'broker.hivemq.com';
  document.getElementById('b-port').value =broker.port||(mustSSL?8884:9001);
  document.getElementById('b-user').value =broker.user||'';
  document.getElementById('b-pass').value =broker.pass||'';
  document.getElementById('b-ssl').checked=mustSSL||broker.ssl||false;
  if(mustSSL){
    document.getElementById('b-ssl').disabled=true;
    const n=document.createElement('div');
    n.style.cssText='font-size:9px;color:var(--amber);margin-top:6px;line-height:1.6';
    n.innerHTML='⚠ HTTPS → WSS required for MQTT.<br>WLED WebSocket: browser will ask to allow mixed content once.';
    document.getElementById('b-ssl').closest('.broker-panel').appendChild(n);
  }
  setConnUI(false); renderSidebar();
  // Auto-connect WebSocket WLED devices (no broker needed)
  devices.forEach(dev=>{ if(isWledWS(dev)) setTimeout(()=>wledConnect(dev),300); });
  if(!activeId&&devices.length) activeId=devices[0].id;
  if(activeId) renderDevice(activeId);
  else document.getElementById('main').innerHTML=emptyHTML('📡','No Device Selected',
    'Add a device.<br><b>Relay Controller</b> — MQTT broker required.<br><b>WLED (MQTT)</b> — broker required, no local network access.<br><b>WLED (WebSocket)</b> — direct to device, browser asks once to allow.');
})();
