/* ═══════════════════════════════════════════════════
   RELAY CTRL — REMOTE DASHBOARD
   Single-file · Tailwind CSS · IBM Plex Mono
   MQTT/Paho for relay controllers + WLED on HTTPS
   WebSocket + HTTP for WLED on HTTP
═══════════════════════════════════════════════════ */

const SK = 'relayctrl_v3';
const IS_HTTPS = location.protocol === 'https:';
const $load = () => { try{return JSON.parse(localStorage.getItem(SK)||'{}');}catch{return{};} };
const $save = d => localStorage.setItem(SK, JSON.stringify(d));

/* ── STATE ── */
let mqttCl   = null;   // Paho client
let connected= false;
let pingT    = {};     // devId→interval
let wsSock   = {};     // devId→WebSocket
let wsRecon  = {};     // devId→timeout
let jsonPoll = {};     // devId→interval
let patterns = {};     // devId→pattern obj
let gpioPoll = {};     // devId→interval for /api/pins
let devices  = [];
let activeId = null;

const stored = $load();
const broker = stored.broker || {host:'',port:9001,user:'',pass:'',ssl:false};
devices = (stored.devices||[]).map(d=>({...d,status:'offline',relays:[],sensors:[],gpioPins:[]}));

/* ── UTILS ── */
const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ago  = ts => { const s=Math.floor((Date.now()-ts)/1000); return s<5?'just now':s<60?s+'s ago':Math.floor(s/60)+'m ago'; };
const getD = id => devices.find(d=>d.id===id);
const isW  = d  => (d?.type||'mqtt')==='wled';
const $    = id => document.getElementById(id);

/* ── CLOCK ── */
setInterval(()=>{$('clock').textContent=new Date().toTimeString().slice(0,8);},1000);
setInterval(()=>{devices.forEach(d=>{const e=$('ls-'+d.id);if(e&&d.lastSeen)e.textContent='seen '+ago(d.lastSeen);});},10000);

/* ── TOAST ── */
let toastT;
function toast(msg,type=''){
  const el=$('toast');el.textContent=msg;
  el.className=`fixed bottom-5 right-5 z-50 text-xs px-4 py-2.5 rounded-lg shadow-xl pointer-events-none transition-all duration-300 opacity-100 translate-y-0 ${
    type==='r'?'bg-red-900 border border-red-700 text-red-200':
    type==='g'?'bg-green-900 border border-green-700 text-green-200':
    'bg-gray-800 border border-gray-700 text-gray-200'}`;
  clearTimeout(toastT);
  toastT=setTimeout(()=>{el.className=el.className.replace('opacity-100 translate-y-0','opacity-0 translate-y-2');},2600);
}

/* ════════════════════════════════════
   MQTT
════════════════════════════════════ */
function mqttConnect(){
  if(typeof Paho==='undefined'){showErr('Paho library not loaded.');return;}
  const host=$('b-host').value.trim(),port=parseInt($('b-port').value)||9001,
        user=$('b-user').value.trim(),pass=$('b-pass').value,
        ssl=IS_HTTPS?true:$('b-ssl').checked;
  if(!host){toast('Enter broker host','r');return;}
  clearErr(); Object.assign(broker,{host,port,user,pass,ssl}); persist();
  if(mqttCl){try{mqttCl.disconnect();}catch{}mqttCl=null;} connected=false;
  const PC=(Paho.MQTT?.Client)||Paho.Client;
  mqttCl=new PC(host,port,'rc-'+Math.random().toString(36).slice(2,9));
  mqttCl.onConnectionLost=resp=>{
    connected=false;setConnUI(false);
    devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>d.status='offline');
    renderSidebar();if(activeId)renderDevice(activeId);
    Object.values(pingT).forEach(clearInterval);pingT={};
    if(resp.errorCode){toast('Disconnected: '+resp.errorMessage,'r');showErr(resp.errorMessage);}
  };
  mqttCl.onMessageArrived=onMsg;
  const opts={useSSL:ssl,keepAliveInterval:30,
    onSuccess(){
      connected=true;clearErr();setConnUI(true);toast('Connected to '+host,'g');
      devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>{subRelay(d);pubPresence(d,true);startPing(d);});
      if(IS_HTTPS) devices.filter(d=>d.type==='wled').forEach(wledMqttSub);
      if(IS_HTTPS) devices.filter(d=>d.type==='wled'&&d.gpioPrefix).forEach(gpioMqttSub);
    },
    onFailure(e){connected=false;setConnUI(false);const m=e.errorMessage||'Err '+e.errorCode;toast('Failed: '+m,'r');showErr(m);}
  };
  if(user){opts.userName=user;opts.password=pass;}
  try{mqttCl.connect(opts);}catch(e){toast(e.message,'r');showErr(e.message);}
}

function mqttDisconnect(){
  Object.values(pingT).forEach(clearInterval);pingT={};
  devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>pubPresence(d,false));
  if(mqttCl){try{mqttCl.disconnect();}catch{}mqttCl=null;}
  connected=false;setConnUI(false);
  devices.filter(d=>(d.type||'mqtt')==='mqtt').forEach(d=>d.status='offline');
  renderSidebar();if(activeId)renderDevice(activeId);
}

function pub(topic,payload,retain=false){
  if(!connected||!mqttCl){toast('Not connected to broker','r');return false;}
  try{
    const PM=(Paho.MQTT?.Message)||Paho.Message;
    const m=new PM(String(payload));m.destinationName=topic;m.retained=retain;m.qos=1;
    mqttCl.send(m);return true;
  }catch(e){toast('Publish error: '+e.message,'r');return false;}
}
const pubJ=(t,o,r=false)=>pub(t,JSON.stringify(o),r);

function subRelay(dev){
  if(!connected||(dev.type||'mqtt')!=='mqtt')return;
  try{['/v','/relay/+/v','/sensor/+/v','/status'].forEach(s=>mqttCl.subscribe(dev.prefix+s));}catch(e){console.warn(e);}
}
function unsubRelay(dev){
  if(!connected||(dev.type||'mqtt')!=='mqtt')return;
  ['/v','/relay/+/v','/sensor/+/v','/status'].forEach(s=>{try{mqttCl.unsubscribe(dev.prefix+s);}catch{}});
}
function pubPresence(dev,on){pub(dev.prefix+'/presence',on?'online':'offline',false);}
function startPing(dev){
  if(pingT[dev.id])clearInterval(pingT[dev.id]);
  pingT[dev.id]=setInterval(()=>{if(connected)pub(dev.prefix+'/ping','1',false);},(dev.pingInterval||10)*1000);
}

