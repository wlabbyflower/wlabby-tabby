/* Tabby plugin: real terminal tabs sharing Tabby's renderer, shortcuts and tab bar. */
(function () {
    const ng = require('@angular/core');
    const common = require('@angular/common');
    const forms = require('@angular/forms');
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
    // @include connection-hub.js
    // @include file-browser.js
    // @include connection-status.js
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
        constructor(modal,zone){super();this.modal=modal;this.zone=zone;this.weight=-100;}
        async getItems(tab){
            if(!(tab instanceof terminal.BaseTerminalTabComponent))return [];
            const items=[{label:'复制',enabled:!!(tab.frontend&&tab.frontend.getSelection()),click:()=>tab.platform.setClipboard({text:tab.frontend.getSelection()})},
                {label:'粘贴',enabled:!!(tab.session&&tab.session.open),click:()=>tab.paste()},
                {label:'重新连接',enabled:typeof tab.reconnect==='function',click:()=>tab.reconnect()},
                {label:'断开连接',enabled:!!(tab.session&&tab.session.open),click:()=>{if(tab.disconnect)tab.disconnect();else if(tab.session)tab.session.destroy();}}];
            if(tab.profile&&tab.profile.type==='lightos')items.push({label:'文件传输',click:()=>openFiles(tab,this.modal,this.zone)});
            return items;
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
    ng.NgModule({imports:[common.CommonModule, forms.FormsModule, terminal.default,bootstrap.NgbModule], declarations:[FileBrowser,LightOSTab,LightOSManagerTab,NewSSHConnection,ClipboardDialog,ConnectionHub,SavedPasswordDialog], entryComponents:[FileBrowser,LightOSTab,LightOSManagerTab,NewSSHConnection,ClipboardDialog,ConnectionHub,SavedPasswordDialog],
        providers:[{provide:terminal.TerminalDecorator,useFactory:(z,m)=>new ConnectionStatusDecorator(z,m),deps:[ng.NgZone,bootstrap.NgbModal],multi:true},{provide:terminal.TerminalDecorator,useFactory:(m,z)=>new BrowserTerminalDecorator(m,z),deps:[bootstrap.NgbModal,ng.NgZone],multi:true},{provide:core.TabContextMenuItemProvider,useFactory:(m,z)=>new TerminalActionsMenu(m,z),deps:[bootstrap.NgbModal,ng.NgZone],multi:true},{provide:core.TabRecoveryProvider,useClass:LightOSRecovery,multi:true},{provide:core.ProfileProvider,useClass:LightOSProfiles,multi:true},
            {provide:core.ToolbarButtonProvider,useFactory:(p,a,m,z)=>new LightOSToolbar(p,a,m,z),deps:[core.ProfilesService,core.AppService,bootstrap.NgbModal,ng.NgZone],multi:true}]})(LightOSModule);
    module.exports = {default:LightOSModule};
})();
