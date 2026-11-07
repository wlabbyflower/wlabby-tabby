const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../content/plugin-loader.js'),'utf8');
async function scenario(query='',failure=false){
 let redirected=null,third=0;const events=new Map(),builtin={default:function Builtin(){}};
 const win={parent:{location:{href:'https://tabby.example.test/'+query,replace:url=>redirected=url}},addEventListener:(type,f)=>events.set(type,f),removeEventListener:type=>events.delete(type)};
 const tabby=win.Tabby={loadPlugins:async urls=>{assert.deepEqual(Array.from(urls),['/dist/tabby-core']);return [builtin];},resolvePluginInfo:async url=>({name:'tabby-fixture',url:url+'/dist/index.js'}),registerPluginModule:()=>third++,bootstrap:async()=>{throw Error('incompatible provider');}};
 const document={createElement:()=>({remove(){}}),head:{appendChild:script=>{if(failure)script.onerror();else{win.module.exports={default:function Plugin(){}};script.onload();}}}};
 vm.runInNewContext(source,{window:win,document,location:{href:'https://tabby.example.test/terminal'},URL,setTimeout,clearTimeout,fetch:async()=>({ok:true,json:async()=>({items:[{name:'tabby-fixture'}]})}),console:{warn(){}}});
 const modules=await tabby.loadPlugins(['/dist/tabby-core','/dist/tabby-fixture']);
 return {win,tabby,modules,get redirected(){return redirected;},third};
}
(async()=>{
 const working=await scenario();assert.equal(working.modules.length,2);assert.equal(working.third,1);await working.tabby.bootstrap();assert.equal(new URL(working.redirected).searchParams.get('plugins'),'off');
 const failed=await scenario('',true);assert.equal(failed.modules.length,1);assert.equal(failed.win.__tabbyPluginErrors.length,1);assert.equal(failed.third,0);
 const safe=await scenario('?plugins=off');assert.equal(safe.modules.length,1);assert.equal(safe.third,0);await assert.rejects(()=>safe.tabby.bootstrap(),/incompatible provider/);assert.equal(safe.redirected,null);
 console.log('Plugin loader passed: successful load, failed bundle skipped, safe-mode exclusion and bootstrap-failure recovery without loops.');
})().catch(e=>{console.error(e);process.exitCode=1});
