"""Real WebSocket disconnect/reattach in the shipped Python 3.7 runtime."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
import websockets

spec = importlib.util.spec_from_file_location('broker', Path(__file__).parents[1]/'content/session-broker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BrokerTests(unittest.TestCase):
    def test_page_close_keeps_task_and_output_and_accounts_are_isolated(self):
        async def test():
            stopped = asyncio.Event()
            starts = []
            async def terminal(ws, path, user):
                starts.append(user)
                await ws.send(json.dumps(dict(type='ready')))
                try:
                    await ws.send(b'ORIGINAL_PROCESS\r\n')
                    await asyncio.sleep(.1)
                    await ws.send(b'OUTPUT_WHILE_PAGE_CLOSED\r\n')
                    async for data in ws:
                        if isinstance(data, bytes):
                            await ws.send(b'ECHO:'+data)
                finally:
                    stopped.set()
            broker = module.Broker(terminal, None)
            async with websockets.serve(broker.handler, '127.0.0.1', 0, create_protocol=module.Protocol) as server:
                port = server.sockets[0].getsockname()[1]
                url = 'ws://127.0.0.1:%s/' % port
                def connect(user='one', admin=True):
                    return websockets.connect(url, origin='http://127.0.0.1:%s'%port,
                        extra_headers={'X-HC-User-ID':user,'X-HC-User-Role':'ADMIN' if admin else 'USER'})
                async def operation(value,user='one',admin=True):
                    async with connect(user,admin) as ws:
                        await ws.send(json.dumps(value))
                        return json.loads(await ws.recv())
                async with connect() as ws:
                    await ws.send(json.dumps(dict(action='create',profile=dict(type='lightos',name='fixture',options=dict(name='fixture')))))
                    first=json.loads(await ws.recv())
                    identifier=first['id']
                    while True:
                        item=json.loads(await ws.recv())
                        if item.get('type')=='output':break
                await asyncio.sleep(.2)
                self.assertFalse(stopped.is_set(), 'closing the page killed the terminal')
                self.assertEqual((await operation(dict(action='list'),user='other'))['items'],[])
                denied=await operation(dict(action='attach',id=identifier),user='other')
                self.assertIn('error',denied)
                self.assertIn('error',await operation(dict(action='attach',id=identifier),admin=False))
                async with connect() as ws:
                    await ws.send(json.dumps(dict(action='attach',id=identifier)))
                    output=[]
                    while True:
                        item=json.loads(await ws.recv())
                        if item['type']=='output':output.append(item['data'])
                        if item['type']=='ready':break
                    import base64
                    tail=b''.join(base64.b64decode(s) for s in output)
                    self.assertIn(b'ORIGINAL_PROCESS',tail)
                    self.assertIn(b'OUTPUT_WHILE_PAGE_CLOSED',tail)
                    await ws.send(b'AFTER_REOPEN')
                    reply=json.loads(await ws.recv())
                    self.assertEqual(base64.b64decode(reply['data']),b'ECHO:AFTER_REOPEN')
                    self.assertEqual(starts,['one'])
                    await ws.send(json.dumps(dict(type='end')))
                await asyncio.wait_for(stopped.wait(),1)
                self.assertEqual((await operation(dict(action='list')))['items'],[])
                self.assertIn('error',await operation(dict(action='create',profile=dict(type='lightos',options=dict(kind='host'))),admin=False))
                # Metadata cannot retain imported passwords, keys or commands.
                profile=broker.profile(dict(type='ssh',password='secret',options=dict(host='example.test',port=22,user='tester',password='secret',privateKeys=['secret'])),False)
                self.assertNotIn('secret',json.dumps(profile))
                session=module.Session(broker,'one',profile,{})
                for _ in range(80):await session.send(b'x'*32768)
                self.assertLessEqual(session.history_bytes,module.MAX_HISTORY)
                self.assertEqual(session.sequence,80)
        loop=asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:loop.run_until_complete(asyncio.wait_for(test(),10))
        finally:loop.run_until_complete(loop.shutdown_asyncgens());loop.close()

if __name__=='__main__':unittest.main()
