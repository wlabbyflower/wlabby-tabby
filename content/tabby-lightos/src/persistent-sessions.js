/* Browser lifecycle adapter; account and terminal ownership live on the server. */
(function(root){
    let leaving=false;
    root.addEventListener('beforeunload',()=>{leaving=true;});
    if(root.parent!==root)root.parent.addEventListener('beforeunload',()=>{leaving=true;});
    function socket(){const url=new URL('/sessions/',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';return new WebSocket(url.href);}
    function command(value){return new Promise((resolve,reject)=>{
        const ws=socket(),timer=setTimeout(()=>{ws.close();reject(Error('后台会话服务未响应，请稍后重试'));},15000);
        const stop=()=>clearTimeout(timer);
        ws.onopen=()=>ws.send(JSON.stringify(value));
        ws.onmessage=e=>{const data=JSON.parse(e.data);stop();ws.close();if(data.error)reject(Error(data.error));else resolve(data);};
        ws.onerror=()=>{stop();reject(Error('无法读取后台会话，请确认登录状态'));};
        ws.onclose=()=>{stop();reject(Error('后台会话连接已关闭'));};
    });}
    function installAuthentication(ssh){
        const type=ssh.LazycatSSHSession;if(!type)return null;
        const captured=new WeakMap(),native=type.prototype.handleAuth,verify=type.prototype.verifyHostKey;
        type.prototype.verifyHostKey=function(handshake){this.__persistentHostAlgorithm=handshake.serverHostKey;return verify.call(this,handshake);};
        type.prototype.handleAuth=async function(...args){const auth=await native.apply(this,args);if(auth&&typeof auth==='object')captured.set(this,auth);return auth;};
        return captured;
    }
    root.TabbyPersistentSessions={socket,command,installAuthentication,isLeaving:()=>leaving};
})(window);
