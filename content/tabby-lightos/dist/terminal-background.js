/* One account-scoped background snapshot shared by every terminal in this frame. */
(function(root){
    let value={enabled:false,hasImage:false,fit:'cover',shade:75,url:null},pending=null;const listeners=new Set();
    function publish(next){value={...next};for(const fn of listeners)fn(value);return value;}
    async function request(body){
        const headers={};const cookie=root.parent.document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('XSRF-TOKEN='));
        if(cookie)headers['X-XSRF-TOKEN']=decodeURIComponent(cookie.slice(11));
        const multipart=typeof FormData!=='undefined'&&body instanceof FormData;
        if(body&&!multipart)headers['Content-Type']='application/json';
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
        try{
            const response=await fetch('/api/1/background/',{method:body?'POST':'GET',headers,body:body?(multipart?body:JSON.stringify(body)):undefined,credentials:'same-origin',cache:'no-store',signal:controller.signal});
            const data=await response.json();if(!response.ok)throw Error(data.error||'背景设置保存失败，请检查登录状态');return publish(data);
        }finally{clearTimeout(timer);}
    }
    function load(){if(!pending)pending=request().finally(()=>pending=null);return pending;}
    function subscribe(fn){listeners.add(fn);fn(value);load().catch(()=>{});return ()=>listeners.delete(fn);}
    root.TabbyTerminalBackground={get:()=>value,preview:publish,load,request,subscribe};
})(window);
