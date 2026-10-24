/* Actual Go SSH worker against ephemeral host/user keys, never real devices. */
const assert=require('node:assert/strict');
const {generateKeyPairSync,createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const {Server,utils}=require(process.env.SSH2_MODULE||'ssh2');
const hostKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'sec1'});
const userKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'sec1'});
const parsed=utils.parseKey(userKey),digest=createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64');
let shells=0,resize=null;const clients=new Set();
const server=new Server({hostKeys:[hostKey]},client=>{
 clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
 client.on('authentication',ctx=>{
  if(ctx.username==='tester'&&ctx.method==='password'&&ctx.password==='synthetic-password')ctx.accept();
  else if(ctx.username==='tester'&&ctx.method==='publickey'&&ctx.key.data.equals(parsed.getPublicSSH())&&(!ctx.signature||parsed.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))ctx.accept();
  else ctx.reject(['password','publickey']);
 });
 client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',accept=>accept());session.on('window-change',(accept,_,info)=>{resize=info;accept&&accept();});session.on('shell',accept=>{shells++;const channel=accept();channel.on('data',data=>channel.write(data));});}));
});
async function worker(config,success){
 const child=spawn(require('node:path').join(__dirname,'../content/ssh-worker/amd64'),[],{stdio:['pipe','pipe','pipe']});let text='',stderr='',output='',ready=false;
 child.stderr.on('data',d=>stderr+=d);const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('worker timeout'));},10000);child.on('exit',()=>{clearTimeout(timer);resolve();});});
 child.stdout.on('data',data=>{text+=data;while(text.includes('\n')){const index=text.indexOf('\n'),message=JSON.parse(text.slice(0,index));text=text.slice(index+1);if(message.type==='ready'){ready=true;child.stdin.write(JSON.stringify({type:'resize',rows:41,columns:101})+'\n');child.stdin.write(JSON.stringify({type:'input',data:Buffer.from('SSH私钥测试; literal $()').toString('base64')})+'\n');}if(message.type==='data'){output+=Buffer.from(message.data,'base64');if(output.includes('SSH私钥测试; literal $()'))child.stdin.end();}}});
 child.stdin.write(JSON.stringify(config)+'\n');await done;assert.equal(stderr,'');assert.equal(ready,success);if(success)assert.equal(output,'SSH私钥测试; literal $()');
}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const config={Host:'127.0.0.1',Port:server.address().port,User:'tester',Digest:digest,HostAlgorithm:'ecdsa-sha2-nistp256'};
 await worker({...config,Password:'synthetic-password'},true);await worker({...config,Key:userKey.toString()},true);
 assert.equal(shells,2);assert.equal(resize.rows,41);assert.equal(resize.cols,101);
 await worker({...config,Digest:'untrusted-key',Password:'synthetic-password'},false);assert.equal(shells,2,'host mismatch must not open a shell');
 console.log('SSH worker passed: password, private key, host-key pinning/rejection, Unicode bytes, window size and clean EOF.');
 }finally{for(const c of clients)c._sock.destroy();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;for(const c of clients)c._sock.destroy();server.close();});