/* ── INCOMING MQTT ── */
function onMsg(msg){
  const topic=msg.destinationName,payload=msg.payloadString;
  // GPIO Monitor via MQTT
  const gd=devices.find(d=>d.type==='wled'&&d.gpioPrefix&&(topic===d.gpioPrefix||topic.startsWith(d.gpioPrefix+'/')));
  if(gd){handleGpioMqtt(gd,topic===gd.gpioPrefix?'':topic.slice(gd.gpioPrefix.length+1),payload);return;}
  // WLED via MQTT (HTTPS)
  const wd=devices.find(d=>d.type==='wled'&&d.wledTopic&&(topic===d.wledTopic||topic.startsWith(d.wledTopic+'/')));
  if(wd){handleWledMqtt(wd,topic===wd.wledTopic?'':topic.slice(wd.wledTopic.length+1),payload);return;}
  // Relay controller
  const dev=devices.find(d=>(d.type||'mqtt')==='mqtt'&&d.prefix&&(topic===d.prefix||topic.startsWith(d.prefix+'/')));
  if(!dev)return;
  const sfx=topic.slice(dev.prefix.length+1);

  if(sfx==='v'){
    try{
      const data=JSON.parse(payload);let ch=false;
      if(Array.isArray(data.relays)){dev.relays=data.relays.map(r=>({...r,state:r.on}));dev.status='online';dev.lastSeen=Date.now();ch=true;}
      if(Array.isArray(data.sensors)){
        const prev=dev.sensors||[];dev.sensors=data.sensors;
        if(prev.length!==data.sensors.length)ch=true;
        else data.sensors.forEach(s=>patchSensor(dev,s));
      }
      if(ch){renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}
    }catch{}return;
  }
  if(sfx==='status'){
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline';dev.lastSeen=Date.now();
    if(dev.status==='online'&&!was)setTimeout(()=>pub(dev.prefix+'/ping','1',false),400);
    renderSidebar();if(activeId===dev.id)renderDevice(dev.id);return;
  }
  const mr=sfx.match(/^relay\/(\d+)\/v$/);
  if(mr){
    const id=parseInt(mr[1]);if(!dev.relays)dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if(!r){r={id,name:'Relay '+(id+1),on:false,state:false};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);}
    r.on=payload.trim().toLowerCase()==='on';r.state=r.on;
    dev.status='online';dev.lastSeen=Date.now();
    if(activeId===dev.id)patchCard(dev,r);renderSidebar();return;
  }
  const ms=sfx.match(/^sensor\/(\d+)\/v$/);
  if(ms){
    const id=parseInt(ms[1]);if(!dev.sensors)dev.sensors=[];
    let s=dev.sensors.find(s=>s.id===id);const active=payload.trim().toLowerCase()==='active';
    if(!s){s={id,name:'Sensor '+(id+1),active};dev.sensors.push(s);dev.sensors.sort((a,b)=>a.id-b.id);dev.status='online';dev.lastSeen=Date.now();if(activeId===dev.id)renderDevice(dev.id);}
    else{s.active=active;dev.status='online';dev.lastSeen=Date.now();patchSensor(dev,s);}
    return;
  }
}

/* ════════════════════════════════════
   RELAY CTRL COMMANDS
════════════════════════════════════ */
function toggleRelay(dId,rId,on){
  const d=getD(dId);if(!d)return;
  if(isW(d)){toggleWR(dId,rId,on);return;}
  pubJ(d.prefix+'/relay/'+rId+'/api',{on});
  const r=d.relays?.find(r=>r.id===rId);if(r){r.on=on;r.state=on;patchCard(d,r);patchMeta(d);}
}
function pulseRelay(dId,rId){
  const d=getD(dId);if(!d)return;
  if(isW(d)){pulseWR(dId,rId);return;}
  const ms=parseInt($('pm-'+dId+'-'+rId)?.value)||500;
  pubJ(d.prefix+'/relay/'+rId+'/api',{pulse:ms});toast('Pulse '+ms+'ms');
}
function timerRelay(dId,rId){
  const d=getD(dId);if(!d)return;
  if(isW(d)){timerWR(dId,rId);return;}
  const s=parseInt($('ts-'+dId+'-'+rId)?.value)||30;
  pubJ(d.prefix+'/relay/'+rId+'/api',{timer:s});toast('Timer '+s+'s');
}
function allOff(dId){
  const d=getD(dId);if(!d)return;
  if(isW(d)){allOffW(dId);return;}
  pubJ(d.prefix+'/api',{on:false});
  d.relays?.forEach(r=>{r.on=false;r.state=false;patchCard(d,r);}); patchMeta(d);toast('All OFF','r');
}
function allOn(dId){
  const d=getD(dId);if(!d)return;
  if(isW(d)){allOnW(dId);return;}
  pubJ(d.prefix+'/api',{on:true});
  d.relays?.forEach(r=>{r.on=true;r.state=true;patchCard(d,r);}); patchMeta(d);toast('All ON');
}
function sendCmd(dId){
  const d=getD(dId);if(!d)return;
  if(isW(d)){sendCmdW(dId);return;}
  const raw=$('cmd-'+dId)?.value.trim();if(!raw)return;
  try{JSON.parse(raw);}catch(e){toast('Invalid JSON: '+e.message,'r');return;}
  pub(d.prefix+'/api',raw);toast('Sent','g');
}
function pingDev(id){
  const d=getD(id);if(!d)return;
  if(isW(d)){wledReqState(d);return;}
  pub(d.prefix+'/ping','1',false);toast('↻ Ping sent');
}

/* ════════════════════════════════════
   WLED — DUAL MODE
   HTTP  → WebSocket + /json poll + /relays HTTP
   HTTPS → MQTT /g /c /v /relay/N/state
════════════════════════════════════ */
function wledConnect(dev){
  if(!dev.host||IS_HTTPS)return;
  wledWsClose(dev);
  let ws;try{ws=new WebSocket('ws://'+dev.host+'/ws');}catch{schedRecon(dev);return;}
  wsSock[dev.id]=ws;
  ws.onopen=()=>{
    dev.status='online';dev.lastSeen=Date.now();
    renderSidebar();if(activeId===dev.id)renderDevice(dev.id);
    try{ws.send(JSON.stringify({v:1}));}catch{}
  };
  ws.onmessage=e=>{try{handleWledWs(dev,JSON.parse(e.data));}catch{}};
  ws.onclose=()=>{dev.status='offline';delete wsSock[dev.id];renderSidebar();if(activeId===dev.id)renderDevice(dev.id);schedRecon(dev);};
  ws.onerror=()=>{dev.status='offline';};
  if(jsonPoll[dev.id])clearInterval(jsonPoll[dev.id]);
  jsonPoll[dev.id]=setInterval(()=>pollJson(dev),3000);
  pollJson(dev);
  // GPIO Monitor — poll /api/pins if prefix configured
  if(dev.gpioPrefix){
    if(gpioPoll[dev.id])clearInterval(gpioPoll[dev.id]);
    gpioPoll[dev.id]=setInterval(()=>pollGpioPins(dev),3000);
    pollGpioPins(dev);
  }
}
function schedRecon(dev){
  if(wsRecon[dev.id]){clearTimeout(wsRecon[dev.id]);clearInterval(wsRecon[dev.id]);}
  wsRecon[dev.id]=setTimeout(()=>{if(devices.find(d=>d.id===dev.id))wledConnect(dev);},5000);
}
function wledWsClose(dev){
  const ws=wsSock[dev.id];if(ws){ws.onclose=null;try{ws.close();}catch{}delete wsSock[dev.id];}
  if(wsRecon[dev.id]){clearTimeout(wsRecon[dev.id]);clearInterval(wsRecon[dev.id]);delete wsRecon[dev.id];}
  if(jsonPoll[dev.id]){clearInterval(jsonPoll[dev.id]);delete jsonPoll[dev.id];}
  if(gpioPoll[dev.id]){clearInterval(gpioPoll[dev.id]);delete gpioPoll[dev.id];}
}
function wledDisconnect(dev){
  wledWsClose(dev);
  if(IS_HTTPS&&dev.wledTopic)wledMqttUnsub(dev);
  dev.status='offline';
}

/* WLED MQTT sub/unsub */
function wledMqttSub(dev){
  if(!connected||!dev.wledTopic)return;
  const t=dev.wledTopic;
  try{['g','c','v','status'].forEach(s=>mqttCl.subscribe(t+'/'+s));mqttCl.subscribe(t+'/relay/+/state');}catch(e){console.warn(e);}
  pub(t,String(dev.wledState?.bri>0?dev.wledState.bri:255),false);
  if(dev.gpioPrefix)gpioMqttSub(dev);
}
function wledMqttUnsub(dev){
  if(!connected||!dev.wledTopic)return;
  const t=dev.wledTopic;
  ['g','c','v','status'].forEach(s=>{try{mqttCl.unsubscribe(t+'/'+s);}catch{}});
  try{mqttCl.unsubscribe(t+'/relay/+/state');}catch{}
  if(dev.gpioPrefix)gpioMqttUnsub(dev);
}

