/* ═══════════════════════════════════════════════════════
   RELAY CTRL — remote.js  (v5)

   Architecture (corrected):
     Commands  → HTTP fetch always (works from HTTP + HTTPS)
     Real-time → WebSocket  on HTTP pages  (ws://host/ws)
               → MQTT subs  on HTTPS pages  (broker WSS)
     Polling   → GET /json + /api/pins every 3s (always)
     MQTT      → relay controllers always
               → WLED + GPIO real-time on HTTPS only
═══════════════════════════════════════════════════════ */

const SK       = 'relayctrl_v5';
const IS_HTTPS = location.protocol === 'https:';

/* ── PERSISTENCE ── */
const load = () => { try { return JSON.parse(localStorage.getItem(SK)||'{}'); } catch { return {}; } };
const save = d => localStorage.setItem(SK, JSON.stringify(d));

/* ── STATE ── */
let mqttCl    = null;
let connected = false;
let pingT     = {};   // devId → keepalive interval
let wsSock    = {};   // devId → WebSocket
let wsRecon   = {};   // devId → reconnect timeout
let jsonPoll  = {};   // devId → /json interval
let gpioPoll  = {};   // devId → /api/pins interval
let patterns  = {};   // devId → pattern state
let devices   = [];
let activeId  = null;
let curTabs   = {};   // devId → active tab id

const stored = load();
const broker  = stored.broker || {host:'',port:9001,user:'',pass:'',ssl:false};
devices = (stored.devices||[]).map(d => ({...d, status:'offline', relays:[], sensors:[], gpioPins:[]}));

/* ── UTILS ── */
const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ago  = t => { const s=Math.floor((Date.now()-t)/1000); return s<5?'just now':s<60?s+'s ago':Math.floor(s/60)+'m ago'; };
const getD = id => devices.find(d => d.id===id);
const isW  = d  => (d?.type||'mqtt')==='wled';
const $    = id => document.getElementById(id);

/* ── CLOCK ── */
setInterval(() => $('clock').textContent = new Date().toTimeString().slice(0,8), 1000);
setInterval(() => devices.forEach(d => {
  const e = $('ls-'+d.id); if (e && d.lastSeen) e.textContent = 'seen '+ago(d.lastSeen);
}), 10000);

/* ── TOAST ── */
let _tt;
const toast = (msg, type='') => {
  const el=$('toast');
  el.textContent = msg;
  el.className = 'toast show'+(type==='ok'?' ok':type==='err'?' err':'');
  clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove('show'), 2600);
};

/* ══════════════════════════════════════════════════════
   MQTT
══════════════════════════════════════════════════════ */
function mqttConnect() {
  if (typeof Paho==='undefined') { showErr('Paho not loaded.'); return; }
  const host=$('b-host').value.trim(), port=parseInt($('b-port').value)||9001,
        user=$('b-user').value.trim(),  pass=$('b-pass').value,
        ssl=IS_HTTPS||$('b-ssl').checked;
  if (!host) { toast('Enter broker host','err'); return; }
  clearErr(); Object.assign(broker,{host,port,user,pass,ssl}); persist();
  if (mqttCl) { try{mqttCl.disconnect();}catch{} mqttCl=null; }
  connected = false;
  const PC = (Paho.MQTT?.Client)||Paho.Client;
  mqttCl = new PC(host, port, 'rc-'+Math.random().toString(36).slice(2,9));
  mqttCl.onConnectionLost = r => {
    connected=false; setConnUI(false);
    devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>d.status='offline');
    Object.values(pingT).forEach(clearInterval); pingT={};
    renderSidebar(); if(activeId) renderDevice(activeId);
    if(r.errorCode) { toast('Lost: '+r.errorMessage,'err'); showErr(r.errorMessage); }
  };
  mqttCl.onMessageArrived = onMsg;
  const opts = { useSSL:ssl, keepAliveInterval:30,
    onSuccess() {
      connected=true; clearErr(); setConnUI(true); toast('Connected to '+host,'ok');
      devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>{ subRelay(d); pubPresence(d,true); startPing(d); });
      if (IS_HTTPS) devices.filter(d=>d.type==='wled').forEach(d=>{ if(d.wledTopic)wledMqttSub(d); if(d.gpioPrefix)gpioMqttSub(d); });
    },
    onFailure(e) { connected=false; setConnUI(false); const m=e.errorMessage||'Err '+e.errorCode; toast('Failed: '+m,'err'); showErr(m); }
  };
  if (user) { opts.userName=user; opts.password=pass; }
  try { mqttCl.connect(opts); } catch(e) { toast(e.message,'err'); showErr(e.message); }
}

function mqttDisconnect() {
  Object.values(pingT).forEach(clearInterval); pingT={};
  devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>pubPresence(d,false));
  if (mqttCl) { try{mqttCl.disconnect();}catch{} mqttCl=null; }
  connected=false; setConnUI(false);
  devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>d.status='offline');
  renderSidebar(); if(activeId) renderDevice(activeId);
}

function pub(topic, payload, retain=false) {
  if (!connected||!mqttCl) { toast('Not connected','err'); return false; }
  try {
    const PM=(Paho.MQTT?.Message)||Paho.Message;
    const m=new PM(String(payload)); m.destinationName=topic; m.retained=retain; m.qos=1;
    mqttCl.send(m); return true;
  } catch(e) { toast('Pub error: '+e.message,'err'); return false; }
}
const pubJ = (t,o,r=false) => pub(t,JSON.stringify(o),r);

function subRelay(dev) {
  if (!connected||(dev.type||'mqtt')!=='mqtt') return;
  try { ['/v','/relay/+/v','/sensor/+/v','/status'].forEach(s=>mqttCl.subscribe(dev.prefix+s)); }
  catch(e) { console.warn('[sub]',e); }
}
function unsubRelay(dev) {
  if (!connected||(dev.type||'mqtt')!=='mqtt') return;
  ['/v','/relay/+/v','/sensor/+/v','/status'].forEach(s=>{ try{mqttCl.unsubscribe(dev.prefix+s);}catch{} });
}
function pubPresence(dev,on) { pub(dev.prefix+'/presence', on?'online':'offline', false); }
function startPing(dev) {
  if (pingT[dev.id]) clearInterval(pingT[dev.id]);
  pingT[dev.id] = setInterval(()=>{ if(connected) pub(dev.prefix+'/ping','1',false); }, (dev.pingInterval||10)*1000);
}

