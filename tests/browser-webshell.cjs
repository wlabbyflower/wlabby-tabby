/* Provider URLs and native-management launcher in an isolated test application. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28086',container=process.env.TEST_CONTAINER||'tabby-063-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated local UI test container');
const code='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="webshell-regression");cfg=Config.objects.create(user=u,name="WebShell fixture",content=\'{"recoverTabs":false}\');u.active_config=cfg;u.save();c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage(),errors=[],targets=[];let managerError=false;
 page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message);});
 const guest=await page.goto(base+'/?name=demo%40owner.test');assert.equal(guest.status(),200);
 const login=new URL(await page.getByRole('link',{name:'使用微服账号进行 OIDC 登录 →'}).getAttribute('href'),base);assert.equal(login.searchParams.get('next'),'/?name=demo%40owner.test');
 const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
 await page.context().addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
 await page.route('**/tabby-lightos/dist/index.js',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(__dirname,'../content/tabby-lightos/dist/index.js'),'utf8')}));
 await page.route('**/lightos/',r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'../content/lightos.html'),'utf8')}));
 await page.route('**/lightos/api/**',r=>{
  const endpoint=new URL(r.request().url()).pathname;
  if(endpoint.endsWith('/admin-info'))return r.fulfill(managerError?{status:403,json:{error:'denied'}}:{json:{home_url:'https://lightos.example.test/?view=home'}});
  const data=endpoint.endsWith('/instances')?[{name:'demo',owner_deploy_id:'owner.test',status:'running'}]:endpoint.endsWith('/client-instances')?[{id:'pc-fixture',name:'Fixture PC',status:'online',platform:'linux'}]:endpoint.endsWith('/local-terminal-ticket')?{ticket:'synthetic-ticket'}:{mode:'host-terminal'};
  return r.fulfill({json:data});
 });
 await page.routeWebSocket('**/lightos-terminal/**',ws=>{targets.push(new URL(ws.url()).searchParams.toString());if(ws.url().includes('client='))ws.send('{"type":"ready"}');ws.send(Buffer.from('PROVIDER_FIXTURE\r\n$ '));ws.onMessage(m=>{if(typeof m==='string'&&JSON.parse(m).type==='ping')ws.send('{"type":"pong"}');});});
 const load=async(query)=>{await page.goto(base+'/'+query);const f=page.frameLocator('iframe').first();try{await f.locator('.xterm-screen, tabby-connection-hub h1').first().waitFor({timeout:10000});}catch(e){console.log('DEBUG',await page.locator('body').innerText(),await Promise.all(page.frames().map(async f=>({url:f.url(),text:await f.locator('body').innerText().catch(()=>'(none)')}))));throw e;}return f;};
 let frame=await load('?name=demo%40owner.test');await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();assert.equal(targets.at(-1),'name=demo&owner=owner.test');assert.equal(new URL(page.url()).searchParams.has('name'),false);
 frame=await load('?target=client%3Apc-fixture');await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();assert.equal(targets.at(-1),'client=pc-fixture');
 frame=await load('?lightos=demo&owner=owner.test');await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();assert.equal(targets.at(-1),'name=demo&owner=owner.test');
 const attempts=targets.length;frame=await load('?name=demo%40foreign.test');await frame.getByRole('alert').filter({hasText:'不可访问'}).waitFor();assert.equal(targets.length,attempts,'foreign target must not connect');
 frame=await load('?view=home');await frame.locator('tabby-connection-hub h1').waitFor();await frame.locator('tabby-connection-hub').getByRole('button',{name:'LightOS 实例',exact:true}).click();await frame.getByRole('button',{name:'管理实例',exact:true}).click();
 const manager=frame.frameLocator('lightos-manager-tab iframe');const link=manager.getByRole('link',{name:'打开 LightOS 管理 ↗'});await link.waitFor();assert.equal(await link.getAttribute('href'),'https://lightos.example.test/?view=home');assert.equal(await link.getAttribute('target'),'_blank');assert.ok((await link.getAttribute('rel')).includes('noopener'));assert.equal(new URL(page.url()).pathname,'/');assert.equal(await manager.getByRole('button',{name:'创建并启动'}).count(),0);
 managerError=true;await page.goto(base+'/lightos/');await page.getByRole('alert').filter({hasText:'管理员'}).waitFor();assert.equal(await page.getByRole('link',{name:'打开 LightOS 管理 ↗'}).isVisible(),false);
 assert.deepEqual(errors,[]);console.log('WebShell browser passed: OIDC target retention, server/client/legacy provider links, unauthorized target, native-management launcher and denied access.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
