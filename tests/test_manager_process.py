"""Production startup regression. Run only in an isolated container with fake lightosctl."""
import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen
import websockets

ROOT = Path(__file__).parents[1]


class ManagerProcessTest(unittest.TestCase):
    def test_real_manager_startup_upload_download_and_cleanup(self):
        if os.environ.get('TABBY_MANAGER_FIXTURE') != '1':
            self.skipTest('requires the isolated Python 3.7 production-image fixture')
        source = os.environ.get('TEST_MANAGER_SOURCE')
        if source:
            command = [sys.executable, '-c', 'import pathlib; p=' + repr(str(ROOT/'content/lightos-manager.py')) + '; exec(compile(pathlib.Path(' + repr(source) + ').read_text(),p,"exec"),{"__name__":"__main__","__file__":p})']
        else:
            command = [sys.executable, str(ROOT/'content/lightos-manager.py')]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, stdout=log, stderr=log)
            try:
                for attempt in range(100):
                    if process.poll() is not None:
                        self.fail('manager exited before serving')
                    try:
                        with urlopen('http://127.0.0.1:9001/health', timeout=.2) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(.05)
                else:
                    self.fail('manager did not start')
                asyncio.run(self.roundtrip())
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                if process.returncode not in (-15, 0):
                    log.seek(0)
                    print(log.read().decode(errors='replace'))

    async def roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory)/'生产启动 文件.bin')
            data = bytes(range(256))*600
            headers = {'X-HC-User-ID': 'test-admin', 'X-HC-User-Role': 'ADMIN'}
            url = 'ws://127.0.0.1:9002/?files=1&name=fixture&owner=test.owner'
            for cycle in range(2):
                async with websockets.connect(url, extra_headers=headers, origin='http://127.0.0.1:9002', max_size=8*1024*1024) as ws:
                    ready = json.loads(await asyncio.wait_for(ws.recv(), 30))
                    self.assertEqual(ready.get('type'), 'files-ready', ready)
                    sequence = 0
                    async def call(action, **fields):
                        nonlocal sequence
                        sequence += 1
                        await ws.send(json.dumps(dict(fields, action=action, id=sequence)))
                        result = json.loads(await asyncio.wait_for(ws.recv(), 10))
                        self.assertEqual(result.get('id'), sequence)
                        self.assertNotIn('error', result)
                        return result
                    await call('upload-start', path=path, size=len(data), overwrite=bool(cycle))
                    for offset in range(0, len(data), 65536):
                        await call('upload-chunk', data=base64.b64encode(data[offset:offset+65536]).decode())
                    await call('upload-finish')
                    self.assertEqual(Path(path).read_bytes(), data)
                    await call('download-start', path=path)
                    output = b''
                    while True:
                        part = await call('download-chunk')
                        output += base64.b64decode(part['data'])
                        if part['eof']:
                            break
                    self.assertEqual(output, data)
                    # The HTTP manager remains responsive while WS owns a subprocess.
                    with urlopen('http://127.0.0.1:9001/health', timeout=1) as response:
                        self.assertEqual(response.status, 200)
                    await call('upload-start', path=str(Path(directory)/'cancelled'), size=100)
                    await call('upload-chunk', data=base64.b64encode(b'partial').decode())
                for attempt in range(40):
                    if not list(Path(directory).glob('.tabby-upload-*')):
                        break
                    await asyncio.sleep(.05)
                self.assertFalse(list(Path(directory).glob('.tabby-upload-*')))
                self.assertFalse((Path(directory)/'cancelled').exists())


if __name__ == '__main__':
    unittest.main()
