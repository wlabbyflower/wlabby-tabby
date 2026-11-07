/* Actual shipped xterm: black/truecolor text, OSC colors, IME style and burst load. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28088',container=process.env.TEST_CONTAINER||'tabby-068-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated fixture');
const code='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="render-browser-test");cfg=Config.objects.create(user=u,name="Render fixture",content="{\\"recoverTabs\\":false}");u.active_config=cfg;u.save();c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],input=[];let send;
 page.on('pageerror',e=>errors.push(e.message));await page.context().addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
 let plugin=fs.readFileSync(path.join(__dirname,'../content/tabby-lightos/dist/index.js'),'utf8').replace('attach(tab){','attach(tab){window.__renderTab=tab;');
 await page.route('**/tabby-lightos/dist/index.js',r=>r.fulfill({contentType:'application/javascript',body:plugin}));
 await page.route('**/lightos/api/**',r=>r.fulfill({json:r.request().url().includes('local-terminal')?{mode:'host-terminal'}:[]}));
 await page.routeWebSocket('**/sessions/',ws=>{let seq=0;ws.onMessage(m=>{if(typeof m==='string'){const data=JSON.parse(m);if(data.action==='list')ws.send(JSON.stringify({type:'sessions',items:[]}));else if(data.action==='end')ws.send(JSON.stringify({type:'ended'}));else if(data.action==='create'){send=bytes=>ws.send(JSON.stringify({type:'output',seq:++seq,data:Buffer.from(bytes).toString('base64')}));ws.send(JSON.stringify({type:'attached',id:'render-fixture'}));ws.send(JSON.stringify({type:'replay-end'}));ws.send(JSON.stringify({type:'ready'}));}else if(data.type==='ping')ws.send('{"type":"pong"}');}else input.push(Buffer.from(m).toString());});});
 await page.goto(base);await page.frameLocator('iframe').first().locator('tabby-connection-hub h1').waitFor();const frame=page.frames().find(f=>f.url().endsWith('/terminal'));
 await frame.evaluate(()=>{const batch=window.TabbyTerminalRendering.batch;window.__batchCount=0;window.TabbyTerminalRendering.batch=(emit,...args)=>batch(data=>{window.__batchCount++;emit(data);},...args);});
 await frame.getByRole('button',{name:'LZC OS 本机终端',exact:true}).click();await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();
 await frame.waitForFunction(()=>window.__renderTab&&window.__renderTab.frontend&&window.__renderTab.frontend.xterm.element);
 const colors=await frame.evaluate(()=>{const t=window.__renderTab;t.config.store.terminal.background='colorScheme';t.config.store.terminal.colorScheme.background='#151a22';t.config.store.terminal.colorScheme.foreground='#000000';t.config.store.terminal.minimumContrastRatio=1;t.frontend.configure();return {theme:t.frontend.xterm.options.theme,minimum:t.frontend.xterm.options.minimumContrastRatio};});
 assert.equal(colors.theme.background,'#151a22');assert.equal(colors.theme.foreground,'#ffffff');assert.equal(colors.minimum,4.5);
 send('\x1b[2J\x1b[H\x1b[30mBLACK_VISIBLE\x1b[0m\r\n\x1b[38;2;0;0;0mTRUE_BLACK_VISIBLE\x1b[0m\r\n\x1b]10;?\x07\x1b]11;?\x07');
 await page.waitForTimeout(250);await frame.evaluate(()=>new Promise(r=>window.__renderTab.frontend.xterm.write('',r)));
 assert.ok(input.join('').includes('11;rgb:1515/1a1a/2222'),'OSC 11 must report the visible background');assert.ok(input.join('').includes('10;rgb:ffff/ffff/ffff'),'OSC 10 must report the readable foreground');
 const geometry=await frame.evaluate(()=>{const t=window.__renderTab.frontend.xterm;return {cols:t.cols,rows:t.rows};});
 const screenshot=await frame.locator('.xterm-screen').screenshot();
 const pixels=JSON.parse(execFileSync('python3',['-c',`from PIL import Image
import sys,json,io
image=Image.open(sys.stdin.buffer).convert('RGB')
cols,rows=${geometry.cols},${geometry.rows}
w,h=image.size
print(json.dumps([sum(1 for r,g,b in image.crop((0,int(row*h/rows),int(13*w/cols),int((row+1)*h/rows))).getdata() if r+g+b>300) for row in (0,1)]))`],{input:screenshot,encoding:'utf8'}));
 assert.ok(pixels[0]>20&&pixels[1]>20,'black ANSI and truecolor text must render visibly: '+pixels);
 const before=await frame.evaluate(()=>{window.__zoneStable=0;window.__renderTab.zone.onStable.subscribe(()=>window.__zoneStable++);return window.__batchCount;});
 for(let i=0;i<1000;i++)send('PERF_'+i+'\r\n');await page.waitForTimeout(800);
 const performance=await frame.evaluate(()=>{const t=window.__renderTab.frontend.xterm,b=t.buffer.active;return {batches:window.__batchCount,stable:window.__zoneStable,last:Array.from({length:Math.min(b.length,100)},(_,i)=>b.getLine(b.length-1-i).translateToString()).join('\n')};});
 assert.ok(performance.batches-before<100,'1000 output packets should be coalesced');assert.ok(performance.stable<30,'output should not trigger Angular per packet');assert.match(performance.last,/PERF_999/);
 assert.deepEqual(errors,[]);console.log('Renderer passed: actual black/truecolor pixels, readable palette, matching OSC 10/11, Unicode batching and 1000-packet burst.',JSON.stringify({batches:performance.batches-before,angularStable:performance.stable}));
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