/* ── INCOMING MQTT ── */
function onMsg(msg) {
  const topic=msg.destinationName, payload=msg.payloadString;

  // GPIO Monitor (check before WLED — prefix can overlap)
  const gd = devices.find(d=>d.type==='wled'&&d.gpioPrefix&&(topic===d.gpioPrefix||topic.startsWith(d.gpioPrefix+'/')));
  if (gd) { handleGpioMqtt(gd, topic===gd.gpioPrefix?'':topic.slice(gd.gpioPrefix.length+1), payload); return; }

  // WLED real-time (HTTPS mode)
  const wd = devices.find(d=>d.type==='wled'&&d.wledTopic&&(topic===d.wledTopic||topic.startsWith(d.wledTopic+'/')));
  if (wd) { handleWledMqtt(wd, topic===wd.wledTopic?'':topic.slice(wd.wledTopic.length+1), payload); return; }

  // Relay controller
  const dev = devices.find(d=>(d.type||'mqtt')==='mqtt'&&d.prefix&&(topic===d.prefix||topic.startsWith(d.prefix+'/')));
  if (!dev) return;
  const sfx = topic.slice(dev.prefix.length+1);

  if (sfx==='v') {
    try {
      const data=JSON.parse(payload); let ch=false;
      if (Array.isArray(data.relays)) { dev.relays=data.relays.map(r=>({...r,state:r.on})); dev.status='online'; dev.lastSeen=Date.now(); ch=true; }
      if (Array.isArray(data.sensors)) {
        const prev=dev.sensors||[]; dev.sensors=data.sensors;
        if (prev.length!==data.sensors.length) ch=true;
        else data.sensors.forEach(s=>patchSensor(dev,s));
      }
      if (ch) { renderSidebar(); if(activeId===dev.id) renderDevice(dev.id); }
    } catch {}
    return;
  }
  if (sfx==='status') {
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline'; dev.lastSeen=Date.now();
    if (dev.status==='online'&&!was) setTimeout(()=>pub(dev.prefix+'/ping','1',false),400);
    renderSidebar(); if(activeId===dev.id) renderDevice(dev.id); return;
  }
  let m=sfx.match(/^relay\/(\d+)\/v$/);
  if (m) {
    const id=parseInt(m[1]); if(!dev.relays)dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if (!r) { r={id,name:'Relay '+(id+1),on:false,state:false}; dev.relays.push(r); dev.relays.sort((a,b)=>a.id-b.id); }
    r.on=payload.trim().toLowerCase()==='on'; r.state=r.on;
    dev.status='online'; dev.lastSeen=Date.now();
    if(activeId===dev.id) patchCard(dev,r); renderSidebar(); return;
  }
  m=sfx.match(/^sensor\/(\d+)\/v$/);
  if (m) {
    const id=parseInt(m[1]); if(!dev.sensors)dev.sensors=[];
    let s=dev.sensors.find(s=>s.id===id); const active=payload.trim().toLowerCase()==='active';
    if (!s) { s={id,name:'Sensor '+(id+1),active}; dev.sensors.push(s); dev.sensors.sort((a,b)=>a.id-b.id); dev.status='online'; dev.lastSeen=Date.now(); if(activeId===dev.id)renderDevice(dev.id); }
    else { s.active=active; dev.status='online'; dev.lastSeen=Date.now(); patchSensor(dev,s); }
    return;
  }
}

/* ══════════════════════════════════════════════════════
   RELAY CONTROLLER COMMANDS (MQTT)
══════════════════════════════════════════════════════ */
function toggleRelay(dId,rId,on) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){toggleWR(dId,rId,on);return;}
  pubJ(d.prefix+'/relay/'+rId+'/api',{on});
  const r=d.relays?.find(r=>r.id===rId); if(r){r.on=on;r.state=on;patchCard(d,r);patchMeta(d);}
}
function pulseRelay(dId,rId) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){pulseWR(dId,rId);return;}
  const ms=parseInt($('pm-'+dId+'-'+rId)?.value)||500;
  pubJ(d.prefix+'/relay/'+rId+'/api',{pulse:ms}); toast('Pulse '+ms+'ms');
}
function timerRelay(dId,rId) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){timerWR(dId,rId);return;}
  const s=parseInt($('ts-'+dId+'-'+rId)?.value)||30;
  pubJ(d.prefix+'/relay/'+rId+'/api',{timer:s}); toast('Timer '+s+'s');
}
function allOff(dId) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){allOffW(dId);return;}
  pubJ(d.prefix+'/api',{on:false});
  d.relays?.forEach(r=>{r.on=false;r.state=false;patchCard(d,r);}); patchMeta(d); toast('All OFF','err');
}
function allOn(dId) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){allOnW(dId);return;}
  pubJ(d.prefix+'/api',{on:true});
  d.relays?.forEach(r=>{r.on=true;r.state=true;patchCard(d,r);}); patchMeta(d); toast('All ON','ok');
}
function sendCmd(dId) {
  const d=getD(dId); if(!d) return;
  if(isW(d)){sendCmdW(dId);return;}
  const raw=$('cmd-'+dId)?.value.trim(); if(!raw) return;
  try{JSON.parse(raw);}catch(e){toast('Invalid JSON: '+e.message,'err');return;}
  pub(d.prefix+'/api',raw); toast('Sent','ok');
}
function pingDev(id) {
  const d=getD(id); if(!d) return;
  if(isW(d)){pollJson(d);if(!IS_HTTPS){const ws=wsSock[id];if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({v:1}));}toast('↻ Refreshing…');return;}
  pub(d.prefix+'/ping','1',false); toast('↻ Ping sent');
}

/* ══════════════════════════════════════════════════════
   WLED — DUAL-MODE
   ────────────────────────────────────────────────────
   Commands:   HTTP fetch (always — works from HTTP+HTTPS)
   Real-time:  WebSocket on HTTP | MQTT subs on HTTPS
   Polling:    /json every 3s (always)
══════════════════════════════════════════════════════ */

/* HTTP helper — no IS_HTTPS guard (browsers allow HTTP fetch to local IPs) */
async function hfetch(dev, path, opts={}) {
  if (!dev.host) return null;
  try { const r=await fetch('http://'+dev.host+path, opts); if(!r.ok) throw new Error(r.status); return r; }
  catch(e) { console.warn('[HTTP]', dev.host+path, e.message); return null; }
}

const swStr = (dev,oid,oval) => {
  const rs=dev.relays||[]; if(!rs.length) return oval?'1':'0';
  return rs.map(r=>r.id===oid?(oval?1:0):(r.on?1:0)).join(',');
};

/* ── Connect: WS (HTTP) + poll (always) + MQTT subs (HTTPS) ── */
function wledConnect(dev) {
  wledWsClose(dev);

  if (!IS_HTTPS && dev.host) {
    // WebSocket — HTTP pages only
    try {
      const ws=new WebSocket('ws://'+dev.host+'/ws');
      wsSock[dev.id]=ws;
      ws.onopen    = () => { dev.status='online'; dev.lastSeen=Date.now(); renderSidebar(); if(activeId===dev.id)renderDevice(dev.id); try{ws.send(JSON.stringify({v:1}));}catch{} };
      ws.onmessage = e => { try{handleWledWs(dev,JSON.parse(e.data));}catch{} };
      ws.onclose   = () => { dev.status='offline'; delete wsSock[dev.id]; renderSidebar(); if(activeId===dev.id)renderDevice(dev.id); schedRecon(dev); };
      ws.onerror   = () => { dev.status='offline'; };
    } catch { schedRecon(dev); }
  }

  if (dev.host) {
    // /json polling — always
    clearInterval(jsonPoll[dev.id]);
    jsonPoll[dev.id] = setInterval(()=>pollJson(dev), 3000);
    pollJson(dev);
    // /api/pins polling — if gpioPrefix set
    if (dev.gpioPrefix) {
      clearInterval(gpioPoll[dev.id]);
      gpioPoll[dev.id] = setInterval(()=>pollGpioPins(dev), 3000);
      pollGpioPins(dev);
    }
  }

  if (IS_HTTPS && connected) {
    if (dev.wledTopic) wledMqttSub(dev);
    if (dev.gpioPrefix) gpioMqttSub(dev);
  }
}

