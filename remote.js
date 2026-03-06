/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD  (remote.js)

   Transport matrix:
   ┌─────────────────────┬──────────┬───────────────────────────┐
   │ Device Type         │ Transport│ HTTPS / GitHub Pages      │
   ├─────────────────────┼──────────┼───────────────────────────┤
   │ Relay Controller    │ MQTT WSS │ ✅ Always works           │
   │ WLED (MQTT)         │ MQTT WSS │ ✅ Always works           │
   │ WLED (WebSocket)    │ ws://    │ ⚠ Unlock in Site Settings │
   │ WLED (HTTP Poll)    │ http://  │ ⚠ Unlock in Site Settings │
   └─────────────────────┴──────────┴───────────────────────────┘
   Chrome 94+: no popup. Unlock: 🔒 → Site settings → Insecure content → Allow
═══════════════════════════════════════════════════ */

/* ── STORAGE ── */
const SK = 'relayctrl_v3';
function load() { try { return JSON.parse(localStorage.getItem(SK)||'{}'); } catch { return {}; } }
function save(d) { localStorage.setItem(SK, JSON.stringify(d)); }

/* ── GLOBAL STATE ── */
let client      = null;
let connected   = false;
let pingTimers  = {};
let devices     = [];
let activeId    = null;
const wledSockets = {};   // devId → WebSocket
const wledPollers = {};   // devId → setInterval

const stored = load();
const broker = stored.broker || { host:'broker.hivemq.com', port:8884, user:'', pass:'', ssl:true };
devices = (stored.devices||[]).map(d => ({...d, status:'offline', relays:[]}));

/* ── CLOCK ── */
setInterval(() => { document.getElementById('clock').textContent = new Date().toTimeString().slice(0,8); }, 1000);

/* ── TOAST ── */
let _toastT;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'show'+(type?' '+type:'');
  clearTimeout(_toastT); _toastT = setTimeout(()=>el.className='', 3000);
}

/* ══════════════════════════════════════════
   TYPE HELPERS
══════════════════════════════════════════ */
const isWled   = d => d?.type==='wled' || d?.type==='wled-ws' || d?.type==='wled-http';
const isWledWS = d => d?.type==='wled-ws';
const isWledMQ = d => d?.type==='wled';
const isWledHT = d => d?.type==='wled-http';
const isMqttT  = d => d?.type==='mqtt' || d?.type==='wled';

/* ══════════════════════════════════════════
   MQTT
══════════════════════════════════════════ */
function mqttConnect() {
  if (typeof Paho === 'undefined') { showError('Paho not loaded — check internet.'); return; }
  const host = document.getElementById('b-host').value.trim();
  const port = parseInt(document.getElementById('b-port').value)||8884;
  const user = document.getElementById('b-user').value.trim();
  const pass = document.getElementById('b-pass').value;
  const ssl  = location.protocol==='https:' ? true : document.getElementById('b-ssl').checked;
  if (!host) { toast('Enter broker host','r'); return; }
  clearError();
  Object.assign(broker, {host, port, user, pass, ssl});
  persist();

  if (client) { try{client.disconnect();}catch{} client=null; }
  connected = false;

  const cid = 'relayctrl-'+Math.random().toString(36).slice(2,9);
  const PC  = Paho.MQTT?.Client || Paho.Client;
  client = new PC(host, port, cid);

  client.onConnectionLost = r => {
    connected = false; setConnUI(false);
    devices.filter(isMqttT).forEach(d=>d.status='offline');
    renderSidebar(); if(activeId) renderDevice(activeId);
    Object.values(pingTimers).forEach(clearInterval); pingTimers={};
    if (r.errorCode!==0) { toast('Lost: '+r.errorMessage,'r'); showError('Disconnected: '+r.errorMessage); }
  };
  client.onMessageArrived = onMessage;

  client.connect({
    useSSL: ssl, keepAliveInterval: 30,
    onSuccess() {
      connected=true; clearError(); setConnUI(true); toast('Connected → '+host,'g');
      devices.filter(isMqttT).forEach(d=>{subscribeDevice(d);publishPresence(d,true);startPing(d);});
    },
    onFailure(e) {
      connected=false; setConnUI(false);
      const msg=e.errorMessage||('code '+e.errorCode);
      toast('Failed: '+msg,'r');
      showError('MQTT connect failed: '+msg+
        '\n\nCheck:\n• Broker host & port\n• TLS checkbox matches port (8884=WSS, 9001=WS)\n• Broker has WebSocket enabled\n• No firewall blocking the port');
    },
    ...(user?{userName:user,password:pass}:{})
  });
}

function mqttDisconnect() {
  Object.values(pingTimers).forEach(clearInterval); pingTimers={};
  devices.filter(isMqttT).forEach(d=>publishPresence(d,false));
  if(client){try{client.disconnect();}catch{} client=null;}
  connected=false; setConnUI(false);
  devices.filter(isMqttT).forEach(d=>d.status='offline');
  renderSidebar(); if(activeId) renderDevice(activeId);
}