/* WLED MQTT handler */
function handleWledMqtt(dev,sfx,payload){
  if(!dev.wledState)dev.wledState={};
  dev.lastSeen=Date.now();dev.status='online';

  if(sfx==='g'){
    const bri=parseInt(payload.trim())||0;
    dev.wledState.bri=bri;dev.wledState.on=bri>0;
    const sl=$('bri-m-'+dev.id);if(sl){sl.value=bri;const v=$('briv-'+dev.id);if(v)v.textContent=bri;}
    if(!dev.hasMultiRelay){
      if(!dev.relays?.length){dev.relays=[{id:0,name:'Master',on:bri>0,state:bri>0,bri,col:null,timer:0}];if(activeId===dev.id)renderDevice(dev.id);}
      else{dev.relays.forEach(r=>{r.on=bri>0;r.state=bri>0;patchCard(dev,r);});patchMeta(dev);}
    }
    renderSidebar();return;
  }
  if(sfx==='c'){dev.wledState.color=payload.trim();return;}
  if(sfx==='v'){
    const p=parseWledXml(payload);
    if(p){
      dev.wledState.on=p.on;dev.wledState.bri=p.bri;
      const sl=$('bri-m-'+dev.id);if(sl){sl.value=p.bri;const v=$('briv-'+dev.id);if(v)v.textContent=p.bri;}
      if(!dev.hasMultiRelay&&p.segs.length&&!dev.relays?.length){
        dev.relays=p.segs.map(s=>({id:s.id,name:s.n||'Seg '+s.id,on:s.on,state:s.on,bri:s.bri,col:null,timer:0}));
        renderSidebar();if(activeId===dev.id)renderDevice(dev.id);return;
      }
    }
    renderSidebar();if(activeId===dev.id)renderDevice(dev.id);return;
  }
  const mr=sfx.match(/^relay\/(\d+)\/state$/);
  if(mr){
    const id=parseInt(mr[1]),on=payload.trim().toLowerCase()==='on';
    if(!dev.relays)dev.relays=[];
    let r=dev.relays.find(r=>r.id===id);
    if(!r){r={id,name:'Relay '+(id+1),on,state:on,bri:255,col:null,timer:0};dev.relays.push(r);dev.relays.sort((a,b)=>a.id-b.id);dev.hasMultiRelay=true;renderSidebar();if(activeId===dev.id)renderDevice(dev.id);return;}
    r.on=on;r.state=on;dev.hasMultiRelay=true;
    if(activeId===dev.id){patchCard(dev,r);patchMeta(dev);}
    renderSidebar();return;
  }
  if(sfx==='status'){
    const was=dev.status==='online';
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline';
    if(dev.status==='online'&&!was)setTimeout(()=>{if(dev.wledTopic&&connected)pub(dev.wledTopic,String(dev.wledState?.bri??255),false);},400);
    renderSidebar();if(activeId===dev.id)renderDevice(dev.id);
  }
}

function parseWledXml(xml){
  try{
    const doc=new DOMParser().parseFromString(xml,'text/xml');
    const g=t=>doc.querySelector(t)?.textContent||null;
    const ac=parseInt(g('ac')||'0'),segs=[];
    doc.querySelectorAll('seg').forEach(s=>{
      const id=parseInt(s.querySelector('id')?.textContent||'-1');
      if(id>=0)segs.push({id,on:(s.querySelector('on')?.textContent||'0')!=='0',bri:parseInt(s.querySelector('bri')?.textContent||'0'),n:s.querySelector('n')?.textContent||null});
    });
    return{on:ac>0,bri:ac,segs};
  }catch{return null;}
}

/* /json poll (HTTP only — reliable MultiRelay source) */
async function pollJson(dev){
  if(!dev.host||IS_HTTPS)return;
  try{
    const res=await fetch('http://'+dev.host+'/json',{signal:AbortSignal.timeout(2500)});
    const data=await res.json();
    dev.lastSeen=Date.now();const was=dev.status!=='online';dev.status='online';
    if(was)renderSidebar();
    if(!dev.wledState)dev.wledState={};
    if(data.state?.bri!==undefined)dev.wledState.bri=data.state.bri;
    if(data.state?.on!==undefined)dev.wledState.on=data.state.on;
    const mr=data.state?.MultiRelay;
    if(mr&&Array.isArray(mr.relays)){
      dev.hasMultiRelay=true;const ex=dev.relays||[];
      const nr=mr.relays.map(r=>{const o=ex.find(x=>x.id===r.relay)||{};return{id:r.relay,name:o.name||'Relay '+(r.relay+1),on:!!r.state,state:!!r.state,bri:255,col:null,timer:0};});
      if(nr.length!==ex.length){dev.relays=nr;if(activeId===dev.id)renderDevice(dev.id);}
      else{nr.forEach((r,i)=>{if(r.on!==ex[i]?.on){dev.relays[i]=r;if(activeId===dev.id)patchCard(dev,r);}});if(activeId===dev.id)patchMeta(dev);}
    }
    dev._miss=0;
  }catch{
    dev._miss=(dev._miss||0)+1;
    if(dev._miss>=3){dev.status='offline';dev._miss=0;renderSidebar();if(activeId===dev.id)renderDevice(dev.id);}
  }
}

function handleWledWs(dev,data){
  if(!dev.wledState)dev.wledState={};
  if(data.effects)dev.wledEffects=data.effects;
  const st=data.state||data;
  if(st.on!==undefined)dev.wledState.on=st.on;
  if(st.bri!==undefined)dev.wledState.bri=st.bri;
  if(!dev.hasMultiRelay){
    const segs=st.seg||[];
    if(segs.length&&!dev.relays?.length){
      dev.relays=segs.map(s=>({id:s.id,name:s.n||'Seg '+s.id,on:!!s.on,state:!!s.on,bri:s.bri??128,col:s.col||null,timer:0}));
      if(activeId===dev.id)renderDevice(dev.id);
    }
  }
}

function wledReqState(dev){
  if(!IS_HTTPS){
    pollJson(dev);
    const ws=wsSock[dev.id];
    if(ws&&ws.readyState===WebSocket.OPEN)try{ws.send(JSON.stringify({v:1}));}catch{}
    else{toast('Reconnecting…');wledConnect(dev);}
    toast('↻ Refreshing…');
  }else if(dev.wledTopic&&connected){
    pub(dev.wledTopic,String(dev.wledState?.bri>0?dev.wledState.bri:255),false);toast('↻ Pinged MQTT');
  }else toast('Connect broker first','r');
}

/* WLED LED send */
function wledSend(dev,obj){
  if(!IS_HTTPS){
    const ws=wsSock[dev.id];
    if(ws&&ws.readyState===WebSocket.OPEN){try{ws.send(JSON.stringify(obj));return true;}catch{}}
    toast('WLED WS not connected','r');return false;
  }
  if(!dev.wledTopic){toast('No MQTT topic set','r');return false;}
  if(!connected){toast('Connect broker first','r');return false;}
  return pubJ(dev.wledTopic+'/api',obj);
}
function wledCmd(dev,cmd){
  if(!IS_HTTPS) return wledSend(dev,cmd==='ON'?{on:true}:cmd==='OFF'?{on:false}:cmd==='T'?{on:'toggle'}:{bri:parseInt(cmd)});
  if(!dev.wledTopic){toast('No MQTT topic set','r');return false;}
  if(!connected){toast('Connect broker first','r');return false;}
  return pub(dev.wledTopic,cmd,false);
}
async function wledHttp(dev,path,opts={}){
  if(IS_HTTPS||!dev.host)return null;
  try{const r=await fetch('http://'+dev.host+path,opts);if(!r.ok)throw r.status;return r;}
  catch{dev.status='offline';renderSidebar();if(activeId===dev.id)renderDevice(dev.id);toast('WLED unreachable','r');return null;}
}
const swStr=(dev,oid,oval)=>{const rs=dev.relays||[];if(!rs.length)return oval?'1':'0';return rs.map(r=>r.id===oid?(oval?1:0):(r.on?1:0)).join(',');};

function wledMasterToggle(id,on){const d=getD(id);if(!d)return;if(!d.wledState)d.wledState={};d.wledState.on=on;wledCmd(d,on?'ON':'OFF');}
function wledBriCommit(id,v){const d=getD(id);if(!d)return;const b=parseInt(v);if(!d.wledState)d.wledState={};d.wledState.bri=b;wledCmd(d,String(b));}
function wledFxChange(id,fx){const d=getD(id);if(d)wledSend(d,{seg:[{id:0,fx:parseInt(fx)}]});}
function wledSegBri(id,sid,v){const d=getD(id);if(d)wledSend(d,{seg:[{id:sid,bri:parseInt(v)}]});}

