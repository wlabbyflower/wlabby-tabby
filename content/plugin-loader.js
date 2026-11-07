/* Isolate load errors and provide a recovery path without third-party plugins. */
(function(){
    const tabby=window.Tabby,load=tabby.loadPlugins.bind(tabby),bootstrap=tabby.bootstrap.bind(tabby);
    const safe=new URL(window.parent.location.href).searchParams.get('plugins')==='off';
    window.__tabbyPluginErrors=[];let loaded=0;
    tabby.loadPlugins=async function(urls,progress){
        const response=await fetch('/api/1/plugins/',{credentials:'same-origin',cache:'no-store'});
        if(!response.ok)throw Error('无法读取当前账号的插件列表');
        const data=await response.json(),names=new Set(data.items.map(p=>p.name));
        const third=urls.filter(u=>names.has(u.split('/').pop())),builtin=urls.filter(u=>!third.includes(u));
        const modules=await load(builtin,progress);
        if(safe)return modules;
        for(const url of third){
            try{
                const info=await tabby.resolvePluginInfo(url);
                const module=await new Promise((resolve,reject)=>{
                    const script=document.createElement('script');window.module={exports:{}};window.exports=window.module.exports;
                    let failure=null;
                    const error=e=>{if(e.filename===new URL(info.url,location.href).href)failure=Error(e.message);};
                    const finish=()=>{clearTimeout(timer);window.removeEventListener('error',error);};
                    window.addEventListener('error',error);
                    const timer=setTimeout(()=>{finish();script.remove();reject(Error('插件加载超时'));},15000);
                    script.onerror=()=>{finish();script.remove();reject(Error('插件文件无法加载'));};
                    script.onload=()=>{finish();if(failure){reject(failure);return;}const value=window.module.exports;if(!value||typeof value.default!=='function'){reject(Error('插件没有提供可用的 Tabby 模块'));return;}resolve(value);};
                    script.src=info.url;document.head.appendChild(script);
                });
                tabby.registerPluginModule(info.name,module);modules.push(module);loaded++;
            }catch(e){window.__tabbyPluginErrors.push({name:url.split('/').pop(),error:e.message});console.warn('Tabby plugin skipped',url,e.message);}
        }
        return modules;
    };
    tabby.bootstrap=async function(...args){
        try{return await bootstrap(...args);}
        catch(e){if(!safe&&loaded){const url=new URL(window.parent.location.href);url.searchParams.set('plugins','off');window.parent.location.replace(url.href);return;}throw e;}
    };
})();