function publish(topic, payload, retained=false) {
  if (!connected||!client) { toast('Not connected to broker','r'); return false; }
  try {
    const PM = Paho.MQTT?.Message||Paho.Message;
    const m  = new PM(String(payload));
    m.destinationName=topic; m.retained=retained; m.qos=1;
    client.send(m); return true;
  } catch(e) { toast('Publish error: '+e.message,'r'); return false; }
}
const publishJSON = (t,o,r=false) => publish(t,JSON.stringify(o),r);

function subscribeDevice(dev) {
  if (!connected||!isMqttT(dev)) return;
  try {
    ['/v','/relay/+/v','/status','/g','/c','/sensor/+/v'].forEach(s=>client.subscribe(dev.prefix+s));
  } catch(e){console.warn('sub err',e);}
}
function unsubscribeDevice(dev) {
  if (!connected||!isMqttT(dev)) return;
  ['/v','/relay/+/v','/status','/g','/c','/sensor/+/v'].forEach(s=>{try{client.unsubscribe(dev.prefix+s);}catch{}});
}
function publishPresence(dev,on) { if(connected&&isMqttT(dev)) publish(dev.prefix+'/presence',on?'online':'offline'); }
function startPing(dev) {
  if (!isMqttT(dev)) return;
  if (pingTimers[dev.id]) clearInterval(pingTimers[dev.id]);
  pingTimers[dev.id] = setInterval(()=>{
    if (!connected) return;
    isWledMQ(dev)?publishJSON(dev.prefix+'/api',{v:true}):publish(dev.prefix+'/ping','1');
  }, (dev.pingInterval||10)*1000);
}

/* ── MQTT INCOMING ── */
function onMessage(msg) {
  const topic=msg.destinationName, payload=msg.payloadString;
  const dev=devices.find(d=>isMqttT(d)&&(topic.startsWith(d.prefix+'/')||topic===d.prefix));
  if (!dev) return;
  const sfx=topic.slice(dev.prefix.length+1);

  if (sfx==='v') {
    try {
      const data=JSON.parse(payload);
      if (Array.isArray(data.relays)) {
        dev.relays=data.relays.map(r=>({...r,state:r.on}));
        dev.status='online'; dev.lastSeen=Date.now();
        renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
      } else if (data.state||data.seg) {
        wledHandleState(dev,data);
      }
    } catch(e){console.warn('/v err',e);}
    return;
  }
  if (sfx==='g') {
    const bri=parseInt(payload)||0;
    if(!dev.wledState)dev.wledState={on:false,bri:0};
    dev.wledState.bri=bri; dev.wledState.on=bri>0;
    dev.status='online'; dev.lastSeen=Date.now(); renderSidebar();
    if(activeId===dev.id){const s=document.getElementById('bri-master-'+dev.id);if(s)s.value=bri;const v=document.getElementById('bri-val-'+dev.id);if(v)v.textContent=bri;}
    return;
  }
  if (sfx==='c') {
    if(!dev.wledState)dev.wledState={on:false,bri:0};
    dev.wledState.color=payload.trim();
    if(activeId===dev.id){const s=document.getElementById('master-color-'+dev.id);if(s)s.style.background=dev.wledState.color;}
    return;
  }
  if (sfx==='status') {
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline'; dev.lastSeen=Date.now();
    if(dev.status==='online'&&!was) setTimeout(()=>publish(dev.prefix+'/ping','1'),400);
    renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
    return;
  }
  const rm=sfx.match(/^relay\/(\d+)\/v$/);
  if (rm) {
    const id=parseInt(rm[1]);
    if(!dev.relays)dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if(!r){r={id,name:'Relay '+(id+1),on:false,state:false};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);}
    r.on=payload.trim().toLowerCase()==='on'; r.state=r.on;
    dev.status='online'; dev.lastSeen=Date.now();
    if(activeId===dev.id)updateCard(dev,r); renderSidebar();
    return;
  }
  const sm=sfx.match(/^sensor\/(\d+)\/v$/);
  if (sm) {
    const id=parseInt(sm[1]);
    if(!dev.sensors)dev.sensors=[];
    let s=dev.sensors.find(s=>s.id===id);
    if(!s){s={id,name:'Sensor '+(id+1),state:false};dev.sensors.push(s);}
    s.state=['on','active'].includes(payload.trim().toLowerCase());
    dev.lastSeen=Date.now();
    if(activeId===dev.id){const d=document.getElementById('sensor-dot-'+dev.id+'-'+id);if(d)d.className='sensor-dot '+(s.state?'active':'');}
  }
}

