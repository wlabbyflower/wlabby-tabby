/* Status messages contain connection diagnostics only, never terminal output history. */
(function(root){
    function explain(text){
        const value=String(text||'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        if(/KEY_EXCHANGE_FAILED|no matching.*algorithm|key exchange failed/i.test(value))return 'SSH 算法协商失败，请检查目标设备的 SSH 版本和算法配置';
        if(/host key.*(?:changed|mismatch|verification failed)|主机密钥.*(?:变化|不匹配)/i.test(value))return '设备主机密钥发生变化，请核实设备身份后再连接';
        if(/心跳超时/i.test(value))return '连接心跳超时，请重新连接';
        if(/authentication failed|all configured authentication|permission denied|incorrect password|认证失败/i.test(value))return '设备认证失败，请检查用户名、密码或密钥';
        if(/connection refused|ECONNREFUSED/i.test(value))return '设备拒绝连接，请检查端口和 SSHD 是否已开启';
        if(/ENOTFOUND|getaddrinfo|name or service not known/i.test(value))return '无法解析设备地址，请检查主机名';
        if(/ETIMEDOUT|timed out|超时/i.test(value))return '连接超时，请检查设备网络和端口';
        if(/gateway|网关/i.test(value))return '连接网关不可用，请检查微服登录状态和应用服务';
        if(/OIDC|登录|403|401/i.test(value))return '登录状态已失效，请重新进行 OIDC 登录';
        if(/实例未运行/i.test(value))return '实例未运行，请先在 LightOS 管理中启动';
        return '连接已中断，可点击重新连接；详细原因见终端提示';
    }
    function exportProfiles(profiles){
        return {format:'tabby-connections',version:1,profiles:profiles.filter(p=>p.type==='ssh'&&!p.isBuiltin&&!p.isTemplate).map(p=>({name:String(p.name||''),group:String(p.group||''),options:{host:String(p.options.host||''),port:Number(p.options.port||22),user:String(p.options.user||''),auth:'password'}}))};
    }
    function importProfiles(value,existing,makeID){
        if(!value||value.format!=='tabby-connections'||value.version!==1||!Array.isArray(value.profiles)||value.profiles.length>500)throw Error('请选择 Tabby 导出的连接文件（最多 500 条）');
        const seen=new Set(existing.filter(p=>p.type==='ssh').map(p=>JSON.stringify([p.options.host,p.options.port||22,p.options.user]))),result=[];
        for(const p of value.profiles){
            const o=p&&p.options;
            if(!o||typeof o.host!=='string'||!o.host||o.host.length>253||/[\s/\\\u0000-\u001f]/.test(o.host)||!Number.isInteger(o.port)||o.port<1||o.port>65535||typeof o.user!=='string'||!o.user||o.user.length>256||/[\u0000-\u001f]/.test(o.user)||typeof p.name!=='string'||p.name.length>256||typeof p.group!=='string'||p.group.length>256)throw Error('连接文件中包含无效的主机、端口、用户名或名称');
            const key=JSON.stringify([o.host,o.port,o.user]);if(seen.has(key))continue;seen.add(key);
            result.push({id:makeID(),type:'ssh',name:p.name||o.user+'@'+o.host,group:p.group,options:{host:o.host,port:o.port,user:o.user,auth:'password'}});
        }
        return result;
    }
    const api={explain,exportProfiles,importProfiles};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyConnectionUI=api;
})(typeof window==='undefined'?globalThis:window);
