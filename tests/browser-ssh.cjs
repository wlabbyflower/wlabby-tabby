/* End-to-end SSH authentication against a synthetic local server; no device credentials. */
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {generateKeyPairSync}=require('node:crypto');
const {Server}=require(process.env.SSH2_MODULE||'ssh2');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28084';
const container=process.env.TEST_CONTAINER||'tabby-061-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated local UI test container');
const code=`from django.test import Client
from tabby.app.models import User,Config
from tabby.lpk_support.models import Credential
u,_=User.objects.get_or_create(username="ssh-browser-test")
Credential.objects.filter(user=u).delete()
c=Config.objects.create(user=u,name="SSH regression",content='{"recoverTabs":false}')
u.active_config=c
u.save()
client=Client()
client.force_login(u,backend="django.contrib.auth.backends.ModelBackend")
print(client.cookies["sessionid"].value)`;
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
const sockets=new Set(),remotes=new Set(),input=[];let authCount=0,passwordPrompts=0;
const server=new Server({algorithms:{kex:['ecdh-sha2-nistp256']},hostKeys:[generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'sec1'})]},client=>{
 sockets.add(client);client.on('error',e=>console.log('SSH_SERVER_ERROR',e.message));client.on('close',()=>sockets.delete(client));
 client.on('authentication',ctx=>{if(ctx.method==='password'&&ctx.username==='tester'&&ctx.password==='synthetic-ssh-password'){authCount++;ctx.accept();}else ctx.reject(['password']);});
 client.on('ready',()=>client.on('session',accept=>{
  const session=accept();session.on('pty',(accept)=>accept&&accept());session.on('env',(accept)=>accept&&accept());
  session.on('shell',accept=>{const stream=accept();stream.write('SSH fixture ready\r\n$ ');stream.on('data',data=>{input.push(data.toString());stream.write(data);});});
 }));
});
(async()=>{
 await new Promise(resolve=>server.listen(22223,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/lightos/api/local-terminal',r=>r.fulfill({json:{host:'127.0.0.1',port:22223,user:'tester'}}));
  await page.route('**/lightos/api/instances',r=>r.fulfill({json:[]}));
  await page.routeWebSocket('**/gateway/',route=>{
   const remote=new WebSocket('ws://127.0.0.1:29002/');remotes.add(remote);remote.binaryType='arraybuffer';const queued=[];
   remote.onopen=()=>{for(const m of queued)remote.send(m);};
   remote.onmessage=e=>route.send(typeof e.data==='string'?e.data:Buffer.from(e.data));
   remote.onerror=()=>{};remote.onclose=()=>{remotes.delete(remote);try{route.close();}catch(_){}};
   route.onMessage(m=>{if(remote.readyState===1)remote.send(m);else queued.push(m);});route.onClose(()=>remote.close());
  });
  async function open(){await page.goto(base);const f=page.frameLocator('iframe').first();try{await f.locator('tabby-connection-hub h1').waitFor();}catch(e){console.error('OPEN_STATE',await page.locator('body').innerText(),{frames:page.frames().map(f=>f.url()),errors});for(const f of page.frames())console.error('FRAME_STATE',f.url(),(await f.locator('body').innerText()).slice(0,2500));throw e;}const frame=page.frames().find(f=>f.url().endsWith('/terminal'));await frame.evaluate(()=>{window.__testWrites=[];const p=window.require('tabby-terminal').BaseTerminalTabComponent.prototype,original=p.write;p.write=function(value,...args){window.__testWrites.push(String(value));return original.call(this,value,...args);};});if(authCount===0){
    await frame.getByRole('button',{name:'新建 SSH 连接',exact:true}).click();const form=frame.locator('lightos-new-ssh');
    await form.getByPlaceholder('设备 IP 或主机名').fill('127.0.0.1');await form.locator('input[type=number]').fill('22223');await form.getByPlaceholder('设备用户名').fill('tester');
    await form.locator('input[autocomplete=new-password]').fill('synthetic-ssh-password');await form.getByPlaceholder('可选',{exact:true}).fill('SSH form fixture');
    assert.equal(await form.locator('input[autocomplete=new-password]').getAttribute('type'),'password');
    await form.getByRole('button',{name:'显示密码',exact:true}).click();assert.equal(await form.locator('input[autocomplete=new-password]').getAttribute('type'),'text');
    await form.getByRole('button',{name:'隐藏密码',exact:true}).click();await form.getByRole('button',{name:'保存并连接',exact:true}).click();await form.waitFor({state:'hidden'});
   }else await frame.locator('tabby-connection-hub .row-item').filter({hasText:'SSH form fixture'}).getByRole('button',{name:'连接',exact:true}).last().click();return frame;}
  let frame=await open();
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
   if(await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').count())break;
   if(await frame.locator('ssh-tab .tabby-connection-status[data-state=disconnected]').count())break;
   const key=frame.getByRole('button',{name:/接受并记住密钥|Accept and remember key/i});
   if(await key.isVisible())await key.click({force:true});
   const password=frame.locator('ngb-modal-window input[type=password]');
   if(await password.isVisible()){
    passwordPrompts++;const dialog=frame.locator('ngb-modal-window').filter({has:frame.locator('input[type=password]')});
    assert.equal(await dialog.locator('input[type=checkbox]').isChecked(),true);
    await password.fill('synthetic-ssh-password');await dialog.getByRole('button',{name:'OK',exact:true}).click({force:true});
   }
   await page.waitForTimeout(250);
  }
  try{await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').waitFor({timeout:1000});}catch(e){console.error('SSH_STATE',await frame.locator('body').innerText(),{passwordPrompts,authCount,errors,writes:await frame.evaluate(()=>window.__testWrites)});throw e;}
  assert.equal(passwordPrompts,0);assert.ok(!await frame.evaluate(()=>window.__connector__.config.content.includes('synthetic-ssh-password')));assert.equal(authCount,1);
  assert.equal(await frame.evaluate(()=>window.require('keytar').getPassword('ssh@127.0.0.1:22223','tester')),'synthetic-ssh-password');
  const pane=frame.locator('ssh-tab .xterm');await page.evaluate(()=>navigator.clipboard.writeText('SSH_PASTE_ONCE'));await pane.click();await page.keyboard.press('Control+v');await page.waitForTimeout(300);assert.equal(input.join('').split('SSH_PASTE_ONCE').length-1,1);
  // A fresh browser load must authenticate using the encrypted saved password.
  frame=await open();await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').waitFor({timeout:20000});assert.equal(await frame.locator('input[type=password]').count(),0);assert.equal(authCount,2);
  // Only restart the isolated test backend; database and encryption key stay stable.
  execFileSync('docker',['restart',container],{stdio:'pipe'});
  for(let i=0;i<40;i++){try{if((await page.request.get(base+'/api/1/auth/providers')).ok())break;}catch(_){}await page.waitForTimeout(250);}
  frame=await open();await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').waitFor({timeout:20000});assert.equal(authCount,3);assert.equal(await frame.locator('input[type=password]').count(),0);
  await frame.locator('ssh-tab .tabby-connection-status').getByRole('button',{name:'断开连接',exact:true}).click();await frame.locator('ssh-tab .tabby-connection-status[data-state=disconnected]').waitFor();
  await frame.locator('ssh-tab .tabby-connection-status').getByRole('button',{name:'重新连接',exact:true}).click();await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').waitFor();assert.equal(await frame.locator('input[type=password]').count(),0);
  assert.deepEqual(errors,[]);
  console.log('Native SSH passed: new connection password field, show/hide, no plaintext in profile, no password re-prompt, real SSH handshake, encrypted credential save, reload and backend restart without password prompts, paste once, disconnect/reconnect.');
 }finally{
  await browser.close();for(const remote of remotes)remote.close();for(const socket of sockets)socket.end();server.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;for(const socket of sockets)socket.end();server.close();});
