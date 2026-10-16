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