/* WLED relay controls */
function toggleWR(dId,rId,on){
  const d=getD(dId);if(!d)return;
  if(!IS_HTTPS&&d.host)wledHttp(d,'/relays?switch='+swStr(d,rId,on));
  else if(d.wledTopic&&connected)pub(d.wledTopic+'/relay/'+rId+'/command',on?'on':'off',false);
  else{toast('No connection','r');return;}
  const r=d.relays?.find(r=>r.id===rId);if(r){r.on=on;r.state=on;patchCard(d,r);patchMeta(d);}
}
function pulseWR(dId,rId){
  const d=getD(dId);if(!d)return;const ms=parseInt($('pm-'+dId+'-'+rId)?.value)||500;
  if(!IS_HTTPS&&d.host){wledHttp(d,'/relays?switch='+swStr(d,rId,true));setTimeout(()=>wledHttp(d,'/relays?switch='+swStr(d,rId,false)),ms);}
  else if(d.wledTopic&&connected){pub(d.wledTopic+'/relay/'+rId+'/command','on',false);setTimeout(()=>pub(d.wledTopic+'/relay/'+rId+'/command','off',false),ms);}
  else{toast('No connection','r');return;}
  const r=d.relays?.find(r=>r.id===rId);if(r){r.on=true;r.state=true;patchCard(d,r);patchMeta(d);}
  toast('Pulse '+ms+'ms → R'+(rId+1));
}
function timerWR(dId,rId){
  const d=getD(dId);if(!d)return;const s=parseInt($('ts-'+dId+'-'+rId)?.value)||30;
  if(!IS_HTTPS&&d.host){wledHttp(d,'/relays?switch='+swStr(d,rId,true));setTimeout(()=>wledHttp(d,'/relays?switch='+swStr(d,rId,false)),s*1000);}
  else if(d.wledTopic&&connected){pub(d.wledTopic+'/relay/'+rId+'/command','on',false);setTimeout(()=>pub(d.wledTopic+'/relay/'+rId+'/command','off',false),s*1000);}
  else{toast('No connection','r');return;}
  const r=d.relays?.find(r=>r.id===rId);if(r){r.on=true;r.state=true;patchCard(d,r);patchMeta(d);}
  toast('Timer '+s+'s → R'+(rId+1));
}
function allOffW(dId){
  const d=getD(dId);if(!d)return;const n=d.relays?.length||4;
  if(!IS_HTTPS&&d.host)wledHttp(d,'/relays?switch='+Array(n).fill(0).join(','));
  else if(d.wledTopic&&connected)d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','off',false));
  else{toast('No connection','r');return;}
  d.relays?.forEach(r=>{r.on=false;r.state=false;patchCard(d,r);});patchMeta(d);toast('All OFF','r');
}
function allOnW(dId){
  const d=getD(dId);if(!d)return;const n=d.relays?.length||4;
  if(!IS_HTTPS&&d.host)wledHttp(d,'/relays?switch='+Array(n).fill(1).join(','));
  else if(d.wledTopic&&connected)d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','on',false));
  else{toast('No connection','r');return;}
  d.relays?.forEach(r=>{r.on=true;r.state=true;patchCard(d,r);});patchMeta(d);toast('All ON');
}
function sendCmdW(dId){
  const d=getD(dId);if(!d)return;
  const raw=$('cmd-'+dId)?.value.trim();if(!raw)return;
  if(raw.startsWith('{')){
    try{wledSend(d,JSON.parse(raw));toast('Sent → /api','g');}
    catch(e){toast('Invalid JSON: '+e.message,'r');}
  }else if(!IS_HTTPS&&d.host&&raw.includes('=')){
    wledHttp(d,'/win?'+raw.replace(/^win[?&]?/i,'')).then(ok=>{if(ok)toast('Sent → /win','g');});
    setTimeout(()=>pollJson(d),400);
  }else{wledCmd(d,raw);toast('Sent → root topic','g');}
}


/* ════════════════════════════════════
   GPIO MONITOR USERMOD
   HTTP  → GET /api/pins every 3s
   HTTPS → MQTT {gpioPrefix}/pin/+/v
   Output pins (mode=4) support toggle + pulse.
   Input pins show HIGH/LOW read-only.
════════════════════════════════════ */
const GPIO_MODES={0:'disabled',1:'input',2:'input_pu',3:'input_pd',4:'output'};

function gpioMqttSub(dev){
  if(!connected||!dev.gpioPrefix)return;
  const t=dev.gpioPrefix;
  try{
    mqttCl.subscribe(t+'/pin/+/v');
    mqttCl.subscribe(t+'/v');
    mqttCl.subscribe(t+'/status');
  }catch(e){console.warn('[GPIO MQTT]',e);}
  pub(t+'/ping','1',false);  // trigger full state push
}
function gpioMqttUnsub(dev){
  if(!connected||!dev.gpioPrefix)return;
  const t=dev.gpioPrefix;
  ['/pin/+/v','/v','/status'].forEach(s=>{try{mqttCl.unsubscribe(t+s);}catch{}});
}

function handleGpioMqtt(dev,sfx,payload){
  dev.lastSeen=Date.now();dev.status='online';
  // Full state push: {prefix}/v
  if(sfx==='v'){
    try{
      const data=JSON.parse(payload);
      if(Array.isArray(data.pins)){
        dev.gpioPins=data.pins;
        renderSidebar();if(activeId===dev.id)renderDevice(dev.id);
      }
    }catch{}
    return;
  }
  // Per-pin: {prefix}/pin/N/v → "high" or "low"
  const mp=sfx.match(/^pin\/(\d+)\/v$/);
  if(mp){
    const id=parseInt(mp[1]),hi=payload.trim().toLowerCase()==='high';
    if(!dev.gpioPins)dev.gpioPins=[];
    let p=dev.gpioPins.find(p=>p.id===id);
    if(!p){p={id,name:'GPIO '+id,mode:1,state:hi,alert:false};dev.gpioPins.push(p);dev.gpioPins.sort((a,b)=>a.id-b.id);if(activeId===dev.id)renderDevice(dev.id);}
    else{p.state=hi;if(activeId===dev.id)patchGpioCard(dev,p);}
    renderSidebar();return;
  }
  if(sfx==='status'){
    dev.status=payload.trim().toLowerCase()==='online'?'online':'offline';
    renderSidebar();if(activeId===dev.id)renderDevice(dev.id);
  }
}

async function pollGpioPins(dev){
  if(!dev.host||IS_HTTPS||!dev.gpioPrefix)return;
  try{
    const res=await fetch('http://'+dev.host+'/api/pins',{signal:AbortSignal.timeout(2500)});
    const data=await res.json();
    if(Array.isArray(data.pins)){
      const prev=dev.gpioPins||[];
      dev.gpioPins=data.pins;
      if(prev.length!==data.pins.length){if(activeId===dev.id)renderDevice(dev.id);}
      else{data.pins.forEach(p=>{if(activeId===dev.id)patchGpioCard(dev,p);});}
    }
    dev._gMiss=0;
  }catch{
    dev._gMiss=(dev._gMiss||0)+1;
    if(dev._gMiss>=3&&activeId===dev.id)renderDevice(dev.id);
  }
}

function toggleGpioPin(dId,pId,on){
  const d=getD(dId);if(!d)return;
  if(!IS_HTTPS&&d.host){
    wledHttp(d,'/api/pin?id='+pId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:on})});
  }else if(d.gpioPrefix&&connected){
    pubJ(d.gpioPrefix+'/pin/'+pId+'/set',{state:on});
  }else{toast('No connection','r');return;}
  const p=d.gpioPins?.find(p=>p.id===pId);if(p){p.state=on;patchGpioCard(d,p);}
}
function pulseGpioPin(dId,pId){
  const d=getD(dId);if(!d)return;
  const ms=parseInt($('gpm-'+dId+'-'+pId)?.value)||500;
  if(!IS_HTTPS&&d.host){
    wledHttp(d,'/api/pin?id='+pId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pulse:ms})});
  }else if(d.gpioPrefix&&connected){
    pubJ(d.gpioPrefix+'/pin/'+pId+'/set',{pulse:ms});
  }else{toast('No connection','r');return;}
  toast('Pulse '+ms+'ms → GPIO '+pId);
}

