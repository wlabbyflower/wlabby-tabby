/* Run only against an isolated local test container. See README for prerequisites. */
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28083';
const container=process.env.TEST_CONTAINER||'tabby-060-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated local UI test container');
const fixture=`from django.test import Client
from tabby.app.models import User,Config
from tabby.lpk_support.models import Credential,ConnectionHistory
import json
u,_=User.objects.get_or_create(username="browser-regression")
Credential.objects.filter(user=u).delete()
ConnectionHistory.objects.filter(user=u).delete()
profiles=[{"id":"ssh:fixture","type":"ssh","name":"SSH fixture","options":{"host":"fixture.example.test","port":22,"user":"tester","auth":"password"}}]
c=Config.objects.create(user=u,name="Regression",content=json.dumps({"profiles":profiles,"recoverTabs":False}))
u.active_config=c
u.save()
client=Client()
client.force_login(u,backend="django.contrib.auth.backends.ModelBackend")
print(client.cookies["sessionid"].value)`;
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',fixture],{encoding:'utf8'}).trim();
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const guest=await browser.newPage();await guest.goto(base);
  await guest.getByRole('heading',{name:'OIDC 登录',exact:true}).waitFor();
  assert.ok(parseFloat(await guest.locator('h1').evaluate(n=>getComputedStyle(n).fontSize))>=44);
  assert.match(await guest.getByRole('link',{name:/OIDC 登录/}).getAttribute('href'),/^\/api\/1\/auth\/social\/login\/oidc\//);
  await guest.close();
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:1440,height:960}});
  await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
  const page=await context.newPage(),errors=[],input=[];let lightConnections=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url());});
  page.on('dialog',d=>d.accept());
  await page.route('**/lightos/api/local-terminal',r=>r.fulfill({json:{host:'fixture.example.test',port:22,user:'root'}}));
  await page.route('**/lightos/api/instances',r=>r.fulfill({json:[{name:'demo',owner_deploy_id:'fixture.app',status:'running'},{name:'stopped',owner_deploy_id:'fixture.app',status:'stopped'}]}));
  let closeLight=null;
  await page.routeWebSocket('**/lightos-terminal/**',ws=>{
   lightConnections++;closeLight=()=>ws.close();ws.send(Buffer.from('\r\nLIGHTOS clipboard regression\r\n$ '));
   ws.onMessage(m=>{if(typeof m==='string'){const data=JSON.parse(m);if(data.type==='ping')ws.send(JSON.stringify({type:'pong'}));}else{input.push(Buffer.from(m).toString());ws.send(m);}});
  });
  async function load(){await page.goto(base);const frame=page.frameLocator('iframe').first();await frame.locator('tabby-connection-hub h1').waitFor();return page.frames().find(f=>f.url().endsWith('/terminal'));}
  let frame=await load(),hub=frame.locator('tabby-connection-hub');
  await hub.getByText('SSH fixture',{exact:true}).waitFor();
  await hub.getByRole('button',{name:'LightOS 实例',exact:true}).click();
  await hub.locator('.row-item').filter({hasText:'demo'}).getByRole('button',{name:'打开终端'}).click();
  const pane=frame.locator('lightos-terminal-tab .xterm');await pane.waitFor();
  const status=frame.locator('lightos-terminal-tab .tabby-connection-status');
  await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();
  await page.waitForTimeout(500);
  const pasted=()=>input.join('');
  const occurrences=(text)=>pasted().split(text).length-1;
  async function expectCount(token,count){await page.waitForTimeout(350);assert.equal(occurrences(token),count,'paste count for '+token+' / '+JSON.stringify(pasted()));}
  await page.evaluate(()=>navigator.clipboard.writeText('CONTEXT_ONCE'));
  await pane.click({button:'right'});await frame.getByText('粘贴',{exact:true}).last().click();await expectCount('CONTEXT_ONCE',1);
  await page.evaluate(()=>navigator.clipboard.writeText('KEYBOARD_ONCE'));
  await pane.click();await page.keyboard.press('Control+v');await expectCount('KEYBOARD_ONCE',1);
  await page.keyboard.press('Control+v');await expectCount('KEYBOARD_ONCE',2);
  await page.evaluate(()=>navigator.clipboard.writeText('SHIFT_KEY_ONCE'));
  await page.keyboard.press('Control+Shift+v');await expectCount('SHIFT_KEY_ONCE',1);
  // Edit-menu / native browser paste is also handled once, independent of keydown.
  await pane.locator('textarea').evaluate(n=>{const data=new DataTransfer();data.setData('text/plain','NATIVE_EVENT_ONCE');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  await expectCount('NATIVE_EVENT_ONCE',1);
  await frame.evaluate(()=>Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:async()=>{throw Error('denied')}}));
  await pane.click({button:'right'});await frame.getByText('粘贴',{exact:true}).last().click();
  const manual=frame.locator('tabby-clipboard-dialog');await manual.locator('textarea').fill('FALLBACK_ONCE');await manual.getByRole('button',{name:'粘贴',exact:true}).click();await expectCount('FALLBACK_ONCE',1);
  await status.getByRole('button',{name:'断开连接'}).click();await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=disconnected]').waitFor();
  await status.getByRole('button',{name:'重新连接'}).click();await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=connected]').waitFor();assert.equal(lightConnections,2);
  closeLight();await frame.locator('lightos-terminal-tab .tabby-connection-status[data-state=disconnected]').waitFor();
  await frame.getByRole('button',{name:'连接首页',exact:true}).click();
  hub=frame.locator('tabby-connection-hub');await hub.getByRole('button',{name:'已保存连接',exact:true}).click();
  await hub.getByRole('button',{name:'刷新列表',exact:true}).click();await hub.getByText('LightOS · demo',{exact:true}).waitFor();
  const service='ssh@fixture.example.test:22',account='tester';
  await frame.evaluate(async({service,account})=>window.require('keytar').setPassword(service,account,'synthetic-old-password'),{service,account});
  await hub.getByRole('button',{name:'已保存密码',exact:true}).click();await hub.getByText(service,{exact:true}).waitFor();
  await hub.getByRole('button',{name:'替换密码'}).click();const edit=frame.locator('tabby-saved-password');await edit.locator('input[type=password]').fill('synthetic-new-password');await edit.getByRole('button',{name:'保存密码',exact:true}).click();await edit.waitFor({state:'hidden'});
  assert.equal(await frame.evaluate(async({service,account})=>window.require('keytar').getPassword(service,account),{service,account}),'synthetic-new-password');
  frame=await load();hub=frame.locator('tabby-connection-hub');await hub.getByRole('button',{name:'已保存密码',exact:true}).click();await hub.getByText(service,{exact:true}).waitFor();
  await hub.getByRole('button',{name:'删除密码'}).click();try{await hub.getByText('没有保存的密码。',{exact:false}).waitFor({timeout:7000});}catch(e){console.log('DELETE_STATE',await frame.locator('body').innerText());throw e;}
  assert.equal(await frame.evaluate(async({service,account})=>window.require('keytar').getPassword(service,account),{service,account}),null);
  await hub.getByRole('button',{name:'已保存连接',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');await hub.getByRole('button',{name:'导出连接',exact:true}).click();const download=await downloadPromise;
  const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const exported=JSON.parse(Buffer.concat(chunks).toString());assert.equal(exported.profiles.length,1);assert.deepEqual(Object.keys(exported.profiles[0].options).sort(),['auth','host','port','user']);
  const imported={format:'tabby-connections',version:1,profiles:[{name:'Imported fixture',group:'test',options:{host:'import.example.test',port:2222,user:'tester',password:'must-not-import'}}]};
  await hub.locator('input[type=file]').setInputFiles({name:'connections.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});await hub.getByText('Imported fixture',{exact:true}).waitFor();
  await page.getByRole('button',{name:'收起左侧栏',exact:true}).click();assert.equal(await page.locator('.sidebar').isVisible(),false);
  frame=await load();assert.equal(await page.locator('.sidebar').isVisible(),false);await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();assert.equal(await page.locator('.sidebar').isVisible(),true);
  try{await frame.locator('tabby-connection-hub').getByText('Imported fixture',{exact:true}).waitFor({timeout:5000});}catch(e){console.log('RELOAD_STATE',await frame.locator('body').innerText());throw e;}
  assert.deepEqual(errors,[]);await page.screenshot({path:process.env.TEST_SCREENSHOT||'/tmp/tabby-060-regression.png'});
  console.log('Browser regression passed: OIDC first; connection hub; paste exactly once for context/keyboard/browser/fallback; two deliberate pastes preserved; status, disconnect/reconnect; recent history; credential replace/delete; import/export; sidebar persistence.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
