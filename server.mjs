import {createServer} from 'node:http';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {WebSocketServer,WebSocket} from 'ws';

const WIDTH=960, HEIGHT=600, SIZE=28, SPEED=210, MAX=80;
const TICK_MS=50, LEASE_MS=20000;
export const colorFor=slot=>`hsl(${slot*137.508%360} 75% 48%)`;
export function ticket(secret,{sub,exp,jti= randomUUID(),...extra}){
  const encoded=Buffer.from(JSON.stringify({sub,exp,jti,...extra})).toString('base64url');
  return encoded+'.'+createHmac('sha256',secret).update(encoded).digest('base64url');
}
function verify(secret,value){
  if(typeof value!=='string'||value.length>1000)return null;
  const parts=value.split('.');if(parts.length!==2)return null;
  try{
    const expected=createHmac('sha256',secret).update(parts[0]).digest();
    const actual=Buffer.from(parts[1],'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
    const claims=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    const now=Date.now();
    return typeof claims.sub==='string'&&claims.sub.length<=128&&claims.sub.length>0&&typeof claims.jti==='string'&&Number.isSafeInteger(claims.exp)&&claims.exp>=now&&claims.exp<=now+LEASE_MS?claims:null;
  }catch{return null;}
}
// The only authoritative collision and round state lives here, never in clients.
export function createKingRound({random=Math.random,roundMs=10000,countdownMs=3000}={}){
  let phase='waiting',until=0,king=null,number=0,participants=new Set(),caught=new Set();
  function reset(){phase='waiting';until=0;king=null;participants.clear();caught.clear();}
  function step(now,players,onCapture){
    const active=players.filter(p=>p.session);
    if(active.length<2){reset();return snapshot(now);}
    if(phase==='waiting'||(phase==='playing'&&now>=until)){
      phase='countdown';until=now+countdownMs;number++;caught=new Set();participants=new Set(active.map(p=>p.key));king=active[Math.floor(random()*active.length)].key;
    }else if(phase==='countdown'&&now>=until){
      if(!active.some(p=>p.key===king)){reset();return step(now,players,onCapture);}
      phase='playing';until=now+roundMs;
    }
    if(phase==='playing'){
      const k=active.find(p=>p.key===king);
      if(k)for(const p of active){if(p.key===king||!participants.has(p.key)||caught.has(p.key))continue;
        if(Math.abs(k.x-p.x)<SIZE&&Math.abs(k.y-p.y)<SIZE){caught.add(p.key);p.dx=0;p.dy=0;k.score++;onCapture(k);}
      }
    }
    return snapshot(now);
  }
  function snapshot(now){return {phase,number,remainingMs:Math.max(0,until-now),king};}
  function frozen(p){return Boolean(p.session&&(phase==='countdown'||(phase==='playing'&&(!participants.has(p.key)||caught.has(p.key)))));}
  return {step,snapshot,frozen,isCaught:p=>caught.has(p.key)};
}
export function createPlaza({secret,origin,port=0,roundOptions,scoreSink}){
  if(typeof secret!=='string'||secret.length<32)throw Error('PLAZA_SHARED_SECRET must have at least 32 characters');
  if(typeof origin!=='string'||!origin)throw Error('CLASSROOM_ORIGIN is required');
  const players=new Map(),byAccount=new Map(),usedTickets=new Map(),sessions=new Map();
  const round=createKingRound(roundOptions);
  const pendingScores=new Map();let flushing=false;
  const queueScore=p=>{if(p.session)pendingScores.set(p.key,Math.max(p.score,pendingScores.get(p.key)??0));};
  async function flushScores(){
    if(flushing||!pendingScores.size)return;flushing=true;
    const rows=[...pendingScores].slice(0,80).map(([id,score])=>({id,score}));
    try{
      if(scoreSink)await scoreSink(rows);
      else{
        const encoded=Buffer.from(JSON.stringify({at:Date.now(),rows})).toString('base64url');
        const signature=createHmac('sha256',secret).update('plaza-score-v1:'+encoded).digest('base64url');
        const r=await fetch(origin+'/api/games/block-plaza/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:encoded,signature}),signal:AbortSignal.timeout(5000)});
        if(!r.ok)throw Error('score sink '+r.status);
      }
      for(const row of rows)if(pendingScores.get(row.id)===row.score)pendingScores.delete(row.id);
    }catch(error){console.warn('Score sync retry:',error instanceof Error?error.message:'unknown');}
    finally{flushing=false;}
  }
  const server=createServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,online:players.size,tickHz:20,capacity:MAX,mode:'king',roundMs:10000,countdownMs:3000}));}
    res.writeHead(404);res.end();
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/plaza'||req.headers.origin!==origin||wss.clients.size>=MAX+16){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  function send(ws,payload){
    if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<128*1024)ws.send(payload);
  }
  function remove(ws){
    const p=players.get(ws);if(!p)return;
    players.delete(ws);if(byAccount.get(p.sub)===ws)byAccount.delete(p.sub);p.dx=0;p.dy=0;p.lastSeen=Date.now();
  }
  function auth(ws,raw){
    const claims=verify(secret,raw);
    if(!claims||usedTickets.has(claims.jti)){ws.close(1008,'Invalid or expired ticket');return false;}
    usedTickets.set(claims.jti,claims.exp);
    const previous=players.get(ws);
    const session=typeof claims.session==='string'&&/^[0-9a-f-]{36}$/i.test(claims.session)?claims.session:null;
    const key=claims.sub+':'+(session??'legacy');
    const score=Number.isSafeInteger(claims.score)&&claims.score>=0?claims.score:0;
    if(previous){
      if(previous.key!==key){ws.close(1008,'Account changed');return false;}
      previous.expires=claims.exp;return true;
    }
    const old=byAccount.get(claims.sub);if(old){remove(old);old.close(1008,'Replaced by new connection');}
    if(players.size>=MAX){ws.close(1013,'Plaza full');return false;}
    const occupied=new Set([...players.values()].map(p=>p.slot));
    let slot=0;while(occupied.has(slot))slot++;
    const prior=session?sessions.get(key):null;
    const player={id:prior?.id??randomUUID(),sub:claims.sub,session,key,slot,x:prior?.x??20+Math.random()*(WIDTH-SIZE-40),y:prior?.y??20+Math.random()*(HEIGHT-SIZE-40),dx:0,dy:0,seq:0,expires:claims.exp,lastInput:Date.now(),lastSeen:Date.now(),score:Math.max(prior?.score??0,score),classCode:typeof claims.classCode==='string'?claims.classCode.slice(0,8):'',seat:typeof claims.seat==='string'?claims.seat.slice(0,8):''};
    if(session)sessions.set(key,player);
    players.set(ws,player);byAccount.set(claims.sub,ws);
    send(ws,JSON.stringify({type:'welcome',id:player.id,color:colorFor(slot),width:WIDTH,height:HEIGHT,size:SIZE,speed:SPEED}));
    return true;
  }
  wss.on('connection',ws=>{
    let rate=0,windowStart=Date.now();
    const timeout=setTimeout(()=>{if(!players.has(ws))ws.close(1008,'Authentication required');},5000);
    ws.on('error',()=>remove(ws));ws.on('close',()=>{clearTimeout(timeout);remove(ws);});
    ws.on('message',data=>{
      const now=Date.now();if(now-windowStart>=1000){rate=0;windowStart=now;}
      if(++rate>60){ws.close(1008,'Too many messages');return;}
      let m;try{m=JSON.parse(data.toString());}catch{return;}
      if(m?.type==='auth'){auth(ws,m.ticket);return;}
      const p=players.get(ws);if(!p||p.expires<=now){ws.close(1008,'Session expired');return;}
      if(m?.type==='input'&&[-1,0,1].includes(m.dx)&&[-1,0,1].includes(m.dy)&&Number.isSafeInteger(m.seq)&&m.seq>p.seq){
        p.dx=m.dx;p.dy=m.dy;p.seq=m.seq;p.lastInput=now;
      }
      if(m?.type==='ping'&&Number.isFinite(m.at))send(ws,JSON.stringify({type:'pong',at:m.at}));
    });
  });
  let last=performance.now(),ticks=0;
  const scoreTimer=setInterval(()=>void flushScores(),1000);
  const interval=setInterval(()=>{
    const now=Date.now(),clock=performance.now(),dt=Math.min(0.1,(clock-last)/1000);last=clock;
    for(const [key,expiration] of usedTickets)if(expiration<now)usedTickets.delete(key);
    for(const [ws,p] of players)if(p.expires<=now){remove(ws);ws.close(1008,'Session expired');}
    const active=[...players.values()];
    const game=round.step(now,active,queueScore);
    for(const [ws,p] of players){
      if(p.expires<=now){remove(ws);ws.close(1008,'Session expired');continue;}
      if(now-p.lastInput>1000||round.frozen(p)){p.dx=0;p.dy=0;}
      const len=Math.hypot(p.dx,p.dy)||1;
      p.x=Math.max(0,Math.min(WIDTH-SIZE,p.x+p.dx/len*SPEED*dt));
      p.y=Math.max(0,Math.min(HEIGHT-SIZE,p.y+p.dy/len*SPEED*dt));
    }
    // One shared snapshot per tick, no SQL or HTTP polling in the movement loop.
    // Drop stale detached sessions (persisted scores can be restored using a new ticket).
    if(ticks%100===0)for(const [key,p] of sessions)if(!active.includes(p)&&now-p.lastSeen>120000)sessions.delete(key);
    const king=active.find(p=>p.key===game.king)?.id??null;
    const state=JSON.stringify({type:'state',tick:++ticks,at:now,round:{phase:game.phase,number:game.number,remainingMs:game.remainingMs,king},players:[...players.values()].map(p=>[p.id,Math.round(p.x*10)/10,Math.round(p.y*10)/10,p.slot,p.dx,p.dy,p.seq,p.classCode,p.seat,p.score,round.frozen(p),round.isCaught(p)])});
    for(const ws of players.keys())send(ws,state);
  },TICK_MS);
  return {server,listen:()=>new Promise(resolve=>server.listen(port,'0.0.0.0',()=>resolve(server.address().port))),close:async()=>{clearInterval(interval);clearInterval(scoreTimer);for(const ws of wss.clients)ws.terminate();await flushScores();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const plaza=createPlaza({secret:process.env.PLAZA_SHARED_SECRET,origin:process.env.CLASSROOM_ORIGIN,port:Number(process.env.PORT)||3000});
  console.log('Realtime plaza listening on',await plaza.listen());
}
