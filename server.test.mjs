import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createPlaza,ticket,createKingRound} from './server.mjs';
const secret='test-secret-only-not-for-deployment-123456789';
const origin='https://classroom.example.test';
async function connect(url,sub){
  const ws=new WebSocket(url,{origin});
  let welcome,latest,states=0;
  ws.on('message',raw=>{const x=JSON.parse(raw);if(x.type==='welcome')welcome=x;if(x.type==='state'){latest=x;states++;}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'auth',ticket:ticket(secret,{sub,exp:Date.now()+15000})}));
  return {ws,get welcome(){return welcome},get state(){return latest},get states(){return states}};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('10 second rounds, 3 second countdown, unique captures, freeze and reset',()=>{
 const game=createKingRound({random:()=>0}),players=[
  {key:'a',session:'a',x:0,y:0,score:0,dx:0,dy:0},
  {key:'b',session:'b',x:10,y:0,score:0,dx:1,dy:0},
  {key:'c',session:'c',x:100,y:0,score:0,dx:0,dy:0}];
 const recorded=[];const tick=ms=>game.step(ms,players,p=>recorded.push(p.score));
 assert.deepEqual(tick(0),{phase:'countdown',number:1,remainingMs:3000,king:'a'});
 assert.ok(game.frozen(players[0]));assert.equal(tick(2999).phase,'countdown');
 assert.equal(tick(3000).remainingMs,10000);assert.equal(players[0].score,1);assert.ok(game.frozen(players[1]));
 tick(3500);assert.equal(players[0].score,1);
 players[2].x=18;tick(4000);assert.equal(players[0].score,2);
 assert.deepEqual(recorded,[1,2]);assert.equal(tick(12999).phase,'playing');
 assert.equal(tick(13000).phase,'countdown');assert.equal(tick(16000).phase,'playing');
 assert.equal(players[0].score,4,'previously frozen players can score again only in the next round');
});
test('80 socket clients; distinct colors, movement, departure, capacity and authentication',async()=>{
  const service=createPlaza({secret,origin});const port=await service.listen(),url='ws://127.0.0.1:'+port+'/plaza';
  try{
    const clients=await Promise.all(Array.from({length:80},(_,i)=>connect(url,'student-'+i)));
    await sleep(300);
    assert.equal(clients[0].state.players.length,80);
    assert.equal(new Set(clients.map(c=>c.welcome.color)).size,80);
    const one=clients[0],two=clients[1],id=one.welcome.id;
    const before=two.state.players.find(p=>p[0]===id);
    const dx=before[1]>480?-1:1;one.ws.send(JSON.stringify({type:'input',dx,dy:0,seq:1}));
    const count=two.states;await sleep(550);
    const after=two.state.players.find(p=>p[0]===id);
    assert.ok((after[1]-before[1])*dx>70);
    assert.ok(two.states-count>=8);
    const extra=await connect(url,'extra');await new Promise(resolve=>extra.ws.once('close',resolve));
    one.ws.close();await sleep(150);assert.equal(two.state.players.length,79);
    const stranger=new WebSocket(url,{origin});await new Promise(r=>stranger.once('open',r));
    stranger.send(JSON.stringify({type:'auth',ticket:'invalid'}));await new Promise(r=>stranger.once('close',r));
    assert.equal(two.state.players.length,79);
  }finally{await service.close();}
});