function gpioCardHTML(dev,p){
  const did=dev.id,pid=p.id,hi=!!p.state,isOut=p.mode===4;
  const modeLabel=GPIO_MODES[p.mode]||('mode '+p.mode);
  return `
    <div class="rounded-xl border p-3 transition-all bg-gray-900/80 ${hi?(isOut?'gpio-out-on':'gpio-in-hi'):'border-gray-800'}" id="gpcard-${did}-${pid}">
      <div class="flex items-center justify-between mb-1.5">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[9px] text-gray-700 font-bold shrink-0">${String(pid).padStart(2,'0')}</span>
          <span class="text-[11px] text-gray-200 truncate">${esc(p.name||'GPIO '+pid)}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${p.alert?`<span class="text-[8px] px-1 py-0.5 bg-red-500/20 text-red-400 rounded font-bold">⚠</span>`:''}
          <span class="text-[8px] px-1 py-0.5 rounded font-bold ${isOut?'bg-indigo-500/20 text-indigo-400':'bg-gray-700 text-gray-500'}">${modeLabel}</span>
          <span id="gpst-${did}-${pid}" class="text-[8px] font-bold ${hi?'text-green-400':'text-gray-600'}">${hi?'HIGH':'LOW'}</span>
          ${isOut?`<label class="tgl"><input type="checkbox" ${hi?'checked':''} onchange="toggleGpioPin('${did}',${pid},this.checked)"><div class="tgl-t"></div></label>`:''}
        </div>
      </div>
      ${p.debounce_ms>0?`<p class="text-[9px] text-gray-700 mb-1.5">⏱ ${p.debounce_ms}ms debounce</p>`:''}
      ${isOut?`<div class="flex gap-1 mt-1">
        <input id="gpm-${did}-${pid}" type="number" value="500" min="50" class="inp flex-none w-14" style="font-size:9px;padding:4px 6px">
        <button onclick="pulseGpioPin('${did}',${pid})" class="flex-1 inp text-[9px] hover:border-indigo-500 text-gray-400 hover:text-white cursor-pointer" style="padding:4px 6px">Pulse</button>
      </div>`:''}
    </div>`;
}

function patchGpioCard(dev,p){
  const card=$('gpcard-'+dev.id+'-'+p.id);if(!card)return;
  const hi=!!p.state,isOut=p.mode===4;
  card.className=`rounded-xl border p-3 transition-all bg-gray-900/80 ${hi?(isOut?'gpio-out-on':'gpio-in-hi'):'border-gray-800'}`;
  const cb=card.querySelector('input[type=checkbox]');if(cb)cb.checked=hi;
  const st=$('gpst-'+dev.id+'-'+p.id);
  if(st){st.textContent=hi?'HIGH':'LOW';st.className='text-[8px] font-bold '+(hi?'text-green-400':'text-gray-600');}
}

/* ════════════════════════════════════
   PATTERN SEQUENCER
════════════════════════════════════ */
const getPat=id=>{if(!patterns[id])patterns[id]={steps:[],repeat:-1,cur:0,rem:0,timer:null,running:false};return patterns[id];};

function patAdd(dId){
  const d=getD(dId);if(!d)return;const p=getPat(dId);
  const last=p.steps[p.steps.length-1];
  p.steps.push({mask:last?last.mask:0,duration_ms:last?last.duration_ms:500});
  renderPatSteps(dId);
}
function patDel(dId,i){const p=patterns[dId];if(!p)return;p.steps.splice(i,1);renderPatSteps(dId);}
function patBit(dId,si,rid,on){const p=getPat(dId);if(!p.steps[si])return;if(on)p.steps[si].mask|=(1<<rid);else p.steps[si].mask&=~(1<<rid);}
function patDur(dId,si,v){const p=getPat(dId);if(p.steps[si])p.steps[si].duration_ms=Math.max(50,parseInt(v)||500);}
function patToggle(dId){const p=getPat(dId);p.running?patStop(dId):patStart(dId);}
function patClear(dId){patStop(dId);if(patterns[dId])patterns[dId].steps=[];renderPatSteps(dId);const s=$('pst-'+dId);if(s)s.textContent='';}

function patStart(dId){
  const d=getD(dId);if(!d)return;
  const p=getPat(dId);if(!p.steps.length){toast('Add at least one step','r');return;}
  p.running=true;p.cur=0;
  const re=$('prep-'+dId);p.repeat=re?parseInt(re.value):-1;p.rem=p.repeat;
  const btn=$('pbtn-'+dId);
  if(btn){btn.textContent='■ Stop';btn.className=btn.className.replace(/bg-amber-\d+\s?/g,'')+'bg-red-700 hover:bg-red-600';}
  patExec(dId);
}
function patStop(dId){
  const p=patterns[dId];if(!p)return;
  if(p.timer){clearTimeout(p.timer);p.timer=null;}
  p.running=false;
  const btn=$('pbtn-'+dId);
  if(btn){btn.textContent='▶ Run';btn.className=btn.className.replace(/bg-red-\d+\s?|hover:bg-red-\d+\s?/g,'')+'bg-amber-500 hover:bg-amber-400';}
  const s=$('pst-'+dId);if(s)s.textContent='';
  renderPatSteps(dId);
  const d=getD(dId);if(!d)return;const n=d.relays?.length||4;
  if(!IS_HTTPS&&d.host)wledHttp(d,'/relays?switch='+Array(n).fill(0).join(','));
  else if(d.wledTopic&&connected)d.relays?.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command','off',false));
}
function patExec(dId){
  const d=getD(dId);if(!d)return;
  const p=patterns[dId];if(!p||!p.running)return;
  const step=p.steps[p.cur];if(!step){patStop(dId);return;}
  const rs=d.relays||[];
  if(!IS_HTTPS&&d.host)wledHttp(d,'/relays?switch='+rs.map(r=>((step.mask>>r.id)&1)?1:0).join(','));
  else if(d.wledTopic&&connected)rs.forEach(r=>pub(d.wledTopic+'/relay/'+r.id+'/command',((step.mask>>r.id)&1)?'on':'off',false));
  rs.forEach(r=>{const on=!!((step.mask>>r.id)&1);r.on=on;r.state=on;patchCard(d,r);});patchMeta(d);
  renderPatSteps(dId);
  const s=$('pst-'+dId);
  if(s)s.textContent=`step ${p.cur+1}/${p.steps.length}${p.repeat>0?' · rep '+(p.repeat-p.rem+1)+'/'+p.repeat:''}`;
  p.timer=setTimeout(()=>{
    if(!p.running)return;p.cur++;
    if(p.cur>=p.steps.length){
      if(p.repeat===-1){p.cur=0;patExec(dId);}
      else{p.rem--;if(p.rem>0){p.cur=0;patExec(dId);}else patStop(dId);}
    }else patExec(dId);
  },step.duration_ms);
}
function patCleanup(dId){patStop(dId);delete patterns[dId];}

