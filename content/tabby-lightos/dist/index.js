/* Browser-side application heartbeat: detects stale transports after idle or sleep. */
(function (root) {
    function watch(ws, sendPing, fail, options) {
        const opts=options||{}, interval=opts.interval||15000, timeout=opts.timeout||45000;
        const clock=opts.now||Date.now, schedule=opts.setInterval||setInterval, unschedule=opts.clearInterval||clearInterval;
        const events=opts.events||root; let deadline=0, stopped=false;
        function stop() { if(stopped)return;stopped=true;unschedule(timer); if(events&&events.removeEventListener){events.removeEventListener('pageshow',wake);events.removeEventListener('focus',wake);events.removeEventListener('online',wake);} if(root.document)root.document.removeEventListener('visibilitychange',visible); }
        function tick() {
            if(stopped)return;
            if(ws.readyState!==1){stop();fail('终端连接已断开，请重新连接');return;}
            if(deadline&&clock()>=deadline){stop();fail('终端连接心跳超时，请重新连接');return;}
            if(!deadline){deadline=clock()+timeout;try{sendPing();}catch(_){stop();fail('终端连接已断开，请重新连接');}}
        }
        function wake(){if(stopped)return;deadline=0;tick();}
        function visible(){if(!root.document.hidden)wake();}
        const timer=schedule(tick,interval);
        if(events&&events.addEventListener){events.addEventListener('pageshow',wake);events.addEventListener('focus',wake);events.addEventListener('online',wake);}
        if(root.document)root.document.addEventListener('visibilitychange',visible);
        return {stop, tick, pong:()=>{deadline=0;}};
    }
    if(typeof module==='object'&&module.exports)module.exports={watch};
    root.TabbyConnectionHealth={watch};
})(typeof window==='undefined'?globalThis:window);

/* Self-hosted installs select their bundled gateway, without a gateway registry. */
(function(root){
    function gatewayURL(location){
        const url=new URL('/gateway/',location.href);
        if(url.protocol!=='https:'&&url.protocol!=='http:')throw Error('Unsupported application URL scheme');
        url.protocol=url.protocol==='https:'?'wss:':'ws:';
        return url.href;
    }
    function install(connector,location){
        if(!connector)return;
        connector.chooseConnectionGateway=async()=>({url:gatewayURL(location),auth_token:''});
    }
    const api={gatewayURL,install};
    if(typeof module==='object'&&module.exports)module.exports=api;
    root.TabbyGatewayDefaults=api;
})(typeof window==='undefined'?globalThis:window);

/* Clipboard and terminal actions use user gestures and preserve native paste rules. */
(function(root){
    async function readClipboard(navigator,fallback){
        try{if(navigator.clipboard&&navigator.clipboard.readText)return await navigator.clipboard.readText();}catch(_){}
        return fallback();
    }
    async function writeClipboard(navigator,document,text){
        try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return;}}catch(_){}
        const active=document.activeElement,area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;left:-10000px;top:0';document.body.appendChild(area);area.select();
        try{if(!document.execCommand('copy'))throw Error('Clipboard copy denied');}finally{area.remove();if(active&&active.focus)active.focus();}
    }
    async function pasteText(tab,text,original){
        if(text===null||text===undefined)return;
        const platform=tab.platform,view=Object.create(platform);view.readClipboard=()=>text;
        // Native Tabby reads synchronously before awaiting its multiline confirmation.
        tab.platform=view;let result;
        try{result=original.call(tab);}finally{tab.platform=platform;}
        await result;
        if(tab.frontend)tab.frontend.focus();
    }
    const api={readClipboard,writeClipboard,pasteText};
    if(typeof module==='object'&&module.exports)module.exports=api;
    root.TabbyTerminalActions=api;
})(typeof window==='undefined'?globalThis:window);

(function(root){
    const key='tabby.ui.sidebarHidden';
    function apply(document,storage){
        let hidden=false;try{hidden=storage.getItem(key)==='true';}catch(_){}
        const node=document.querySelector('.sidebar');
        if(node){node.style.display=hidden?'none':'';if(hidden)node.setAttribute('aria-hidden','true');else node.removeAttribute('aria-hidden');}
        return hidden;
    }
    function updateHandle(document){
        const node=document.querySelector('.sidebar'),button=document.querySelector('.tabby-sidebar-handle');if(!node||!button)return;
        const hidden=node.style.display==='none';
        button.textContent=hidden?'›':'‹';button.title=hidden?'展开左侧栏':'收起左侧栏';button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(!hidden));
        button.style.left=(hidden?0:Math.max(0,node.getBoundingClientRect().right))+'px';
    }
    function toggle(document,storage){
        const node=document.querySelector('.sidebar');if(!node)return false;
        const hidden=node.style.display!=='none';node.style.display=hidden?'none':'';
        if(hidden)node.setAttribute('aria-hidden','true');else node.removeAttribute('aria-hidden');
        try{storage.setItem(key,String(hidden));}catch(_){}
        updateHandle(document);return hidden;
    }
    function installHandle(document,storage){
        if(document.querySelector('.tabby-sidebar-handle'))return;
        const node=document.querySelector('.sidebar');if(!node)return;
        const button=document.createElement('button');button.type='button';button.className='tabby-sidebar-handle';
        button.style.cssText='position:fixed;top:48%;z-index:1000;width:20px;height:52px;border:1px solid #46536a;border-left:0;border-radius:0 7px 7px 0;background:#273346;color:#e5edfa;font:24px system-ui;cursor:pointer;padding:0;';
        button.addEventListener('click',()=>toggle(document,storage));document.body.appendChild(button);updateHandle(document);
        const view=document.defaultView;if(view){view.addEventListener('resize',()=>updateHandle(document));const observer=new view.MutationObserver(()=>updateHandle(document));observer.observe(node,{attributes:true,attributeFilter:['style']});}
    }
    const api={apply,toggle,installHandle,updateHandle};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbySidebar=api;
})(typeof window==='undefined'?globalThis:window);

/* Native keytar shim backed by authenticated, encrypted, per-user persistent storage. */
(function(root){
    async function saveConnectionPassword(keytar,vault,profile,password){
        if(password==='')return;
        const options=profile.options;
        if(vault&&vault.isEnabled()){
            await vault.addSecret({type:'ssh:password',key:{user:options.user,host:options.host,port:options.port},value:password});
        }else{
            await keytar.setPassword('ssh@'+options.host+(options.port?':'+options.port:''),options.user,password);
        }
    }
    function install(keytar,connector,fetch,document){
        async function request(action,service,account,password){
            if(!connector.loginService||!connector.loginService.user){if(action==='read')return null;throw Error('请先完成微服账号 OIDC 登录再保存密码');}
            const cookie=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('XSRF-TOKEN='));
            const headers={'Content-Type':'application/json'};if(cookie)headers['X-XSRF-TOKEN']=decodeURIComponent(cookie.substring('XSRF-TOKEN='.length));
            const response=await fetch('/api/1/credentials/'+action+'/',{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:JSON.stringify({service,account,password})});
            if(!response.ok)throw Error(response.status===403?'登录已失效，请重新登录后保存密码':'凭据存储失败');
            const data=await response.json();return action==='read'?data.password:true;
        }
        keytar.getPassword=(s,a)=>request('read',s,a);
        keytar.setPassword=(s,a,p)=>request('write',s,a,p);
        keytar.deletePassword=(s,a)=>request('delete',s,a);
    }
    const api={install,saveConnectionPassword};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyCredentialStorage=api;
})(typeof window==='undefined'?globalThis:window);

