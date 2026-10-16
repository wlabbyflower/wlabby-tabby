/* Self-hosted installs select their bundled gateway, without a gateway registry. */
(function(root){
    function gatewayURL(location){
        const url=new URL('/gateway/',location.href);
        if(url.protocol!=='https:'&&url.protocol!=='http:')throw Error('Unsupported application URL scheme');
        url.protocol=url.protocol==='https:'?'wss:':'ws:';
        return url.href;
    }
    function install(connector,location){
        if(!connector)return;
        connector.chooseConnectionGateway=async()=>({url:gatewayURL(location),auth_token:''});
    }
    const api={gatewayURL,install};
    if(typeof module==='object'&&module.exports)module.exports=api;
    root.TabbyGatewayDefaults=api;
})(typeof window==='undefined'?globalThis:window);