function renderPatSteps(dId){
  const d=getD(dId);if(!d)return;
  const p=getPat(dId);const c=$('psteps-'+dId);if(!c)return;
  if(!p.steps.length){c.innerHTML='<p class="text-[10px] text-gray-600 py-2">No steps yet — click <b class="text-gray-500">+ Step</b>.</p>';return;}
  c.innerHTML=p.steps.map((step,i)=>`
    <div class="flex items-center gap-2 p-2.5 rounded-lg border transition-all ${p.running&&p.cur===i?'pat-active border-amber-600/40 bg-amber-500/5':'border-gray-800 bg-gray-900/60'}" id="pstep-${dId}-${i}">
      <span class="text-[9px] text-gray-700 font-bold w-4 shrink-0">${String(i+1).padStart(2,'0')}</span>
      <div class="flex gap-3 flex-1 flex-wrap">
        ${(d.relays||[]).map(r=>`
          <label class="flex items-center gap-1 text-[9px] text-gray-400 cursor-pointer">
            <input type="checkbox" ${(step.mask>>r.id)&1?'checked':''} onchange="patBit('${dId}',${i},${r.id},this.checked)">
            R${r.id+1}
          </label>`).join('')}
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <input type="number" value="${step.duration_ms}" min="50" max="60000"
          class="inp w-16 text-right" style="font-size:9px;padding:4px 6px"
          onchange="patDur('${dId}',${i},this.value)">
        <span class="text-[9px] text-gray-600">ms</span>
      </div>
      <button onclick="patDel('${dId}',${i})" class="text-gray-700 hover:text-red-400 text-[9px] px-1.5 py-0.5 rounded border border-gray-800 hover:border-red-900 transition-colors shrink-0">✕</button>
    </div>`).join('');
}

/* ════════════════════════════════════
   UI — SIDEBAR
════════════════════════════════════ */
function setConnUI(on){
  $('conn-dot').className=`w-2 h-2 rounded-full transition-colors ${on?'bg-green-400':'bg-gray-600'}`;
  $('conn-lbl').textContent=on?'online':'offline';
  $('conn-lbl').className='text-[10px] '+(on?'text-green-400':'text-gray-500');
  $('tb-broker').textContent=on?'CONNECTED':'DISCONNECTED';
  $('tb-broker').className='text-[10px] font-semibold '+(on?'text-green-400':'text-red-400');
  $('btn-conn').style.display=on?'none':'';
  $('btn-disc').style.display=on?'':'none';
}
function showErr(m){const e=$('conn-err');e.textContent=m;e.classList.remove('hidden');}
function clearErr(){const e=$('conn-err');e.textContent='';e.classList.add('hidden');}

function renderSidebar(){
  const list=$('dev-list');list.innerHTML='';
  if(!devices.length){list.innerHTML='<p class="text-[10px] text-gray-600 px-1 py-2">No devices yet.</p>';return;}
  devices.forEach(dev=>{
    const online=dev.status==='online';
    const gpioLabel=isW(dev)&&dev.gpioPins?.length?`<span class="text-[8px] px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-bold">GPIO</span>`:'';
    const badge=isW(dev)
      ?`<span class="text-[8px] px-1 py-0.5 rounded font-bold ${dev.hasMultiRelay?'bg-amber-500/20 text-amber-400':'bg-teal-500/20 text-teal-400'}">${dev.hasMultiRelay?'W+R':'WLED'}</span>${gpioLabel}`
      :`<span class="text-[8px] px-1 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-bold">MQTT</span>`;
    const el=document.createElement('div');
    el.className=`flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer transition-colors group ${dev.id===activeId?'bg-indigo-600/20 border border-indigo-500/30':'border border-transparent hover:bg-gray-800'}`;
    el.innerHTML=`
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full shrink-0 ${online?'bg-green-400':'bg-gray-600'}"></span>
        <span class="text-[11px] text-gray-300 truncate">${esc(dev.name)}</span>
        ${badge}
      </div>
      <button onclick="removeDevice('${dev.id}',event)" class="text-gray-800 hover:text-red-400 text-xs px-1 shrink-0 transition-colors opacity-0 group-hover:opacity-100">✕</button>`;
    el.onclick=e=>{if(e.target.closest('button'))return;selectDevice(dev.id);};
    list.appendChild(el);
  });
  $('tb-devices').textContent=devices.length;
}

function selectDevice(id){activeId=id;renderSidebar();renderDevice(id);}

