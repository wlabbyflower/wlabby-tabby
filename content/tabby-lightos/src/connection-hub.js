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
            this.saved=[];this.lightos=[];this.clients=[];this.clientNotice='';this.recent=[];this.credentials=[];this.local=null;this.loading=false;this.error='';this.notice='';this.adminNotice='';this.query='';this.panel='connections';this.alive=true;
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
        <div class="banner failure" *ngIf="error" role="alert">{{error}} <button *ngIf="error.includes('OIDC')" class="btn btn-sm btn-secondary" (click)="login()">OIDC 登录</button></div><div class="banner" *ngIf="notice" role="status">{{notice}}</div>
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
        <section *ngIf="panel==='lightos'"><h2>客户端实例</h2><p class="muted">在电脑客户端中开启“接入 LightOS”后，可在这里直接连接其终端。</p><p *ngIf="clientNotice" class="muted" role="status">{{clientNotice}}</p><div *ngIf="!clients.length && !clientNotice" class="empty">当前账号没有已接入的客户端实例。</div><div *ngIf="clients.length" class="list"><div class="row-item" *ngFor="let i of clients"><div><strong>{{i.name}}</strong><div class="description">{{i.platform}} · {{i.status}}</div></div><button class="btn btn-primary" [disabled]="i.status!=='running' && i.status!=='online' && i.status!=='connected'" (click)="openClient(i)">打开客户端终端</button></div></div><div class="heading"><h2>LightOS 实例</h2><button class="btn btn-secondary" (click)="manageLightOS()">管理实例</button></div><div *ngIf="!lightos.length" class="empty">暂无实例。管理员可在“管理实例”中创建。</div><div *ngIf="lightos.length" class="list"><div class="row-item" *ngFor="let i of lightos"><div><strong>{{i.name}}</strong><div class="description">{{i.status}}</div></div><button class="btn btn-primary" [disabled]="i.status!=='running'" (click)="openLightOS(i)">打开终端</button></div></div></section>
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
