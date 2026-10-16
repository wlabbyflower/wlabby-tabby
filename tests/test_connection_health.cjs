const assert=require('node:assert/strict');
const {watch}=require('../content/tabby-lightos/dist/connection-health.js');
function fixture(){let time=0,pings=0,failures=[],removed=0;const listeners=new Map();const ws={readyState:1};const h=watch(ws,()=>pings++,m=>failures.push(m),{interval:10,timeout:40,now:()=>time,setInterval:()=>1,clearInterval:()=>removed++,events:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)}});return {h,ws,listeners,time:t=>time=t,pings:()=>pings,failures,removed:()=>removed};}
let f=fixture();f.h.tick();assert.equal(f.pings(),1);f.time(30);f.h.pong();f.h.tick();assert.equal(f.pings(),2);assert.equal(f.failures.length,0);f.time(71);f.h.tick();assert.equal(f.failures.length,1);assert.equal(f.removed(),1);assert.equal(f.listeners.size,0);
f=fixture();f.h.tick();f.time(1000);f.listeners.get('focus')();assert.equal(f.pings(),2);assert.equal(f.failures.length,0);f.time(1041);f.h.tick();assert.equal(f.failures.length,1);
f=fixture();f.ws.readyState=3;f.h.tick();assert.equal(f.failures.length,1);assert.equal(f.pings(),0);
console.log('Heartbeat regression tests passed: live, timeout, wake from suspension, closed transport, cleanup.');
