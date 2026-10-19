/* Real host-file transport in a disposable container with a private PID namespace. */
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),WS=require(process.env.WS_MODULE||'ws');
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:28087',container=process.env.TEST_CONTAINER||'tabby-064-ui-test';
if(!/^tabby-[a-z0-9-]+-ui-test$/.test(container)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use an isolated local test app');
const code='from django.test import Client;from tabby.app.models import User,Config;u,_=User.objects.get_or_create(username="files-browser-test");cfg=Config.objects.create(user=u,name="Files test",content=\'{"recoverTabs":false}\');u.active_config=cfg;u.save();c=Client();c.force_login(u,backend="django.contrib.auth.backends.ModelBackend");print(c.cookies["sessionid"].value)';
const key='synthetic-host-files-test-key-only-064';
function ticket(purpose='files'){const body=Buffer.from(JSON.stringify({purpose,user:'test-admin',host:new URL(base).host,expires:Math.floor(Date.now()/1000)+45,nonce:crypto.randomBytes(24).toString('hex')})).toString('base64url');return body+'.'+crypto.createHmac('sha256',key).update(body).digest('hex');}
(async()=>{const browser=await chromium.launch({headless:true}),remotes=[];try{
 execFileSync('docker',['exec','tabby-064-host-files-test','rm','-rf','/tmp/tabby-files-fixture']);
 execFileSync('docker',['exec','tabby-064-host-files-test','mkdir','-p','/tmp/tabby-files-fixture']);
 const context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
 const session=execFileSync('docker',['exec',container,'sh','-c','exec /venv/*/bin/python /app/manage.py shell -c "$1"','sh',code],{encoding:'utf8'}).trim();
 await context.addCookies([{name:'sessionid',value:session,url:base},{name:'XSRF-TOKEN',value:'abcdefghijklmnopqrstuvwxyzABCDEF',url:base}]);
 await page.route('**/lightos/api/**',r=>{const p=new URL(r.request().url()).pathname;return r.fulfill({json:p.endsWith('/local-files-ticket')?{ticket:ticket()}:p.endsWith('/local-terminal-ticket')?{ticket:'synthetic-terminal'}:p.endsWith('/local-terminal')?{mode:'host-terminal'}:p.endsWith('/client-instances')?[{id:'pc-fixture',name:'PC fixture',status:'online',platform:'linux'}]:[]});});
 await page.routeWebSocket('**/lzc-terminal/**',route=>{
  const url=new URL(route.url());if(!url.searchParams.has('files')){route.send(Buffer.from('SYNTHETIC TERMINAL\r\n$ '));return;}
  const remote=new WS('ws://127.0.0.1:29004/'+url.search,{headers:{Origin:base}});remotes.push(remote);const queue=[];
  remote.on('open',()=>queue.splice(0).forEach(m=>remote.send(m)));remote.on('message',(m,binary)=>route.send(binary?m:m.toString()));remote.on('error',()=>route.close());remote.on('close',()=>route.close());
  route.onMessage(m=>remote.readyState===WS.OPEN?remote.send(m):queue.push(m));route.onClose(()=>remote.close());
 });
 const clientData={name:'client.bin',bytes:Buffer.alloc(0)};
 await page.routeWebSocket('**/lightos-terminal/**',route=>{
  if(!new URL(route.url()).searchParams.has('files')){route.send('{"type":"ready"}');route.send(Buffer.from('CLIENT TERMINAL\r\n$ '));return;}
  route.send(JSON.stringify({type:'files-ready',path:'/',capabilities:{write:false,upload:true,staging:true}}));let offset=0;
  route.onMessage(message=>{const m=JSON.parse(message);let result={};
   if(m.action==='list')result={path:m.path,parent:'/',entries:m.path==='/'?[]:[{name:clientData.name,path:'/tmp/client-upload/'+clientData.name,type:'file',size:clientData.bytes.length}]};
   if(m.action==='upload-start'){clientData.name=m.filename;clientData.bytes=Buffer.alloc(0);}
   if(m.action==='upload-chunk')clientData.bytes=Buffer.concat([clientData.bytes,Buffer.from(m.data,'base64')]);
   if(m.action==='upload-finish')result={path:'/tmp/client-upload/'+clientData.name};
   if(m.action==='download-start'){offset=0;result={name:clientData.name,size:clientData.bytes.length};}
   if(m.action==='download-chunk'){const part=clientData.bytes.subarray(offset,offset+65536);offset+=part.length;result={data:part.toString('base64'),eof:part.length===0};}
   route.send(JSON.stringify({...result,id:m.id}));
  });
 });
 await page.goto(base);const frame=page.frameLocator('iframe').first();await frame.getByRole('button',{name:'LZC OS 本机终端',exact:true}).click();await frame.locator('.tabby-connection-status[data-state=connected]').waitFor();await frame.getByRole('button',{name:'文件传输',exact:true}).click();
 const dialog=frame.locator('tabby-file-browser');await dialog.getByRole('textbox',{name:'远程目录'}).waitFor();await dialog.getByRole('button',{name:'刷新目录'}).waitFor({state:'visible'});await dialog.getByRole('button',{name:'刷新目录'}).isEnabled();
 const directory=dialog.getByRole('textbox',{name:'远程目录'});await directory.fill('/tmp/tabby-files-fixture');await dialog.getByRole('button',{name:'转到',exact:true}).click();await dialog.getByRole('button',{name:'刷新目录'}).waitFor();
 await page.waitForTimeout(150);
 const content=Buffer.alloc(150000);for(let i=0;i<content.length;i++)content[i]=i%251;
 await dialog.locator('input[type=file]').setInputFiles({name:"文件 ' ; example.bin",mimeType:'application/octet-stream',buffer:content});
 const row=dialog.locator('tbody tr').filter({hasText:"文件 ' ; example.bin"});await row.waitFor();
 const actual=execFileSync('docker',['exec','tabby-064-host-files-test','cat',"/tmp/tabby-files-fixture/文件 ' ; example.bin"]);assert.deepEqual(actual,content);
 const terminalFrame=page.frames().find(f=>f.url().endsWith('/terminal'));await terminalFrame.evaluate(()=>window.showSaveFilePicker=undefined);
 const downloadPromise=page.waitForEvent('download');await row.getByRole('button',{name:'下载',exact:true}).click();const download=await downloadPromise,stream=await download.createReadStream(),parts=[];for await(const part of stream)parts.push(part);assert.deepEqual(Buffer.concat(parts),content);
 page.once('dialog',d=>d.accept('renamed.bin'));await row.getByRole('button',{name:'重命名'}).click();const renamed=dialog.locator('tbody tr').filter({hasText:'renamed.bin'});await renamed.waitFor();
 page.once('dialog',d=>d.accept('new-directory'));await dialog.getByRole('button',{name:'新建目录'}).click();await dialog.getByRole('button',{name:'📁 new-directory'}).waitFor();
 page.once('dialog',d=>d.accept());await renamed.getByRole('button',{name:'删除',exact:true}).click();await renamed.waitFor({state:'hidden'});
 // Start a long upload, then close its independently owned file channel.
 await dialog.locator('input[type=file]').setInputFiles({name:'cancelled.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(5*1024*1024,17)});await dialog.getByRole('button',{name:'取消并关闭'}).click();await dialog.waitFor({state:'hidden'});await page.waitForTimeout(300);
 const list=execFileSync('docker',['exec','tabby-064-host-files-test','ls','-A','/tmp/tabby-files-fixture'],{encoding:'utf8'});assert.ok(!list.includes('.tabby-upload-'));assert.ok(!list.includes('cancelled.bin'));
 await frame.getByRole('button',{name:'连接首页',exact:true}).click();const hub=frame.locator('tabby-connection-hub');await hub.getByRole('button',{name:'LightOS 实例',exact:true}).click();await hub.locator('.row-item').filter({hasText:'PC fixture'}).getByRole('button',{name:'打开客户端终端'}).click();await frame.locator('lightos-terminal-tab').last().getByRole('button',{name:'文件传输',exact:true}).click();
 const clientDialog=frame.locator('tabby-file-browser');await clientDialog.getByText('客户端上传文件保存在客户端提供的临时目录',{exact:false}).waitFor();assert.equal(await clientDialog.getByRole('button',{name:'新建目录'}).count(),0);
 await clientDialog.locator('input[type=file]').setInputFiles({name:'client.bin',mimeType:'application/octet-stream',buffer:content});await clientDialog.getByRole('status').filter({hasText:'/tmp/client-upload/client.bin'}).waitFor();assert.deepEqual(clientData.bytes,content);
 const clientRow=clientDialog.locator('tbody tr').filter({hasText:'client.bin'});const clientDownload=page.waitForEvent('download');await clientRow.getByRole('button',{name:'下载',exact:true}).click();const saved=await clientDownload,read=await saved.createReadStream(),chunks=[];for await(const chunk of read)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),content);await clientDialog.getByRole('button',{name:'关闭',exact:true}).click();
 assert.deepEqual(errors,[]);console.log('File browser passed: non-SSH host browsing, binary upload/download, Unicode and shell characters, rename, mkdir, delete, cancellation, temporary-file cleanup and client staged upload/download.');
 }finally{await browser.close();for(const remote of remotes)remote.close();}})().catch(e=>{console.error(e);process.exitCode=1});
