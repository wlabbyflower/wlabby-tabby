/* Isolated real npm bundle install, browser bootstrap and account persistence. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28088',container=process.env.TEST_CONTAINER||'tabby-068-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated fixture');
const fixture='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="plugin-browser-test");c=Config.objects.create(user=u,name="Plugin fixture",content="{\\"recoverTabs\\":false}");u.active_config=c;u.save();client=Client();client.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(client.cookies["sessionid"].value)';
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',fixture],{encoding:'utf8'}).trim();
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});try{
 const context=await browser.newContext();await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
 await context.route('**/lightos/api/**',r=>r.fulfill({json:r.request().url().includes('local-terminal')?{mode:'host-terminal'}:[]}));
 await context.routeWebSocket('**/sessions/',ws=>ws.onMessage(m=>{const data=JSON.parse(m);if(data.action==='list')ws.send(JSON.stringify({type:'sessions',items:[]}));}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function open(query=''){await page.goto(base+'/'+query);const frame=page.frames().find(f=>f.url().endsWith('/terminal'));await page.frameLocator('iframe').first().locator('tabby-connection-hub h1').waitFor();assert.equal(new URL(page.url()).pathname,'/');return page.frames().find(f=>f.url().endsWith('/terminal'));}
 let frame=await open();await frame.getByRole('button',{name:'插件',exact:true}).first().click();const ui=()=>frame.locator('tabby-plugin-manager');
 await ui().getByLabel('插件包名',{exact:true}).fill('tabby-theme-snazzy');await ui().getByLabel('插件版本',{exact:true}).fill('0.2.0');await ui().getByRole('button',{name:'安装插件',exact:true}).click();
 await ui().getByRole('status').waitFor({timeout:60000});await ui().getByText('tabby-theme-snazzy',{exact:true}).waitFor();
 frame=await open();assert.equal(await frame.evaluate(()=>typeof window.require('tabby-theme-snazzy').default),'function');
 await frame.getByRole('button',{name:'插件',exact:true}).first().click();await ui().getByText('tabby-theme-snazzy',{exact:true}).waitFor();
 await ui().getByRole('button',{name:'禁用',exact:true}).click();await ui().getByRole('status').waitFor();frame=await open();assert.equal(await frame.evaluate(()=>{try{window.require('tabby-theme-snazzy');return true;}catch(_){return false;}}),false);
 await frame.getByRole('button',{name:'插件',exact:true}).first().click();await ui().getByRole('button',{name:'启用',exact:true}).click();await ui().getByRole('status').waitFor();
 frame=await open('?plugins=off');assert.equal(await frame.evaluate(()=>{try{window.require('tabby-theme-snazzy');return true;}catch(_){return false;}}),false);
 execFileSync('docker',['restart',container],{encoding:'utf8'});await page.waitForTimeout(1000);frame=await open();assert.equal(await frame.evaluate(()=>typeof window.require('tabby-theme-snazzy').default),'function');
 // A second account cannot see or fetch the first account's installed assets.
 const other='from django.test import Client;from tabby.app.models import User;u,_=User.objects.get_or_create(username="plugin-other-user");c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
 const otherSession=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',other],{encoding:'utf8'}).trim();
 const stranger=await browser.newContext();await stranger.addCookies([{name:'sessionid',value:otherSession,url:base}]);const list=await stranger.request.get(base+'/api/1/plugins/');assert.deepEqual((await list.json()).items,[]);const asset=await stranger.request.get(base+'/app-dist/1.0.187-nightly.1/tabby-theme-snazzy/dist/index.js');assert.equal(asset.status(),404);await stranger.close();
 await frame.getByRole('button',{name:'插件',exact:true}).first().click();await ui().getByRole('button',{name:'卸载',exact:true}).click();await ui().getByRole('status').waitFor();frame=await open();assert.equal(await frame.evaluate(()=>{try{window.require('tabby-theme-snazzy');return true;}catch(_){return false;}}),false);
 assert.deepEqual(errors,[]);console.log('Plugin browser passed: real npm install and bootstrap, enable/disable/uninstall, root landing, safe mode, restart persistence and cross-account asset denial.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