/* ════════════════════════════════════
   UI — MAIN PANEL
════════════════════════════════════ */
function renderDevice(id){
  const main=$('main');const dev=getD(id);
  if(!dev){main.innerHTML=emptyState('📡','No Device Selected','Add a device in the sidebar.');return;}
  const relays=dev.relays||[],sensors=dev.sensors||[];
  const online=dev.status==='online',active=relays.filter(r=>r.state).length;
  const isWled=isW(dev);

  main.innerHTML=`
    ${isWled&&IS_HTTPS&&!dev.wledTopic?`<div class="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-300 leading-relaxed">⚠ <b>No MQTT topic set.</b> Edit device and add the WLED MQTT Device Topic to use on HTTPS.</div>`:''}

    <!-- Header -->
    <div class="flex items-start justify-between gap-4 mb-5 flex-wrap">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="text-sm font-semibold text-white">${esc(dev.name)}</h2>
          <code class="text-[9px] text-gray-600">${isWled?esc(IS_HTTPS?(dev.wledTopic||dev.host||''):(dev.host||dev.wledTopic||'')):esc(dev.prefix)}</code>
        </div>
        <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
          <span id="pill-st-${dev.id}" class="text-[8px] font-bold px-1.5 py-0.5 rounded ${online?'bg-green-500/20 text-green-400':'bg-red-500/20 text-red-400'}">${online?'ONLINE':'OFFLINE'}</span>
          ${isWled?`<span class="text-[8px] font-bold px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-400">${dev.hasMultiRelay?'WLED+RELAYS':'WLED'}</span>`:'<span class="text-[8px] font-bold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">MQTT</span>'}
          <span id="pill-ct-${dev.id}" class="text-[8px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">${relays.length} relays</span>
          <span id="pill-ac-${dev.id}" class="text-[8px] font-bold px-1.5 py-0.5 rounded ${active?'bg-indigo-500/20 text-indigo-400':'bg-gray-800 text-gray-600'}">${active} active</span>
          ${!isWled&&sensors.length?`<span class="text-[8px] font-bold px-1.5 py-0.5 rounded bg-teal-500/20 text-teal-400">${sensors.length} sensors</span>`:''}
          ${isWled&&dev.gpioPins?.length?`<span class="text-[8px] font-bold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">${dev.gpioPins.length} GPIO</span>`:''}
          <span id="ls-${dev.id}" class="text-[9px] text-gray-600">${dev.lastSeen?'seen '+ago(dev.lastSeen):''}</span>
        </div>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button onclick="pingDev('${dev.id}')" class="btn-ghost">↻ Ping</button>
        <button onclick="openEdit('${dev.id}')" class="btn-ghost">✎ Edit</button>
        <button onclick="allOff('${dev.id}')" class="text-[10px] px-3 py-1.5 rounded bg-red-700/80 hover:bg-red-700 text-white transition-colors">⬛ All Off</button>
        <button onclick="allOn('${dev.id}')" class="text-[10px] px-3 py-1.5 rounded bg-amber-500/90 hover:bg-amber-500 text-black font-bold transition-colors">■ All On</button>
      </div>
    </div>

    <!-- WLED LED bar -->
    ${isWled?`
    <div class="mb-4 p-3 rounded-xl bg-gray-900/80 border border-gray-800">
      <div class="flex items-center gap-4 flex-wrap">
        <span class="text-[8px] text-gray-600 tracking-widest font-semibold">LED CTRL</span>
        <label class="tgl flex items-center gap-2 cursor-pointer">
          <input type="checkbox" ${dev.wledState?.on?'checked':''} onchange="wledMasterToggle('${dev.id}',this.checked)">
          <div class="tgl-t"></div>
          <span class="text-[10px] text-gray-400">Master</span>
        </label>
        <div class="flex items-center gap-2 flex-1 min-w-32">
          <span class="text-[8px] text-gray-600 shrink-0">BRI</span>
          <input type="range" min="0" max="255" value="${dev.wledState?.bri??128}" id="bri-m-${dev.id}" class="flex-1"
            oninput="$('briv-${dev.id}').textContent=this.value" onchange="wledBriCommit('${dev.id}',this.value)">
          <span id="briv-${dev.id}" class="text-[10px] text-gray-500 w-7 text-right tabular-nums">${dev.wledState?.bri??128}</span>
        </div>
        ${dev.wledEffects?`<select onchange="wledFxChange('${dev.id}',this.value)" class="inp text-[10px]" style="font-size:9px;padding:4px 8px">${dev.wledEffects.filter(n=>n!=='RSVD'&&n!=='-').map((n,i)=>`<option value="${i}">${esc(n)}</option>`).join('')}</select>`:''}
      </div>
    </div>`:''}

    <!-- CMD bar -->
    <div class="mb-4 p-3 rounded-xl bg-gray-900/80 border border-gray-800">
      <div class="flex gap-2 items-center mb-1.5">
        <span class="text-[8px] text-gray-600 tracking-widest shrink-0">CMD</span>
        <input id="cmd-${dev.id}" type="text"
          placeholder="${isWled?(!IS_HTTPS?'{"bri":128}  ·  FX=73&A=200  ·  ON  ·  T':'{"bri":128}  ·  ON  ·  T'):'{"on":true}  ·  {"relay":0,"on":true}'}"
          class="inp flex-1" style="font-size:9px"
          onkeydown="if(event.key==='Enter')sendCmd('${dev.id}')">
        <button onclick="sendCmd('${dev.id}')" class="text-[10px] px-3 py-1 rounded bg-teal-700/80 hover:bg-teal-700 text-white transition-colors shrink-0">Send</button>
      </div>
      <p class="text-[9px] text-gray-700">
        ${isWled?`JSON→/api · ${!IS_HTTPS?'HTTP params→/win · ':''}Plain→root (<code>ON</code> <code>OFF</code> <code>T</code> <code>0-255</code>)`:'JSON object to /api'}
      </p>
    </div>

    <!-- Relay grid -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4" id="grid-${dev.id}">
      ${relays.length?relays.map(r=>cardHTML(dev,r)).join(''):emptyState('🔌','No data yet',online?'Click ↻ Ping to request state.':'Device is offline.')}
    </div>

    <!-- WLED Pattern Sequencer -->
    ${isWled&&dev.hasMultiRelay?`
    <div class="mb-4 p-3 rounded-xl bg-gray-900/80 border border-gray-800">
      <div class="flex items-center gap-3 mb-3 flex-wrap">
        <span class="text-[8px] text-amber-400 tracking-widest font-bold">⟳ RELAY PATTERN</span>
        <span id="pst-${dev.id}" class="text-[9px] text-teal-400 font-mono"></span>
        <div class="ml-auto flex gap-2 items-center flex-wrap">
          <select id="prep-${dev.id}" class="inp text-[9px]" style="padding:4px 8px">
            <option value="-1">∞ Loop</option><option value="1">1×</option>
            <option value="2">2×</option><option value="5">5×</option><option value="10">10×</option>
          </select>
          <button onclick="patAdd('${dev.id}')" class="text-[9px] px-2.5 py-1 rounded bg-teal-700/80 hover:bg-teal-700 text-white transition-colors">+ Step</button>
          <button id="pbtn-${dev.id}" onclick="patToggle('${dev.id}')" class="text-[9px] px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold transition-colors">▶ Run</button>
          <button onclick="patClear('${dev.id}')" class="btn-ghost text-[9px]">✕ Clear</button>
        </div>
      </div>
      <div id="psteps-${dev.id}" class="space-y-1.5">
        <p class="text-[10px] text-gray-600 py-2">No steps yet — click <b class="text-gray-500">+ Step</b>.</p>
      </div>
    </div>`:''}

    <!-- GPIO Monitor section -->
    ${isWled&&dev.gpioPins?.length?`
    <div class="mb-4 p-3 rounded-xl bg-gray-900/80 border border-gray-800">
      <div class="text-[8px] text-indigo-400 tracking-widest font-bold mb-3">⬡ GPIO PINS <span class="text-gray-600 font-normal">${dev.gpioPins.length} monitored</span></div>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" id="gpgrid-${dev.id}">
        ${dev.gpioPins.map(p=>gpioCardHTML(dev,p)).join('')}
      </div>
    </div>`:''}

    <!-- Sensor section -->
    ${!isWled&&sensors.length?`
    <div class="p-3 rounded-xl bg-gray-900/80 border border-gray-800">
      <div class="text-[8px] text-teal-400 tracking-widest font-bold mb-3">⬡ SENSORS <span class="text-gray-600 font-normal">${sensors.length} configured</span></div>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" id="sgrid-${dev.id}">
        ${sensors.map(s=>sensorHTML(dev,s)).join('')}
      </div>
    </div>`:''}`;

  if(isW(dev)&&dev.hasMultiRelay&&patterns[dev.id]?.steps.length)renderPatSteps(dev.id);
}

