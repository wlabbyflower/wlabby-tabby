    class BackgroundSettings {
        constructor(zone){this.zone=zone;this.value={...window.TabbyTerminalBackground.get()};this.error='';this.notice='';this.busy=false;this.alive=true;}
        ngOnInit(){window.TabbyTerminalBackground.load().then(value=>this.zone.run(()=>{if(this.alive)this.value={...value};})).catch(e=>this.zone.run(()=>this.error=e.message));}
        preview(){window.TabbyTerminalBackground.preview({...this.value,shade:Number(this.value.shade)});this.notice='预览已更新，点击“保存设置”后永久生效。';}
        async action(body){if(this.busy)return;this.busy=true;this.error='';this.notice='';try{const value=await window.TabbyTerminalBackground.request(body);this.zone.run(()=>{if(this.alive){this.value={...value};this.notice='已保存，所有终端已更新。';}});}catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>this.busy=false);}}
        async upload(event){const file=event.target.files[0];event.target.value='';if(!file)return;if(file.size>8*1024*1024){this.error='图片不能超过 8 MiB';return;}const body=new FormData();body.append('image',file);await this.action(body);}
        save(){return this.action({enabled:!!this.value.enabled,fit:this.value.fit,shade:Number(this.value.shade)});}
        remove(){return this.action({action:'remove'});}
        ngOnDestroy(){this.alive=false;window.TabbyTerminalBackground.load().catch(()=>{});}
    }
    BackgroundSettings.ctorParameters=()=>[{type:ng.NgZone}];
    ng.Component({selector:'tabby-background-settings',styles:[`:host{display:block;padding:20px;max-width:1000px;color:inherit}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.preview{margin:22px 0;height:240px;background-position:center;background-repeat:no-repeat;position:relative;background-color:#171b22;border-radius:8px;overflow:hidden}.sample{padding:24px;color:#eef3fc;font:15px/1.7 monospace;position:relative;z-index:1;white-space:pre-line}.shade{position:absolute;inset:0;background:#171b22;pointer-events:none}.notice{padding:12px;margin:14px 0;background:#263649;color:#e5ebf4}.error{background:#452c32;color:#ffb8bb}label{display:block;margin:18px 0}select{max-width:300px}input[type=range]{display:block;width:100%;max-width:460px}p{line-height:1.7;opacity:.8}`],template:`<section>
        <h2>终端背景</h2><p>选择自己的背景图，本机、SSH 和 LightOS 终端都会使用。图片和设置按当前账号保存，重新打开或正常升级后继续保留。</p>
        <div class="notice error" role="alert" *ngIf="error">{{error}}</div><div class="notice" role="status" *ngIf="notice">{{notice}}</div>
        <div class="actions"><button class="btn btn-primary" [disabled]="busy" (click)="file.click()">{{busy?'正在保存…':'选择背景图'}}</button><input #file hidden type="file" accept="image/png,image/jpeg,image/webp" (change)="upload($event)"><button class="btn btn-outline-danger" [disabled]="busy||!value.hasImage" (click)="remove()">移除背景图</button></div>
        <p>支持静态 PNG、JPEG、WebP，最大 8 MiB、1600 万像素。图片只保存在当前应用中。</p>
        <div class="preview" [style.background-image]="value.enabled&&value.url?'url('+value.url+')':'none'" [style.background-size]="value.fit==='stretch'?'100% 100%':value.fit"><div class="shade" [style.opacity]="value.enabled&&value.url?value.shade/100:1"></div><div class="sample">$ echo Hello\nHello\n$ 正在等待输入…</div></div>
        <label><input type="checkbox" [(ngModel)]="value.enabled" [disabled]="!value.hasImage||busy" (change)="preview()"> 启用终端背景图</label>
        <label>显示方式<select class="form-control" [(ngModel)]="value.fit" [disabled]="busy" (change)="preview()"><option value="cover">铺满终端（可能裁剪）</option><option value="contain">完整显示</option><option value="stretch">拉伸填满</option></select></label>
        <label>遮罩深度：{{value.shade}}%<input type="range" min="65" max="95" step="1" [(ngModel)]="value.shade" [disabled]="busy" (input)="preview()"></label><p>数值越大，图片越暗，文字越清楚。遮罩保留一定深度，避免 Agent 输入区文字被背景盖住。</p>
        <button class="btn btn-primary" [disabled]="busy" (click)="save()">保存设置</button>
    </section>`})(BackgroundSettings);
    class BackgroundSettingsProvider extends settings.SettingsTabProvider {
        constructor(){super();this.id='terminal-background';this.title='终端背景';this.icon='fas fa-image';this.weight=30;}
        getComponentType(){return BackgroundSettings;}
    }
    function openBackgroundSettings(app){
        for(const top of app.tabs){const found=(top.getAllTabs?top.getAllTabs():[top]).find(t=>t instanceof settings.SettingsTabComponent);if(found){found.activeTab='terminal-background';app.selectTab(top);if(top.focus)top.focus(found);return found;}}
        return app.openNewTab({type:settings.SettingsTabComponent,inputs:{activeTab:'terminal-background'}});
    }