function schedRecon(dev) {
  clearTimeout(wsRecon[dev.id]);
  wsRecon[dev.id] = setTimeout(()=>{ if(getD(dev.id)) wledConnect(dev); }, 5000);
}

function wledWsClose(dev) {
  const ws=wsSock[dev.id];
  if (ws) { ws.onclose=null; try{ws.close();}catch{} delete wsSock[dev.id]; }
  clearTimeout(wsRecon[dev.id]); delete wsRecon[dev.id];
  clearInterval(jsonPoll[dev.id]); delete jsonPoll[dev.id];
  clearInterval(gpioPoll[dev.id]); delete gpioPoll[dev.id];
}
function wledDisconnect(dev) {
  wledWsClose(dev);
  if (connected) { if(dev.wledTopic)wledMqttUnsub(dev); if(dev.gpioPrefix)gpioMqttUnsub(dev); }
  dev.status='offline';
}

/* ── WLED MQTT sub/unsub ── */
function wledMqttSub(dev) {
  if (!connected||!dev.wledTopic) return;
  try { ['g','c','v','status'].forEach(s=>mqttCl.subscribe(dev.wledTopic+'/'+s)); mqttCl.subscribe(dev.wledTopic+'/relay/+/state'); }
  catch(e) { console.warn('[wled sub]',e); }
  pub(dev.wledTopic, String(dev.wledState?.bri||255), false);
}
function wledMqttUnsub(dev) {
  if (!connected||!dev.wledTopic) return;
  ['g','c','v','status'].forEach(s=>{try{mqttCl.unsubscribe(dev.wledTopic+'/'+s);}catch{}});
  try{mqttCl.unsubscribe(dev.wledTopic+'/relay/+/state');}catch{}
}

/* ── WLED MQTT handler ── */
function handleWledMqtt(dev, sfx, payload) {
  if(!dev.wledState) dev.wledState={};
  dev.lastSeen=Date.now(); dev.status='online';
  if (sfx==='g') {
    const bri=parseInt(payload)||0; dev.wledState.bri=bri; dev.wledState.on=bri>0;
    const sl=$('bri-m-'+dev.id); if(sl){sl.value=bri; const v=$('briv-'+dev.id); if(v)v.textContent=bri;}
    if (!dev.hasMultiRelay) {
      if (!dev.relays?.length) { dev.relays=[{id:0,name:'Master',on:bri>0,state:bri>0,bri,col:null}]; if(activeId===dev.id)renderDevice(dev.id); }
      else { dev.relays.forEach(r=>{r.on=bri>0;r.state=bri>0;patchCard(dev,r);}); patchMeta(dev); }
    }
    renderSidebar(); return;
  }
  if (sfx==='c') { dev.wledState.color=payload.trim(); return; }
  if (sfx==='v') {
    const p=parseWledXml(payload);
    if (p) {
      dev.wledState.on=p.on; dev.wledState.bri=p.bri;
      const sl=$('bri-m-'+dev.id); if(sl){sl.value=p.bri; const v=$('briv-'+dev.id); if(v)v.textContent=p.bri;}
      if (!dev.hasMultiRelay&&p.segs.length&&!dev.relays?.length) {
        dev.relays=p.segs.map(s=>({id:s.id,name:s.n||'Seg '+s.id,on:s.on,state:s.on,bri:s.bri,col:null}));
        renderSidebar(); if(activeId===dev.id)renderDevice(dev.id); return;
      }
    }
    renderSidebar(); if(activeId===dev.id)renderDevice(dev.id); return;
  }
  let m=sfx.match(/^relay\/(\d+)\/state$/);
  if (m) {
    const id=parseInt(m[1]),on=payload.trim().toLowerCase()==='on';
    if(!dev.relays) dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if(!r){r={id,name:'Relay '+(id+1),on,state:on,bri:255,col:null};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);dev.hasMultiRelay=true;renderSidebar();if(activeId===dev.id)renderDevice(dev.id);return;}
    r.on=on;r.state=on;dev.hasMultiRelay=true;
    if(activeId===dev.id){patchCard(dev,r);patchMeta(dev);}
    renderSidebar(); return;
  }
  if (sfx==='status') {
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline';
    if(dev.status==='online'&&!was) setTimeout(()=>{if(dev.wledTopic&&connected)pub(dev.wledTopic,String(dev.wledState?.bri||255),false);},400);
    renderSidebar(); if(activeId===dev.id)renderDevice(dev.id);
  }
}

function parseWledXml(xml) {
  try {
    const doc=new DOMParser().parseFromString(xml,'text/xml');
    const g=t=>doc.querySelector(t)?.textContent||null;
    const ac=parseInt(g('ac')||'0'),segs=[];
    doc.querySelectorAll('seg').forEach(s=>{
      const id=parseInt(s.querySelector('id')?.textContent||'-1');
      if(id>=0) segs.push({id,on:(s.querySelector('on')?.textContent||'0')!=='0',bri:parseInt(s.querySelector('bri')?.textContent||'0'),n:s.querySelector('n')?.textContent||null});
    });
    return {on:ac>0,bri:ac,segs};
  } catch { return null; }
}

/* ── /json polling ── */
async function pollJson(dev) {
  if (!dev.host) return;
  try {
    const res=await fetch('http://'+dev.host+'/json',{signal:AbortSignal.timeout(2500)});
    const data=await res.json();
    dev.lastSeen=Date.now(); const was=dev.status!=='online'; dev.status='online';
    if(!dev.wledState) dev.wledState={};
    if(data.state?.bri!==undefined) dev.wledState.bri=data.state.bri;
    if(data.state?.on !==undefined) dev.wledState.on =data.state.on;
    const mr=data.state?.MultiRelay;
    if (mr&&Array.isArray(mr.relays)) {
      dev.hasMultiRelay=true;
      const ex=dev.relays||[];
      const nr=mr.relays.map(r=>{const o=ex.find(x=>x.id===r.relay)||{};return{id:r.relay,name:o.name||'Relay '+(r.relay+1),on:!!r.state,state:!!r.state,bri:255,col:null};});
      if(nr.length!==ex.length){dev.relays=nr;if(activeId===dev.id)renderDevice(dev.id);}
      else{nr.forEach((r,i)=>{if(r.on!==ex[i]?.on){dev.relays[i]=r;if(activeId===dev.id)patchCard(dev,r);}});if(activeId===dev.id)patchMeta(dev);}
    }
    if(data.effects) dev.wledEffects=data.effects;
    dev._miss=0; if(was){renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}
  } catch {
    dev._miss=(dev._miss||0)+1;
    if(dev._miss>=3){dev.status='offline';dev._miss=0;renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}
  }
}

/* ── WebSocket state (HTTP mode) ── */
function handleWledWs(dev, data) {
  if(!dev.wledState) dev.wledState={};
  dev.lastSeen=Date.now(); dev.status='online';
  if(data.effects) dev.wledEffects=data.effects;
  const st=data.state||data;
  if(st.on!==undefined)  dev.wledState.on =st.on;
  if(st.bri!==undefined) dev.wledState.bri=st.bri;
  if(!dev.hasMultiRelay) {
    const segs=st.seg||[];
    if(segs.length&&!dev.relays?.length){
      dev.relays=segs.map(s=>({id:s.id,name:s.n||'Seg '+s.id,on:!!s.on,state:!!s.on,bri:s.bri??128,col:s.col||null}));
      if(activeId===dev.id) renderDevice(dev.id);
    }
  }
}

