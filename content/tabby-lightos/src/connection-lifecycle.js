    // Connection ownership and history do not add another terminal toolbar.
    class ConnectionLifecycleDecorator extends terminal.TerminalDecorator {
        constructor(zone){super();this.zone=zone;}
        attach(tab){
            if(!tab.profile||!['ssh','lightos'].includes(tab.profile.type))return;
            const reconnectCleanup=window.TabbySSHReconnect.install(tab);
            const persistenceCleanup=installPersistentSSH(tab);
            let stopped=false,connectedSession=null;const restorers=[];
            const update=()=>{
                if(stopped)return;
                const connected=!!(tab.session&&tab.session.open);
                tab.__connectionStatus={state:connected?'connected':tab.connectionError?'disconnected':'connecting'};
                if(connected&&connectedSession!==tab.session){
                    connectedSession=tab.session;
                    requestJSON('/api/1/connections/history/',{action:'touch',profile_id:tab.profile.id}).catch(()=>{});
                    if(tab.__persistenceNotice)tab.write('\r\n'+tab.__persistenceNotice+'\r\n');
                }
            };
            for(const name of ['initializeSession','startLightOS','disconnect']){
                if(typeof tab[name]!=='function')continue;
                const original=tab[name];
                tab[name]=async function(...args){try{return await original.apply(this,args);}finally{update();}};
                restorers.push(()=>tab[name]=original);
            }
            if(!tab.disconnect){tab.disconnect=async()=>{if(tab.session)await tab.session.destroy();if(tab.sshSession&&tab.sshSession.open)tab.sshSession.destroy();update();};restorers.push(()=>delete tab.disconnect);}
            this.subscribeUntilDetached(tab,tab.sessionChanged$.subscribe(update));
            const timer=this.zone.runOutsideAngular(()=>setInterval(update,1000));update();
            tab.__lifecycleCleanup=()=>{stopped=true;clearInterval(timer);restorers.reverse().forEach(fn=>fn());persistenceCleanup();reconnectCleanup();};
        }
        detach(tab){if(tab.__lifecycleCleanup)tab.__lifecycleCleanup();super.detach(tab);}
    }
