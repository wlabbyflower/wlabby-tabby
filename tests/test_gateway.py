"""Run in the gateway image: Python 3.7 + the exact shipped websockets version."""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
import websockets
from tabby_connection_gateway.gateway_server import GatewayServer

spec = importlib.util.spec_from_file_location('gateway_fixes', Path(__file__).parents[1] / 'content/gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
gateway.install_worker_fixes()


class GatewayTests(unittest.TestCase):
    def run_async(self, fn):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(fn())
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    def test_client_disconnect_closes_tcp_and_ping_never_enters_tcp(self):
        async def test():
            eof = asyncio.Event()
            received = []
            async def echo(reader, writer):
                while True:
                    data = await reader.read(4096)
                    if not data:
                        break
                    received.append(data)
                    writer.write(data)
                    await writer.drain()
                writer.close()
                eof.set()
            tcp = await asyncio.start_server(echo, '127.0.0.1', 0)
            server = GatewayServer(host='127.0.0.1', port=0, disable_auth=True)
            wsserver = await websockets.serve(lambda ws, path: server.handler(ws), '127.0.0.1', 0, close_timeout=.1)
            try:
                async with websockets.connect('ws://127.0.0.1:%s' % wsserver.sockets[0].getsockname()[1]) as ws:
                    self.assertEqual(json.loads(await ws.recv())['_'], 'hello')
                    await ws.send(json.dumps({'_': 'hello'}))
                    self.assertEqual(json.loads(await ws.recv())['_'], 'ready')
                    await ws.send(json.dumps({'_':'connect', 'host':'127.0.0.1', 'port':tcp.sockets[0].getsockname()[1]}))
                    self.assertEqual(json.loads(await ws.recv())['_'], 'connected')
                    for _ in range(3):
                        await ws.send(json.dumps({'_':'ping'}))
                        self.assertEqual(json.loads(await ws.recv())['_'], 'pong')
                    await ws.send(b'after-idle')
                    self.assertEqual(await ws.recv(), b'after-idle')
                await asyncio.wait_for(eof.wait(), 1)
                self.assertEqual(b''.join(received), b'after-idle')
            finally:
                wsserver.close()
                await asyncio.wait_for(wsserver.wait_closed(), 2)
                tcp.close()
                await tcp.wait_closed()
        self.run_async(test)

    def test_remote_eof_closes_websocket(self):
        async def test():
            async def close(reader, writer):
                writer.close()
            tcp = await asyncio.start_server(close, '127.0.0.1', 0)
            server = GatewayServer(host='127.0.0.1', port=0, disable_auth=True)
            wsserver = await websockets.serve(lambda ws,path: server.handler(ws), '127.0.0.1', 0, close_timeout=.1)
            try:
                async with websockets.connect('ws://127.0.0.1:%s' % wsserver.sockets[0].getsockname()[1]) as ws:
                    await ws.recv();await ws.send(json.dumps({'_':'hello'}));await ws.recv()
                    await ws.send(json.dumps({'_':'connect','host':'127.0.0.1','port':tcp.sockets[0].getsockname()[1]}))
                    self.assertEqual(json.loads(await ws.recv())['_'], 'connected')
                    await asyncio.wait_for(ws.wait_closed(), 1)
            finally:
                wsserver.close();await wsserver.wait_closed();tcp.close();await tcp.wait_closed()
        self.run_async(test)

if __name__ == '__main__':
    unittest.main()