/* ══════════════════════════════════════════
   WLED — WEBSOCKET  (wled-ws)
   On HTTPS: Chrome 94+ has NO popup. User must
   manually allow in: 🔒 → Site settings → Insecure content → Allow
══════════════════════════════════════════ */
function wledConnect(dev) {
  if (!isWledWS(dev)) return;
  if (wledSockets[dev.id]) { try{wledSockets[dev.id].onclose=null;wledSockets[dev.id].close();}catch{} }
  const proto = location.protocol==='https:' ? 'wss' : 'ws';
  const url   = `${proto}://${dev.host}/ws`;
  let ws;
  try { ws = new WebSocket(url); }
  catch(e) { dev.status='offline'; dev.wsError='WS init failed: '+e.message; renderSidebar(); return; }
  wledSockets[dev.id] = ws;

  ws.onopen = () => {
    dev.status='online'; dev.wsError=null; dev.lastSeen=Date.now();
    renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
    ws.send(JSON.stringify({v:true}));
    toast('WS → '+dev.name,'g');
    if (!dev.wledEffects) {
      fetch(`${location.protocol==='https:'?'https':'http'}://${dev.host}/json/eff`)
        .then(r=>r.json()).then(a=>{if(Array.isArray(a)){dev.wledEffects=a;if(activeId===dev.id)renderDevice(dev.id);}}).catch(()=>{});
    }
    if ((dev.pollInterval||0)>0) {
      wledPollers[dev.id]=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({v:true}));},dev.pollInterval*1000);
    }
  };
  ws.onmessage = e => { try{wledHandleState(dev,JSON.parse(e.data));}catch{} };
  ws.onerror   = () => {
    dev.status='offline'; dev.wsError='Connection refused or blocked by browser';
    renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
  };
  ws.onclose   = () => {
    dev.status='offline'; renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
    setTimeout(()=>{ if(devices.find(d=>d.id===dev.id)) wledConnect(dev); },5000);
  };
}

function wledDisconnect(dev) {
  if (wledPollers[dev.id]) { clearInterval(wledPollers[dev.id]); delete wledPollers[dev.id]; }
  if (wledSockets[dev.id]) {
    const ws=wledSockets[dev.id]; ws.onclose=null;
    try{ws.close();}catch{} delete wledSockets[dev.id];
  }
  dev.status='offline';
}

/* ══════════════════════════════════════════
   WLED — HTTP POLLING  (wled-http)
   Same as your working standalone page.
   On HTTPS: same "unlock" needed as WebSocket.
   On HTTP (local): just works.
══════════════════════════════════════════ */
function wledHttpStart(dev) {
  if (!isWledHT(dev)) return;
  if (wledPollers[dev.id]) clearInterval(wledPollers[dev.id]);
  dev.status='connecting';
  wledHttpFetch(dev);
  wledPollers[dev.id] = setInterval(()=>wledHttpFetch(dev), (dev.pollInterval||3)*1000);
}

function wledHttpStop(dev) {
  if (wledPollers[dev.id]) { clearInterval(wledPollers[dev.id]); delete wledPollers[dev.id]; }
  dev.status='offline';
}

async function wledHttpFetch(dev) {
  const proto = location.protocol==='https:' ? 'https' : 'http';
  try {
    const r = await fetch(`${proto}://${dev.host}/json`, {cache:'no-store'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    dev.status='online'; dev.lastSeen=Date.now(); dev.wsError=null;
    // Parse MultiRelay format (your working page's format)
    const mr = data.state?.MultiRelay?.relays;
    if (Array.isArray(mr)) {
      if (!dev.relays) dev.relays=[];
      mr.forEach(item=>{
        let r=dev.relays.find(r=>r.id===item.relay);
        if (!r){r={id:item.relay,name:'Relay '+item.relay,on:false,state:false};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);}
        r.on=!!item.state; r.state=r.on;
      });
    }
    // Also parse WLED full state (segments etc.)
    if (data.state||data.seg) {
      wledHandleState(dev, data);
    } else {
      renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
    }
  } catch(e) {
    dev.status='offline'; dev.wsError=String(e);
    renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
  }
}

async function wledHttpToggle(dev, relayIndex, newState) {
  // WLED MultiRelay HTTP API: /relays?switch=0,1,0,1
  const states = (dev.relays||[]).map(r=>r.id===relayIndex?(newState?1:0):(r.on?1:0));
  // Pad to 4
  while(states.length<4) states.push(0);
  const sw = states.slice(0,4).join(',');
  const proto = location.protocol==='https:'?'https':'http';
  try {
    await fetch(`${proto}://${dev.host}/relays?switch=${sw}`, {cache:'no-store'});
    setTimeout(()=>wledHttpFetch(dev), 200);
  } catch(e) { dev.status='offline'; dev.wsError=String(e); renderSidebar(); }
}

async function wledHttpSendJson(dev, payload) {
  const proto = location.protocol==='https:'?'https':'http';
  try {
    await fetch(`${proto}://${dev.host}/json/state`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), cache:'no-store'
    });
    setTimeout(()=>wledHttpFetch(dev),200);
  } catch(e) { dev.status='offline'; renderSidebar(); }
}

