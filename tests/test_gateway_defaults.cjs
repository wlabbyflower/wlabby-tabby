const assert=require('node:assert/strict');
const {gatewayURL,install}=require('../content/tabby-lightos/dist/gateway-defaults.js');
(async()=>{
 assert.equal(gatewayURL({href:'https://tabby.device-a.example.test/terminal?x=1'}),'wss://tabby.device-a.example.test/gateway/');
 assert.equal(gatewayURL({href:'https://tabby.device-b.example.test/'}),'wss://tabby.device-b.example.test/gateway/');
 assert.equal(gatewayURL({href:'http://localhost:28081/terminal'}),'ws://localhost:28081/gateway/');
 const connector={chooseConnectionGateway:()=>{throw Error('Empty upstream gateway pool must not be used')}};
 const location={href:'https://tabby.device-a.example.test/'};install(connector,location);
 assert.deepEqual(await connector.chooseConnectionGateway(),{url:'wss://tabby.device-a.example.test/gateway/',auth_token:''});
 location.href='https://tabby.device-b.example.test/';assert.equal((await connector.chooseConnectionGateway()).url,'wss://tabby.device-b.example.test/gateway/');
 console.log('Gateway default tests passed: empty pool bypass, per-installation origin, HTTPS/HTTP and ports.');
})().catch(e=>{console.error(e);process.exitCode=1});
