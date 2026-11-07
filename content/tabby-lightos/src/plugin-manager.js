    class PluginManager extends core.BaseTabComponent {
        constructor(zone){super();this.zone=zone;this.installed=[];this.available=[];this.query='';this.name='';this.version='';this.error='';this.notice='';this.busy=false;this.alive=true;this.safe=new URL(window.parent.location.href).searchParams.get('plugins')==='off';this.failures=window.__tabbyPluginErrors||[];}
        ngOnInit(){this.refresh();}
        async refresh(){try{const value=await requestJSON('/api/1/plugins/');this.zone.run(()=>{if(this.alive)this.installed=value.items;});}catch(e){this.zone.run(()=>this.error=e.message);}}
        async search(){if(this.busy)return;this.busy=true;this.error='';try{const value=await requestJSON('/api/1/plugins/?q='+encodeURIComponent(this.query));this.zone.run(()=>this.available=value.items);}catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>this.busy=false);}}
        async change(action,name,version=''){
            if(this.busy)return;this.busy=true;this.error='';this.notice='';
            try{await requestJSON('/api/1/plugins/',{action,name,version},'POST',120000);await this.refresh();this.zone.run(()=>this.notice='已保存。点击“应用插件更改”重新加载页面后生效，后台终端会话会保留。');}
            catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>this.busy=false);}
        }
        reload(){const url=new URL(window.parent.location.href);url.searchParams.delete('plugins');window.parent.location.assign(url.href);}
        safeStart(){window.parent.location.assign('/?plugins=off');}
        async canClose(){return true;}
        async getRecoveryToken(){return null;}
        ngOnDestroy(){this.alive=false;super.ngOnDestroy();}
    }
    PluginManager.ctorParameters=()=>[{type:ng.NgZone}];
    ng.Component({selector:'tabby-plugin-manager',styles:[`:host{display:block;overflow:auto;height:100%;padding:28px 36px;background:#151a22;color:#e5ebf4}main{max-width:1050px;margin:auto}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row-item{display:flex;justify-content:space-between;align-items:center;padding:16px 0;gap:16px;border-bottom:1px solid #374254}p{color:#b3bfce;line-height:1.7}input{max-width:380px}.notice{padding:14px;background:#263649;margin:16px 0}.error{color:#ffb8bb;white-space:pre-wrap}h2{margin-top:28px}.description{max-width:680px;overflow-wrap:anywhere}small{color:#a0aec1}`],template:`<main>
        <div class="actions"><h1 class="mr-auto">插件</h1><button class="btn btn-secondary" (click)="safeStart()">禁用第三方插件启动</button><button class="btn btn-primary" (click)="reload()">应用插件更改</button></div>
        <p>从 Tabby 使用的 npm 插件仓库搜索，也可以填写插件名称和版本安装。插件按当前账号保存。</p>
        <p>支持完整打包的 JavaScript 插件；依赖 Electron、本机文件系统、原生模块或额外未打包依赖的插件暂不支持。部分新插件可能需要更新的 Tabby 内核。</p>
        <div *ngIf="safe" class="notice">当前已禁用第三方插件。可以在这里关闭或卸载有问题的插件，再点击“应用插件更改”。</div>
        <div *ngFor="let item of failures" class="notice error">{{item.name}} 加载失败：{{item.error}}</div>
        <div *ngIf="error" class="notice error" role="alert">{{error}}</div><div *ngIf="notice" class="notice" role="status">{{notice}}</div>
        <h2>已安装</h2><p *ngIf="!installed.length">还没有安装第三方插件。</p>
        <div class="row-item" *ngFor="let item of installed"><div><strong>{{item.name}}</strong> <small>{{item.version}} · {{item.enabled?'已启用':'已禁用'}}</small><div class="description">{{item.description}}</div></div><div class="actions"><button class="btn btn-secondary" [disabled]="busy" (click)="change(item.enabled?'disable':'enable',item.name)">{{item.enabled?'禁用':'启用'}}</button><button class="btn btn-outline-danger" [disabled]="busy" (click)="change('uninstall',item.name)">卸载</button></div></div>
        <h2>搜索插件仓库</h2><form class="actions" (submit)="search();$event.preventDefault()"><input name="query" class="form-control" [(ngModel)]="query" placeholder="搜索插件名称" aria-label="搜索插件名称"><button class="btn btn-secondary" [disabled]="busy">{{busy?'处理中…':'搜索'}}</button></form>
        <div class="row-item" *ngFor="let item of available"><div><strong>{{item.name}}</strong> <small>{{item.version}}</small><div class="description">{{item.description}}</div></div><button class="btn btn-primary" [disabled]="busy" (click)="change('install',item.name,item.version)">安装</button></div>
        <h2>按名称安装</h2><form class="actions" (submit)="change('install',name,version);$event.preventDefault()"><input name="name" class="form-control" [(ngModel)]="name" placeholder="tabby-插件名" aria-label="插件包名" required><input name="version" class="form-control" [(ngModel)]="version" placeholder="版本号，可选" aria-label="插件版本"><button class="btn btn-primary" [disabled]="busy">安装插件</button></form>
    </main>`})(PluginManager);
    function openPluginManager(app){for(const top of app.tabs){const found=(top.getAllTabs?top.getAllTabs():[top]).find(t=>t instanceof PluginManager);if(found){app.selectTab(top);if(top.focus)top.focus(found);return found;}}return app.openNewTab({type:PluginManager,inputs:{title:'插件'}});}