/* ══════════════════════════════════════════
   WLED UNIFIED SEND
══════════════════════════════════════════ */
function wledSend(dev, payload) {
  if (isWledWS(dev)) {
    const ws=wledSockets[dev.id];
    if (!ws||ws.readyState!==WebSocket.OPEN) { toast('WS not open','r'); return false; }
    ws.send(JSON.stringify(payload)); return true;
  }
  if (isWledHT(dev)) { wledHttpSendJson(dev,payload); return true; }
  return publishJSON(dev.prefix+'/api', payload);
}

/* ── WLED STATE HANDLER (all transports share this) ── */
function wledHandleState(dev, data) {
  const state=data.state||data; if(!state) return;
  dev.lastSeen=Date.now(); dev.status='online';
  if (!dev.wledState) dev.wledState={};
  Object.assign(dev.wledState, {on:state.on, bri:state.bri??128, transition:state.transition??7});
  if (Array.isArray(state.seg)) {
    dev.relays = state.seg.filter(s=>s&&typeof s.id==='number').map(s=>({
      id:s.id, name:s.n||('Seg '+s.id), on:!!s.on, state:!!s.on,
      bri:s.bri??(s.on?255:0), timer:s.timer||0, fx:s.fx??0, sx:s.sx??128, col:s.col
    }));
  }
  if (data.info) {
    dev.wledInfo={ver:data.info.ver,name:data.info.name,brand:data.info.brand,leds:data.info.leds};
    dev.isRelayCtrl=(data.info.brand==='WLED-Relay');
  }
  if (Array.isArray(data.effects)) dev.wledEffects=data.effects;
  renderSidebar(); if(activeId===dev.id) renderDevice(dev.id);
}

/* ── WLED CONTROLS ── */
function wledMasterToggle(devId,on) {
  const dev=getDevice(devId);if(!dev)return;
  if(!dev.wledState)dev.wledState={};  dev.wledState.on=on;
  if(isWledWS(dev)||isWledHT(dev)) wledSend(dev,{on});
  else publish(dev.prefix, on?'ON':'OFF');
  if(activeId===dev.id) renderDevice(dev.id);
}
function wledBriCommit(devId,val) {
  const dev=getDevice(devId);if(!dev)return;
  const bri=parseInt(val); if(!dev.wledState)dev.wledState={}; dev.wledState.bri=bri;
  wledSend(dev,{bri});
}
function wledFxChange(devId,fx)   {const dev=getDevice(devId);if(!dev)return;wledSend(dev,{seg:[{id:0,fx:parseInt(fx)}]});}
function wledSpeedChange(devId,sx){const dev=getDevice(devId);if(!dev)return;wledSend(dev,{seg:[{id:0,sx:parseInt(sx)}]});}
function wledSegBri(devId,sid,v)  {
  const dev=getDevice(devId);if(!dev)return;
  const bri=parseInt(v),r=dev.relays?.find(r=>r.id===sid);if(r)r.bri=bri;
  wledSend(dev,{seg:[{id:sid,bri}]});
}
function toggleRelayWled(devId,rid,on) {
  const dev=getDevice(devId);if(!dev)return;
  if (isWledHT(dev)) { wledHttpToggle(dev,rid,on); }
  else wledSend(dev,{seg:[{id:rid,on}]});
  const r=dev.relays?.find(r=>r.id===rid);
  if(r){r.on=on;r.state=on;updateCard(dev,r);updateMeta(dev);}
}
function pulseRelayWled(devId,rid) {
  const dev=getDevice(devId);if(!dev)return;
  const ms=parseInt(document.getElementById('pm-'+devId+'-'+rid).value)||500;
  if(isWledHT(dev)){wledHttpToggle(dev,rid,true);setTimeout(()=>wledHttpToggle(dev,rid,false),ms);}
  else{wledSend(dev,{seg:[{id:rid,on:true}]});setTimeout(()=>wledSend(dev,{seg:[{id:rid,on:false}]}),ms);}
  toast('Pulse '+ms+'ms → S'+rid);
}
function timerRelayWled(devId,rid) {
  const dev=getDevice(devId);if(!dev)return;
  const s=parseInt(document.getElementById('ts-'+devId+'-'+rid).value)||30;
  if(isWledHT(dev)){wledHttpToggle(dev,rid,true);setTimeout(()=>wledHttpToggle(dev,rid,false),s*1000);}
  else{wledSend(dev,{seg:[{id:rid,on:true}]});setTimeout(()=>wledSend(dev,{seg:[{id:rid,on:false}]}),s*1000);}
  toast('Timer '+s+'s → S'+rid);
}
function allOffWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWledHT(dev))wledHttpSendJson(dev,{on:false});else wledSend(dev,{on:false});
  if(dev.wledState)dev.wledState.on=false;
  dev.relays?.forEach(r=>{r.on=false;r.state=false;updateCard(dev,r);}); updateMeta(dev);
  toast('All OFF — '+dev.name,'r');
}
function allOnWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWledHT(dev))wledHttpSendJson(dev,{on:true});else wledSend(dev,{on:true});
  if(dev.wledState)dev.wledState.on=true;
  dev.relays?.forEach(r=>{r.on=true;r.state=true;updateCard(dev,r);}); updateMeta(dev);
  toast('All ON — '+dev.name);
}
function sendCmdWled(devId) {
  const dev=getDevice(devId);if(!dev)return;
  const raw=document.getElementById('cmd-'+devId).value.trim();if(!raw)return;
  try{const o=JSON.parse(raw);wledSend(dev,o);toast('Sent','g');}
  catch(e){toast('Bad JSON','r');}
}