/* Status messages contain connection diagnostics only, never terminal output history. */
(function(root){
    function explain(text){
        const value=String(text||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        if(/KEY_EXCHANGE_FAILED|no matching.*algorithm|key exchange failed/i.test(value))return 'SSH 算法协商失败，请检查目标设备的 SSH 版本和算法配置';
        if(/host key.*(?:changed|mismatch|verification failed)|主机密钥.*(?:变化|不匹配)/i.test(value))return '设备主机密钥发生变化，请核实设备身份后再连接';
        if(/心跳超时/i.test(value))return '连接心跳超时，请重新连接';
        if(/authentication failed|all configured authentication|permission denied|incorrect password|认证失败/i.test(value))return '设备认证失败，请检查用户名、密码或密钥';
        if(/connection refused|ECONNREFUSED/i.test(value))return '设备拒绝连接，请检查端口和 SSHD 是否已开启';
        if(/ENOTFOUND|getaddrinfo|name or service not known/i.test(value))return '无法解析设备地址，请检查主机名';
        if(/ETIMEDOUT|timed out|超时/i.test(value))return '连接超时，请检查设备网络和端口';
        if(/gateway|网关/i.test(value))return '连接网关不可用，请检查微服登录状态和应用服务';
        if(/OIDC|登录|403|401/i.test(value))return '登录状态已失效，请重新进行 OIDC 登录';
        if(/实例未运行/i.test(value))return '实例未运行，请先在 LightOS 管理中启动';
        return '连接已中断，可点击重新连接；详细原因见终端提示';
    }
    function exportProfiles(profiles){
        return {format:'tabby-connections',version:1,profiles:profiles.filter(p=>p.type==='ssh'&&!p.isBuiltin&&!p.isTemplate).map(p=>({name:String(p.name||''),group:String(p.group||''),options:{host:String(p.options.host||''),port:Number(p.options.port||22),user:String(p.options.user||''),auth:'password'}}))};
    }
    function importProfiles(value,existing,makeID){
        if(!value||value.format!=='tabby-connections'||value.version!==1||!Array.isArray(value.profiles)||value.profiles.length>500)throw Error('请选择 Tabby 导出的连接文件（最多 500 条）');
        const seen=new Set(existing.filter(p=>p.type==='ssh').map(p=>JSON.stringify([p.options.host,p.options.port||22,p.options.user]))),result=[];
        for(const p of value.profiles){
            const o=p&&p.options;
            if(!o||typeof o.host!=='string'||!o.host||o.host.length>253||/[\s/\\\u0000-\u001f]/.test(o.host)||!Number.isInteger(o.port)||o.port<1||o.port>65535||typeof o.user!=='string'||!o.user||o.user.length>256||/[\u0000-\u001f]/.test(o.user)||typeof p.name!=='string'||p.name.length>256||typeof p.group!=='string'||p.group.length>256)throw Error('连接文件中包含无效的主机、端口、用户名或名称');
            const key=JSON.stringify([o.host,o.port,o.user]);if(seen.has(key))continue;seen.add(key);
            result.push({id:makeID(),type:'ssh',name:p.name||o.user+'@'+o.host,group:p.group,options:{host:o.host,port:o.port,user:o.user,auth:'password'}});
        }
        return result;
    }
    const api={explain,exportProfiles,importProfiles};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyConnectionUI=api;
})(typeof window==='undefined'?globalThis:window);

/* Keep scrollback anchored while output arrives; leave TUI mouse handling to xterm. */
(function(root){
    function passiveInput(data){
        const text=typeof data==='string'?data:data&&data.toString();
        return typeof text==='string'&&/^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+;\d+M|\x1b\[[IO]|\x1b\[[?>]?[\d;]*[Rcn]|\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\))$/.test(text);
    }
    function install(tab){
        const frontend=tab.frontend,xterm=frontend&&frontend.xterm,host=tab.content&&tab.content.nativeElement;
        if(!xterm||!host||!xterm.onWriteParsed||!xterm.registerMarker)return ()=>{};
        const viewport=host.querySelector('.xterm-viewport'),win=host.ownerDocument.defaultView;
        let pinned=true,anchor=null,restoring=false,dragging=false,passive=false,disposed=false,wheelRemainder=0;
        const restorers=[],listeners=[],disposables=[];
        const normal=()=>xterm.buffer.active.type==='normal';
        const discard=()=>{if(anchor)anchor.dispose();anchor=null;};
        function capture(){
            if(disposed||!normal()||restoring)return;
            const b=xterm.buffer.active;
            pinned=b.viewportY>=b.baseY;
            discard();
            if(!pinned)anchor=xterm.registerMarker(b.viewportY-b.baseY-b.cursorY);
        }
        function restore(){
            if(disposed||!normal()||dragging||restoring)return;
            restoring=true;
            try{
                if(pinned)bottom.call(frontend);
                else xterm.scrollToLine(Math.max(0,Math.min(anchor&&!anchor.isDisposed?anchor.line:0,xterm.buffer.active.baseY)));
            }finally{restoring=false;}
        }
        function listen(target,type,fn,options){if(!target)return;target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));}
        function wrap(object,name,fn){const original=object[name];if(typeof original!=='function')return;const value=fn(original);object[name]=value;restorers.push(()=>{if(object[name]===value)object[name]=original;});}
        const bottom=frontend.scrollToBottom;
        wrap(frontend,'scrollToBottom',original=>function(...args){if(passive)return;const result=original.apply(this,args);capture();return result;});
        for(const name of ['scrollToTop','scrollPages','scrollLines'])wrap(frontend,name,original=>function(...args){const result=original.apply(this,args);capture();return result;});
        wrap(tab,'sendInput',original=>function(data,...args){const previous=passive;passive=passiveInput(data);try{return original.call(this,data,...args);}finally{passive=previous;}});
        // Handle normal scrollback once, before legacy mousewheel and parent scroll handlers.
        // Mouse-reporting applications and alternate-screen TUIs retain xterm's own protocol.
        listen(host,'wheel',event=>{
            if(!normal()||xterm.modes.mouseTrackingMode!=='none'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!event.deltaY)return;
            event.preventDefault();event.stopImmediatePropagation();
            const height=(viewport&&viewport.clientHeight||host.clientHeight)/Math.max(1,xterm.rows)||16;
            wheelRemainder+=event.deltaMode===1?event.deltaY:event.deltaMode===2?event.deltaY*xterm.rows:event.deltaY/height;
            const lines=Math.trunc(wheelRemainder);wheelRemainder-=lines;
            if(lines){xterm.scrollLines(lines);capture();}
        },{capture:true,passive:false});
        // Scrollbar dragging must not compete with incoming output or auto-follow.
        listen(host,'pointerdown',event=>{
            if(!normal()||event.button!==0||!viewport||event.target!==viewport)return;
            const box=viewport.getBoundingClientRect();
            if(event.clientX<box.right-18)return;
            dragging=true;pinned=false;
        },true);
        const finish=()=>{if(!dragging)return;dragging=false;capture();};
        listen(win,'pointerup',finish,true);listen(win,'pointercancel',finish,true);listen(win,'blur',finish);
        listen(viewport,'scroll',()=>{if(dragging&&!restoring)capture();});
        disposables.push(xterm.onWriteParsed(restore));
        if(typeof frontend.resizeHandler==='function'){
            const original=frontend.resizeHandler;
            win.removeEventListener('resize',original);
            wrap(frontend,'resizeHandler',fn=>function(...args){const result=fn.apply(this,args);restore();return result;});
            win.addEventListener('resize',frontend.resizeHandler);
            restorers.push(()=>{win.removeEventListener('resize',frontend.resizeHandler);win.addEventListener('resize',original);});
        }
        capture();
        return ()=>{disposed=true;discard();disposables.forEach(d=>d.dispose());listeners.reverse().forEach(f=>f());restorers.reverse().forEach(f=>f());};
    }
    const api={install,passiveInput};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyTerminalScroll=api;
})(typeof window==='undefined'?globalThis:window);

/* LightOS WebShell provider entry: resolve only targets in the fresh visible list. */
(function(root){
    function target(url){
        const q=url.searchParams;
        const value=q.get('target')||q.get('name')||q.get('lightos')||'';
        if(!value)return null;
        if(value.length>512||/[\u0000-\u0020\u007f]/.test(value))throw Error('LightOS 终端目标无效');
        if(value.startsWith('client:')){if(value.length===7)throw Error('客户端实例标识无效');return {kind:'client',id:value.slice(7)};}
        const parts=value.split('@'),owner=parts.length===2?parts[1]:(q.get('owner')||'');
        if(parts.length>2||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(parts[0])||owner&&!/^[a-zA-Z0-9_.-]+$/.test(owner))throw Error('LightOS 实例标识无效');
        return {kind:'instance',name:parts[0],owner};
    }
    async function resolve(value,loadInstances,loadClients){
        if(value.kind==='client'){
            const item=(await loadClients()).find(i=>i.id===value.id);
            if(!item)throw Error('客户端实例不可访问，请返回连接首页刷新列表');
            if(!['running','online','connected'].includes(item.status))throw Error('客户端不在线，请先连接该设备');
            return {kind:'client',item};
        }
        const matches=(await loadInstances()).filter(i=>i.name===value.name&&(!value.owner||i.owner_deploy_id===value.owner));
        if(matches.length!==1)throw Error('LightOS 实例不可访问或标识不唯一，请返回连接首页选择');
        if(matches[0].status!=='running')throw Error('实例未运行，请先在 LightOS 中启动');
        return {kind:'instance',item:matches[0]};
    }
    const api={target,resolve};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyWebShellEntry=api;
})(typeof window==='undefined'?globalThis:window);

