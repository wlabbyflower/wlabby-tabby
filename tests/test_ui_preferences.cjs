const assert=require('node:assert/strict');
const sidebar=require('../content/tabby-lightos/dist/sidebar-toggle.js');
const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
const node={style:{display:''},setAttribute(){},removeAttribute(){}},document={querySelector:selector=>selector==='.sidebar'?node:null};
assert.equal(sidebar.apply(document,storage),false);assert.equal(sidebar.toggle(document,storage),true);assert.equal(node.style.display,'none');node.style.display='';assert.equal(sidebar.apply(document,storage),true);assert.equal(sidebar.toggle(document,storage),false);assert.equal(node.style.display,'');
console.log('Sidebar tests passed: hide, restore and persisted preference.');