/* ══════════════════════════════════════════
   RELAY CTRL ROUTING
══════════════════════════════════════════ */
function toggleRelay(devId,rid,on) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){toggleRelayWled(devId,rid,on);return;}
  publishJSON(dev.prefix+'/relay/'+rid+'/api',{on});
  const r=dev.relays?.find(r=>r.id===rid);
  if(r){r.on=on;r.state=on;updateCard(dev,r);updateMeta(dev);}
}
function pulseRelay(devId,rid) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){pulseRelayWled(devId,rid);return;}
  const ms=parseInt(document.getElementById('pm-'+devId+'-'+rid).value)||500;
  publishJSON(dev.prefix+'/relay/'+rid+'/api',{pulse:ms}); toast('Pulse '+ms+'ms');
}
function timerRelay(devId,rid) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){timerRelayWled(devId,rid);return;}
  const s=parseInt(document.getElementById('ts-'+devId+'-'+rid).value)||30;
  publishJSON(dev.prefix+'/relay/'+rid+'/api',{timer:s}); toast('Timer '+s+'s');
}
function allOff(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){allOffWled(devId);return;}
  publishJSON(dev.prefix+'/api',{on:false});
  dev.relays?.forEach(r=>{r.on=false;r.state=false;updateCard(dev,r);}); updateMeta(dev);
  toast('All OFF','r');
}
function allOn(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){allOnWled(devId);return;}
  publishJSON(dev.prefix+'/api',{on:true});
  dev.relays?.forEach(r=>{r.on=true;r.state=true;updateCard(dev,r);}); updateMeta(dev);
  toast('All ON');
}
function sendCmd(devId) {
  const dev=getDevice(devId);if(!dev)return;
  if(isWled(dev)){sendCmdWled(devId);return;}
  const raw=document.getElementById('cmd-'+devId).value.trim();if(!raw)return;
  try{JSON.parse(raw);}catch(e){toast('Bad JSON','r');return;}
  publish(dev.prefix+'/api',raw); toast('Sent','g');
}
function pingDevice(id) {
  const dev=getDevice(id);if(!dev)return;
  if(isWledWS(dev)){const ws=wledSockets[dev.id];if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({v:true}));return;}
  if(isWledHT(dev)){wledHttpFetch(dev);return;}
  if(isWledMQ(dev)){publishJSON(dev.prefix+'/api',{v:true});return;}
  publish(dev.prefix+'/ping','1');
}

/* ══════════════════════════════════════════
   MODAL
══════════════════════════════════════════ */
function onDevTypeChange() {
  const t = document.getElementById('dm-type').value;
  document.getElementById('dm-mqtt-fields').style.display = (t==='mqtt'||t==='wled')?'':'none';
  document.getElementById('dm-ws-fields').style.display   = (t==='wled-ws'||t==='wled-http')?'':'none';
  const note = document.getElementById('dm-wled-note');
  note.style.display = isWled({type:t})?'':'none';
  if (note.style.display!=='none') {
    note.querySelector('.note-mqtt').style.display  = t==='wled'?'':'none';
    note.querySelector('.note-ws').style.display    = t==='wled-ws'?'':'none';
    note.querySelector('.note-http').style.display  = t==='wled-http'?'':'none';
  }
  const ph=document.getElementById('dm-prefix'), hint=document.getElementById('dm-prefix-hint');
  if(t==='wled'){if(ph&&!ph.value)ph.placeholder='wled/strip1';if(hint)hint.textContent='Match MQTT Topic in WLED → Settings → Sync Interfaces → MQTT.';}
  else{if(ph&&!ph.value)ph.placeholder='home/relay';if(hint)hint.textContent='Match prefix in ESP32 firmware config.';}
}

/* ── DEVICE CRUD ── */
function getDevice(id){return devices.find(d=>d.id===id);}