/* Tabby plugin: real terminal tabs sharing Tabby's renderer, shortcuts and tab bar. */
(function () {
    const ng = require('@angular/core');
    const common = require('@angular/common');
    const core = require('tabby-core');
    const terminal = require('tabby-terminal');
    const Buffer = require('buffer').Buffer;
    const bootstrap = require('@ng-bootstrap/ng-bootstrap');
    // The shipped PromptModal has uninitialised @Input fields; default when the
    // SSH session enables its Remember checkbox, after the modal is constructed.
    const rememberState=Symbol('tabbyRememberCheckbox');
    Object.defineProperty(core.PromptModalComponent.prototype,'showRememberCheckbox',{
        configurable:true,get(){return !!this[rememberState];},
        set(value){this[rememberState]=value;if(value&&this.remember===undefined)this.remember=true;}
    });
    // Loaded from this plugin package by the startup script before bootstrap.
    const health = window.TabbyConnectionHealth;
    function protectSSHConnector() {
        const connector=window.__connector__;
        if(!connector||connector.__healthOwner===window||!health)return;
        connector.__healthOwner=window;
        const create=connector.__rawCreateSocket||connector.createSocket.bind(connector);
        connector.__rawCreateSocket=create;
        connector.createSocket=function(){
            const socket=create();let closed=false,watcher=null;
            const close=socket.close.bind(socket),handle=socket.handleServiceMessage.bind(socket);
            socket.close=function(error){if(closed)return;closed=true;if(watcher)watcher.stop();return close(error);};
            socket.handleServiceMessage=function(message){
                if(message._==='pong'){if(watcher)watcher.pong();return;}
                return handle(message);
            };
            socket.connect$.subscribe(()=>{
                watcher=health.watch(socket.webSocket,()=>socket.sendServiceMessage({_:'ping'}),reason=>socket.close(new Error(reason)));
            });
            socket.close$.subscribe(()=>{closed=true;if(watcher)watcher.stop();});
            socket.write=function(data){
                const ws=socket.webSocket;
                if(!closed&&(!ws||ws.readyState===0)){socket.initialBuffers.push(data);return;}
                if(!ws||ws.readyState!==1){socket.close(new Error('终端连接已断开，请重新连接'));return;}
                try{ws.send(data);}catch(_){socket.close(new Error('终端连接已断开，请重新连接'));}
            };
            return socket;
        };
    }
    window.TabbyGatewayDefaults.install(window.__connector__, window.parent.location);
    protectSSHConnector();
    window.TabbyCredentialStorage.install(require('keytar'),window.__connector__,window.fetch.bind(window),window.parent.document);
    async function instances() { return requestJSON('/lightos/api/instances'); }
    async function localOSProfile() {
        if(!window.__connector__.loginService || !window.__connector__.loginService.user)throw Error('请先显示左侧栏，点击登录按钮，完成微服账号 OIDC 登录后再连接 LZC OS。');
        await requestJSON('/lightos/api/local-terminal');
        return {id:'lightos:lzcos-current',type:'lightos',name:'LZC OS · 本机',icon:'fas fa-server',
            isBuiltin:true,disableDynamicTitle:true,behaviorOnSessionEnd:'keep',options:{kind:'host'}};
    }
    function profile(i) {
        return { id: 'lightos:' + i.name + '@' + i.owner_deploy_id, type: 'lightos',
            name: 'LightOS · ' + i.name, group: 'LightOS', icon: 'fas fa-terminal',
            options: { name: i.name, owner: i.owner_deploy_id }, isBuiltin: true,
            behaviorOnSessionEnd: 'keep', disableDynamicTitle: true };
    }
    class LightOSSession extends terminal.BaseSession {
        constructor(injector, p) {
            super(injector.get(core.LogService).create(p.options.kind==='host'?'lzcos-local':'lightos-' + p.options.name));
            this.profile = p; this.label=p.options.kind==='host'?'LZC OS':p.options.kind==='client'?'客户端':'LightOS'; this.open = false; this.columns = 80; this.rows = 24;
        }
        async start() {
            let ticket=null;
            if(this.profile.options.kind==='host')ticket=(await requestJSON('/lightos/api/local-terminal-ticket',{})).ticket;
            return new Promise((resolve, reject) => {
                const u = new URL(ticket?'/lzc-terminal/':'/lightos-terminal/', location.href);
                u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                if(ticket)u.searchParams.set('ticket',ticket);
                else if(this.profile.options.kind==='client')u.searchParams.set('client',this.profile.options.id);
                else {u.searchParams.set('name', this.profile.options.name);u.searchParams.set('owner', this.profile.options.owner || '');}
                this.ws = new WebSocket(u.href); this.ws.binaryType = 'arraybuffer';
                const ready=()=>{if(this.open)return;this.open=true;this.resize(this.columns,this.rows);if(health)this.health=health.watch(this.ws,()=>this.ws.send(JSON.stringify({type:'ping'})),reason=>{this.emitOutput(Buffer.from('\r\n'+reason+'\r\n'));this.kill();});resolve();};
                this.ws.onopen=()=>{if(this.profile.options.kind!=='client')ready();};
                this.ws.onmessage = e => {
                    if (typeof e.data === 'string') {
                        const message = JSON.parse(e.data);
                        if(message.type==='ready'){ready();return;}
                        if(message.type==='pong'){if(this.health)this.health.pong();return;}
                        if(message.error){if(!this.open){reject(Error(message.error));this.kill();}else{this.emitOutput(Buffer.from('\r\n'+this.label+': '+message.error+'\r\n'));this.kill();}}
                    } else this.emitOutput(Buffer.from(e.data));
                };
                this.ws.onerror = () => { reject(Error(this.label+' 终端连接失败，请确认管理员登录状态')); };
                this.ws.onclose = () => {if(this.health)this.health.stop();if(this.open){this.emitOutput(Buffer.from('\r\n['+this.label+' 终端已断开；请右键重新连接]\r\n'));this.destroy();}else reject(Error(this.label+' 终端已断开'));};
            });
        }
        resize(columns, rows) {
            this.columns = columns; this.rows = rows;
            if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({type:'resize', columns, rows}));
        }
        write(data) { if (this.ws && this.ws.readyState === 1) this.ws.send(data); }
        kill() { if(this.health)this.health.stop();if (this.ws) this.ws.close(); }
        async gracefullyKillProcess() { this.kill(); }
        async destroy() { this.kill();await super.destroy(); }
        supportsWorkingDirectory() { return false; }
        async getWorkingDirectory() { return null; }
    }
    class LightOSTab extends terminal.BaseTerminalTabComponent {
        constructor(injector) { super(injector); this.lightosInjector = injector; }
        ngOnInit() {
            super.ngOnInit();
            this.startLightOS();
        }
        async startLightOS() {
            const attempt=this.lightosAttempt=(this.lightosAttempt||0)+1;this.connectionError=null;
            const session = new LightOSSession(this.lightosInjector, this.profile);
            this.setSession(session);
            try { await session.start();if(this.frontendIsReady)session.releaseInitialDataBuffer(); }
            catch(e) { if(attempt===this.lightosAttempt){this.connectionError=e.message;this.write('\r\n'+e.message+'\r\n');} }
        }
        async disconnect() { this.lightosAttempt=(this.lightosAttempt||0)+1;if(this.session)await this.session.destroy(); }
        async reconnect() { await this.disconnect();await this.startLightOS();if(this.frontend)this.frontend.focus(); }
        async canClose() { return true; }
        getRecoveryToken() { return Promise.resolve({type: 'lightos', profile: this.profile}); }
    }
    LightOSTab.ctorParameters = () => [{type: ng.Injector}];
    ng.Input()(LightOSTab.prototype, 'profile');
    ng.Component({selector:'lightos-terminal-tab', template:terminal.BaseTerminalTabComponent.template,
        styles:terminal.BaseTerminalTabComponent.styles, animations:terminal.BaseTerminalTabComponent.animations})(LightOSTab);
    class LightOSManagerTab extends core.BaseTabComponent {
        async canClose() { return true; }
    }
    ng.Component({selector:'lightos-manager-tab',
        template:'<iframe src="/lightos/" title="LightOS 实例管理" style="border:0;width:100%;height:100%"></iframe>',
        styles:[':host { display:flex; flex:1; min-height:0; width:100%; height:100%; }']})(LightOSManagerTab);
    function clientProfile(item){return {id:'lightos:client:'+item.id,type:'lightos',name:'客户端 · '+item.name,group:'LightOS 客户端',icon:'fas fa-desktop',isBuiltin:true,disableDynamicTitle:true,options:{kind:'client',id:item.id}};}
    class LightOSProfiles extends core.ProfileProvider {
        constructor() { super(); this.id = 'lightos'; this.name = 'LightOS'; this.configDefaults = {options:{name:'',owner:'',kind:'instance',id:''}}; }
        async getBuiltinProfiles() {
            const result=[];
            try { result.push(await localOSProfile()); } catch (_) {}
            try { result.push(...(await instances()).map(profile)); } catch (_) {}
            try { result.push(...(await requestJSON('/lightos/api/client-instances')).map(clientProfile)); } catch (_) {}
            return result;
        }
        async getNewTabParameters(p) { return {type: LightOSTab, inputs: {profile:p}}; }
        getDescription(p) { return p.options.kind==='host'?'LZC OS 本机终端':p.options.kind==='client'?'LightOS 客户端':'LightOS / ' + p.options.name; }
    }
    class NewSSHConnection {
        constructor(profiles, config, modal, zone, vault) { this.profiles=profiles; this.config=config; this.modal=modal; this.zone=zone; this.vault=vault; this.error=''; this.busy=false; this.showPassword=false; }
        async connect(host, port, user, name, passwordInput) {
            if(this.busy)return;
            if(!window.__connector__.loginService.user){this.error='请先显示左侧栏并完成微服账号登录，再保存连接。';return;}
            host=host.trim(); user=user.trim(); port=Number(port);
            if (!host || !user || !Number.isInteger(port) || port<1 || port>65535) { this.error='请填写主机、用户名和有效端口'; return; }
            const p={id:'ssh:custom:'+Date.now()+':'+Array.from(crypto.getRandomValues(new Uint32Array(2))).join(''),type:'ssh',name:name.trim()||user+'@'+host,options:{host,port,user,auth:'password'}};
            this.busy=true;
            try {
                await window.TabbyCredentialStorage.saveConnectionPassword(require('keytar'),this.vault,p,passwordInput.value);
                this.config.store.profiles.push(p); await this.config.save();
                this.zone.run(()=>{passwordInput.value='';this.modal.close();this.profiles.openNewTabForProfile(p);});
            }
            catch(e) { this.config.store.profiles=this.config.store.profiles.filter(item=>item.id!==p.id);this.zone.run(()=>{this.error=e.message;this.busy=false;}); }
        }
    }
    NewSSHConnection.ctorParameters=()=>[{type:core.ProfilesService},{type:core.ConfigService},{type:bootstrap.NgbActiveModal},{type:ng.NgZone},{type:core.VaultService}];
    ng.Component({selector:'lightos-new-ssh',template:`<form (submit)="connect(host.value,port.value,user.value,name.value,password); $event.preventDefault()">
        <div class="modal-header"><h4 class="modal-title">新建 SSH 连接</h4><button type="button" class="close" (click)="modal.dismiss()">×</button></div>
        <div class="modal-body"><p>填写设备的 SSH 连接信息。</p>
        <label class="d-block">主机 / IP<input #host class="form-control" required placeholder="设备 IP 或主机名" autofocus></label>
        <label class="d-block">端口<input #port class="form-control" type="number" min="1" max="65535" value="22" required></label>
        <label class="d-block">用户名<input #user class="form-control" required placeholder="设备用户名"></label>
        <label class="d-block">密码<div class="input-group"><input #password class="form-control" [type]="showPassword?'text':'password'" autocomplete="new-password" maxlength="16384" placeholder="可选，留空则在连接时输入" [readOnly]="busy"><div class="input-group-append"><button class="btn btn-secondary" type="button" [attr.aria-label]="showPassword?'隐藏密码':'显示密码'" (click)="showPassword=!showPassword">{{showPassword?'隐藏':'显示'}}</button></div></div></label>
        <p class="text-muted">填写的密码会加密保存，下次连接自动使用。</p>
        <label class="d-block">连接名称<input #name class="form-control" placeholder="可选"></label>
        <div class="text-danger" role="alert">{{error}}</div></div>
        <div class="modal-footer"><button class="btn btn-secondary" type="button" (click)="modal.dismiss()">取消</button><button class="btn btn-primary" [disabled]="busy">保存并连接</button></div></form>`})(NewSSHConnection);
    async function requestJSON(path,body,method) {
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
        const headers={'Content-Type':'application/json'};
        const cookie=window.parent.document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('XSRF-TOKEN='));
        if(cookie)headers['X-XSRF-TOKEN']=decodeURIComponent(cookie.slice(11));
        try {
            const response=await fetch(path,{method:method||(body===undefined?'GET':'POST'),body:body===undefined?undefined:JSON.stringify(body),headers,credentials:'same-origin',cache:'no-store',signal:controller.signal});
            if(response.status===401||response.status===403)throw Error('请先进行 OIDC 登录；LightOS 和本机终端还需要管理员权限');
            const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败，请稍后重试');return data;
        }catch(e){if(e.name==='AbortError')throw Error('请求超时，请检查网络后重试');throw e;}finally{clearTimeout(timer);}
    }
    // Upstream saveConfig() returns after scheduling a debounced write. Await
    // the authenticated PATCH instead, so a refresh cannot discard a new profile.
    const configConnector=window.__connector__;
    let configWrite=Promise.resolve();
    configConnector.saveConfig=function(content){
        const selected=this.config;
        const operation=configWrite.catch(()=>{}).then(async()=>{
            if(!this.loginService.user)throw Error('请先进行 OIDC 登录再保存连接');
            if(!selected||!selected.id)throw Error('没有可保存的配置，请刷新连接首页');
            await requestJSON('/api/1/configs/'+encodeURIComponent(selected.id),{content},'PATCH');
            selected.content=content;
        });
        configWrite=operation;return operation;
    };
    class SavedPasswordDialog {
        constructor(modal,zone){this.modal=modal;this.zone=zone;this.item=null;this.error='';this.busy=false;}
        async save(password){
            if(!password){this.error='请输入新密码';return;}this.busy=true;
            try{await requestJSON('/api/1/credentials/write/',{...this.item,password});this.zone.run(()=>this.modal.close(true));}
            catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>this.busy=false);}
        }
    }
    SavedPasswordDialog.ctorParameters=()=>[{type:bootstrap.NgbActiveModal},{type:ng.NgZone}];
    ng.Component({selector:'tabby-saved-password',template:`<form (submit)="save(password.value);$event.preventDefault()">
        <div class="modal-header"><h4>替换保存的密码</h4><button type="button" class="close" (click)="modal.dismiss()" aria-label="关闭">×</button></div>
        <div class="modal-body"><p>{{item?.account}} · {{item?.service}}</p><label class="d-block">新密码<input #password class="form-control" type="password" autocomplete="new-password" required></label><p>保存后在下次连接时使用，不会中断当前终端。</p><p class="text-danger" role="alert">{{error}}</p></div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" (click)="modal.dismiss()">取消</button><button class="btn btn-primary" [disabled]="busy">保存密码</button></div></form>`})(SavedPasswordDialog);
    class ConnectionHub extends core.BaseTabComponent {
        constructor(profiles,config,app,modal,zone){
            super();this.profiles=profiles;this.config=config;this.app=app;this.modal=modal;this.zone=zone;
            this.saved=[];this.lightos=[];this.clients=[];this.clientNotice='';this.recent=[];this.credentials=[];this.local=null;this.loading=false;this.error='';this.entryError='';this.notice='';this.adminNotice='';this.query='';this.panel='connections';this.alive=true;
            this.subscribeUntilDestroyed(this.focused$,()=>this.refresh());
        }
        ngOnInit(){this.refresh();}
        get loggedIn(){return !!window.__connector__.loginService.user;}
        get username(){const user=window.__connector__.loginService.user;return user&&(user.username||user.name)||'当前账号';}
        login(){window.parent.location.assign('/login');}
        get filtered(){const q=this.query.trim().toLowerCase();return this.saved.filter(p=>[p.name,p.group,p.options.host,p.options.user].join(' ').toLowerCase().includes(q));}
        async refresh(){
            if(!this.alive)return;if(this.loading){this.refreshAgain=true;return;}this.loading=true;this.error='';this.adminNotice='';
            try{
                const [credentials,history,local,lightos,clients]=await Promise.allSettled([
                    requestJSON('/api/1/credentials/list/',{}),requestJSON('/api/1/connections/history/'),localOSProfile(),instances(),requestJSON('/lightos/api/client-instances')
                ]);
                this.zone.run(()=>{
                    if(!this.alive)return;
                    this.saved=(this.config.store.profiles||[]).filter(p=>p.type==='ssh'&&!p.isBuiltin&&!p.isTemplate);
                    this.local=local.status==='fulfilled'?local.value:null;
                    this.lightos=lightos.status==='fulfilled'?lightos.value:[];
                    this.clients=clients.status==='fulfilled'?clients.value:[];this.clientNotice=clients.status==='rejected'?clients.reason.message:'';
                    this.adminNotice=[local,lightos].filter(r=>r.status==='rejected').map(r=>r.reason.message).filter((v,i,a)=>a.indexOf(v)===i).join('；');
                    this.credentials=credentials.status==='fulfilled'?credentials.value.items:[];
                    if(credentials.status==='rejected')this.error=credentials.reason.message;
                    if(history.status==='rejected')this.error=this.error||history.reason.message;
                    const all=[...this.saved,...this.lightos.map(profile),...(this.local?[this.local]:[])];
                    this.recent=history.status==='fulfilled'?history.value.items.map(h=>{const p=all.find(p=>p.id===h.profile_id);return p?{profile:p,time:new Date(h.opened_at).toLocaleString()}:null;}).filter(Boolean):[];
                });
            }catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>{this.loading=false;if(this.refreshAgain&&this.alive){this.refreshAgain=false;this.refresh();}});}
        }
        async open(p){try{await this.profiles.openNewTabForProfile(p);}catch(e){this.zone.run(()=>this.error=e.message);}}
        openLightOS(i){this.open(profile(i));}
        openClient(item){this.open(clientProfile(item));}
        manageLightOS(){this.app.openNewTab({type:LightOSManagerTab,inputs:{title:'LightOS 管理'}});}
        newSSH(){const ref=this.modal.open(NewSSHConnection);ref.result.then(()=>this.refresh(),()=>{});}
        hasPassword(p){return this.credentials.some(c=>c.service==='ssh@'+p.options.host+':'+(p.options.port||22)&&c.account===p.options.user);}
        async replacePassword(item){const ref=this.modal.open(SavedPasswordDialog);ref.componentInstance.item=item;try{await ref.result;this.zone.run(()=>this.notice='密码已替换，下次连接时生效');await this.refresh();}catch(_){} }
        async deletePassword(item){
            if(!window.confirm('删除 '+item.account+' · '+item.service+' 保存的密码？下次连接需要重新输入。'))return;
            try{await requestJSON('/api/1/credentials/delete/',item);this.zone.run(()=>this.notice='已删除保存的密码，当前终端不受影响');await this.refresh();}catch(e){this.zone.run(()=>this.error=e.message);}
        }
        async clearHistory(){
            if(!window.confirm('清空当前账号的最近连接记录？已保存的连接和密码会保留。'))return;
            try{await requestJSON('/api/1/connections/history/',{action:'clear'});this.zone.run(()=>{this.recent=[];this.notice='最近连接记录已清空';});}catch(e){this.zone.run(()=>this.error=e.message);}
        }
        exportConnections(){
            const data=window.TabbyConnectionUI.exportProfiles(this.saved),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
            const a=document.createElement('a');a.href=url;a.download='tabby-connections.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);this.notice='已导出连接地址和用户名，文件不包含密码、密钥或命令';
        }
        async importConnections(event){
            const file=event.target.files[0];if(!file)return;this.error='';
            try{
                if(file.size>1024*1024)throw Error('连接文件不能大于 1 MB');
                const value=JSON.parse(await file.text());
                const added=window.TabbyConnectionUI.importProfiles(value,this.config.store.profiles||[],()=> 'ssh:import:'+crypto.randomUUID());
                if(!added.length){this.zone.run(()=>this.notice='没有新连接，重复的地址和用户名已跳过');return;}
                if(!window.confirm('导入 '+added.length+' 条 SSH 连接？文件中的密码、密钥和命令不会导入。'))return;
                const previous=Array.from(this.config.store.profiles||[]);
                this.config.store.profiles=[...previous,...added];
                try{await this.config.save();}catch(e){this.config.store.profiles=previous;throw e;}
                this.zone.run(()=>this.notice='已导入 '+added.length+' 条连接，请在连接时输入设备密码');await this.refresh();
            }catch(e){this.zone.run(()=>this.error=e instanceof SyntaxError?'文件不是有效的 JSON':e.message);}finally{event.target.value='';}
        }
        async canClose(){return true;}
        async getRecoveryToken(){return null;}
        ngOnDestroy(){this.alive=false;super.ngOnDestroy();}
    }
    ConnectionHub.ctorParameters=()=>[{type:core.ProfilesService},{type:core.ConfigService},{type:core.AppService},{type:bootstrap.NgbModal},{type:ng.NgZone}];
    ng.Component({selector:'tabby-connection-hub',styles:[`
        :host{display:block;overflow:auto;height:100%;width:100%;background:#151a22;color:#e5ebf4;font-size:14px}.hub{max-width:1120px;margin:auto;padding:32px 36px 60px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 16px}.muted{color:#a0aec1}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:24px 0}.card-button{display:flex;flex-direction:column;gap:8px;align-items:flex-start;text-align:left;border:1px solid #374254;border-radius:12px;background:#202835;color:inherit;padding:22px;font:inherit;cursor:pointer}.card-button strong{font-size:18px}.card-button:hover{border-color:#8fb8ff}.card-button:disabled{opacity:.55;cursor:default}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button:focus-visible,a:focus-visible{outline:2px solid #8fb8ff;outline-offset:3px}.tabs{display:flex;gap:8px;border-bottom:1px solid #374254;padding-bottom:14px;margin:22px 0}.tabs .selected{background:#8fb8ff;color:#11203a}.list{border:1px solid #374254;border-radius:10px;overflow:hidden}.row-item{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:15px 18px;border-bottom:1px solid #303a49;flex-wrap:wrap}.row-item:last-child{border-bottom:0}.description{margin-top:5px;color:#a0aec1;font-size:13px;overflow-wrap:anywhere}.empty{padding:24px;border:1px dashed #374254;border-radius:10px;color:#a0aec1}.search{max-width:380px;margin:14px 0;background:#202835;color:#e5ebf4;border-color:#374254}.badge-saved{color:#9ddbb5;margin-left:12px;font-size:12px}.banner{padding:12px 16px;border-radius:8px;margin:12px 0;background:#263649;overflow-wrap:anywhere}.failure{background:#452c32;color:#ffb8bb}.login-gate{max-width:580px;padding:64px 0}.login-gate h1{font-size:56px}.login-gate button{font-size:21px;padding:16px 24px;margin-top:20px}@media(max-width:600px){.hub{padding:24px 16px}.row-item{padding:14px}.login-gate h1{font-size:44px}}
    `],template:`<main class="hub">
        <section *ngIf="!loggedIn" class="login-gate"><h1>OIDC 登录</h1><p>先登录微服账号，再打开终端。</p><button class="btn btn-primary" (click)="login()">使用微服账号进行 OIDC 登录 →</button></section>
        <ng-container *ngIf="loggedIn">
        <header class="heading"><div><h1>连接首页</h1><span class="muted">{{username}} · OIDC 已登录</span></div><div class="actions"><button class="btn btn-secondary" [disabled]="loading" (click)="refresh()">{{loading?'正在刷新…':'刷新列表'}}</button><button class="btn btn-primary" (click)="newSSH()">＋ 新建 SSH 连接</button></div></header>
        <div class="banner failure" *ngIf="entryError" role="alert">{{entryError}}</div><div class="banner failure" *ngIf="error" role="alert">{{error}} <button *ngIf="error.includes('OIDC')" class="btn btn-sm btn-secondary" (click)="login()">OIDC 登录</button></div><div class="banner" *ngIf="notice" role="status">{{notice}}</div>
        <section class="cards" aria-label="选择连接类型">
            <button class="card-button" [disabled]="!local" (click)="open(local)"><strong>LZC OS 本机</strong><span class="muted">直接进入当前微服终端</span><small>管理员可用 · 无需 SSH 密码</small></button>
            <button class="card-button" (click)="panel='lightos'"><strong>LightOS 实例</strong><span class="muted">选择实例，打开终端</span><small>{{lightos.length}} 个服务端实例 · {{clients.length}} 个客户端实例</small></button>
            <button class="card-button" (click)="newSSH()"><strong>其他 SSH 设备</strong><span class="muted">填写地址、端口、用户名和密码</span><small>密码加密保存，下次自动使用</small></button>
        </section><p *ngIf="adminNotice" class="muted" role="status">{{adminNotice}}</p>
        <nav class="tabs" aria-label="连接管理"><button class="btn btn-secondary" [class.selected]="panel==='connections'" (click)="panel='connections'">已保存连接</button><button class="btn btn-secondary" [class.selected]="panel==='lightos'" (click)="panel='lightos'">LightOS 实例</button><button class="btn btn-secondary" [class.selected]="panel==='passwords'" (click)="panel='passwords';refresh()">已保存密码</button></nav>
        <section *ngIf="panel==='connections'">
            <div class="heading"><h2>最近连接</h2><button *ngIf="recent.length" class="btn btn-sm btn-secondary" (click)="clearHistory()">清空记录</button></div>
            <div *ngIf="!recent.length" class="empty">成功连接后会显示在这里。</div><div *ngIf="recent.length" class="list"><div class="row-item" *ngFor="let item of recent"><div><strong>{{item.profile.name}}</strong><div class="description">{{item.time}}</div></div><button class="btn btn-secondary" (click)="open(item.profile)">连接</button></div></div>
            <div class="heading"><h2>已保存的 SSH 连接</h2><div class="actions"><button class="btn btn-sm btn-secondary" [disabled]="!saved.length" (click)="exportConnections()">导出连接</button><button class="btn btn-sm btn-secondary" (click)="importFile.click()">导入连接</button><input #importFile hidden type="file" accept=".json,application/json" (change)="importConnections($event)"></div></div>
            <p class="muted">导入和导出只包含连接地址、端口、用户名及名称，不包含密码或密钥。</p><input #search class="form-control search" type="search" placeholder="搜索名称、主机或用户名" aria-label="搜索 SSH 连接" (input)="query=search.value">
            <div *ngIf="!saved.length" class="empty">还没有 SSH 连接，点击右上角“新建 SSH 连接”。</div><div *ngIf="saved.length && !filtered.length" class="empty">没有匹配的连接。</div><div class="list" *ngIf="filtered.length"><div class="row-item" *ngFor="let p of filtered"><div><strong>{{p.name}}</strong><span *ngIf="hasPassword(p)" class="badge-saved">密码已保存</span><div class="description">{{p.options.user}}@{{p.options.host}}:{{p.options.port || 22}} <span *ngIf="p.group"> · {{p.group}}</span></div></div><button class="btn btn-primary" (click)="open(p)">连接</button></div></div>
        </section>
        <section *ngIf="panel==='lightos'"><h2>客户端实例</h2><p class="muted">在电脑客户端中开启“接入 LightOS”后，可在这里直接连接其终端。</p><p *ngIf="clientNotice" class="muted" role="status">{{clientNotice}}</p><div *ngIf="!clients.length && !clientNotice" class="empty">当前账号没有已接入的客户端实例。</div><div *ngIf="clients.length" class="list"><div class="row-item" *ngFor="let i of clients"><div><strong>{{i.name}}</strong><div class="description">{{i.platform}} · {{i.status}}</div></div><button class="btn btn-primary" [disabled]="i.status!=='running' && i.status!=='online' && i.status!=='connected'" (click)="openClient(i)">打开客户端终端</button></div></div><div class="heading"><h2>LightOS 实例</h2><button class="btn btn-secondary" (click)="manageLightOS()">管理实例</button></div><div *ngIf="!lightos.length" class="empty">暂无实例。管理员可打开 LightOS 创建。</div><div *ngIf="lightos.length" class="list"><div class="row-item" *ngFor="let i of lightos"><div><strong>{{i.name}}</strong><div class="description">{{i.status}}</div></div><button class="btn btn-primary" [disabled]="i.status!=='running'" (click)="openLightOS(i)">打开终端</button></div></div></section>
        <section *ngIf="panel==='passwords'"><h2>已保存密码</h2><p class="muted">仅显示当前账号保存的凭据。替换或删除后，下次连接时生效，不影响已打开的终端。Tabby 保险库中的凭据仍在原设置中管理。</p><div *ngIf="!credentials.length" class="empty">没有保存的密码。连接设备时勾选“记住”，成功登录后会保存在这里。</div><div *ngIf="credentials.length" class="list"><div class="row-item" *ngFor="let item of credentials"><div><strong>{{item.account}}</strong><div class="description">{{item.service.startsWith('ssh-private-key:')?'私钥口令 · ':''}}{{item.service}}</div></div><div class="actions"><button class="btn btn-secondary" (click)="replacePassword(item)">替换密码</button><button class="btn btn-outline-danger" (click)="deletePassword(item)">删除密码</button></div></div></div></section>
        </ng-container>
    </main>`})(ConnectionHub);
    function openConnectionHub(app){
        for(const top of app.tabs){
            const existing=(top.getAllTabs?top.getAllTabs():[top]).find(tab=>tab instanceof ConnectionHub);
            if(existing){app.selectTab(top);if(top.focus)top.focus(existing);return existing;}
        }
        return app.openNewTab({type:ConnectionHub,inputs:{title:'连接首页'}});
    }

    class ConnectionStatusDecorator extends terminal.TerminalDecorator {
        constructor(zone){super();this.zone=zone;}
        attach(tab){
            if(!tab.profile||!['ssh','lightos'].includes(tab.profile.type))return;
            const target=tab.element&&tab.element.nativeElement;if(!target)return;
            const banner=document.createElement('div'),text=document.createElement('span'),button=document.createElement('button');
            banner.className='tabby-connection-status';banner.setAttribute('role','status');banner.style.cssText='flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:6px 12px;min-height:34px;background:#202936;color:#c3d0e1;font:12px/1.5 system-ui;';
            text.style.cssText='flex:1;overflow-wrap:anywhere';button.className='btn btn-sm btn-secondary';button.style.cssText='padding:1px 10px;font-size:12px;flex-shrink:0';
            banner.append(text,button);target.insertBefore(banner,target.firstChild);
            const toolbar=target.querySelector(':scope > terminal-toolbar'),pin=target.querySelector(':scope > .toolbar-pin-button');
            const oldToolbarTop=toolbar&&toolbar.style.top,oldPinTop=pin&&pin.style.top;
            const positionToolbar=()=>{const height=banner.getBoundingClientRect().height;if(toolbar)toolbar.style.top=height+'px';if(pin)pin.style.top=(height+5)+'px';};
            const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(positionToolbar);
            if(observer)observer.observe(banner);positionToolbar();
            const ui=window.TabbyConnectionUI;let stopped=false,connectedSession=null,attempting=false,byHand=false,restorers=[];
            const set=(state,detail)=>{if(stopped)return;tab.__connectionStatus={state,detail};banner.dataset.state=state;text.textContent=detail;button.textContent=state==='connected'?'断开连接':'重新连接';button.disabled=state==='connecting';};
            const update=()=>{
                if(stopped)return;
                if(tab.connectionError&&(!tab.session||!tab.session.open)){set('disconnected',tab.connectionError);return;}
                if(tab.session&&tab.session.open){
                    if(connectedSession!==tab.session){
                        connectedSession=tab.session;
                        requestJSON('/api/1/connections/history/',{action:'touch',profile_id:tab.profile.id}).catch(()=>{});
                    }
                    set('connected','已连接 · '+(tab.profile.type==='ssh'?tab.profile.options.user+'@'+tab.profile.options.host+':'+(tab.profile.options.port||22):tab.profile.options.kind==='host'?'LZC OS 本机终端':tab.profile.options.kind==='client'?tab.profile.name:'LightOS · '+tab.profile.options.name));
                }else if(tab.__connectionStatus&&tab.__connectionStatus.state==='connected')set('disconnected',byHand?'连接已断开':'连接已中断，请重新连接');
                else if((attempting||!tab.__connectionStatus||tab.__connectionStatus.state==='connecting')&&tab.hasFocus){
                    const password=document.querySelector('ngb-modal-window input[type="password"]');
                    const hostKey=Array.from(document.querySelectorAll('ngb-modal-window')).some(n=>/主机密钥|Host key|host key/.test(n.textContent));
                    set('connecting',password?'等待输入设备密码':hostKey?'等待确认设备主机密钥':'正在连接 / 等待认证');
                }
            };
            const wrap=(name,handler)=>{if(typeof tab[name]!=='function')return;const original=tab[name];tab[name]=handler(original);restorers.push(()=>tab[name]=original);};
            wrap('write',original=>function(value,...args){
                const plain=String(value||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
                if((!tab.session||!tab.session.open)&&/(?:^|\n)\s*(?:X\s|LightOS:|LZC OS:|\[(?:LightOS|LZC OS))/.test(plain)){
                    const detail=ui.explain(plain),generic=ui.explain('');
                    if(!tab.__connectionStatus||tab.__connectionStatus.state!=='disconnected'||detail!==generic){set('disconnected',detail);text.title=plain.trim();}
                }
                return original.call(this,value,...args);
            });
            for(const name of ['initializeSession','startLightOS'])wrap(name,original=>async function(...args){
                attempting=true;byHand=false;set('connecting','正在连接 / 等待认证');
                try{const result=await original.apply(this,args);if(!this.session||!this.session.open){if(this.__connectionStatus.state==='connecting')set('disconnected',this.connectionError||'连接未建立，请查看终端提示后重试');}return result;}
                catch(e){set('disconnected',ui.explain(e.message));throw e;}
                finally{attempting=false;update();}
            });
            wrap('disconnect',original=>async function(...args){byHand=true;const result=await original.apply(this,args);set('disconnected','连接已断开');return result;});
            // The bundled SSH tab lacks disconnect(); destroy both shell and transport.
            if(!tab.disconnect){tab.disconnect=async()=>{byHand=true;if(tab.session)await tab.session.destroy();if(tab.sshSession&&tab.sshSession.open&&tab.sshSession.destroy)tab.sshSession.destroy();set('disconnected','连接已断开');};restorers.push(()=>delete tab.disconnect);}
            const click=()=>this.zone.run(async()=>{
                try{if(tab.session&&tab.session.open)await tab.disconnect();else if(tab.reconnect)await tab.reconnect();update();}
                catch(e){set('disconnected',ui.explain(e.message));}
            });
            button.addEventListener('click',click);set('connecting','正在连接 / 等待认证');update();
            const timer=setInterval(update,500);
            const online=()=>{if(!navigator.onLine&&(!tab.session||!tab.session.open))set('disconnected','网络已断开，请恢复网络后重新连接');};
            window.addEventListener('offline',online);
            this.subscribeUntilDetached(tab,tab.sessionChanged$.subscribe(update));
            tab.__statusCleanup=()=>{stopped=true;clearInterval(timer);window.removeEventListener('offline',online);button.removeEventListener('click',click);if(observer)observer.disconnect();if(toolbar)toolbar.style.top=oldToolbarTop;if(pin)pin.style.top=oldPinTop;banner.remove();restorers.reverse().forEach(f=>f());};
        }
        detach(tab){if(tab.__statusCleanup)tab.__statusCleanup();super.detach(tab);}
    }

    class ClipboardDialog {
        constructor(modal){this.modal=modal;this.text='';this.copy=false;}
    }
    ClipboardDialog.ctorParameters=()=>[{type:bootstrap.NgbActiveModal}];
    ng.Component({selector:'tabby-clipboard-dialog',template:`<div class="modal-header"><h4>{{copy?'复制终端内容':'粘贴到终端'}}</h4><button class="close" (click)="modal.dismiss()">×</button></div>
        <div class="modal-body"><p>{{copy?'浏览器未允许直接复制。请选中下方文本后使用系统复制快捷键。':'浏览器未允许直接读取剪贴板。请在下方使用系统粘贴快捷键，再点击粘贴。'}}</p>
        <textarea #value class="form-control" rows="6" [value]="text" [readOnly]="copy" aria-label="剪贴板内容"></textarea></div>
        <div class="modal-footer"><button class="btn btn-secondary" (click)="modal.dismiss()">取消</button><button *ngIf="!copy" class="btn btn-primary" (click)="modal.close(value.value)">粘贴</button></div>`})(ClipboardDialog);
    class BrowserTerminalDecorator extends terminal.TerminalDecorator {
        constructor(modal,zone){super();this.modal=modal;this.zone=zone;}
        attach(tab){
            const actions=window.TabbyTerminalActions,platform=tab.platform,modal=this.modal,zone=this.zone;
            const nativePaste=tab.paste,nativeMenu=tab.buildContextMenu.bind(tab);
            tab.buildContextMenu=async()=>{
                const aliases={Copy:'copy','复制':'copy',Paste:'paste','粘贴':'paste',Reconnect:'reconnect','重新连接':'reconnect',Disconnect:'disconnect','断开连接':'disconnect'},seen=new Set();
                return (await nativeMenu()).filter(item=>{const key=aliases[item.label];if(!key)return true;if(seen.has(key))return false;seen.add(key);return true;});
            };
            const manual=async()=>{
                const m=zone.run(()=>modal.open(ClipboardDialog));try{return await m.result;}catch(_){return null;}
            };
            tab.paste=async()=>{
                const text=await actions.readClipboard(navigator,manual);
                await zone.run(()=>actions.pasteText(tab,text,nativePaste));
            };
            if(!platform.__browserClipboardFixed){
                platform.__browserClipboardFixed=true;
                platform.setClipboard=content=>{
                    actions.writeClipboard(navigator,document,content.text).catch(()=>{
                        const m=zone.run(()=>modal.open(ClipboardDialog));m.componentInstance.copy=true;m.componentInstance.text=content.text;m.result.catch(()=>{});
                    });
                };
            }
            // Web build's default is right-click paste; this package exposes a menu.
            tab.handleRightMouseDown=event=>{event.preventDefault();event.stopPropagation();};
            tab.handleRightMouseUp=event=>{event.preventDefault();event.stopPropagation();};
            const keyboardPaste=event=>{
                if(!tab.hasFocus||event.altKey||!(event.ctrlKey||event.metaKey)||event.code!=='KeyV'||!event.target.closest||!event.target.closest('.xterm'))return;
                event.preventDefault();event.stopImmediatePropagation();
                if(!event.repeat)zone.run(()=>tab.paste());
            };
            window.addEventListener('keydown',keyboardPaste,true);
            const paste=event=>{
                if(!tab.hasFocus||!event.clipboardData||!event.target.closest||!event.target.closest('.xterm'))return;
                event.preventDefault();event.stopImmediatePropagation();
                zone.run(()=>actions.pasteText(tab,event.clipboardData.getData('text/plain'),nativePaste));
            };
            const copy=event=>{
                if(!tab.hasFocus||!event.clipboardData||!event.target.closest||!event.target.closest('.xterm'))return;
                const text=tab.frontend&&tab.frontend.getSelection();if(!text)return;
                event.preventDefault();event.clipboardData.setData('text/plain',text);
            };
            const scrollCleanup=window.TabbyTerminalScroll.install(tab);
            const host=tab.content&&tab.content.nativeElement;
            const context=event=>{event.preventDefault();event.stopImmediatePropagation();zone.run(()=>tab.buildContextMenu().then(items=>platform.popupContextMenu(items,event)));};
            if(host)host.addEventListener('contextmenu',context,true);
            document.addEventListener('paste',paste,true);document.addEventListener('copy',copy,true);
            tab.__clipboardCleanup=()=>{scrollCleanup();window.removeEventListener('keydown',keyboardPaste,true);if(host)host.removeEventListener('contextmenu',context,true);document.removeEventListener('paste',paste,true);document.removeEventListener('copy',copy,true);};
        }
        detach(tab){if(tab.__clipboardCleanup)tab.__clipboardCleanup();super.detach(tab);}
    }
    class TerminalActionsMenu extends core.TabContextMenuItemProvider {
        constructor(){super();this.weight=-100;}
        async getItems(tab){
            if(!(tab instanceof terminal.BaseTerminalTabComponent))return [];
            return [{label:'复制',enabled:!!(tab.frontend&&tab.frontend.getSelection()),click:()=>tab.platform.setClipboard({text:tab.frontend.getSelection()})},
                {label:'粘贴',enabled:!!(tab.session&&tab.session.open),click:()=>tab.paste()},
                {label:'重新连接',enabled:typeof tab.reconnect==='function',click:()=>tab.reconnect()},
                {label:'断开连接',enabled:!!(tab.session&&tab.session.open),click:()=>{if(tab.disconnect)tab.disconnect();else if(tab.session)tab.session.destroy();}}];
        }
    }
    class LightOSRecovery extends core.TabRecoveryProvider {
        async applicableTo(token) { return token.type==='lightos'||token.type==='lightos-client'; }
        async recover(token) { return {type:LightOSTab,inputs:{profile:token.profile}}; }
    }
    class LightOSToolbar extends core.ToolbarButtonProvider {
        constructor(profiles, app, modal, zone) {
            super(); this.profiles = profiles; this.app = app; this.modal = modal; this.zone=zone;
            try{window.TabbySidebar.apply(window.parent.document,window.parent.localStorage);}catch(_){}
            const refocus=()=>{if(!document.hidden&&!document.querySelector('ngb-modal-window, .modal.show, input:focus')&&this.app.activeTab&&this.app.activeTab.emitFocused)this.app.activeTab.emitFocused();};
            window.addEventListener('focus',refocus);document.addEventListener('visibilitychange',refocus);
            const deepLink = new URL(window.parent.location.href);
            this.app.ready$.subscribe(()=>this.zone.run(async()=>{
                try{
                    const target=window.TabbyWebShellEntry.target(deepLink);
                    if(!target){openConnectionHub(this.app);return;}
                    const selected=await window.TabbyWebShellEntry.resolve(target,instances,()=>requestJSON('/lightos/api/client-instances'));
                    const params=await this.profiles.newTabParametersForProfile(selected.kind==='client'?clientProfile(selected.item):profile(selected.item));
                    if(!params)throw Error('Tabby 无法打开该 LightOS 终端');
                    this.zone.run(()=>this.app.openNewTab(params));
                    for(const key of ['target','name','lightos','owner'])deepLink.searchParams.delete(key);
                    window.parent.history.replaceState(null,'',deepLink.href);
                }catch(e){
                    this.zone.run(()=>{const hub=openConnectionHub(this.app);if(hub)hub.entryError=e.message;});
                }
            }));
            window.TabbySidebar.installHandle(window.parent.document,window.parent.localStorage);
            window.addEventListener('message', event => {
                if (event.origin !== location.origin || !event.data || event.data.type !== 'tabby-lightos-open') return;
                const source = Array.from(document.querySelectorAll('lightos-manager-tab iframe')).some(f => f.contentWindow === event.source);
                if (!source) return;
                instances().then(items => {
                    const i = items.find(i => i.name === event.data.name && i.owner_deploy_id === event.data.owner);
                    if (i) this.profiles.openNewTabForProfile(profile(i));
                });
            });
        }
        async openLocalOS() {
            try { const p=await localOSProfile();this.zone.run(()=>this.profiles.openNewTabForProfile(p)); }
            catch(e) { this.zone.run(()=>window.alert(e.message)); }
        }
        provide() {
            const buttons=[{title:'连接首页',weight:3,icon:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 3h7v7H3V3zm11 0h7v7h-7V3zM3 14h7v7H3v-7zm11 0h7v7h-7v-7z"/></svg>',click:()=>openConnectionHub(this.app)},{title:'LZC OS 本机终端',weight:4,icon:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 3h18v8H3V3zm2 2v4h14V5H5zm-2 8h18v8H3v-8zm2 2v4h14v-4H5zm2-9h2v2H7V6zm0 10h2v2H7v-2z"/></svg>',click:()=>this.openLocalOS()},{title:'LightOS 实例', icon:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v12h14V6H5zm2 3 3 3-3 3 1.5 1.5L13 12 8.5 7.5 7 9zm6 6h4v2h-4v-2z"/></svg>', weight:5,
                submenu: async () => {
                    const items = [{title:'LZC OS 本机终端',click:()=>this.openLocalOS()},{title:'管理 LightOS 实例', click:()=>this.app.openNewTab({type:LightOSManagerTab,inputs:{title:'LightOS 管理'}})}];
                    try {
                        for (const i of await instances()) items.push({title:i.name+' · '+i.status,
                            click:()=>this.profiles.openNewTabForProfile(profile(i))});
                    } catch(e) { items.push({title:e.message, click:()=>{}}); }
                    try{for(const i of await requestJSON('/lightos/api/client-instances'))items.push({title:'客户端 · '+i.name+' · '+i.status,click:()=>this.profiles.openNewTabForProfile(clientProfile(i))});}
                    catch(e){items.push({title:'客户端实例：'+e.message,click:()=>{}});}
                    return items;
                }}, {title:'新建 SSH 连接',weight:6,icon:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11 3h2v8h8v2h-8v8h-2v-8H3v-2h8V3z"/></svg>',click:()=>this.modal.open(NewSSHConnection)}];
            const side={title:window.parent.document.querySelector('.sidebar')?.style.display==='none'?'显示左侧栏':'隐藏左侧栏',weight:7,
                icon:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v12h4V6H5zm6 0v12h8V6h-8z"/></svg>',
                click:()=>{const hidden=window.TabbySidebar.toggle(window.parent.document,window.parent.localStorage);window.TabbySidebar.updateHandle(window.parent.document);side.title=hidden?'显示左侧栏':'隐藏左侧栏';}};
            buttons.push(side);return buttons;
        }
    }
    class LightOSModule {}
    ng.NgModule({imports:[common.CommonModule, terminal.default,bootstrap.NgbModule], declarations:[LightOSTab,LightOSManagerTab,NewSSHConnection,ClipboardDialog,ConnectionHub,SavedPasswordDialog], entryComponents:[LightOSTab,LightOSManagerTab,NewSSHConnection,ClipboardDialog,ConnectionHub,SavedPasswordDialog],
        providers:[{provide:terminal.TerminalDecorator,useFactory:z=>new ConnectionStatusDecorator(z),deps:[ng.NgZone],multi:true},{provide:terminal.TerminalDecorator,useFactory:(m,z)=>new BrowserTerminalDecorator(m,z),deps:[bootstrap.NgbModal,ng.NgZone],multi:true},{provide:core.TabContextMenuItemProvider,useClass:TerminalActionsMenu,multi:true},{provide:core.TabRecoveryProvider,useClass:LightOSRecovery,multi:true},{provide:core.ProfileProvider,useClass:LightOSProfiles,multi:true},
            {provide:core.ToolbarButtonProvider,useFactory:(p,a,m,z)=>new LightOSToolbar(p,a,m,z),deps:[core.ProfilesService,core.AppService,bootstrap.NgbModal,ng.NgZone],multi:true}]})(LightOSModule);
    module.exports = {default:LightOSModule};
})();
