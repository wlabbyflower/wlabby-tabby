const assert=require('node:assert/strict');
const a=require('../content/tabby-lightos/dist/terminal-actions.js');
(async()=>{
 assert.equal(await a.readClipboard({clipboard:{readText:async()=>'native text'}},()=>{throw Error('fallback')}),'native text');
 assert.equal(await a.readClipboard({clipboard:{readText:async()=>{throw Error('denied')}}},async()=>'manual text'),'manual text');
 let written='';await a.writeClipboard({clipboard:{writeText:async s=>written=s}},null,'copy text');assert.equal(written,'copy text');
 const platform={readClipboard:()=>''};let pasted='',focused=false;const tab={platform,frontend:{focus:()=>focused=true}};
 await a.pasteText(tab,'a\nb',function(){pasted=this.platform.readClipboard();return Promise.resolve();});assert.equal(pasted,'a\nb');assert.equal(tab.platform,platform);assert.equal(focused,true);
 await a.pasteText(tab,null,()=>{throw Error('cancelled paste must do nothing')});
 try{await a.pasteText(tab,'text',()=>{throw Error('native error')})}catch(_){}
 assert.equal(tab.platform,platform);
 console.log('Clipboard tests passed: native APIs, denied-permission fallback, native paste rules, cancellation and state restoration.');
})().catch(e=>{console.error(e);process.exitCode=1});
