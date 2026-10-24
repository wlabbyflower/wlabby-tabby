/* Real browser + shipped xterm/SSH + server broker; synthetic credentials only. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {generateKeyPairSync}=require('node:crypto');
const {Server,utils}=require(process.env.SSH2_MODULE||'ssh2');
const WS=require(process.env.WS_MODULE||'ws');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28087',container=process.env.TEST_CONTAINER||'tabby-067-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated fixture');
const code=`from django.test import Client
from tabby.app.models import User,Config
u,_=User.objects.get_or_create(username="persistent-browser-test")
c=Config.objects.create(user=u,name="Persistence regression",content='{"recoverTabs":false}')
u.active_config=c
u.save()
client=Client()
client.force_login(u,backend="django.contrib.auth.backends.ModelBackend")
print(client.cookies["sessionid"].value)`;
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
const connections=new Set(),shells=[];let auths=0;
const server=new Server({algorithms:{kex:['ecdh-sha2-nistp256']},hostKeys:[generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'pem',type:'sec1'})]},client=>{
 connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
 client.on('authentication',ctx=>{if(ctx.method==='password'&&ctx.username==='tester'&&ctx.password==='synthetic-password'){auths++;ctx.accept();}else ctx.reject(['password']);});
 client.on('ready',()=>client.on('session',accept=>{
  const session=accept();session.on('pty',accept=>accept&&accept());session.on('window-change',accept=>accept&&accept());
  session.on('sftp',accept=>{const sftp=accept();let read=false;const status=utils.sftp.STATUS_CODE;
   sftp.on('REALPATH',id=>sftp.name(id,[{filename:'/',longname:'/',attrs:{}}]));
   sftp.on('STAT',id=>sftp.attrs(id,{mode:0o40755,size:0,uid:0,gid:0,atime:0,mtime:0}));
   sftp.on('OPENDIR',id=>{read=false;sftp.handle(id,Buffer.from([1]));});
   sftp.on('READDIR',id=>{if(read)sftp.status(id,status.EOF);else{read=true;sftp.name(id,[{filename:'persistent-sftp.txt',longname:'persistent-sftp.txt',attrs:{mode:0o100644,size:3,uid:0,gid:0,atime:0,mtime:0}}]);}});
   sftp.on('CLOSE',id=>sftp.status(id,status.OK));
  });
  session.on('shell',accept=>{const stream=accept();shells.push(stream);stream.write('SAME_SSH_SHELL_'+shells.length+'\r\n$ ');stream.on('data',data=>stream.write(data));});
 }));
});
(async()=>{
 await new Promise(resolve=>server.listen(22227,'127.0.0.1',resolve));
 async function control(message){const ws=new WS('ws://127.0.0.1:29004/',{headers:{'X-HC-User-ID':'persistent-browser-test','X-HC-User-Role':'ADMIN',Origin:'http://127.0.0.1:29004'}});return new Promise((resolve,reject)=>{ws.on('open',()=>ws.send(JSON.stringify(message)));ws.on('message',data=>{ws.close();resolve(JSON.parse(data));});ws.on('error',reject);});}
 for(const item of (await control({action:'list'})).items)await control({action:'end',id:item.id});
 const browser=await chromium.launch({headless:true}),errors=[];
 try{
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const plugin=require('node:fs').readFileSync(require('node:path').join(__dirname,'../content/tabby-lightos/dist/index.js'),'utf8').replace('attach(tab){','attach(tab){window.__activeTestTab=tab;');
  await context.route('**/tabby-lightos/dist/index.js',r=>r.fulfill({contentType:'application/javascript',body:plugin}));
  await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
  await context.route('**/lightos/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path.endsWith('instances')&&!path.includes('client-')?[{name:'fixture',owner_deploy_id:'test.owner',status:'running'}]:path.endsWith('client-instances')?[]:{mode:'host-terminal'}});});
  function proxy(route,url,headers){const remote=new WS(url,headers?{headers}:undefined),pending=[];
   remote.on('open',()=>{for(const m of pending)remote.send(m);});remote.on('message',(data,binary)=>route.send(binary?data:data.toString()));remote.on('error',()=>{});remote.on('close',()=>{try{route.close();}catch(_){}});
   route.onMessage(data=>{if(remote.readyState===1)remote.send(data);else pending.push(data);});route.onClose(()=>remote.close());
  }
  await context.routeWebSocket('**/sessions/',route=>proxy(route,'ws://127.0.0.1:29004/',{'X-HC-User-ID':'persistent-browser-test','X-HC-User-Role':'ADMIN',Origin:'http://127.0.0.1:29004'}));
  await context.routeWebSocket('**/gateway/',route=>proxy(route,'ws://127.0.0.1:29002/'));
  async function load(){const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(base);await page.frameLocator('iframe').first().locator('tabby-connection-hub h1, .tabby-connection-status').first().waitFor();const frame=page.frames().find(f=>f.url().endsWith('/terminal'));await frame.evaluate(()=>{const base=window.require('tabby-terminal').BaseTerminalTabComponent.prototype,write=base.write;base.write=function(value,...args){window.__activeTestTab=this;return write.call(this,value,...args);};});return {page,frame};}
  let {page,frame}=await load();
  await frame.getByRole('button',{name:'新建 SSH 连接',exact:true}).click();const form=frame.locator('lightos-new-ssh');
  await form.getByPlaceholder('设备 IP 或主机名').fill('127.0.0.1');await form.locator('input[type=number]').fill('22227');await form.getByPlaceholder('设备用户名').fill('tester');await form.locator('input[autocomplete=new-password]').fill('synthetic-password');await form.getByPlaceholder('可选',{exact:true}).fill('Persistent SSH');await form.getByRole('button',{name:'保存并连接',exact:true}).click();
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
   if(await frame.locator('ssh-tab .tabby-connection-status[data-state=connected]').count())break;
   const key=frame.getByRole('button',{name:/接受并记住密钥|Accept and remember key/i});if(await key.isVisible())await key.click({force:true});
   await page.waitForTimeout(100);
  }
  const connected=()=>frame.locator('ssh-tab .tabby-connection-status[data-state=connected]');
  try{await connected().waitFor({timeout:3000});}catch(e){console.log('STATE',await frame.locator('body').innerText(),errors);throw e;}
  await page.waitForTimeout(400);assert.equal(shells.length,1);assert.equal(auths,2,'initial trust/auth plus server-owned shell');
  await frame.locator('ssh-tab .xterm').click();await page.keyboard.type('BEFORE_CLOSE');await page.waitForTimeout(100);
  await page.close();shells[0].write('\r\nSSH_JOB_CONTINUES_OFFLINE\r\n');
  ({page,frame}=await load());await connected().waitFor();await page.waitForTimeout(400);
  assert.equal(shells.length,1,'reopening must attach the original SSH shell');assert.equal(auths,2,'restore must not authenticate again');
  const screen=()=>frame.evaluate(()=>{const n=window.__activeTestTab;return n&&n.frontend&&Array.from({length:n.frontend.xterm.buffer.active.length},(_,i)=>n.frontend.xterm.buffer.active.getLine(i).translateToString()).join('\n');});
  // The frontend is real xterm; inspect rendered text via its public buffer.
  await frame.locator('ssh-tab .xterm').click();await page.keyboard.type('AFTER_REOPEN');await page.waitForTimeout(300);
  const text=await screen();assert.match(text,/SSH_JOB_CONTINUES_OFFLINE/);assert.match(text,/AFTER_REOPEN/);
  await frame.getByText('SFTP',{exact:true}).click();await frame.locator('sftp-panel').getByText('persistent-sftp.txt',{exact:true}).waitFor();
  await frame.getByRole('button',{name:'连接首页',exact:true}).click();await frame.getByRole('button',{name:'LZC OS 本机终端',exact:true}).click();
  await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();
  await frame.locator('lightos-terminal-tab .xterm').click();await page.keyboard.type('export PERSIST_FIXTURE=kept; echo HOST_PID=$$; (sleep 1; echo HOST_JOB_FINISHED) &');await page.keyboard.press('Enter');
  await page.waitForTimeout(300);await page.close();await new Promise(r=>setTimeout(r,1300));
  ({page,frame}=await load());await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();await page.waitForTimeout(400);
  await frame.locator('lightos-terminal-tab .xterm').click();await page.keyboard.type('echo ENV=$PERSIST_FIXTURE; echo RESTORED_PID=$$');await page.keyboard.press('Enter');await page.waitForTimeout(400);
  const hostText=await screen();assert.match(hostText,/HOST_JOB_FINISHED/);assert.match(hostText,/ENV=kept/);assert.equal(hostText.match(/HOST_PID=(\d+)/)[1],hostText.match(/RESTORED_PID=(\d+)/)[1]);
  // Explicit disconnect removes just this host session; it must not reappear.
  await frame.locator('lightos-terminal-tab .tabby-connection-status').getByRole('button',{name:'断开连接',exact:true}).click();await page.waitForTimeout(200);await page.close();
  ({page,frame}=await load());await connected().waitFor();assert.equal(await frame.locator('lightos-terminal-tab').count(),0);assert.equal(shells.length,1);
  await frame.getByRole('button',{name:'连接首页',exact:true}).click();
  await frame.locator('tabby-connection-hub').getByRole('button',{name:'LightOS 实例',exact:true}).click();
  await frame.locator('tabby-connection-hub .row-item').filter({hasText:'fixture'}).getByRole('button',{name:'打开终端',exact:true}).click();
  await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();
  await frame.locator('lightos-terminal-tab .xterm').click();await page.keyboard.type('export LIGHTOS_FIXTURE=kept; echo LIGHTOS_PID=$$');await page.keyboard.press('Enter');await page.waitForTimeout(200);await page.close();
  ({page,frame}=await load());await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();
  await frame.locator('lightos-terminal-tab .xterm').click();await page.keyboard.type('echo LIGHTOS_ENV=$LIGHTOS_FIXTURE; echo LIGHTOS_RESTORED_PID=$$');await page.keyboard.press('Enter');await page.waitForTimeout(300);
  const lightosText=await screen();assert.match(lightosText,/LIGHTOS_ENV=kept/);assert.equal(lightosText.match(/LIGHTOS_PID=(\d+)/)[1],lightosText.match(/LIGHTOS_RESTORED_PID=(\d+)/)[1]);
  await frame.locator('lightos-terminal-tab .tabby-connection-status').getByRole('button',{name:'断开连接',exact:true}).click();
  await frame.getByRole('button',{name:'连接首页',exact:true}).click();await frame.locator('tabby-connection-hub').getByRole('button',{name:'回到终端',exact:true}).click();
  await frame.getByText('Reconnect',{exact:true}).evaluate(label=>{const b=label.closest('button');b.click();b.click();});
  await connected().waitFor();await page.waitForTimeout(400);assert.equal(shells.length,2,'rapid reconnect must create exactly one new shell');
  await frame.getByText('SFTP',{exact:true}).click();await frame.locator('sftp-panel').getByText('persistent-sftp.txt',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('Persistence browser passed: original SSH shell, host and LightOS PID/environment, offline output/jobs, automatic restore, no re-authentication, SFTP after restore/reconnect, rapid reconnect, explicit disconnect, account isolation covered separately.');
  await frame.locator('ssh-tab .tabby-connection-status').getByRole('button',{name:'断开连接',exact:true}).click();
 }finally{await browser.close();for(const c of connections)c._sock.destroy();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;for(const c of connections)c._sock.destroy();server.close();});
