/* Real shipped xterm renderer under sustained output; all transports are local fixtures. */
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28086',container=process.env.TEST_CONTAINER||'tabby-063-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated local UI test container');
const code='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="scroll-regression");cfg=Config.objects.create(user=u,name="Scroll fixture",content="{}");u.active_config=cfg;u.save();c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
(async()=>{const browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--hide-scrollbars']});let outputTimer;try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],input=[];let socket;
 page.on('pageerror',e=>errors.push(e.message));
 const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
 await page.context().addCookies([{name:'sessionid',value:session,url:base}]);
 let plugin=fs.readFileSync(process.env.TEST_PLUGIN||require('node:path').join(__dirname,'../content/tabby-lightos/dist/index.js'),'utf8');
 // Test-only access to the actual frontend instance, never part of shipped code.
 plugin=plugin.replace('attach(tab){','attach(tab){window.__scrollFixtureTab=tab;');
 await page.route('**/tabby-lightos/dist/index.js',r=>r.fulfill({contentType:'application/javascript',body:plugin}));
 await page.route('**/lightos/api/**',r=>r.fulfill({json:r.request().url().includes('local-terminal-ticket')?{ticket:'synthetic-ticket'}:r.request().url().includes('local-terminal')?{mode:'host-terminal'}:[]}));
 await page.routeWebSocket('**/lzc-terminal/**',ws=>{socket=ws;ws.onMessage(m=>{if(typeof m==='string'){if(JSON.parse(m).type==='ping')ws.send('{"type":"pong"}');}else input.push(Buffer.from(m).toString());});});
 await page.goto(base);const frameLocator=page.frameLocator('iframe').first();await frameLocator.getByRole('button',{name:'LZC OS 本机终端',exact:true}).click();
 await frameLocator.locator('.xterm-screen').waitFor();const frame=page.frames().find(f=>f.url().endsWith('/terminal'));
 await frame.waitForFunction(()=>window.__scrollFixtureTab&&window.__scrollFixtureTab.frontend&&window.__scrollFixtureTab.frontend.xterm.element);
 const state=()=>frame.evaluate(()=>{const t=window.__scrollFixtureTab.frontend.xterm,b=t.buffer.active;return {top:b.viewportY,bottom:b.baseY,type:b.type,text:b.getLine(b.viewportY)?.translateToString().trimEnd(),mouse:t.modes.mouseTrackingMode};});
 const parsed=async()=>{await frame.evaluate(()=>new Promise(r=>window.__scrollFixtureTab.frontend.xterm.write('',r)));};
 socket.send(Buffer.from(Array.from({length:1000},(_,i)=>'scroll-fixture-line-'+i+'\r\n').join('')));await page.waitForTimeout(500);await parsed();
 const pane=frameLocator.locator('lightos-terminal-tab .xterm-screen');await pane.hover();await page.mouse.wheel(0,-500);await page.waitForTimeout(150);
 const before=await state();assert.ok(before.top>0&&before.top<before.bottom,'wheel up must reach a middle position');
 let count=1000;outputTimer=setInterval(()=>socket.send(Buffer.from('scroll-fixture-line-'+count+++'\r\n')),5);
 await page.waitForTimeout(750);await parsed();const during=await state();
 console.log('SCROLL_OUTPUT',JSON.stringify({before,during}));assert.equal(during.text,before.text,'incoming output must preserve the visible history line');
 // A later wheel gesture must remain authoritative while output is still queued.
 await page.mouse.wheel(0,180);await page.waitForTimeout(150);const down=await state();assert.ok(down.top>before.top,'wheel down must move forward');assert.ok(down.top<down.bottom,'small wheel movement must not jump to latest output');
 await page.setViewportSize({width:1220,height:820});await page.waitForTimeout(300);await parsed();const resized=await state();assert.equal(resized.text,down.text,'resize must preserve history anchor');
 clearInterval(outputTimer);outputTimer=null;await parsed();
 // Drag the native scrollbar while the remote process is still writing.
 const viewport=frameLocator.locator('lightos-terminal-tab .xterm-viewport');
 const geometry=await viewport.evaluate(v=>{const r=v.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,total:v.scrollHeight,top:v.scrollTop};});
 const outerBox=await viewport.boundingBox();geometry.x=outerBox.x;geometry.y=outerBox.y;
 const thumb=Math.max(20,geometry.height*geometry.height/geometry.total),thumbY=geometry.y+geometry.top/(geometry.total-geometry.height)*(geometry.height-thumb)+thumb/2;
 await page.mouse.move(geometry.x+geometry.width-6,thumbY);await page.mouse.down();outputTimer=setInterval(()=>socket.send(Buffer.from('scroll-fixture-line-'+count+++'\r\n')),5);await page.mouse.move(geometry.x+geometry.width-6,thumbY-65,{steps:10});await page.mouse.up();await page.waitForTimeout(100);await parsed();
 const dragged=await state();assert.ok(dragged.top<resized.top,'native scrollbar drag must move upward during output');await page.waitForTimeout(150);await parsed();assert.equal((await state()).text,dragged.text,'native scrollbar position must survive later output');
 clearInterval(outputTimer);outputTimer=null;
 await frame.evaluate(()=>window.__scrollFixtureTab.frontend.scrollToBottom());await parsed();let bottom=await state();assert.equal(bottom.top,bottom.bottom,'explicit follow returns to bottom');
 socket.send(Buffer.from('new-followed-line\r\n'));await page.waitForTimeout(100);await parsed();bottom=await state();assert.equal(bottom.top,bottom.bottom,'new output follows at bottom');
 // A terminal status reply must not act like typing and drag the view to bottom.
 await page.mouse.wheel(0,-250);await page.waitForTimeout(100);const replyBefore=await state();socket.send(Buffer.from('\x1b[6n'));await page.waitForTimeout(100);await parsed();assert.equal((await state()).text,replyBefore.text,'cursor-position reply must not reset scrollback');
 // Once the history cap is reached, anchor follows the same line through trims.
 await frame.evaluate(()=>window.__scrollFixtureTab.frontend.xterm.options.scrollback=1200);
 const trimBefore=await state();socket.send(Buffer.from(Array.from({length:150},(_,i)=>'trim-fixture-'+i+'\r\n').join('')));await page.waitForTimeout(200);await parsed();assert.equal((await state()).text,trimBefore.text,'history trimming must preserve surviving anchored line');
 // Real mouse reporting in alternate screen must reach the remote TUI once.
 socket.send(Buffer.from('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[HTUI fixture'));await page.waitForTimeout(100);await parsed();assert.equal((await state()).type,'alternate');
 input.length=0;await pane.hover();await page.mouse.wheel(0,100);await page.waitForTimeout(150);assert.ok(input.some(s=>/\x1b\[<65;\d+;\d+M/.test(s)),'TUI wheel-down must produce SGR mouse report');assert.ok(!input.some(s=>/\x1b\[<64;/.test(s)),'wheel-down must not report wheel-up');
 socket.send(Buffer.from('\x1b[?1000l\x1b[?1006l\x1b[?1049l'));await page.waitForTimeout(100);await parsed();assert.equal((await state()).type,'normal');
 assert.deepEqual(errors,[]);console.log('Scroll browser regression passed: output anchor, bidirectional wheel, native scrollbar drag, resize, history trim, follow-bottom, passive replies and TUI mouse protocol.');
 }finally{if(outputTimer)clearInterval(outputTimer);await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
