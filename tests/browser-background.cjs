/* Isolated actual settings UI, private image upload, canvas transparency and storage. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28089',container=process.env.TEST_CONTAINER||'tabby-069-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated fixture');
const fixture='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="background-browser-test");c=Config.objects.create(user=u,name="Background fixture",content="{\\"recoverTabs\\":false}");u.active_config=c;u.save();client=Client();client.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(client.cookies["sessionid"].value)';
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',fixture],{encoding:'utf8'}).trim();
const image=execFileSync('python3',['-c',"from PIL import Image;import sys;im=Image.new('RGB',(64,32),(255,0,0));im.paste((0,0,255),(32,0,64,32));im.save(sys.stdout.buffer,format='PNG')"]);
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});try{
 const context=await browser.newContext({viewport:{width:1280,height:900}});await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
 const plugin=fs.readFileSync(path.join(__dirname,'../content/tabby-lightos/dist/index.js'),'utf8').replace('attach(tab){','attach(tab){window.__backgroundTab=tab;');
 await context.route('**/tabby-lightos/dist/index.js',r=>r.fulfill({contentType:'application/javascript',body:plugin}));
 await context.route('**/lightos/api/**',r=>r.fulfill({json:r.request().url().includes('local-terminal')?{mode:'host-terminal'}:[]}));
 const input=[];let send;
 await context.routeWebSocket('**/sessions/',ws=>{let seq=0;ws.onMessage(m=>{if(typeof m==='string'){const d=JSON.parse(m);if(d.action==='list')ws.send(JSON.stringify({type:'sessions',items:[]}));else if(d.action==='end')ws.send(JSON.stringify({type:'ended'}));else if(d.action==='create'){send=data=>ws.send(JSON.stringify({type:'output',seq:++seq,data:Buffer.from(data).toString('base64')}));ws.send(JSON.stringify({type:'attached',id:'background-fixture'}));ws.send(JSON.stringify({type:'replay-end'}));ws.send(JSON.stringify({type:'ready'}));}else if(d.type==='ping')ws.send('{"type":"pong"}');}else input.push(Buffer.from(m).toString());});});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function open(){await page.goto(base);await page.frameLocator('iframe').first().locator('tabby-connection-hub h1').waitFor();return page.frames().find(f=>f.url().endsWith('/terminal'));}
 let frame=await open();assert.equal(await frame.getByRole('button',{name:'插件',exact:true}).count(),0);
 assert.equal((await context.request.get(base+'/api/1/plugins/')).status(),404);
 await frame.getByRole('button',{name:'背景',exact:true}).first().click();let ui=()=>frame.locator('settings-tab tabby-background-settings');await ui().getByRole('heading',{name:'终端背景',exact:true}).waitFor();await frame.locator('settings-tab .nav-pills').getByText('终端背景',{exact:true}).waitFor();
 await ui().locator('input[type=file]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:image});await ui().getByRole('status').filter({hasText:'已保存'}).waitFor();
 let metadata=await (await context.request.get(base+'/api/1/background/')).json();assert.equal(metadata.enabled,true);assert.equal(metadata.width,64);assert.equal(metadata.height,32);assert.ok(metadata.url);
 await frame.getByRole('button',{name:'LZC OS 本机终端',exact:true}).click();await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();
 await frame.waitForFunction(()=>window.__backgroundTab&&window.__backgroundTab.frontend&&window.__backgroundTab.content.nativeElement.style.backgroundImage.includes('/api/1/background/image/'));
 send('\x1b[2J\x1b[H');await page.waitForTimeout(250);
 const screenshot=await frame.locator('.xterm-screen').screenshot();
 const samples=JSON.parse(execFileSync('python3',['-c',"from PIL import Image;import sys,json;im=Image.open(sys.stdin.buffer).convert('RGB');w,h=im.size;print(json.dumps([im.getpixel((w//4,h//2)),im.getpixel((3*w//4,h//2))]))"],{input:screenshot,encoding:'utf8'}));
 assert.ok(samples[0][0]-samples[1][0]>20&&samples[1][2]-samples[0][2]>20,'image must remain visible through actual terminal canvas: '+JSON.stringify(samples));
 send('\x1b[H\x1b[30mBLACK_ON_IMAGE\x1b[0m\r\n\x1b[38;2;0;0;0mTRUE_ON_IMAGE\x1b[0m\r\n');await page.waitForTimeout(180);
 const geometry=await frame.evaluate(()=>({cols:window.__backgroundTab.frontend.xterm.cols,rows:window.__backgroundTab.frontend.xterm.rows}));
 const textShot=await frame.locator('.xterm-screen').screenshot();
 const visible=JSON.parse(execFileSync('python3',['-c',`from PIL import Image
import sys,json
im=Image.open(sys.stdin.buffer).convert('RGB');w,h=im.size
print(json.dumps([sum(1 for r,g,b in im.crop((0,int(y*h/${geometry.rows}),int(13*w/${geometry.cols}),int((y+1)*h/${geometry.rows}))).getdata() if r+g+b>400) for y in (0,1)]))`],{input:textShot,encoding:'utf8'}));
 assert.ok(visible.every(n=>n>20),'black and truecolor Agent text must remain readable over the image: '+visible);
 send('\x1b]11;?\x07');await page.waitForTimeout(100);assert.ok(input.join('').includes('11;rgb:'),'background image must retain a valid terminal color reply');
 await frame.getByRole('button',{name:'背景',exact:true}).first().click();await ui().locator('select').selectOption('contain');await ui().locator('input[type=range]').fill('85');await ui().getByRole('button',{name:'保存设置',exact:true}).click();await ui().getByRole('status').filter({hasText:'已保存'}).waitFor();
 metadata=await (await context.request.get(base+'/api/1/background/')).json();assert.equal(metadata.fit,'contain');assert.equal(metadata.shade,85);
 execFileSync('docker',['restart',container],{encoding:'utf8'});await page.waitForTimeout(1000);frame=await open();metadata=await (await context.request.get(base+'/api/1/background/')).json();assert.equal(metadata.enabled,true);assert.equal(metadata.shade,85);assert.equal((await context.request.get(base+metadata.url)).status(),200);
 const other='from django.test import Client;from tabby.app.models import User;u,_=User.objects.get_or_create(username="background-other-user");c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
 const otherSession=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',other],{encoding:'utf8'}).trim();const stranger=await browser.newContext();await stranger.addCookies([{name:'sessionid',value:otherSession,url:base}]);assert.equal((await (await stranger.request.get(base+'/api/1/background/')).json()).hasImage,false);assert.equal((await stranger.request.get(base+metadata.url)).status(),404);await stranger.close();
 await frame.getByRole('button',{name:'背景',exact:true}).first().click();await ui().getByRole('button',{name:'移除背景图',exact:true}).click();await ui().getByRole('status').filter({hasText:'已保存'}).waitFor();metadata=await (await context.request.get(base+'/api/1/background/')).json();assert.equal(metadata.hasImage,false);assert.equal((await context.request.get(base+'/api/1/background/image/')).status(),404);
 assert.deepEqual(errors,[]);console.log('Background browser passed: native settings, real image upload, image visible through terminal pixels, live update, fit/mask save, restart persistence, account isolation, removal and no plugin UI/API.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
