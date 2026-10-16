/* LightOS WebShell provider entry: resolve only targets in the fresh visible list. */
(function(root){
    function target(url){
        const q=url.searchParams;
        const value=q.get('target')||q.get('name')||q.get('lightos')||'';
        if(!value)return null;
        if(value.length>512||/[\u0000-\u0020\u007f]/.test(value))throw Error('LightOS 终端目标无效');
        if(value.startsWith('client:')){if(value.length===7)throw Error('客户端实例标识无效');return {kind:'client',id:value.slice(7)};}
        const parts=value.split('@'),owner=parts.length===2?parts[1]:(q.get('owner')||'');
        if(parts.length>2||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(parts[0])||owner&&!/^[a-zA-Z0-9_.-]+$/.test(owner))throw Error('LightOS 实例标识无效');
        return {kind:'instance',name:parts[0],owner};
    }
    async function resolve(value,loadInstances,loadClients){
        if(value.kind==='client'){
            const item=(await loadClients()).find(i=>i.id===value.id);
            if(!item)throw Error('客户端实例不可访问，请返回连接首页刷新列表');
            if(!['running','online','connected'].includes(item.status))throw Error('客户端不在线，请先连接该设备');
            return {kind:'client',item};
        }
        const matches=(await loadInstances()).filter(i=>i.name===value.name&&(!value.owner||i.owner_deploy_id===value.owner));
        if(matches.length!==1)throw Error('LightOS 实例不可访问或标识不唯一，请返回连接首页选择');
        if(matches[0].status!=='running')throw Error('实例未运行，请先在 LightOS 中启动');
        return {kind:'instance',item:matches[0]};
    }
    const api={target,resolve};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyWebShellEntry=api;
})(typeof window==='undefined'?globalThis:window);
