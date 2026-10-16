/* Keep scrollback anchored while output arrives; leave TUI mouse handling to xterm. */
(function(root){
    function passiveInput(data){
        const text=typeof data==='string'?data:data&&data.toString();
        return typeof text==='string'&&/^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+;\d+M|\x1b\[[IO]|\x1b\[[?>]?[\d;]*[Rcn]|\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\))$/.test(text);
    }
    function install(tab){
        const frontend=tab.frontend,xterm=frontend&&frontend.xterm,host=tab.content&&tab.content.nativeElement;
        if(!xterm||!host||!xterm.onWriteParsed||!xterm.registerMarker)return ()=>{};
        const viewport=host.querySelector('.xterm-viewport'),win=host.ownerDocument.defaultView;
        let pinned=true,anchor=null,restoring=false,dragging=false,passive=false,disposed=false,wheelRemainder=0;
        const restorers=[],listeners=[],disposables=[];
        const normal=()=>xterm.buffer.active.type==='normal';
        const discard=()=>{if(anchor)anchor.dispose();anchor=null;};
        function capture(){
            if(disposed||!normal()||restoring)return;
            const b=xterm.buffer.active;
            pinned=b.viewportY>=b.baseY;
            discard();
            if(!pinned)anchor=xterm.registerMarker(b.viewportY-b.baseY-b.cursorY);
        }
        function restore(){
            if(disposed||!normal()||dragging||restoring)return;
            restoring=true;
            try{
                if(pinned)bottom.call(frontend);
                else xterm.scrollToLine(Math.max(0,Math.min(anchor&&!anchor.isDisposed?anchor.line:0,xterm.buffer.active.baseY)));
            }finally{restoring=false;}
        }
        function listen(target,type,fn,options){if(!target)return;target.addEventListener(type,fn,options);listeners.push(()=>target.removeEventListener(type,fn,options));}
        function wrap(object,name,fn){const original=object[name];if(typeof original!=='function')return;const value=fn(original);object[name]=value;restorers.push(()=>{if(object[name]===value)object[name]=original;});}
        const bottom=frontend.scrollToBottom;
        wrap(frontend,'scrollToBottom',original=>function(...args){if(passive)return;const result=original.apply(this,args);capture();return result;});
        for(const name of ['scrollToTop','scrollPages','scrollLines'])wrap(frontend,name,original=>function(...args){const result=original.apply(this,args);capture();return result;});
        wrap(tab,'sendInput',original=>function(data,...args){const previous=passive;passive=passiveInput(data);try{return original.call(this,data,...args);}finally{passive=previous;}});
        // Handle normal scrollback once, before legacy mousewheel and parent scroll handlers.
        // Mouse-reporting applications and alternate-screen TUIs retain xterm's own protocol.
        listen(host,'wheel',event=>{
            if(!normal()||xterm.modes.mouseTrackingMode!=='none'||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!event.deltaY)return;
            event.preventDefault();event.stopImmediatePropagation();
            const height=(viewport&&viewport.clientHeight||host.clientHeight)/Math.max(1,xterm.rows)||16;
            wheelRemainder+=event.deltaMode===1?event.deltaY:event.deltaMode===2?event.deltaY*xterm.rows:event.deltaY/height;
            const lines=Math.trunc(wheelRemainder);wheelRemainder-=lines;
            if(lines){xterm.scrollLines(lines);capture();}
        },{capture:true,passive:false});
        // Scrollbar dragging must not compete with incoming output or auto-follow.
        listen(host,'pointerdown',event=>{
            if(!normal()||event.button!==0||!viewport||event.target!==viewport)return;
            const box=viewport.getBoundingClientRect();
            if(event.clientX<box.right-18)return;
            dragging=true;pinned=false;
        },true);
        const finish=()=>{if(!dragging)return;dragging=false;capture();};
        listen(win,'pointerup',finish,true);listen(win,'pointercancel',finish,true);listen(win,'blur',finish);
        listen(viewport,'scroll',()=>{if(dragging&&!restoring)capture();});
        disposables.push(xterm.onWriteParsed(restore));
        if(typeof frontend.resizeHandler==='function'){
            const original=frontend.resizeHandler;
            win.removeEventListener('resize',original);
            wrap(frontend,'resizeHandler',fn=>function(...args){const result=fn.apply(this,args);restore();return result;});
            win.addEventListener('resize',frontend.resizeHandler);
            restorers.push(()=>{win.removeEventListener('resize',frontend.resizeHandler);win.addEventListener('resize',original);});
        }
        capture();
        return ()=>{disposed=true;discard();disposables.forEach(d=>d.dispose());listeners.reverse().forEach(f=>f());restorers.reverse().forEach(f=>f());};
    }
    const api={install,passiveInput};if(typeof module==='object'&&module.exports)module.exports=api;root.TabbyTerminalScroll=api;
})(typeof window==='undefined'?globalThis:window);