function openAddDevice() {
  document.getElementById('modal-title').textContent='Add Device';
  ['dm-id','dm-name','dm-prefix','dm-host'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('dm-type').value='mqtt';
  document.getElementById('dm-ping').value='10';
  document.getElementById('dm-poll').value='3';
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
  setTimeout(()=>document.getElementById('dm-name').focus(),100);
}
function openEditDevice(id) {
  const d=getDevice(id);if(!d)return;
  document.getElementById('modal-title').textContent='Edit Device';
  document.getElementById('dm-id').value=d.id;
  document.getElementById('dm-name').value=d.name;
  document.getElementById('dm-type').value=d.type||'mqtt';
  document.getElementById('dm-prefix').value=d.prefix||'';
  document.getElementById('dm-ping').value=d.pingInterval||10;
  document.getElementById('dm-host').value=d.host||'';
  document.getElementById('dm-poll').value=d.pollInterval||3;
  onDevTypeChange();
  document.getElementById('add-modal').classList.add('open');
}
function closeModal(){document.getElementById('add-modal').classList.remove('open');}

function saveDevice() {
  const eid=document.getElementById('dm-id').value;
  const name  =document.getElementById('dm-name').value.trim()||'Device';
  const type  =document.getElementById('dm-type').value||'mqtt';
  const prefix=document.getElementById('dm-prefix').value.trim().replace(/\/+$/,'')||'home/relay';
  const ping  =parseInt(document.getElementById('dm-ping').value)||10;
  const host  =document.getElementById('dm-host').value.trim();
  const poll  =parseInt(document.getElementById('dm-poll').value)||3;
  if ((type==='wled-ws'||type==='wled-http')&&!host){toast('Enter WLED IP/host','r');return;}

  if (eid) {
    const dev=getDevice(eid);if(!dev)return;
    // teardown
    if(isWledWS(dev))wledDisconnect(dev);
    else if(isWledHT(dev))wledHttpStop(dev);
    else{unsubscribeDevice(dev);if(pingTimers[dev.id]){clearInterval(pingTimers[dev.id]);delete pingTimers[dev.id];}}
    Object.assign(dev,{name,type,prefix,pingInterval:ping,host,pollInterval:poll});
    // setup
    if(isWledWS(dev))wledConnect(dev);
    else if(isWledHT(dev))wledHttpStart(dev);
    else if(connected){subscribeDevice(dev);publishPresence(dev,true);startPing(dev);}
  } else {
    const dev={id:'dev-'+Date.now(),name,type,prefix,pingInterval:ping,host,pollInterval:poll,status:'offline',lastSeen:null,relays:[]};
    devices.push(dev);
    if(isWledWS(dev))wledConnect(dev);
    else if(isWledHT(dev))wledHttpStart(dev);
    else if(connected){subscribeDevice(dev);publishPresence(dev,true);startPing(dev);}
    selectDevice(dev.id);
  }
  persist();renderSidebar();closeModal();toast('Saved','g');
}

function removeDevice(id,e) {
  if(e)e.stopPropagation();
  const dev=getDevice(id);if(!dev)return;
  if(!confirm('Remove "'+dev.name+'"?'))return;
  if(isWledWS(dev))wledDisconnect(dev);
  else if(isWledHT(dev))wledHttpStop(dev);
  else{unsubscribeDevice(dev);publishPresence(dev,false);if(pingTimers[id]){clearInterval(pingTimers[id]);delete pingTimers[id];}}
  devices=devices.filter(d=>d.id!==id);
  if(activeId===id)activeId=devices[0]?.id||null;
  persist();renderSidebar();
  if(activeId)renderDevice(activeId);
  else document.getElementById('main').innerHTML=emptyHTML('📡','No Device Selected','Add a device.');
}

function persist() {
  save({broker, devices:devices.map(({id,name,type,prefix,pingInterval,host,pollInterval})=>
    ({id,name,type:type||'mqtt',prefix,pingInterval:pingInterval||10,host:host||'',pollInterval:pollInterval||3}))});
}

/* ══════════════════════════════════════════
   UI RENDER
══════════════════════════════════════════ */
function setConnUI(on){
  document.getElementById('conn-dot').className='cdot'+(on?' on':'');
  document.getElementById('conn-label').textContent=on?'online':'offline';
  const ts=document.getElementById('tb-status');ts.textContent=on?'CONNECTED':'DISCONNECTED';ts.className='tb-val '+(on?'g':'r');
  document.getElementById('btn-connect').style.display=on?'none':'';
  document.getElementById('btn-disconnect').style.display=on?'':'none';
}
function showError(msg){const e=document.getElementById('conn-error');e.textContent=msg;e.style.display='block';}
function clearError(){const e=document.getElementById('conn-error');e.textContent='';e.style.display='none';}

function renderSidebar(){
  const list=document.getElementById('device-list');list.innerHTML='';
  if(!devices.length){list.innerHTML='<div style="padding:12px 14px;font-size:10px;color:var(--dim)">No devices yet.</div>';}
  devices.forEach(dev=>{
    const el=document.createElement('div');
    el.className='device-item'+(dev.id===activeId?' active':'');
    const badges={'wled':'WLED·MQ','wled-ws':'WLED·WS','wled-http':'WLED·HTTP'};
    const btype={'wled':'wled','wled-ws':'wled-ws','wled-http':'wled-http'};
    const badge=badges[dev.type]?`<span class="dev-badge ${btype[dev.type]}">${badges[dev.type]}</span>`:'';
    el.innerHTML=`<div class="dev-left"><span class="dev-dot ${dev.status||'offline'}"></span><span class="dev-name">${esc(dev.name)}</span>${badge}</div><button class="dev-remove" onclick="removeDevice('${dev.id}',event)">✕</button>`;
    el.onclick=e=>{if(e.target.closest('.dev-remove'))return;selectDevice(dev.id);};
    list.appendChild(el);
  });
  const tbd=document.getElementById('tb-devices');if(tbd)tbd.textContent=devices.length;
}

function selectDevice(id){activeId=id;renderSidebar();renderDevice(id);}

function protoBadgeHTML(dev) {
  if(dev.type==='wled')     return '<span class="pill" style="background:rgba(56,184,200,.15);border:1px solid var(--teal);color:var(--teal)">WLED · MQTT</span>';
  if(dev.type==='wled-ws')  return '<span class="pill" style="background:rgba(147,120,232,.15);border:1px solid var(--purple);color:var(--purple)">WLED · WebSocket</span>';
  if(dev.type==='wled-http')return '<span class="pill" style="background:rgba(245,158,11,.15);border:1px solid var(--amber);color:var(--amber)">WLED · HTTP Poll</span>';
  return '<span class="pill pill-d">MQTT</span>';
}

function mixedContentWarningHTML(dev) {
  if (location.protocol!=='https:') return '';
  if (!isWledWS(dev)&&!isWledHT(dev)) return '';
  const icon = dev.status==='online' ? '' :
    `<div style="background:rgba(239,68,68,.1);border:1px solid var(--red);border-radius:4px;padding:10px 14px;margin-bottom:14px;font-size:10px;line-height:1.8;color:var(--red)">
      <b>🔒 Mixed content blocked by browser</b><br>
      Chrome 94+ has no popup. To unlock for this site:<br>
      <span style="color:var(--text2)">
        1. Click the <b>🔒 lock icon</b> in the address bar<br>
        2. Choose <b>Site settings</b><br>
        3. Set <b>Insecure content</b> → <b>Allow</b><br>
        4. Reload this page
      </span><br>
      <span style="color:var(--dim)">(Firefox: click the shield icon in the address bar)</span>
    </div>`;
  return icon;
}

function renderDevice(id){
  const main=document.getElementById('main'),dev=getDevice(id);
  if(!dev){main.innerHTML=emptyHTML('📡','No Device Selected','Add a device in the sidebar.');return;}
  const relays=dev.relays||[],online=dev.status==='online',active=relays.filter(r=>r.state).length,sensors=dev.sensors||[];

  main.innerHTML=`
    ${mixedContentWarningHTML(dev)}
    <div class="dev-header">
      <div>
        <div class="dev-title">${esc(dev.name)}<span class="sub">${esc(isWledWS(dev)||isWledHT(dev)?dev.host:dev.prefix)}</span></div>
        <div class="dev-meta">
          <span class="pill ${online?'pill-g':'pill-r'}">${online?'ONLINE':'OFFLINE'}</span>
          ${protoBadgeHTML(dev)}
          ${isWled(dev)&&dev.wledInfo?`<span class="pill pill-d">v${esc(dev.wledInfo.ver||'')}</span>`:''}
          <span class="pill pill-a">${relays.length} ${isWled(dev)?'segs':'relays'}</span>
          <span class="pill ${active>0?'pill-a':'pill-d'}" id="pill-active-${dev.id}">${active} active</span>
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
          `→ ${isWledHT(dev)?'POST /json/state':isWledWS(dev)?'WebSocket /ws':dev.prefix+'/api'} &nbsp;
          <code>{"on":true}</code> <code>{"bri":200}</code> <code>{"seg":[{"id":0,"on":true}]}</code>`:
          `<code>{"on":true}</code> <code>{"relay":0,"on":true}</code> <code>{"relay":1,"pulse":500}</code>`}
      </div>
    </div>

    <div class="relay-grid" id="grid-${dev.id}">
      ${relays.length?relays.map(r=>cardHTML(dev,r)).join(''):emptyHTML('🔌','No data yet',online?'Click ↻ Ping to request state.':'Device offline.')}
    </div>
    ${sensors.length?`<div style="margin-top:16px"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);margin-bottom:8px">Sensors</div><div style="display:flex;flex-wrap:wrap;gap:8px">${sensors.map(s=>`<div style="background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:6px 10px;font-size:11px;display:flex;align-items:center;gap:6px"><span class="sensor-dot ${s.state?'active':''}" id="sensor-dot-${dev.id}-${s.id}"></span>${esc(s.name)}</div>`).join('')}</div></div>`:''}`;
}