function cardHTML(dev,r){
  const did=dev.id,rid=r.id,isOn=!!(r.on||r.state);
  const wled=isW(dev);
  const showBri=wled&&!dev.hasMultiRelay;
  const showPulse=!wled||dev.hasMultiRelay;
  const fx=showBri&&dev.wledEffects?(dev.wledEffects[r.fx??0]||null):null;
  const col=Array.isArray(r.col)&&Array.isArray(r.col[0])?r.col[0]:null;
  const hex=col?'#'+col.slice(0,3).map(v=>(v||0).toString(16).padStart(2,'0')).join(''):null;
  const base='rounded-xl border p-3 transition-all bg-gray-900/80 ';
  const glow=isOn?(wled?'wled-on':'relay-on'):'border-gray-800';
  return `
    <div class="${base}${glow}" id="rcard-${did}-${rid}">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[9px] text-gray-700 font-bold shrink-0">${String(rid+1).padStart(2,'0')}</span>
          ${hex?`<span class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${hex}"></span>`:''}
          <span class="text-[11px] text-gray-200 truncate">${esc(r.name||'Relay '+(rid+1))}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${fx&&fx!=='Solid'?`<span class="text-[8px] px-1 py-0.5 bg-indigo-500/20 text-indigo-400 rounded">${esc(fx)}</span>`:''}
          <span id="rsp-${did}-${rid}" class="text-[8px] font-bold ${isOn?'text-green-400':'text-gray-600'}">${isOn?'ON':'OFF'}</span>
          <label class="tgl"><input type="checkbox" ${isOn?'checked':''} onchange="toggleRelay('${did}',${rid},this.checked)"><div class="tgl-t"></div></label>
        </div>
      </div>
      ${showBri?`<div class="flex items-center gap-2 mb-2"><span class="text-[8px] text-gray-600 shrink-0">BRI</span><input type="range" min="0" max="255" value="${r.bri??128}" class="flex-1" oninput="this.nextElementSibling.textContent=this.value" onchange="wledSegBri('${did}',${rid},this.value)"><span class="text-[9px] text-gray-600 w-5 text-right tabular-nums">${r.bri??128}</span></div>`:''}
      ${showPulse?`<div class="flex gap-1.5 mt-2">
        <div class="flex gap-1 flex-1"><input id="pm-${did}-${rid}" type="number" value="500" min="50" class="inp flex-none w-14" style="font-size:9px;padding:4px 6px"><button onclick="pulseRelay('${did}',${rid})" class="flex-1 inp text-[9px] hover:border-indigo-500 text-gray-400 hover:text-white transition-colors cursor-pointer" style="padding:4px 6px">Pulse</button></div>
        <div class="flex gap-1 flex-1"><input id="ts-${did}-${rid}" type="number" value="30" min="1" class="inp flex-none w-14" style="font-size:9px;padding:4px 6px"><button onclick="timerRelay('${did}',${rid})" class="flex-1 inp text-[9px] hover:border-indigo-500 text-gray-400 hover:text-white transition-colors cursor-pointer" style="padding:4px 6px">Timer</button></div>
      </div>`:''}
    </div>`;
}

function sensorHTML(dev,s){
  const active=!!s.active;
  const mode=s.trigger_mode&&s.trigger_mode!=='NONE'&&s.trigger_relay>=0?`→R${s.trigger_relay+1}·${s.trigger_mode}`:'';
  return `
    <div class="rounded-lg border p-2.5 transition-all ${active?'sensor-act border-teal-500/40 bg-teal-500/5':'border-gray-800 bg-gray-900/50'}" id="scrd-${dev.id}-${s.id}">
      <div class="flex items-center justify-between gap-1 mb-0.5">
        <span class="text-[10px] text-gray-200 truncate">${esc(s.name||'Sensor '+(s.id+1))}</span>
        <span id="scpill-${dev.id}-${s.id}" class="text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0 ${active?'bg-teal-500/20 text-teal-400 pulsing':'bg-gray-800 text-gray-600'}">${active?'ACTIVE':'IDLE'}</span>
      </div>
      ${s.pin!==undefined?`<p class="text-[9px] text-gray-600">GPIO ${s.pin}${s.debounce_ms>0?` · ⏱${s.debounce_ms}ms`:''}${mode?` · ${mode}`:''}</p>`:''}
    </div>`;
}

/* ── DOM patch helpers ── */
function patchCard(dev,r){
  const card=$('rcard-'+dev.id+'-'+r.id);if(!card)return;
  const on=r.state,wled=isW(dev);
  card.className=`rounded-xl border p-3 transition-all bg-gray-900/80 ${on?(wled?'wled-on':'relay-on'):'border-gray-800'}`;
  const cb=card.querySelector('input[type=checkbox]');if(cb)cb.checked=on;
  const sp=$('rsp-'+dev.id+'-'+r.id);
  if(sp){sp.textContent=on?'ON':'OFF';sp.className='text-[8px] font-bold '+(on?'text-green-400':'text-gray-600');}
}
function patchMeta(dev){
  if(activeId!==dev.id)return;
  const active=(dev.relays||[]).filter(r=>r.state).length;
  const pa=$('pill-ac-'+dev.id);
  if(pa){pa.textContent=active+' active';pa.className='text-[8px] font-bold px-1.5 py-0.5 rounded '+(active?'bg-indigo-500/20 text-indigo-400':'bg-gray-800 text-gray-600');}
}
function patchSensor(dev,s){
  const card=$('scrd-'+dev.id+'-'+s.id);if(!card)return;
  const a=!!s.active;
  card.className=`rounded-lg border p-2.5 transition-all ${a?'sensor-act border-teal-500/40 bg-teal-500/5':'border-gray-800 bg-gray-900/50'}`;
  const p=$('scpill-'+dev.id+'-'+s.id);
  if(p){p.textContent=a?'ACTIVE':'IDLE';p.className='text-[8px] font-bold px-1.5 py-0.5 rounded shrink-0 '+(a?'bg-teal-500/20 text-teal-400 pulsing':'bg-gray-800 text-gray-600');}
}

function emptyState(icon,title,sub){
  return `<div class="col-span-full flex flex-col items-center py-14 text-center"><div class="text-3xl mb-3">${icon}</div><div class="text-xs font-semibold text-gray-500 mb-1">${title}</div><div class="text-[10px] text-gray-600">${sub}</div></div>`;
}

/* ════════════════════════════════════
   DEVICE MANAGEMENT
════════════════════════════════════ */
function onTypeChange(){
  const t=$('dm-type').value;
  $('dm-mqtt').classList.toggle('hidden',t!=='mqtt');
  $('dm-wled').classList.toggle('hidden',t!=='wled');
}
function openAdd(){
  $('modal-title').textContent='Add Device';
  ['dm-id','dm-name','dm-prefix','dm-host','dm-wtopic','dm-gpio-prefix'].forEach(i=>{$(i).value='';});
  $('dm-type').value='mqtt';$('dm-ping').value='10';onTypeChange();
  $('modal').classList.remove('hidden');setTimeout(()=>$('dm-name').focus(),100);
}
function openEdit(id){
  const d=getD(id);if(!d)return;
  $('modal-title').textContent='Edit Device';
  $('dm-id').value=d.id;$('dm-name').value=d.name;$('dm-type').value=d.type||'mqtt';
  $('dm-prefix').value=d.prefix||'';$('dm-ping').value=d.pingInterval||10;
  $('dm-host').value=d.host||'';$('dm-wtopic').value=d.wledTopic||'';$('dm-gpio-prefix').value=d.gpioPrefix||'';
  onTypeChange();$('modal').classList.remove('hidden');
}
function closeModal(){$('modal').classList.add('hidden');}

function saveDevice(){
  const existId=$('dm-id').value,name=$('dm-name').value.trim()||'Device',type=$('dm-type').value||'mqtt';
  const prefix=$('dm-prefix').value.trim().replace(/\/+$/,'')||'home/relay';
  const ping=parseInt($('dm-ping').value)||10;
  const host=$('dm-host').value.trim(),wledTopic=$('dm-wtopic').value.trim().replace(/\/+$/,''),gpioPrefix=$('dm-gpio-prefix').value.trim().replace(/\/+$/,'');
  if(type==='wled'&&!host&&!wledTopic){toast('Enter WLED IP or MQTT topic','r');return;}

  if(existId){
    const d=getD(existId);if(!d)return;
    if((d.type||'mqtt')==='mqtt'){unsubRelay(d);if(pingT[d.id]){clearInterval(pingT[d.id]);delete pingT[d.id];}}
    else wledDisconnect(d);
    Object.assign(d,{name,type,prefix,pingInterval:ping,host,wledTopic,gpioPrefix});
    if(type==='mqtt'&&connected){subRelay(d);startPing(d);}
    if(type==='wled'){if(!IS_HTTPS)wledConnect(d);else if(connected)wledMqttSub(d);}
  }else{
    const d={id:'dev-'+Date.now(),name,type,prefix,pingInterval:ping,host,wledTopic,gpioPrefix,status:'offline',lastSeen:null,relays:[],sensors:[],gpioPins:[]};
    devices.push(d);
    if(type==='mqtt'&&connected){subRelay(d);pubPresence(d,true);startPing(d);}
    if(type==='wled'){if(!IS_HTTPS)wledConnect(d);else if(connected)wledMqttSub(d);}
    selectDevice(d.id);
  }
  persist();renderSidebar();closeModal();toast('Saved','g');
}

function removeDevice(id,e){
  if(e)e.stopPropagation();
  const d=getD(id);if(!d)return;
  if(!confirm('Remove "'+d.name+'"?'))return;
  if((d.type||'mqtt')==='mqtt'){unsubRelay(d);pubPresence(d,false);if(pingT[id]){clearInterval(pingT[id]);delete pingT[id];}}
  else{wledDisconnect(d);patCleanup(id);}
  devices=devices.filter(d=>d.id!==id);
  if(activeId===id)activeId=devices[0]?.id||null;
  persist();renderSidebar();
  if(activeId)renderDevice(activeId);
  else $('main').innerHTML=emptyState('📡','No Device Selected','Add a device in the sidebar.');
}

/* ════════════════════════════════════
   PERSIST + INIT
════════════════════════════════════ */
function persist(){
  $save({broker,devices:devices.map(({id,name,type,prefix,pingInterval,host,wledTopic,gpioPrefix})=>({id,name,type:type||'mqtt',prefix,pingInterval:pingInterval||10,host:host||'',wledTopic:wledTopic||'',gpioPrefix:gpioPrefix||''}))});
}

// btn-ghost style (too long for inline)
/* btn-ghost defined in remote.css */

(function init(){
  const ssl=IS_HTTPS;
  $('b-host').value=broker.host||(ssl?'broker.hivemq.com':'');
  $('b-port').value=broker.port||(ssl?8884:9001);
  $('b-user').value=broker.user||'';$('b-pass').value=broker.pass||'';
  $('b-ssl').checked=ssl||broker.ssl||false;
  if(ssl){$('b-ssl').disabled=true;$('https-note').classList.remove('hidden');}
  setConnUI(false);renderSidebar();
  if(!IS_HTTPS)devices.filter(d=>d.type==='wled').forEach(wledConnect);  // wledConnect already starts gpioPoll if gpioPrefix set
  if(!activeId&&devices.length)activeId=devices[0].id;
  if(activeId)renderDevice(activeId);
  else $('main').innerHTML=emptyState('📡','No Device Selected','Add a relay controller (MQTT) or WLED device. WLED uses WebSocket on HTTP, MQTT on HTTPS.');
})();
