/* Reconnect a tab with a fresh transport, without closing other shared tabs. */
(function(root){
    function live(session){const ws=session&&session.ssh&&session.ssh._sock&&session.ssh._sock.socket&&session.ssh._sock.socket.webSocket;return !!((!ws||ws.readyState===1)&&session&&session.open&&!session.__tabbyClosing&&!(session.willDestroy$&&session.willDestroy$.isStopped)&&!(session.ssh&&session.ssh._sock&&session.ssh._sock.destroyed));}
    function protect(session){
        if(!session||session.__tabbyDestroyProtected)return;
        session.__tabbyDestroyProtected=true;
        const destroy=session.destroy;
        session.destroy=function(...args){if(this.__tabbyClosing)return;this.__tabbyClosing=true;this.open=false;return destroy.apply(this,args);};
        // The browser net shim completes its data observable on close, but never
        // emits stream EOF/close. Explicitly close SSH and all child channels.
        const socket=session.ssh&&session.ssh._sock&&session.ssh._sock.socket;
        if(socket&&socket.close$)socket.close$.subscribe(()=>session.destroy());
        if(socket&&socket.webSocket&&socket.webSocket.readyState>1)session.destroy();
    }
    function protectMultiplexer(mux){
        if(mux.__tabbyReconnectFixed)return;mux.__tabbyReconnectFixed=true;
        const get=mux.getSession;
        mux.getSession=async function(profile){const session=await get.call(this,profile);return live(session)?session:null;};
        mux.addSession=async function(session){
            protect(session);const key=await this.getMultiplexerKey(session.profile);
            if(!live(session))return;
            this.sessions.set(key,session);
            session.willDestroy$.subscribe(()=>{if(this.sessions.get(key)===session)this.sessions.delete(key);});
        };
    }
    function install(tab){
        if(!tab.profile||tab.profile.type!=='ssh'||!tab.sshMultiplexer)return ()=>{};
        protectMultiplexer(tab.sshMultiplexer);
        const originals={setupOneSession:tab.setupOneSession,initializeSession:tab.initializeSession,reconnect:tab.reconnect,disconnect:tab.disconnect};
        let fresh=false,depth=0,initializing=null,reconnecting=null,disposed=false;
        tab.setupOneSession=async function(injector,profile,...args){
            let selected=profile;
            if(fresh&&depth===0){
                selected=Object.create(profile);
                const options=Object.create(profile.options);Object.defineProperty(options,'reuseSession',{value:false,enumerable:true});
                Object.defineProperty(selected,'options',{value:options,enumerable:true});
            }
            depth++;
            try{const session=await originals.setupOneSession.call(this,injector,selected,...args);protect(session);if(disposed){await session.destroy();throw Error('终端已关闭');}if(!live(session))throw Error('SSH 连接未建立，请检查终端中的认证或网关提示');return session;}
            finally{depth--;}
        };
        tab.initializeSession=function(...args){
            if(initializing)return initializing;
            initializing=Promise.resolve().then(()=>originals.initializeSession.apply(this,args)).catch(e=>{this.connectionError=e.message;this.write('\r\nSSH: '+e.message+'\r\n');}).finally(()=>{initializing=null;});
            return initializing;
        };
        const disconnect=async function(){
            this.reconnectOffered=false;this.recentInputs='';this.sftpPanelVisible=false;
            const shell=this.session;
            this.setSession(null);
            this.sshSession=null;
            if(shell&&!shell.__tabbyClosed){shell.__tabbyClosed=true;await shell.destroy();}
        };
        tab.disconnect=disconnect;
        tab.reconnect=function(){
            if(reconnecting)return reconnecting;
            reconnecting=(async()=>{
                if(initializing)await initializing;
                if(disposed)return;
                await this.disconnect();this.connectionError=null;fresh=true;
                try{await this.initializeSession();if(disposed){await disconnect.call(this);return;}if(this.session){this.session.releaseInitialDataBuffer();this.session.resize(this.size.columns,this.size.rows);}if(this.frontend)this.frontend.focus();}
                finally{fresh=false;}
            })().finally(()=>{reconnecting=null;});
            return reconnecting;
        };
        return ()=>{disposed=true;for(const [name,value] of Object.entries(originals)){if(value)tab[name]=value;else delete tab[name];}};
    }
    const api={install,live,protectMultiplexer};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbySSHReconnect=api;
})(typeof window==='undefined'?globalThis:window);
