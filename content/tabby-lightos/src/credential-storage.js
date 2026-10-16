/* Native keytar shim backed by authenticated, encrypted, per-user persistent storage. */
(function(root){
    async function saveConnectionPassword(keytar,vault,profile,password){
        if(password==='')return;
        const options=profile.options;
        if(vault&&vault.isEnabled()){
            await vault.addSecret({type:'ssh:password',key:{user:options.user,host:options.host,port:options.port},value:password});
        }else{
            await keytar.setPassword('ssh@'+options.host+(options.port?':'+options.port:''),options.user,password);
        }
    }
    function install(keytar,connector,fetch,document){
        async function request(action,service,account,password){
            if(!connector.loginService||!connector.loginService.user){if(action==='read')return null;throw Error('请先完成微服账号 OIDC 登录再保存密码');}
            const cookie=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('XSRF-TOKEN='));
            const headers={'Content-Type':'application/json'};if(cookie)headers['X-XSRF-TOKEN']=decodeURIComponent(cookie.substring('XSRF-TOKEN='.length));
            const response=await fetch('/api/1/credentials/'+action+'/',{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:JSON.stringify({service,account,password})});
            if(!response.ok)throw Error(response.status===403?'登录已失效，请重新登录后保存密码':'凭据存储失败');
            const data=await response.json();return action==='read'?data.password:true;
        }
        keytar.getPassword=(s,a)=>request('read',s,a);
        keytar.setPassword=(s,a,p)=>request('write',s,a,p);
        keytar.deletePassword=(s,a)=>request('delete',s,a);
    }
    const api={install,saveConnectionPassword};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyCredentialStorage=api;
})(typeof window==='undefined'?globalThis:window);
