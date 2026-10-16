const assert=require('node:assert/strict'),entry=require('../content/tabby-lightos/src/webshell-entry.js');
(async()=>{
 const instance={name:'demo',owner_deploy_id:'owner.test',status:'running'},client={id:'pc',status:'online'};
 const instances=async()=>[instance],clients=async()=>[client];
 for(const query of ['?name=demo%40owner.test','?target=demo%40owner.test','?lightos=demo&owner=owner.test'])assert.deepEqual(await entry.resolve(entry.target(new URL('https://tabby.example.test/'+query)),instances,clients),{kind:'instance',item:instance});
 assert.deepEqual(await entry.resolve(entry.target(new URL('https://tabby.example.test/?name=client%3Apc')),instances,clients),{kind:'client',item:client});
 assert.equal(entry.target(new URL('https://tabby.example.test/?view=home')),null);
 for(const query of ['?name=../demo','?name=demo@owner@other','?name=client:','?name=demo%0A'])assert.throws(()=>entry.target(new URL('https://tabby.example.test/'+query)));
 await assert.rejects(entry.resolve({kind:'instance',name:'demo',owner:'other'},instances,clients),/不可访问/);
 await assert.rejects(entry.resolve({kind:'instance',name:'demo',owner:''},async()=>[instance,{...instance,owner_deploy_id:'other'}],clients),/不唯一/);
 await assert.rejects(entry.resolve({kind:'instance',name:'demo',owner:''},async()=>[{...instance,status:'stopped'}],clients),/未运行/);
 await assert.rejects(entry.resolve({kind:'client',id:'foreign'},instances,clients),/不可访问/);
 await assert.rejects(entry.resolve({kind:'client',id:'pc'},instances,async()=>[{...client,status:'offline'}]),/不在线/);
 console.log('WebShell entry passed: selectors, legacy links, home, ownership, ambiguity, offline and malformed targets.');
})().catch(e=>{console.error(e);process.exitCode=1});