function cardHTML(dev,r){
  const did=dev.id,rid=r.id,isOn=!!(r.on||r.state);
  const showBri=isWled(dev)&&!dev.isRelayCtrl&&!isWledHT(dev);
  const showPulse=!isWled(dev)||dev.isRelayCtrl||isWledHT(dev);
  const fxName=showBri&&dev.wledEffects?(dev.wledEffects[r.fx??0]||null):null;
  const colArr=Array.isArray(r.col)&&Array.isArray(r.col[0])?r.col[0]:null;
  const colHex=colArr?'#'+colArr.slice(0,3).map(v=>(v||0).toString(16).padStart(2,'0')).join(''):null;
  const label=r.name||(isWled(dev)?'Seg '+rid:'Relay '+(rid+1));
  return `<div class="rcard ${isOn?'on':''}" id="rcard-${did}-${rid}">
    <div class="rc-head">
      <div class="rc-left"><span class="rc-num">${String(rid+1).padStart(2,'0')}</span>${colHex?`<span class="col-swatch" style="background:${colHex}"></span>`:''}<span class="rc-name">${esc(label)}</span></div>
      <div class="rc-right">
        ${fxName&&fxName!=='Solid'?`<span class="fx-badge">${esc(fxName)}</span>`:''}
        <span class="spill ${isOn?'on':'off'}" id="rsp-${did}-${rid}">${isOn?'ON':'OFF'}</span>
        <label class="itoggle"><input type="checkbox" ${isOn?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)"><div class="itrack"><div class="ithumb"></div></div></label>
      </div>
    </div>
    ${showBri?`<div class="rc-bri"><span class="wg-lbl">BRI</span><input type="range" min="0" max="255" value="${r.bri??128}" class="bri-slider" oninput="this.nextElementSibling.textContent=this.value" onchange="wledSegBri('${did}',${rid},this.value)"><span class="bri-val">${r.bri??128}</span></div>`:''}
    <div class="rc-body"><div class="rc-actions">
      ${showPulse?`<div class="act-group"><input class="act-input" id="pm-${did}-${rid}" value="500" title="ms"><button class="act-btn" onclick="pulseRelay('${did}',${rid})">Pulse</button></div><div class="act-group"><input class="act-input" id="ts-${did}-${rid}" value="30" title="sec"><button class="act-btn" onclick="timerRelay('${did}',${rid})">Timer</button></div><span class="timer-badge ${r.timer>0?'v':''}" id="tbadge-${did}-${rid}">${r.timer>0?r.timer+'s':''}</span>`:''}
    </div></div>
  </div>`;
}