/* ── LED controls — HTTP POST if host, else MQTT ── */
function wledSend(dev, obj) {
  if (dev.host) { hfetch(dev,'/json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)}); return true; }
  if (!dev.wledTopic) { toast('No MQTT topic set','err'); return false; }
  if (!connected) { toast('Connect broker first','err'); return false; }
  return pubJ(dev.wledTopic+'/api',obj);
}
function wledCmd(dev, cmd) {
  if (dev.host) {
    const obj=cmd==='ON'?{on:true}:cmd==='OFF'?{on:false}:cmd==='T'?{on:'toggle'}:{bri:parseInt(cmd)||128};
    hfetch(dev,'/json',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)}); return true;
  }
  if (!dev.wledTopic) { toast('No IP or MQTT topic','err'); return false; }
  if (!connected)     { toast('Connect broker first','err'); return false; }
  return pub(dev.wledTopic,cmd,false);
}

function wledMasterToggle(id,on) { const d=getD(id); if(d){if(!d.wledState)d.wledState={};d.wledState.on=on;wledCmd(d,on?'ON':'OFF');} }
function wledBriCommit(id,v)     { const d=getD(id); if(d){const b=parseInt(v);if(!d.wledState)d.wledState={};d.wledState.bri=b;wledCmd(d,String(b));} }
function wledFxChange(id,fx)     { const d=getD(id); if(d) wledSend(d,{seg:[{id:0,fx:parseInt(fx)}]}); }
function wledSegBri(id,sid,v)    { const d=getD(id); if(d) wledSend(d,{seg:[{id:sid,bri:parseInt(v)}]}); }

/* ── WLED Relay commands ── */
function toggleWR(dId,rId,on) {
  const d=getD(dId); if(!d) return;
  if(d.host) hfetch(d,'/relays?switch='+swStr(d,rId,on));
  else if(d.wledTopic&&connected) pub(d.wledTopic+'/relay/'+rId+'/command',on?'on':'off',false);
  else { toast('No IP or MQTT topic','err'); return; }
  const r=d.relays?.find(r=>r.id===rId); if(r){r.on=on;r.state=on;patchCard(d,r);patchMeta(d);}
}
function pulseWR(dId,rId) {
  const d=getD(dId); if(!d) return;
  const ms=parseInt($('pm-'+dId+'-'+rId)?.value)||500;
  if(d.host){ hfetch(d,'/relays?switch='+swStr(d,rId,true)); setTimeout(()=>hfetch(d,'/relays?switch='+swStr(d,rId,false)),ms); }
  else if(d.wledTopic&&connected){ pub(d.wledTopic+'/relay/'+rId+'/command','on',false); setTimeout(()=>pub(d.wledTopic+'/relay/'+rId+'/command','off',false),ms); }
  else { toast('No connection','err'); return; }
  const r=d.relays?.find(r=>r.id===rId); if(r){r.on=true;r.state=true;patchCard(d,r);patchMeta(d);}
  toast('Pulse '+ms+'ms → R'+(rId+1));
}
function timerWR(dId,rId) {
  const d=getD(dId); if(!d) return;
  const s=parseInt($('ts-'+dId+'-'+rId)?.value)||30;
  if(d.host){ hfetch(d,'/relays?switch='+swStr(d,rId,true)); setTimeout(()=>hfetch(d,'/relays?switch='+swStr(d,rId,false)),s*1000); }
  else if(d.wledTopic&&connected){ pub(d.wledTopic+'/relay/'+rId+'/command','on',false); setTimeout(()=>pub(d.wledTopic+'/relay/'+rId+'/command','off',false),s*1000); }
  else { toast('No connection','err'); return; }
  const r=d.relays?.find(r=>r.id===rId); if(r){r.on=true;r.state=true;patchCard(d,r);patchMeta(d);}
  toast('Timer '+s+'s → R'+(rId+1));
}
function allOffW(dId) {
  const d=getD(dId); if(!d) return; const n=d.relays?.length||4;
  if(d.host) hfetch(d,'/relays?switch='+Array(n).fill(0).join(','));
  else if(d.wledTopic&&connected) d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','off',false));
  else { toast('No connection','err'); return; }
  d.relays?.forEach(r=>{r.on=false;r.state=false;patchCard(d,r);}); patchMeta(d); toast('All OFF','err');
}
function allOnW(dId) {
  const d=getD(dId); if(!d) return; const n=d.relays?.length||4;
  if(d.host) hfetch(d,'/relays?switch='+Array(n).fill(1).join(','));
  else if(d.wledTopic&&connected) d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','on',false));
  else { toast('No connection','err'); return; }
  d.relays?.forEach(r=>{r.on=true;r.state=true;patchCard(d,r);}); patchMeta(d); toast('All ON','ok');
}
function sendCmdW(dId) {
  const d=getD(dId); if(!d) return;
  const raw=$('cmd-'+dId)?.value.trim(); if(!raw) return;
  if(raw.startsWith('{')) {
    try{wledSend(d,JSON.parse(raw));toast('Sent → JSON','ok');}
    catch(e){toast('Invalid JSON: '+e.message,'err');}
  } else if(d.host&&raw.includes('=')) {
    hfetch(d,'/win?'+raw.replace(/^win[?&]?/i,'')).then(r=>{ if(r){toast('Sent → /win','ok');setTimeout(()=>pollJson(d),400);}});
  } else {
    wledCmd(d,raw); toast('Sent','ok');
  }
}

/* ══════════════════════════════════════════════════════
   GPIO MONITOR  (HTTP polling always + MQTT on HTTPS)
══════════════════════════════════════════════════════ */
const GPIO_MODES={0:'disabled',1:'input',2:'inp_pu',3:'inp_pd',4:'output'};

