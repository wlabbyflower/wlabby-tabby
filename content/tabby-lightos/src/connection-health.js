/* Browser-side application heartbeat: detects stale transports after idle or sleep. */
(function (root) {
    function watch(ws, sendPing, fail, options) {
        const opts=options||{}, interval=opts.interval||15000, timeout=opts.timeout||45000;
        const clock=opts.now||Date.now, schedule=opts.setInterval||setInterval, unschedule=opts.clearInterval||clearInterval;
        const events=opts.events||root; let deadline=0, stopped=false;
        function stop() { if(stopped)return;stopped=true;unschedule(timer); if(events&&events.removeEventListener){events.removeEventListener('pageshow',wake);events.removeEventListener('focus',wake);events.removeEventListener('online',wake);} if(root.document)root.document.removeEventListener('visibilitychange',visible); }
        function tick() {
            if(stopped)return;
            if(ws.readyState!==1){stop();fail('终端连接已断开，请重新连接');return;}
            if(deadline&&clock()>=deadline){stop();fail('终端连接心跳超时，请重新连接');return;}
            if(!deadline){deadline=clock()+timeout;try{sendPing();}catch(_){stop();fail('终端连接已断开，请重新连接');}}
        }
        function wake(){if(stopped)return;deadline=0;tick();}
        function visible(){if(!root.document.hidden)wake();}
        const timer=schedule(tick,interval);
        if(events&&events.addEventListener){events.addEventListener('pageshow',wake);events.addEventListener('focus',wake);events.addEventListener('online',wake);}
        if(root.document)root.document.addEventListener('visibilitychange',visible);
        return {stop, tick, pong:()=>{deadline=0;}};
    }
    if(typeof module==='object'&&module.exports)module.exports={watch};
    root.TabbyConnectionHealth={watch};
})(typeof window==='undefined'?globalThis:window);
