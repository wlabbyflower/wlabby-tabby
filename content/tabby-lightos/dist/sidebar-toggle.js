(function(root){
    const key='tabby.ui.sidebarHidden';
    function apply(document,storage){
        let hidden=false;try{hidden=storage.getItem(key)==='true';}catch(_){}
        const node=document.querySelector('.sidebar');
        if(node){node.style.display=hidden?'none':'';if(hidden)node.setAttribute('aria-hidden','true');else node.removeAttribute('aria-hidden');}
        return hidden;
    }
    function updateHandle(document){
        const node=document.querySelector('.sidebar'),button=document.querySelector('.tabby-sidebar-handle');if(!node||!button)return;
        const hidden=node.style.display==='none';
        button.textContent=hidden?'›':'‹';button.title=hidden?'展开左侧栏':'收起左侧栏';button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(!hidden));
        button.style.left=(hidden?0:Math.max(0,node.getBoundingClientRect().right))+'px';
    }
    function toggle(document,storage){
        const node=document.querySelector('.sidebar');if(!node)return false;
        const hidden=node.style.display!=='none';node.style.display=hidden?'none':'';
        if(hidden)node.setAttribute('aria-hidden','true');else node.removeAttribute('aria-hidden');
        try{storage.setItem(key,String(hidden));}catch(_){}
        updateHandle(document);return hidden;
    }
    function installHandle(document,storage){
        if(document.querySelector('.tabby-sidebar-handle'))return;
        const node=document.querySelector('.sidebar');if(!node)return;
        const button=document.createElement('button');button.type='button';button.className='tabby-sidebar-handle';
        button.style.cssText='position:fixed;top:48%;z-index:1000;width:20px;height:52px;border:1px solid #46536a;border-left:0;border-radius:0 7px 7px 0;background:#273346;color:#e5edfa;font:24px system-ui;cursor:pointer;padding:0;';
        button.addEventListener('click',()=>toggle(document,storage));document.body.appendChild(button);updateHandle(document);
        const view=document.defaultView;if(view){view.addEventListener('resize',()=>updateHandle(document));const observer=new view.MutationObserver(()=>updateHandle(document));observer.observe(node,{attributes:true,attributeFilter:['style']});}
    }
    const api={apply,toggle,installHandle,updateHandle};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbySidebar=api;
})(typeof window==='undefined'?globalThis:window);
