/* Keep xterm's palette, reported colors and visible background in agreement. */
(function(root){
    const colors=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
    function rgb(value){const m=/^#([\da-f]{6})$/i.exec(value||'');if(m)return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16));const r=/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(value||'');return r&&(!r[4]||Number(r[4])===1)?r.slice(1,4).map(Number):null;}
    function luminance(c){return c.map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
    function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
    function install(tab){
        const frontend=tab.frontend,xterm=frontend&&frontend.xterm;if(!xterm)return ()=>{};
        const host=tab.content.nativeElement,doc=host.ownerDocument,win=doc.defaultView;
        let fingerprint='',disposed=false,backgroundValue={enabled:false};
        const oldStyle={image:host.style.backgroundImage,size:host.style.backgroundSize,position:host.style.backgroundPosition,repeat:host.style.backgroundRepeat};
        let reportedBackground=[23,27,34];
        function apply(){
            if(disposed)return;
            const options=tab.config.store.terminal,scheme=options.colorScheme;
            let background=options.background==='colorScheme'?scheme.background:null;
            if(!rgb(background)){for(let node=host;node;node=node.parentElement){const value=win.getComputedStyle(node).backgroundColor;if(rgb(value)){background=value;break;}}}
            if(!rgb(background))background=rgb(scheme.background)?scheme.background:'#171b22';
            const image=backgroundValue.enabled&&backgroundValue.hasImage&&backgroundValue.url;
            const base=rgb(background);reportedBackground=base;
            if(image){
                const opacity=Math.max(.65,Math.min(.95,Number(backgroundValue.shade)/100));
                host.style.backgroundImage='linear-gradient(rgba('+base.join(',')+','+opacity+'),rgba('+base.join(',')+','+opacity+')),url("'+backgroundValue.url+'")';
                host.style.backgroundSize=backgroundValue.fit==='stretch'?'100% 100%':backgroundValue.fit==='contain'?'contain':'cover';host.style.backgroundPosition='center';host.style.backgroundRepeat='no-repeat';
            }else{host.style.backgroundImage=oldStyle.image;host.style.backgroundSize=oldStyle.size;host.style.backgroundPosition=oldStyle.position;host.style.backgroundRepeat=oldStyle.repeat;}
            let foreground=scheme.foreground||'#d9e0ec';
            const back=rgb(background);
            if(!rgb(foreground)||contrast(rgb(foreground),back)<4.5)foreground=contrast([255,255,255],back)>=contrast([0,0,0],back)?'#ffffff':'#000000';
            const theme={background:image?'rgba('+base.join(',')+',0)':background,foreground,cursor:scheme.cursor||foreground,cursorAccent:scheme.cursorAccent||background,selectionBackground:scheme.selection||'#66778888',selectionForeground:scheme.selectionForeground||undefined};
            colors.forEach((name,i)=>{if(scheme.colors&&scheme.colors[i])theme[name]=scheme.colors[i];});
            const next=JSON.stringify(theme);
            // The shipped frontend still checks the removed _colorManager field.
            // Assign current xterm options directly, including an opaque OSC background.
            if(next!==fingerprint){fingerprint=next;xterm.options.theme=theme;}
            const minimum=Math.max(image?9:4.5,Number(options.minimumContrastRatio)||0);
            if(xterm.options.minimumContrastRatio!==minimum)xterm.options.minimumContrastRatio=minimum;
        }
        const native=frontend.configureColors;
        if(native)frontend.configureColors=function(...args){const result=native.apply(this,args);apply();return result;};
        const refresh=()=>{if(doc.hidden||!tab.hasFocus)return;apply();xterm.refresh(0,xterm.rows-1);};
        win.addEventListener('focus',refresh);doc.addEventListener('visibilitychange',refresh);
        const subscription=tab.focused$&&tab.focused$.subscribe(refresh);
        const backgroundCleanup=root.TabbyTerminalBackground?root.TabbyTerminalBackground.subscribe(value=>{backgroundValue=value;apply();}):()=>{};
        const osc=xterm.parser&&xterm.parser.registerOscHandler(11,data=>{if(data==='?'&&backgroundValue.enabled&&backgroundValue.hasImage){tab.sendInput('\x1b]11;rgb:'+reportedBackground.map(n=>n.toString(16).padStart(2,'0').repeat(2)).join('/')+'\x1b\\');return true;}return false;});
        apply();
        return ()=>{disposed=true;backgroundCleanup();if(osc)osc.dispose();host.style.backgroundImage=oldStyle.image;host.style.backgroundSize=oldStyle.size;host.style.backgroundPosition=oldStyle.position;host.style.backgroundRepeat=oldStyle.repeat;if(native)frontend.configureColors=native;if(subscription)subscription.unsubscribe();win.removeEventListener('focus',refresh);doc.removeEventListener('visibilitychange',refresh);};
    }
    // Batch output independently of Angular and preserve split UTF-8 characters.
    function batch(emit,win,Buffer){
        let queue=[],bytes=0,timer=null,closed=false;const decoder=new TextDecoder();
        function flush(){if(timer!==null){win.clearTimeout(timer);timer=null;}if(!bytes)return;const chunk=Buffer.concat(queue,bytes);queue=[];bytes=0;const text=decoder.decode(chunk,{stream:true});if(text)emit(Buffer.from(text));}
        function push(data){if(closed)return;queue.push(data);bytes+=data.length;if(bytes>=256*1024)flush();else if(timer===null)timer=win.setTimeout(flush,16);}
        return {push,flush,close(){flush();closed=true;if(timer!==null)win.clearTimeout(timer);}};
    }
    root.TabbyTerminalRendering={install,batch,contrast,rgb};
    if(typeof module==='object'&&module.exports)module.exports=root.TabbyTerminalRendering;
})(typeof window==='undefined'?globalThis:window);