function gpioMqttSub(dev) {
  if(!connected||!dev.gpioPrefix) return;
  try{['/pin/+/v','/v','/status'].forEach(s=>mqttCl.subscribe(dev.gpioPrefix+s));}catch(e){console.warn('[gpio sub]',e);}
  pub(dev.gpioPrefix+'/ping','1',false);
}
function gpioMqttUnsub(dev) {
  if(!connected||!dev.gpioPrefix) return;
  ['/pin/+/v','/v','/status'].forEach(s=>{try{mqttCl.unsubscribe(dev.gpioPrefix+s);}catch{}});
}
function handleGpioMqtt(dev,sfx,payload) {
  dev.lastSeen=Date.now(); dev.status='online';
  if(sfx==='v'){
    try{const d=JSON.parse(payload);if(Array.isArray(d.pins)){dev.gpioPins=d.pins;renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}}catch{}
    return;
  }
  const m=sfx.match(/^pin\/(\d+)\/v$/);
  if(m){
    const id=parseInt(m[1]),hi=payload.trim().toLowerCase()==='high';
    if(!dev.gpioPins) dev.gpioPins=[];
    let p=dev.gpioPins.find(p=>p.id===id);
    if(!p){p={id,name:'GPIO '+id,mode:1,state:hi,alert:false};dev.gpioPins.push(p);dev.gpioPins.sort((a,b)=>a.id-b.id);if(activeId===dev.id)renderDevice(dev.id);}
    else{p.state=hi;if(activeId===dev.id)patchGpio(dev,p);}
    renderSidebar(); return;
  }
  if(sfx==='status'){dev.status=payload.trim().toLowerCase()==='online'?'online':'offline';renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}
}
async function pollGpioPins(dev) {
  if(!dev.host||!dev.gpioPrefix) return;
  try{
    const res=await fetch('http://'+dev.host+'/api/pins',{signal:AbortSignal.timeout(2500)});
    const data=await res.json();
    if(Array.isArray(data.pins)){
      const prev=dev.gpioPins||[]; dev.gpioPins=data.pins;
      if(prev.length!==data.pins.length){if(activeId===dev.id)renderDevice(dev.id);}
      else data.pins.forEach(p=>{if(activeId===dev.id)patchGpio(dev,p);});
    }
    dev._gm=0;
  }catch{dev._gm=(dev._gm||0)+1;if(dev._gm>=3&&activeId===dev.id)renderDevice(dev.id);}
}
function toggleGpio(dId,pId,on) {
  const d=getD(dId); if(!d) return;
  const body=JSON.stringify({state:on}),opts={method:'POST',headers:{'Content-Type':'application/json'},body};
  if(d.host) hfetch(d,'/api/pin?id='+pId,opts);
  else if(d.gpioPrefix&&connected) pubJ(d.gpioPrefix+'/pin/'+pId+'/set',{state:on});
  else{toast('No connection','err');return;}
  const p=d.gpioPins?.find(p=>p.id===pId); if(p){p.state=on;patchGpio(d,p);}
}
function pulseGpio(dId,pId) {
  const d=getD(dId); if(!d) return;
  const ms=parseInt($('gpm-'+dId+'-'+pId)?.value)||500;
  const body=JSON.stringify({pulse:ms}),opts={method:'POST',headers:{'Content-Type':'application/json'},body};
  if(d.host) hfetch(d,'/api/pin?id='+pId,opts);
  else if(d.gpioPrefix&&connected) pubJ(d.gpioPrefix+'/pin/'+pId+'/set',{pulse:ms});
  else{toast('No connection','err');return;}
  toast('Pulse '+ms+'ms → GPIO '+pId);
}

