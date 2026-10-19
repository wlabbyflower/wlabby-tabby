"""Real file stdio + WebSocket transport; synthetic instance and device only."""
import asyncio
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import websockets

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('files_bridge', ROOT/'content/lightos-terminal.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class FileTests(unittest.TestCase):
    def test_instance_roundtrip_and_authorization(self):
        asyncio.run(self.flow())

    async def flow(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            control = root/'lightosctl'
            control.write_text('#!'+sys.executable+'\nimport os,sys\na=sys.argv[1:]\nif a[-2:]==["uname","-m"]:print("x86_64");sys.exit(0)\nassert a[:2]==["exec","-i"]\nos.execv(a[3],a[3:])\n')
            control.chmod(0o755)
            info={'name':'fixture','owner_deploy_id':'test.owner','status':'running','username':'root'}
            with patch.object(bridge.manager,'CTL',str(control)),patch.object(bridge.manager,'call',return_value=[info]):
                server=await websockets.serve(bridge.terminal,'127.0.0.1',0,create_protocol=bridge.Protocol,max_size=8*1024*1024)
                port=server.sockets[0].getsockname()[1]
                url='ws://127.0.0.1:'+str(port)+'/?files=1&name=fixture&owner=test.owner'
                headers={'X-HC-User-ID':'alice','X-HC-User-Role':'ADMIN'}
                try:
                    with self.assertRaises(websockets.exceptions.InvalidStatusCode):
                        async with websockets.connect(url,extra_headers=dict(headers,**{'X-HC-User-Role':'NORMAL'})):pass
                    async with websockets.connect(url,extra_headers=headers,origin='http://127.0.0.1:'+str(port)) as ws:
                        ready=json.loads(await asyncio.wait_for(ws.recv(),30));self.assertEqual(ready['type'],'files-ready')
                        sequence=0
                        async def call(action,**values):
                            nonlocal sequence
                            sequence+=1
                            await ws.send(json.dumps(dict(values,id=sequence,action=action)))
                            result=json.loads(await asyncio.wait_for(ws.recv(),10));self.assertEqual(result['id'],sequence);self.assertNotIn('error',result);return result
                        content=bytes(range(256))*600
                        path=str(root/"文件 ' ; safe.bin")
                        await call('upload-start',path=path,size=len(content))
                        for offset in range(0,len(content),65536):await call('upload-chunk',data=base64.b64encode(content[offset:offset+65536]).decode())
                        await call('upload-finish');self.assertEqual(Path(path).read_bytes(),content)
                        listing=await call('list',path=folder);self.assertIn(Path(path).name,[i['name'] for i in listing['entries']])
                        await call('download-start',path=path);received=b''
                        while True:
                            chunk=await call('download-chunk');received+=base64.b64decode(chunk['data'])
                            if chunk['eof']:break
                        self.assertEqual(received,content)
                        await call('upload-start',path=str(root/'cancelled'),size=100)
                        await call('upload-chunk',data=base64.b64encode(b'partial').decode())
                    await asyncio.sleep(.1)
                    self.assertFalse(list(root.glob('.tabby-upload-*')),'disconnect must remove partial upload')
                    with patch.object(bridge.files,'instance_command',wraps=bridge.files.instance_command) as command:
                        async with websockets.connect(url.replace('test.owner','foreign'),extra_headers=headers) as ws:
                            self.assertIn('error',json.loads(await ws.recv()))
                        self.assertFalse((root/'cancelled').exists())
                finally:
                    server.close();await server.wait_closed()

    def test_client_file_api_upload_download_and_fresh_auth(self):
        stored={};body_seen=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.assert_auth()
                route=urlsplit(self.path).path
                if route.endswith('/attachments/open'):
                    data=stored['body'];self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
                if route.endswith('/attachments/stat'):result=[{'path':'/fixture.bin','name':'fixture.bin','type':'file','size':len(stored['body'])}]
                else:result={'path':'/','parent':'/','entries':[]}
                data=json.dumps(result).encode();self.send_response(200);self.end_headers();self.wfile.write(data)
            def assert_auth(self):
                assert self.headers.get('lzc_dapi_auth_token')=='synthetic-token'
                assert parse_qs(urlsplit(self.path).query)['ticket']==['synthetic-ticket']
            def do_POST(self):
                self.assert_auth();raw=self.rfile.read(int(self.headers['Content-Length']));body_seen.append(raw)
                payload=raw.split(b'\r\n\r\n',1)[1].rsplit(b'\r\n--',1)[0];stored['body']=payload
                self.send_response(201);self.end_headers();self.wfile.write(b'{"files":[{"path":"/tmp/upload-fixture/fixture.bin"}]}')
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
        clients=bridge.manager.clients
        info={'base':'http://127.0.0.1:'+str(server.server_port)+'/s/terminal','token':'synthetic-token','ticket':'synthetic-ticket'}
        backend=bridge.files.ClientFiles(clients,{'X-HC-User-ID':'alice'},'pc-fixture')
        try:
            with patch.object(clients,'authorize'),patch.object(clients,'dial_info',return_value=info) as authorization:
                self.assertEqual(backend.execute({'action':'list','path':'/'})['entries'],[])
                data=bytes(range(256))*400
                backend.execute({'action':'upload-start','filename':'fixture.bin','size':len(data)})
                for offset in range(0,len(data),65536):backend.execute({'action':'upload-chunk','data':base64.b64encode(data[offset:offset+65536]).decode()})
                self.assertEqual(backend.execute({'action':'upload-finish'})['path'],'/tmp/upload-fixture/fixture.bin')
                self.assertEqual(stored['body'],data)
                backend.execute({'action':'download-start','path':'/fixture.bin'});download=b''
                while True:
                    chunk=backend.execute({'action':'download-chunk'});download+=base64.b64decode(chunk['data'])
                    if chunk['eof']:break
                self.assertEqual(download,data);self.assertGreaterEqual(authorization.call_count,4)
                for action in ('remove','rename','mkdir'):
                    with self.assertRaises(ValueError):backend.execute({'action':action,'path':'/'})
                with patch.object(clients,'dial_info',side_effect=RuntimeError('denied')):
                    with self.assertRaisesRegex(RuntimeError,'denied'):backend.execute({'action':'list','path':'/'})
        finally:backend.close();server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
