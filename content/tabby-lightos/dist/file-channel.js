/* Chunked file requests on authenticated, independently closable WebSockets. */
(function(root){
    class Channel {
        constructor(profile,request,options){this.profile=profile;this.request=request;this.options=options||{};this.pending=new Map();this.sequence=0;this.closed=false;}
        async connect(){
            if(this.connecting)return this.connecting;
            this.connecting=(async()=>{
                const o=this.profile.options;
                const ticket=o.kind==='host'?(await this.request('/lightos/api/local-files-ticket',{})).ticket:null;
                if(this.closed)throw Error('文件传输已关闭');
                const u=new URL(ticket?'/lzc-terminal/':'/lightos-terminal/',this.options.location||root.location.href);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.searchParams.set('files','1');
                if(ticket)u.searchParams.set('ticket',ticket);else if(o.kind==='client')u.searchParams.set('client',o.id);else{u.searchParams.set('name',o.name);u.searchParams.set('owner',o.owner||'');}
                return new Promise((resolve,reject)=>{
                    const WS=this.options.WebSocket||root.WebSocket;this.ws=new WS(u.href);
                    const timer=setTimeout(()=>{reject(Error('文件传输连接超时'));this.close();},65000);
                    this.ws.onmessage=event=>{
                        try{
                            const data=JSON.parse(event.data);
                            if(data.type==='files-ready'){clearTimeout(timer);this.ready=data;resolve(data);return;}
                            const pending=this.pending.get(data.id);
                            if(pending){this.pending.delete(data.id);clearTimeout(pending.timer);if(data.error)pending.reject(Error(data.error));else pending.resolve(data);}
                            else if(data.error&&!this.ready){clearTimeout(timer);reject(Error(data.error));this.close();}
                        }catch(_){reject(Error('文件传输响应无效'));this.close();}
                    };
                    this.ws.onerror=()=>{clearTimeout(timer);reject(Error('文件传输连接失败，请检查登录和设备状态'));this.close();};
                    this.ws.onclose=()=>{clearTimeout(timer);reject(Error('文件传输连接已断开'));this.failPending();};
                });
            })();return this.connecting;
        }
        async call(action,fields){
            await this.connect();if(this.closed||this.ws.readyState!==1)throw Error('文件传输已断开，请关闭窗口后重新打开');
            const id=++this.sequence;
            return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('文件操作超时，请重新打开文件传输'));this.close();},action==='upload-finish'?300000:65000);this.pending.set(id,{resolve,reject,timer});try{this.ws.send(JSON.stringify({id,action,...fields}));}catch(e){this.pending.delete(id);clearTimeout(timer);reject(e);}});
        }
        failPending(){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('文件传输连接已断开'));}this.pending.clear();}
        close(){this.closed=true;this.failPending();if(this.ws)this.ws.close();}
    }
    function encode(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
    function decode(text){const s=atob(text),bytes=new Uint8Array(s.length);for(let i=0;i<s.length;i++)bytes[i]=s.charCodeAt(i);return bytes;}
    const api={Channel,encode,decode};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyFileChannel=api;
})(typeof window==='undefined'?globalThis:window);
