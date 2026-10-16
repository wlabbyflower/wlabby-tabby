/* Clipboard and terminal actions use user gestures and preserve native paste rules. */
(function(root){
    async function readClipboard(navigator,fallback){
        try{if(navigator.clipboard&&navigator.clipboard.readText)return await navigator.clipboard.readText();}catch(_){}
        return fallback();
    }
    async function writeClipboard(navigator,document,text){
        try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return;}}catch(_){}
        const active=document.activeElement,area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;left:-10000px;top:0';document.body.appendChild(area);area.select();
        try{if(!document.execCommand('copy'))throw Error('Clipboard copy denied');}finally{area.remove();if(active&&active.focus)active.focus();}
    }
    async function pasteText(tab,text,original){
        if(text===null||text===undefined)return;
        const platform=tab.platform,view=Object.create(platform);view.readClipboard=()=>text;
        // Native Tabby reads synchronously before awaiting its multiline confirmation.
        tab.platform=view;let result;
        try{result=original.call(tab);}finally{tab.platform=platform;}
        await result;
        if(tab.frontend)tab.frontend.focus();
    }
    const api={readClipboard,writeClipboard,pasteText};
    if(typeof module==='object'&&module.exports)module.exports=api;
    root.TabbyTerminalActions=api;
})(typeof window==='undefined'?globalThis:window);
