const assert=require('node:assert/strict');
const rendering=require('../content/tabby-lightos/src/terminal-rendering.js');
assert.equal(rendering.contrast([0,0,0],[255,255,255]),21);
let timers=[],output=[];const win={setTimeout:f=>{timers.push(f);return timers.length;},clearTimeout:()=>{}};
const batch=rendering.batch(d=>output.push(d),win,Buffer),input=Buffer.from('中文😀\x1b[31m 输入');
for(const byte of input)batch.push(Buffer.from([byte]));assert.equal(output.length,0);batch.flush();assert.equal(Buffer.concat(output).toString(),input.toString());
for(let i=0;i<1000;i++)batch.push(Buffer.from('agent-output\n'));
assert.equal(output.length,1);batch.close();assert.equal(output.length,2);assert.equal(Buffer.concat(output).toString(),input.toString()+'agent-output\n'.repeat(1000));
console.log('Rendering batch passed: split Unicode, ordered ANSI bytes, 1000 packets in one batch, flush on close and contrast calculation.');
