"""Real HTTP + WebSocket protocol test; only the SDK token lookup is simulated."""
import asyncio
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen
import websockets

spec=importlib.util.spec_from_file_location('bridge',Path(__file__).parents[1]/'content/lightos-terminal.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
clients=bridge.manager.clients

class TransportTest(unittest.TestCase):
    def test_ticket_sdk_workspace_binary_resize_heartbeat_and_access(self):
        asyncio.run(self.flow())

    def test_existing_lightos_pty_route_still_accepts_websocket_dispatch(self):
        asyncio.run(self.service_flow())

    async def service_flow(self):
        import tempfile
        import os
        with tempfile.TemporaryDirectory() as directory:
            executable=Path(directory)/'lightosctl'
            executable.write_text('#!/bin/sh\nexec /bin/sh\n');executable.chmod(0o755)
            info={'name':'service-test','owner_deploy_id':'test.app','status':'running','username':'root'}
            with patch.object(bridge.manager,'CTL',str(executable)),patch.object(bridge.manager,'call',return_value=[info]):
                server=await websockets.serve(bridge.terminal,'127.0.0.1',0,create_protocol=bridge.Protocol)
                port=server.sockets[0].getsockname()[1]
                try:
                    async with websockets.connect('ws://127.0.0.1:'+str(port)+'/?name=service-test&owner=test.app',extra_headers={'X-HC-User-ID':'alice','X-HC-User-Role':'ADMIN'},origin='http://127.0.0.1:'+str(port)) as ws:
                        await ws.send(b"printf '\nSERVICE_ROUTE_OK\n'\r")
                        output=b''
                        for _ in range(10):
                            message=await asyncio.wait_for(ws.recv(),3)
                            if isinstance(message,bytes):output+=message
                            if b'\r\nSERVICE_ROUTE_OK\r\n' in output:break
                        self.assertIn(b'\r\nSERVICE_ROUTE_OK\r\n',output)
                finally:
                    server.close();await server.wait_closed()

    async def flow(self):
        seen={'tickets':0,'input':[],'resize':[]}
        target_port=[None]
        class HTTP(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,status,value):
                body=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):
                path=urlsplit(self.path).path
                if path=='/api/client-instances':
                    assert self.headers.get('X-HC-User-Ticket')=='synthetic-delegation'
                    self.reply(200,[{'id':'pc-test','name':'Fixture PC','platform':'windows','owner_user_id':'alice','status':'online'}])
                elif path=='/s/terminal/workspace':
                    assert self.headers.get('lzc_dapi_auth_token')=='synthetic-sdk-token'
                    assert parse_qs(urlsplit(self.path).query)['ticket'][0]=='ticket-1'
                    self.reply(200,{'active_tab_id':'tab','tabs':[{'id':'tab','active_pane_id':'pane-test','panes':[{'id':'pane-test'}]}]})
                else:self.reply(404,{})
            def do_POST(self):
                assert self.path=='/api/client-instances/terminal-ticket'
                assert json.loads(self.rfile.read(int(self.headers['Content-Length'])))=={'id':'pc-test'}
                seen['tickets']+=1
                self.reply(200,{'client_instance_id':'pc-test','device_api_url':'http://127.0.0.1:'+str(target_port[0]),'terminal_service_name':'terminal','ticket':'ticket-'+str(seen['tickets'])})
        http=ThreadingHTTPServer(('127.0.0.1',0),HTTP);threading.Thread(target=http.serve_forever,daemon=True).start()
        real_urlopen=urlopen
        def mapped_open(request,**kwargs):
            url=request.full_url
            if url.startswith('http://app.test.lightos.lzcx'):
                url='http://127.0.0.1:'+str(http.server_port)+urlsplit(url).path
            elif '/workspace?' in url:
                url='http://127.0.0.1:'+str(http.server_port)+urlsplit(url).path+'?'+urlsplit(url).query
            return real_urlopen(Request(url,data=request.data,headers=dict(request.header_items()),method=request.get_method()),**kwargs)
        async def device(ws,path):
            assert ws.request_headers.get('lzc_dapi_auth_token')=='synthetic-sdk-token'
            q=parse_qs(urlsplit(path).query);assert q['ticket']==['ticket-2'];assert q['pane']==['pane-test'];assert q['history_replay_mode']==['snapshot'];assert 'checkpoint_protocol' not in q
            await ws.send(json.dumps({'type':'history-replay-start'}));await ws.send(b'CLIENT_REAL_PROTOCOL\r\n$ ')
            async for data in ws:
                if isinstance(data,bytes):seen['input'].append(data);await ws.send(data)
                else:seen['resize'].append(json.loads(data))
        server=await websockets.serve(device,'127.0.0.1',0);target_port[0]=server.sockets[0].getsockname()[1]
        source=await websockets.serve(bridge.terminal,'127.0.0.1',0,create_protocol=bridge.Protocol)
        port=source.sockets[0].getsockname()[1];url='ws://127.0.0.1:'+str(port)+'/?client=pc-test'
        headers={'X-HC-User-ID':'alice','X-HC-User-Role':'ADMIN','X-HC-User-Ticket':'synthetic-delegation'}
        try:
            with patch.object(clients,'admin_info',return_value={'deploy_id':'test.lightos'}),patch.object(clients,'device_auth_token',return_value='synthetic-sdk-token') as token,patch.object(clients,'urlopen',side_effect=mapped_open):
                async with websockets.connect(url,extra_headers=headers,origin='http://127.0.0.1:'+str(port)) as ws:
                    self.assertEqual(json.loads(await ws.recv()),{'type':'ready'})
                    self.assertIn(b'CLIENT_REAL_PROTOCOL',await ws.recv())
                    await ws.send(b'PASTE_ONCE');self.assertEqual(await ws.recv(),b'PASTE_ONCE')
                    await ws.send(json.dumps({'type':'resize','columns':100,'rows':35}))
                    await ws.send(json.dumps({'type':'ping'}));self.assertEqual(json.loads(await ws.recv()),{'type':'pong'})
                    self.assertEqual(seen['input'],[b'PASTE_ONCE'])
                    self.assertEqual(seen['resize'],[{'type':'resize','cols':100,'rows':35}])
                    self.assertEqual(token.call_count,2)
                denied=dict(headers,**{'X-HC-User-Role':'NORMAL'})
                with self.assertRaises(websockets.InvalidStatusCode) as error:
                    async with websockets.connect(url,extra_headers=denied,origin='http://127.0.0.1:'+str(port)):pass
                self.assertEqual(error.exception.status_code,403)
                with self.assertRaises(websockets.InvalidStatusCode):
                    async with websockets.connect(url,extra_headers=headers,origin='http://other.example.test'):pass
                async with websockets.connect(url.replace('pc-test','foreign'),extra_headers=headers,origin='http://127.0.0.1:'+str(port)) as ws:
                    result=json.loads(await ws.recv());self.assertIn('不可访问',result['error']);self.assertNotIn('synthetic-sdk-token',str(result));self.assertEqual(token.call_count,2)
        finally:
            source.close();server.close();await source.wait_closed();await server.wait_closed();http.shutdown();http.server_close()
