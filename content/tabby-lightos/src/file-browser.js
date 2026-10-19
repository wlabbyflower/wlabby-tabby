    class FileBrowser {
        constructor(modal,zone){this.modal=modal;this.zone=zone;this.entries=[];this.path='/';this.pathInput='/';this.parent='/';this.error='';this.notice='';this.progress='';this.busy=false;this.capabilities={};this.alive=true;}
        async ngOnInit(){
            this.channel=new window.TabbyFileChannel.Channel(this.profile,requestJSON);
            this.busy=true;
            try{const ready=await this.channel.connect();this.zone.run(()=>{this.capabilities=ready.capabilities||{};});await this.navigate(ready.path||'/');}
            catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>this.busy=false);}
        }
        ngOnDestroy(){this.alive=false;if(this.channel)this.channel.close();}
        async run(fn){if(this.busy)return;this.busy=true;this.error='';this.notice='';try{await fn();}catch(e){this.zone.run(()=>this.error=e.message);}finally{this.zone.run(()=>{this.busy=false;this.progress='';});}}
        async navigate(path){const result=await this.channel.call('list',{path});this.zone.run(()=>{this.path=result.path;this.pathInput=result.path;this.parent=result.parent||result.path;this.entries=result.entries||[];this.truncated=result.truncated;});}
        join(name){if(!name||name==='.'||name==='..'||/[\x00/\\\r\n]/.test(name))throw Error('请输入有效的文件名');return this.path.replace(/\/$/,'')+'/'+name;}
        async upload(event){
            const files=Array.from(event.target.files||[]);event.target.value='';
            await this.run(async()=>{
                for(const file of files){
                    if(file.size>2*1024**3)throw Error('单文件不能超过 2 GiB');
                    const existing=this.entries.find(i=>i.name===file.name),overwrite=!!existing;
                    if(overwrite&&!this.capabilities.staging&&!window.confirm('覆盖 '+file.name+'？'))continue;
                    await this.channel.call('upload-start',{path:this.join(file.name),filename:file.name,size:file.size,overwrite});
                    for(let offset=0;offset<file.size;offset+=65536){
                        const bytes=new Uint8Array(await file.slice(offset,offset+65536).arrayBuffer());
                        await this.channel.call('upload-chunk',{data:window.TabbyFileChannel.encode(bytes)});
                        this.zone.run(()=>this.progress='上传 '+file.name+' · '+Math.round(Math.min(file.size,offset+bytes.length)/Math.max(1,file.size)*100)+'%');
                    }
                    this.zone.run(()=>this.progress='正在保存 '+file.name+'…');
                    const result=await this.channel.call('upload-finish');
                    if(this.capabilities.staging){this.zone.run(()=>this.notice='已保存到客户端：'+result.path);const parent=result.path.slice(0,result.path.lastIndexOf('/'))||'/';await this.navigate(parent);}
                    else await this.navigate(this.path);
                }
            });
        }
        async download(item){
            if(this.busy)return;
            // Ask for a destination during the user gesture, before network awaits.
            let picker=null;
            try{if(window.showSaveFilePicker)picker=window.showSaveFilePicker({suggestedName:item.name});}
            catch(e){this.error=e.message;return;}
            await this.run(async()=>{
                let writer=null,finished=false;
                try{
                    if(picker)writer=await(await picker).createWritable();
                    const metadata=await this.channel.call('download-start',{path:item.path}),parts=[];let total=0;
                    if(!writer&&metadata.size>128*1024*1024)throw Error('此浏览器下载超过 128 MiB 的文件需要支持保存文件接口，请使用桌面 Chrome 或 Edge');
                    while(true){
                        const result=await this.channel.call('download-chunk'),bytes=window.TabbyFileChannel.decode(result.data);
                        total+=bytes.length;
                        if(total>metadata.size)throw Error('下载期间文件大小发生变化，请重试');
                        if(writer)await writer.write(bytes);else if(bytes.length)parts.push(bytes);
                        this.zone.run(()=>this.progress='下载 '+item.name+' · '+Math.round(total/Math.max(1,metadata.size)*100)+'%');
                        if(result.eof)break;
                    }
                    if(total!==metadata.size)throw Error('下载不完整，请重试');
                    if(writer)await writer.close();else{const url=URL.createObjectURL(new Blob(parts));const a=document.createElement('a');a.href=url;a.download=metadata.name||item.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
                    finished=true;
                }finally{if(writer&&!finished)await writer.abort().catch(()=>{});if(!finished)this.channel.call('cancel').catch(()=>{});}
            });
        }
        mkdir(){const name=window.prompt('新建目录名称');if(name)this.run(async()=>{await this.channel.call('mkdir',{path:this.join(name)});await this.navigate(this.path);});}
        rename(item){const name=window.prompt('新名称',item.name);if(name&&name!==item.name)this.run(async()=>{await this.channel.call('rename',{path:item.path,destination:this.join(name)});await this.navigate(this.path);});}
        remove(item){if(window.confirm('删除 '+item.name+'？目录必须为空。'))this.run(async()=>{await this.channel.call('remove',{path:item.path});await this.navigate(this.path);});}
    }
    FileBrowser.ctorParameters=()=>[{type:bootstrap.NgbActiveModal},{type:ng.NgZone}];
    ng.Component({selector:'tabby-file-browser',styles:[`:host{display:block} .file-path{flex:1;min-width:180px} .file-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.file-table{max-height:52vh;overflow:auto}table{width:100%}th,td{padding:8px;border-bottom:1px solid #394454;overflow-wrap:anywhere}.file-name{color:#acd0ff;border:0;background:none;text-align:left}.file-error{color:#ffb6b6}.file-note{color:#aebacb}.file-actions{white-space:nowrap}`],template:`
    <div class="modal-header"><h4>文件传输 · {{profile.name}}</h4><button class="close" (click)="modal.dismiss()" aria-label="关闭文件传输">×</button></div>
    <div class="modal-body"><p *ngIf="capabilities.staging" class="file-note">客户端上传文件保存在客户端提供的临时目录，上传后显示实际路径。可浏览和下载当前账号能访问的文件。</p>
    <form class="file-toolbar" (submit)="run(navigate.bind(this,pathInput));$event.preventDefault()"><input class="form-control file-path" aria-label="远程目录" [(ngModel)]="pathInput" name="path" [disabled]="busy"><button class="btn btn-secondary" [disabled]="busy">转到</button></form>
    <div class="file-toolbar"><button class="btn btn-secondary" [disabled]="busy||parent===path" (click)="run(navigate.bind(this,parent))">上级目录</button><button class="btn btn-secondary" [disabled]="busy" (click)="run(navigate.bind(this,path))">刷新目录</button><button class="btn btn-primary" [disabled]="busy||!capabilities.upload" (click)="uploadInput.click()">上传文件</button><input #uploadInput type="file" multiple hidden (change)="upload($event)"><button *ngIf="capabilities.write" class="btn btn-secondary" [disabled]="busy" (click)="mkdir()">新建目录</button></div>
    <p *ngIf="error" class="file-error" role="alert">{{error}}</p><p *ngIf="notice" role="status">{{notice}}</p><p *ngIf="busy" role="status">{{progress||'正在读取…'}}</p><p *ngIf="truncated" class="file-note">目录项目较多，仅显示前 5000 项。可以在上方输入具体路径。</p>
    <div class="file-table"><table><thead><tr><th>名称</th><th>大小</th><th>操作</th></tr></thead><tbody><tr *ngFor="let item of entries"><td><button class="file-name" *ngIf="item.type==='dir'" [disabled]="busy" (click)="run(navigate.bind(this,item.path))">📁 {{item.name}}</button><span *ngIf="item.type!=='dir'">{{item.name}}</span></td><td>{{item.type==='dir'?'目录':item.size+' B'}}</td><td class="file-actions"><button *ngIf="item.type==='file'" class="btn btn-sm btn-secondary" [disabled]="busy" (click)="download(item)">下载</button><button *ngIf="capabilities.write" class="btn btn-sm btn-secondary" [disabled]="busy" (click)="rename(item)">重命名</button><button *ngIf="capabilities.write" class="btn btn-sm btn-secondary" [disabled]="busy" (click)="remove(item)">删除</button></td></tr></tbody></table></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" (click)="modal.dismiss()">{{busy?'取消并关闭':'关闭'}}</button></div>`})(FileBrowser);
    function openFiles(tab,modal,zone){return zone.run(()=>{const ref=modal.open(FileBrowser,{size:'lg'});ref.componentInstance.profile=tab.profile;ref.result.catch(()=>{});return ref;});}
