const assert=require('node:assert/strict'),fix=require('../content/tabby-lightos/src/ssh-reconnect.js');
function subject(){return {isStopped:false,callbacks:[],subscribe(fn){this.callbacks.push(fn);},next(){for(const f of this.callbacks)f();},complete(){this.isStopped=true;}};}
function session(profile){return {open:true,profile,willDestroy$:subject(),ssh:{_sock:{destroyed:false}},destroy(){this.willDestroy$.next();this.willDestroy$.complete();return Promise.resolve();}};}
(async()=>{
 const profile={type:'ssh',options:{host:'fixture.example.test',user:'tester',reuseSession:true}},mux={sessions:new Map(),async getMultiplexerKey(){return 'key'},async getSession(){return this.sessions.get('key')}};
 fix.protectMultiplexer(mux);
 const dropped=session(profile);dropped.ssh._sock.socket={webSocket:{readyState:1},close$:subject()};await mux.addSession(dropped);dropped.ssh._sock.socket.webSocket.readyState=3;dropped.ssh._sock.socket.close$.next();assert.equal(dropped.open,false,'closed gateway must close upper-layer SSH');assert.equal(fix.live(dropped),false);
 const old=session(profile),replacement=session(profile);await mux.addSession(old);await mux.addSession(replacement);old.destroy();assert.equal(mux.sessions.get('key'),replacement,'old close must not evict a newer transport');replacement.__tabbyClosing=true;assert.equal(await mux.getSession(profile),null,'closing transport must not be reused');
 let opened=0,destroyed=0;
 const tab={profile,sshMultiplexer:mux,size:{columns:100,rows:30},setSession(s){this.session=s},async setupOneSession(_,p){opened++;assert.equal(p.options.reuseSession,false,'reconnect must request a fresh transport');return session(p)},async initializeSession(){this.sshSession=await this.setupOneSession(null,this.profile);this.session={open:true,async destroy(){destroyed++},releaseInitialDataBuffer(){},resize(){}}},write(){}};
 const cleanup=fix.install(tab);tab.session={async destroy(){await new Promise(r=>setTimeout(r,20));destroyed++}};
 await Promise.all([tab.reconnect(),tab.reconnect(),tab.reconnect()]);assert.equal(opened,1,'concurrent reconnect must be coalesced');assert.equal(destroyed,1);assert.equal(profile.options.reuseSession,true,'saved profile must not be mutated');assert.equal(tab.session.open,true);
 await tab.disconnect();await tab.reconnect();assert.equal(opened,2);cleanup();
 console.log('SSH reconnect passed: closing transport rejected, old-close isolation, fresh transport, concurrency, profile preservation and retry.');
})().catch(e=>{console.error(e);process.exitCode=1});