/* ══════════════════════════════════════════════════════
   PATTERN SEQUENCER  (repeat = total plays; -1 = ∞)
══════════════════════════════════════════════════════ */
const getPat = id => { if(!patterns[id]) patterns[id]={steps:[],repeat:-1,cur:0,rem:0,timer:null,running:false}; return patterns[id]; };
function patAdd(dId) { const d=getD(dId);if(!d)return;const p=getPat(dId),l=p.steps[p.steps.length-1];p.steps.push({mask:l?l.mask:0,duration_ms:l?l.duration_ms:500});renderPatSteps(dId); }
function patDel(dId,i){ const p=patterns[dId];if(!p)return;p.steps.splice(i,1);renderPatSteps(dId); }
function patBit(dId,si,rid,on){ const p=getPat(dId);if(!p.steps[si])return;on?(p.steps[si].mask|=(1<<rid)):(p.steps[si].mask&=~(1<<rid)); }
function patDur(dId,si,v){ const p=getPat(dId);if(p.steps[si])p.steps[si].duration_ms=Math.max(50,parseInt(v)||500); }
function patToggle(dId){ const p=getPat(dId);p.running?patStop(dId):patStart(dId); }
function patClear(dId){ patStop(dId);if(patterns[dId])patterns[dId].steps=[];renderPatSteps(dId);const s=$('pst-'+dId);if(s)s.textContent=''; }
function patStart(dId) {
  const d=getD(dId);if(!d)return;
  const p=getPat(dId);if(!p.steps.length){toast('Add at least one step','err');return;}
  p.running=true;p.cur=0;
  const re=$('prep-'+dId);p.repeat=re?parseInt(re.value):-1;p.rem=p.repeat;
  const btn=$('pbtn-'+dId);if(btn){btn.textContent='■ Stop';btn.className='btn btn-red';}
  patExec(dId);
}
function patStop(dId) {
  const p=patterns[dId];if(!p)return;
  if(p.timer){clearTimeout(p.timer);p.timer=null;}
  p.running=false;
  const btn=$('pbtn-'+dId);if(btn){btn.textContent='▶ Run';btn.className='btn btn-amber';}
  const s=$('pst-'+dId);if(s)s.textContent='';
  renderPatSteps(dId);
  const d=getD(dId);if(!d)return;const n=d.relays?.length||4;
  if(d.host) hfetch(d,'/relays?switch='+Array(n).fill(0).join(','));
  else if(d.wledTopic&&connected) d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','off',false));
}
function patExec(dId) {
  const d=getD(dId);if(!d)return;
  const p=patterns[dId];if(!p||!p.running)return;
  const step=p.steps[p.cur];if(!step){patStop(dId);return;}
  const rs=d.relays||[];
  if(d.host) hfetch(d,'/relays?switch='+rs.map(r=>((step.mask>>r.id)&1)?1:0).join(','));
  else if(d.wledTopic&&connected) rs.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command',((step.mask>>r.id)&1)?'on':'off',false));
  rs.forEach(r=>{const on=!!((step.mask>>r.id)&1);r.on=on;r.state=on;patchCard(d,r);}); patchMeta(d);
  renderPatSteps(dId);
  const s=$('pst-'+dId);
  if(s)s.textContent=`step ${p.cur+1}/${p.steps.length}${p.repeat>0?' · rep '+(p.repeat-p.rem+1)+'/'+p.repeat:''}`;
  p.timer=setTimeout(()=>{
    if(!p.running)return;
    p.cur++;
    if(p.cur>=p.steps.length){
      if(p.repeat===-1){p.cur=0;patExec(dId);}
      else{p.rem--;if(p.rem>0){p.cur=0;patExec(dId);}else patStop(dId);}
    } else patExec(dId);
  }, step.duration_ms);
}
function patCleanup(dId){patStop(dId);delete patterns[dId];}
function renderPatSteps(dId) {
  const d=getD(dId);if(!d)return;
  const p=getPat(dId),c=$('psteps-'+dId);if(!c)return;
  if(!p.steps.length){c.innerHTML='<div class="pat-empty">No steps — click <b>+ Step</b> to add one.</div>';return;}
  c.innerHTML=p.steps.map((step,i)=>`
    <div class="pstep ${p.running&&p.cur===i?'cur':''}">
      <span class="pstep-n">${String(i+1).padStart(2,'0')}</span>
      <div class="pstep-relays">
        ${(d.relays||[]).map(r=>`<label class="pstep-chk"><input type="checkbox" ${(step.mask>>r.id)&1?'checked':''} onchange="patBit('${dId}',${i},${r.id},this.checked)"> R${r.id+1}</label>`).join('')}
      </div>
      <div class="pstep-dur">
        <input type="number" value="${step.duration_ms}" min="50" max="60000" class="act-num" style="width:54px" onchange="patDur('${dId}',${i},this.value)">
        <span>ms</span>
      </div>
      <button class="pstep-del" onclick="patDel('${dId}',${i})">✕</button>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════
   UI — SIDEBAR (right panel)
══════════════════════════════════════════════════════ */
function setConnUI(on) {
  $('conn-dot').className='conn-dot'+(on?' on':'');
  $('conn-pill').className='conn-pill'+(on?' online':'');
  $('conn-lbl').textContent=on?'Online':'Offline';
  const tb=$('tb-broker');tb.textContent=on?'CONNECTED':'DISCONNECTED';tb.style.color=on?'var(--green)':'var(--red)';
  $('btn-conn').style.display=on?'none':'';
  $('btn-disc').style.display=on?'':'none';
}
function showErr(m){const e=$('conn-err');e.textContent=m;e.classList.remove('hidden');}
function clearErr(){const e=$('conn-err');e.textContent='';e.classList.add('hidden');}

function renderSidebar() {
  const list=$('dev-list');list.innerHTML='';
  if(!devices.length){list.innerHTML='<div style="padding:8px 10px;font-size:9px;color:var(--text-d)">No devices yet.</div>';$('tb-devices').textContent='0';return;}
  devices.forEach(dev=>{
    const online=dev.status==='online';
    const wled=isW(dev);
    const badge=wled
      ?`<span class="chip ${dev.hasMultiRelay?'chip-amber':'chip-cyan'}">${dev.hasMultiRelay?'W+R':'WLED'}</span>${dev.gpioPins?.length?'<span class="chip chip-violet">GPIO</span>':''}`
      :`<span class="chip chip-dim">MQTT</span>`;
    const el=document.createElement('div');
    el.className='dev-item'+(dev.id===activeId?' active':'');
    el.innerHTML=`
      <span class="dev-dot ${online?'on':''}"></span>
      <span class="dev-name">${esc(dev.name)}</span>
      ${badge}
      <button class="dev-remove" onclick="removeDevice('${dev.id}',event)">✕</button>`;
    el.onclick=e=>{if(e.target.closest('.dev-remove'))return;selectDevice(dev.id);};
    list.appendChild(el);
  });
  $('tb-devices').textContent=devices.length;
}
function selectDevice(id){activeId=id;renderSidebar();renderDevice(id);}

/* ══════════════════════════════════════════════════════
   UI — MAIN PANEL
══════════════════════════════════════════════════════ */
function renderDevice(id) {
  const main=$('main'), dev=getD(id);
  if(!dev){main.innerHTML=mkEmpty('📡','No Device Selected','Add a device using the right panel.');return;}

  const relays=dev.relays||[], sensors=dev.sensors||[], gpio=dev.gpioPins||[];
  const online=dev.status==='online', active=relays.filter(r=>r.state).length, wled=isW(dev);

  // Tabs
  const tabs=[{id:'relays',label:'Relays'}];
  if(wled&&dev.hasMultiRelay) tabs.push({id:'pattern',label:'Pattern'});
  if(!wled&&sensors.length)   tabs.push({id:'sensors',label:'Sensors'});
  if(wled&&gpio.length)       tabs.push({id:'gpio',label:'GPIO'});
  tabs.push({id:'cmd',label:'CMD'});
  let tab=curTabs[dev.id]||'relays';
  if(!tabs.find(t=>t.id===tab)) tab=tabs[0].id;
  curTabs[dev.id]=tab;

  main.innerHTML=`
    ${wled&&!dev.host?`<div class="warn-banner">⚠ No WLED IP set — HTTP commands and polling unavailable. Edit the device and enter the WLED IP address.</div>`:''}

    <div class="dev-header">
      <div class="dev-hd-left">
        <div class="dev-title">${esc(dev.name)}</div>
        <span class="dev-addr">${esc(wled?(IS_HTTPS?dev.wledTopic||dev.host||'':dev.host||dev.wledTopic||''):dev.prefix)}</span>
        <div class="pills">
          <span id="pill-st-${dev.id}" class="pill ${online?'pill-green':'pill-red'}">${online?'ONLINE':'OFFLINE'}</span>
          ${wled
            ?`<span class="pill pill-cyan">${dev.hasMultiRelay?'WLED+RELAYS':'WLED'}</span>${dev.host?`<span class="pill pill-green">HTTP ✓</span>`:''}`
            :`<span class="pill pill-amber">MQTT</span>`}
          <span id="pill-ct-${dev.id}" class="pill pill-dim">${relays.length} relays</span>
          <span id="pill-ac-${dev.id}" class="pill ${active?'pill-amber':'pill-dim'}">${active} active</span>
          ${!wled&&sensors.length?`<span class="pill pill-green">${sensors.length} sensors</span>`:''}
          ${wled&&gpio.length?`<span class="pill pill-violet">${gpio.length} GPIO</span>`:''}
          <span id="ls-${dev.id}" class="last-seen">${dev.lastSeen?'seen '+ago(dev.lastSeen):''}</span>
        </div>
      </div>
      <div class="dev-actions">
        <button onclick="pingDev('${dev.id}')" class="btn btn-ghost">↻ Ping</button>
        <button onclick="openEdit('${dev.id}')" class="btn btn-ghost">✎ Edit</button>
        <button onclick="allOff('${dev.id}')" class="btn btn-red">All Off</button>
        <button onclick="allOn('${dev.id}')" class="btn btn-green">All On</button>
      </div>
    </div>

    ${wled?`
    <div class="led-bar">
      <span class="led-bar-lbl">LED</span>
      <div class="led-bar-master">
        <label class="tgl">
          <input type="checkbox" ${dev.wledState?.on?'checked':''} onchange="wledMasterToggle('${dev.id}',this.checked)">
          <div class="tgl-t cyan"></div>
        </label>
        Master
      </div>
      <div class="led-bar-bri">
        <span class="led-bar-bri-lbl">BRI</span>
        <input type="range" min="0" max="255" value="${dev.wledState?.bri??128}" id="bri-m-${dev.id}"
          oninput="$('briv-${dev.id}').textContent=this.value" onchange="wledBriCommit('${dev.id}',this.value)">
        <span id="briv-${dev.id}" class="led-bar-bri-val">${dev.wledState?.bri??128}</span>
      </div>
      ${dev.wledEffects?`<select onchange="wledFxChange('${dev.id}',this.value)" class="inp" style="width:140px;font-size:9px;padding:5px 7px">
        ${dev.wledEffects.filter(n=>n!=='RSVD'&&n!=='-').map((n,i)=>`<option value="${i}">${esc(n)}</option>`).join('')}
      </select>`:''}
    </div>`:''}

    <div class="tab-bar">
      ${tabs.map(t=>`<button class="tab ${t.id===tab?'active':''}" data-dev="${dev.id}" data-tab="${t.id}" onclick="switchTab('${dev.id}','${t.id}')">${t.label}</button>`).join('')}
    </div>

    <div class="tab-panel ${tab==='relays'?'active':''}" data-dev="${dev.id}" data-tab="relays">
      <div class="relay-grid">
        ${relays.length?relays.map(r=>cardHTML(dev,r)).join(''):mkEmpty('🔌','No relay data',online?(wled&&!dev.host?'Set WLED IP and refresh.':'Click ↻ Ping.'):'Device offline.')}
      </div>
    </div>

    ${wled&&dev.hasMultiRelay?`
    <div class="tab-panel ${tab==='pattern'?'active':''}" data-dev="${dev.id}" data-tab="pattern">
      <div class="pat-hd">
        <span class="pat-title">⟳ Relay Pattern</span>
        <span id="pst-${dev.id}" class="pat-status"></span>
        <div class="pat-ctrl">
          <select id="prep-${dev.id}" class="inp" style="width:90px;font-size:9px;padding:5px 7px">
            <option value="-1">∞ Loop</option>
            <option value="1">1× play</option><option value="2">2× play</option>
            <option value="5">5× play</option><option value="10">10× play</option>
          </select>
          <button onclick="patAdd('${dev.id}')" class="btn btn-cyan">+ Step</button>
          <button id="pbtn-${dev.id}" onclick="patToggle('${dev.id}')" class="btn btn-amber">▶ Run</button>
          <button onclick="patClear('${dev.id}')" class="btn btn-ghost">✕ Clear</button>
        </div>
      </div>
      <div id="psteps-${dev.id}" class="pat-steps">
        <div class="pat-empty">No steps — click <b>+ Step</b> to add one.</div>
      </div>
    </div>`:''}

    ${!wled&&sensors.length?`
    <div class="tab-panel ${tab==='sensors'?'active':''}" data-dev="${dev.id}" data-tab="sensors">
      <div class="sec-lbl">Sensors · ${sensors.length}</div>
      <div class="sensor-grid">${sensors.map(s=>sensorHTML(dev,s)).join('')}</div>
    </div>`:''}

    ${wled&&gpio.length?`
    <div class="tab-panel ${tab==='gpio'?'active':''}" data-dev="${dev.id}" data-tab="gpio">
      <div class="sec-lbl">GPIO Monitor · ${gpio.length} pins</div>
      <div class="gpio-grid">${gpio.map(p=>gpioHTML(dev,p)).join('')}</div>
    </div>`:''}

    <div class="tab-panel ${tab==='cmd'?'active':''}" data-dev="${dev.id}" data-tab="cmd">
      <div class="cmd-wrap">
        <div class="cmd-lbl">Command</div>
        <div class="cmd-row">
          <input id="cmd-${dev.id}" type="text" class="inp" style="flex:1"
            placeholder="${wled?'{"bri":128}  ·  FX=73&SX=128  ·  ON  ·  T':'{"on":true}  ·  {"relay":0,"on":true}'}"
            onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
          <button onclick="sendCmd('${dev.id}')" class="btn btn-cyan">Send</button>
        </div>
        <div class="cmd-hint">
          ${wled
            ?`<code>{"bri":128}</code>, <code>{"seg":[{"id":0,"fx":73}]}</code> → POST /json &nbsp;·&nbsp; <code>FX=73&amp;SX=128</code> → /win${dev.host?'':' (needs IP)'} &nbsp;·&nbsp; <code>ON</code> <code>OFF</code> <code>T</code> <code>0-255</code> → master`
            :`<code>{"on":true}</code> → all &nbsp;·&nbsp; <code>{"relay":0,"on":true}</code> → single &nbsp;·&nbsp; <code>{"relay":1,"pulse":500}</code> → pulse`}
        </div>
      </div>
    </div>`;

  if(wled&&dev.hasMultiRelay&&patterns[dev.id]?.steps.length) renderPatSteps(dev.id);
}

/* Fix switchTab — uses data attributes, not fragile onclick string matching */
function switchTab(devId, tabId) {
  curTabs[devId]=tabId;
  document.querySelectorAll(`[data-dev="${devId}"].tab`).forEach(b=>b.classList.toggle('active',b.dataset.tab===tabId));
  document.querySelectorAll(`[data-dev="${devId}"].tab-panel`).forEach(p=>p.classList.toggle('active',p.dataset.tab===tabId));
}

/* ── CARD HTML ── */
function cardHTML(dev,r) {
  const did=dev.id,rid=r.id,on=!!(r.on||r.state),wled=isW(dev);
  const showBri=wled&&!dev.hasMultiRelay, showPulse=!wled||dev.hasMultiRelay;
  const stateClass=on?(wled?'won':'on'):'';
  return `
    <div class="rcard ${stateClass}" id="rcard-${did}-${rid}">
      <div class="rcard-top">
        <div class="rcard-ind" id="rind-${did}-${rid}">${on?(wled?'●':'●'):'○'}</div>
        <div class="rcard-info">
          <div class="rcard-num">R${String(rid+1).padStart(2,'0')}</div>
          <div class="rcard-name">${esc(r.name||'Relay '+(rid+1))}</div>
          <span class="rcard-state" id="rsp-${did}-${rid}">${on?'ON':'OFF'}</span>
        </div>
        <label class="tgl">
          <input type="checkbox" ${on?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)">
          <div class="tgl-t${wled?' cyan':''}"></div>
        </label>
      </div>
      ${showBri?`<div class="rcard-bri"><span class="rcard-bri-lbl">BRI</span><input type="range" min="0" max="255" value="${r.bri??128}" oninput="this.nextElementSibling.textContent=this.value" onchange="wledSegBri('${did}',${rid},this.value)"><span class="rcard-bri-val">${r.bri??128}</span></div>`:''}
      ${showPulse?`<div class="rcard-actions">
        <div class="act-pair"><input id="pm-${did}-${rid}" type="number" value="500" min="50" class="act-num"><button onclick="pulseRelay('${did}',${rid})" class="act-btn">Pulse</button></div>
        <div class="act-pair"><input id="ts-${did}-${rid}" type="number" value="30" min="1" class="act-num"><button onclick="timerRelay('${did}',${rid})" class="act-btn">Timer</button></div>
      </div>`:''}
    </div>`;
}

function sensorHTML(dev,s) {
  const a=!!s.active, mode=s.trigger_mode&&s.trigger_mode!=='NONE'&&s.trigger_relay>=0?`→R${s.trigger_relay+1}·${s.trigger_mode}`:'';
  return `<div class="scrd ${a?'active':''}" id="scrd-${dev.id}-${s.id}">
    <div class="scrd-head">
      <span class="scrd-name">${esc(s.name||'Sensor '+(s.id+1))}</span>
      <span class="chip ${a?'chip-green pulsing':'chip-dim'}" id="scpill-${dev.id}-${s.id}">${a?'ACTIVE':'IDLE'}</span>
    </div>
    ${s.pin!==undefined?`<div class="scrd-meta">GPIO ${s.pin}${s.debounce_ms>0?` · ⏱${s.debounce_ms}ms`:''}${mode?' · '+mode:''}</div>`:''}
  </div>`;
}

function gpioHTML(dev,p) {
  const did=dev.id,pid=p.id,hi=!!p.state,isOut=p.mode===4;
  const cls=hi?(isOut?'hi-out':'hi-in'):'';
  return `<div class="gpcard ${cls}" id="gpcard-${did}-${pid}">
    <div class="gpcard-head">
      <div class="gpcard-id"><span class="gpcard-num">${String(pid).padStart(2,'0')}</span><span class="gpcard-name">${esc(p.name||'GPIO '+pid)}</span></div>
      <div class="gpcard-right">
        ${p.alert?`<span class="chip chip-red">⚠</span>`:''}
        <span class="chip chip-dim">${GPIO_MODES[p.mode]||'m'+p.mode}</span>
        <span class="gpcard-state" id="gpst-${did}-${pid}">${hi?'HIGH':'LOW'}</span>
        ${isOut?`<label class="tgl"><input type="checkbox" ${hi?'checked':''} onchange="toggleGpio('${did}',${pid},this.checked)"><div class="tgl-t"></div></label>`:''}
      </div>
    </div>
    <div class="gpcard-meta">${GPIO_MODES[p.mode]||'unknown'} · pin ${pid}${p.debounce_ms>0?' · ⏱'+p.debounce_ms+'ms':''}</div>
    ${isOut?`<div class="gpcard-pulse"><input id="gpm-${did}-${pid}" type="number" value="500" min="50" class="act-num"><button onclick="pulseGpio('${did}',${pid})" class="act-btn">Pulse</button></div>`:''}
  </div>`;
}

/* ── DOM patch helpers ── */
function patchCard(dev,r) {
  const card=$('rcard-'+dev.id+'-'+r.id); if(!card)return;
  const on=r.state,wled=isW(dev),cls=on?(wled?'won':'on'):'';
  card.className='rcard '+cls;
  const cb=card.querySelector('input[type=checkbox]'); if(cb)cb.checked=on;
  const sp=$('rsp-'+dev.id+'-'+r.id); if(sp)sp.textContent=on?'ON':'OFF';
  const ind=$('rind-'+dev.id+'-'+r.id); if(ind)ind.textContent=on?'●':'○';
}
function patchMeta(dev) {
  if(activeId!==dev.id)return;
  const a=(dev.relays||[]).filter(r=>r.state).length;
  const pa=$('pill-ac-'+dev.id); if(pa){pa.textContent=a+' active';pa.className='pill '+(a?'pill-amber':'pill-dim');}
}
function patchSensor(dev,s) {
  const card=$('scrd-'+dev.id+'-'+s.id); if(!card)return;
  const a=!!s.active; card.className='scrd '+(a?'active':'');
  const p=$('scpill-'+dev.id+'-'+s.id); if(p){p.textContent=a?'ACTIVE':'IDLE';p.className='chip '+(a?'chip-green pulsing':'chip-dim');}
}
function patchGpio(dev,p) {
  const card=$('gpcard-'+dev.id+'-'+p.id); if(!card)return;
  const hi=!!p.state,isOut=p.mode===4;
  card.className='gpcard '+(hi?(isOut?'hi-out':'hi-in'):'');
  const cb=card.querySelector('input[type=checkbox]'); if(cb)cb.checked=hi;
  const st=$('gpst-'+dev.id+'-'+p.id); if(st)st.textContent=hi?'HIGH':'LOW';
}
const mkEmpty=(ico,title,sub)=>`<div class="empty"><div class="empty-ico">${ico}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;

/* ══════════════════════════════════════════════════════
   DEVICE MANAGEMENT
══════════════════════════════════════════════════════ */
function onTypeChange(){const t=$('dm-type').value;$('dm-mqtt-fields').style.display=t==='mqtt'?'':'none';$('dm-wled-fields').style.display=t==='wled'?'':'none';}
function openAdd(){$('modal-title').textContent='Add Device';['dm-id','dm-name','dm-prefix','dm-host','dm-wtopic','dm-gpio-prefix'].forEach(i=>$(i).value='');$('dm-type').value='mqtt';$('dm-ping').value='10';onTypeChange();$('modal').classList.remove('hidden');setTimeout(()=>$('dm-name').focus(),100);}
function openEdit(id){const d=getD(id);if(!d)return;$('modal-title').textContent='Edit Device';$('dm-id').value=d.id;$('dm-name').value=d.name;$('dm-type').value=d.type||'mqtt';$('dm-prefix').value=d.prefix||'';$('dm-ping').value=d.pingInterval||10;$('dm-host').value=d.host||'';$('dm-wtopic').value=d.wledTopic||'';$('dm-gpio-prefix').value=d.gpioPrefix||'';onTypeChange();$('modal').classList.remove('hidden');}
function closeModal(){$('modal').classList.add('hidden');}

function saveDevice(){
  const existId=$('dm-id').value,name=$('dm-name').value.trim()||'Device',type=$('dm-type').value||'mqtt';
  const prefix=$('dm-prefix').value.trim().replace(/\/+$/,'')||'home/relay';
  const ping=parseInt($('dm-ping').value)||10;
  const host=$('dm-host').value.trim(),wledTopic=$('dm-wtopic').value.trim().replace(/\/+$/,''),gpioPrefix=$('dm-gpio-prefix').value.trim().replace(/\/+$/,'');
  if(type==='wled'&&!host&&!wledTopic){toast('Enter WLED IP or MQTT topic','err');return;}
  if(existId){
    const d=getD(existId);if(!d)return;
    if((d.type||'mqtt')==='mqtt'){unsubRelay(d);if(pingT[d.id]){clearInterval(pingT[d.id]);delete pingT[d.id];}}
    else wledDisconnect(d);
    Object.assign(d,{name,type,prefix,pingInterval:ping,host,wledTopic,gpioPrefix});
    if(type==='mqtt'&&connected){subRelay(d);startPing(d);}
    if(type==='wled') wledConnect(d);
  } else {
    const d={id:'dev-'+Date.now(),name,type,prefix,pingInterval:ping,host,wledTopic,gpioPrefix,status:'offline',lastSeen:null,relays:[],sensors:[],gpioPins:[]};
    devices.push(d);
    if(type==='mqtt'&&connected){subRelay(d);pubPresence(d,true);startPing(d);}
    if(type==='wled') wledConnect(d);
    selectDevice(d.id);
  }
  persist();renderSidebar();closeModal();toast('Saved','ok');
}

function removeDevice(id,e){
  if(e)e.stopPropagation();
  const d=getD(id);if(!d)return;
  if(!confirm('Remove "'+d.name+'"?'))return;
  if((d.type||'mqtt')==='mqtt'){unsubRelay(d);pubPresence(d,false);if(pingT[id]){clearInterval(pingT[id]);delete pingT[id];}}
  else{wledDisconnect(d);patCleanup(id);}
  devices=devices.filter(d=>d.id!==id);
  if(activeId===id) activeId=devices[0]?.id||null;
  persist();renderSidebar();
  if(activeId)renderDevice(activeId);
  else $('main').innerHTML=mkEmpty('📡','No Device Selected','Add a device using the right panel.');
}

/* ══════════════════════════════════════════════════════
   PERSIST + INIT
══════════════════════════════════════════════════════ */
function persist(){
  save({broker,devices:devices.map(({id,name,type,prefix,pingInterval,host,wledTopic,gpioPrefix})=>
    ({id,name,type:type||'mqtt',prefix,pingInterval:pingInterval||10,host:host||'',wledTopic:wledTopic||'',gpioPrefix:gpioPrefix||''}))});
}

(function init(){
  const ssl=IS_HTTPS;
  $('b-host').value=broker.host||(ssl?'broker.hivemq.com':'');
  $('b-port').value=broker.port||(ssl?8884:9001);
  $('b-user').value=broker.user||'';$('b-pass').value=broker.pass||'';
  $('b-ssl').checked=ssl||broker.ssl||false;
  if(ssl){$('b-ssl').disabled=true;$('https-note').classList.remove('hidden');}
  setConnUI(false);renderSidebar();
  devices.filter(d=>d.type==='wled').forEach(wledConnect);
  if(!activeId&&devices.length) activeId=devices[0].id;
  if(activeId) renderDevice(activeId);
  else $('main').innerHTML=mkEmpty('📡','No Device Selected','Add a relay controller (MQTT) or WLED device using the right panel.');
})();