function updateCard(dev,r){
  const c=document.getElementById('rcard-'+dev.id+'-'+r.id);if(!c)return;
  c.className='rcard'+(r.state?' on':'');
  const cb=c.querySelector('input[type=checkbox]');if(cb)cb.checked=r.state;
  const sp=document.getElementById('rsp-'+dev.id+'-'+r.id);
  if(sp){sp.textContent=r.state?'ON':'OFF';sp.className='spill '+(r.state?'on':'off');}
}
function updateMeta(dev){
  if(activeId!==dev.id)return;
  const a=(dev.relays||[]).filter(r=>r.state).length;
  const p=document.getElementById('pill-active-'+dev.id);
  if(p){p.textContent=a+' active';p.className='pill '+(a>0?'pill-a':'pill-d');}
}

/* ── HELPERS ── */
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<5)return'just now';if(s<60)return s+'s ago';return Math.floor(s/60)+'m ago';}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function emptyHTML(icon,title,sub){return`<div class="empty"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;}
setInterval(()=>{devices.forEach(d=>{const e=document.getElementById('last-seen-'+d.id);if(e&&d.lastSeen)e.textContent='seen '+ago(d.lastSeen);});},10000);

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
    n.style.cssText='font-size:9px;color:var(--amber);margin-top:6px;line-height:1.7';
    n.innerHTML='⚠ HTTPS page: MQTT needs WSS broker.<br>WLED WS/HTTP: unlock via 🔒 → Site settings → Insecure content → Allow';
    document.getElementById('b-ssl').closest('.broker-panel').appendChild(n);
  }
  setConnUI(false);renderSidebar();
  devices.forEach(dev=>{
    if(isWledWS(dev)) setTimeout(()=>wledConnect(dev),300+devices.indexOf(dev)*100);
    if(isWledHT(dev)) setTimeout(()=>wledHttpStart(dev),300+devices.indexOf(dev)*100);
  });
  if(!activeId&&devices.length)activeId=devices[0].id;
  if(activeId)renderDevice(activeId);
  else document.getElementById('main').innerHTML=emptyHTML('📡','No Device Selected',
    '<b>Relay Controller / WLED (MQTT)</b> — needs broker, works everywhere.<br>'+
    '<b>WLED (WebSocket)</b> — direct ws://, no broker. On HTTPS: 🔒 → Site settings → Insecure content → Allow.<br>'+
    '<b>WLED (HTTP Poll)</b> — same as your existing fetch page. Polls /json every few sec.');
})();
