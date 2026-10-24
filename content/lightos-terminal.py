"""Authenticated WebSocket <-> lightosctl PTY sessions for native Tabby tabs."""
import asyncio
import fcntl
import importlib.util
import json
import os
import re
import signal
import struct
import subprocess
import sys
import termios
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import websockets

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location('lightos_manager', HERE + '/lightos-manager.py')
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
spec = importlib.util.spec_from_file_location('gateway_diagnostics', HERE + '/gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class Protocol(gateway.DiagnosticProtocol):
    async def process_request(self, path, headers):
        await super().process_request(path, headers)
        if headers.get('X-HC-User-Role') != 'ADMIN' or not headers.get('X-HC-User-ID'):
            return HTTPStatus.FORBIDDEN, [('Content-Type', 'text/plain')], '仅管理员可进入 LightOS 终端'.encode()
        origin = headers.get('Origin')
        if origin and urlsplit(origin).netloc != headers.get('Host'):
            return HTTPStatus.FORBIDDEN, [], b'Cross-origin terminal rejected'


spec = importlib.util.spec_from_file_location('file_transport', HERE + '/file-transport.py')
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)

sessions = {}


def qualified_name(info):
    owner = info.get('owner_deploy_id', '')
    if owner and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', owner):
        raise ValueError('实例所属应用标识无效')
    return info['name'] + ('@' + owner if owner else '')


async def terminal(ws, path=None, command=None, user=None):
    path = ws.path if path is None else path
    host_mode = command is not None
    user = user or ws.request_headers['X-HC-User-ID']
    if sessions.get(user, 0) >= 8:
        await ws.send(json.dumps({'error': '最多同时打开 8 个终端'}))
        await ws.close(1008)
        return
    sessions[user] = sessions.get(user, 0) + 1
    proc = None
    master = slave = None
    tasks = []
    loop = asyncio.get_event_loop()
    try:
        if command is None:
            query = parse_qs(urlsplit(path).query)
            if query.get('files') == ['1']:
                if 'client' in query:
                    await files.client_channel(ws, manager.clients, ws.request_headers, query['client'][0])
                else:
                    args, binary = await loop.run_in_executor(None, files.instance_command, manager, query.get('name', [''])[0], query.get('owner', [''])[0])
                    await files.process_channel(ws, args, binary)
                return
            if 'client' in query:
                await manager.clients.terminal(ws, ws.request_headers, query['client'][0])
                return
            name = query.get('name', [''])[0]
            if not manager.NAME.fullmatch(name):
                raise ValueError('实例名无效')
            requested_owner = query.get('owner', [''])[0]
            if requested_owner:
                items = await loop.run_in_executor(None, manager.call, ['ps'])
                info = next((i for i in items if i['name'] == name and i.get('owner_deploy_id') == requested_owner), None)
                if info is None:
                    raise ValueError('实例所属应用已变化，请刷新实例列表')
            else:
                info = await loop.run_in_executor(None, manager.call, ['inspect', name])
            if info.get('status') != 'running':
                raise ValueError('实例未运行，请先在管理界面启动')
            username = info.get('username') or 'root'
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*\$?', username):
                raise ValueError('实例用户名无效')
            shell = 'if [ "$1" = root ]; then exec "${SHELL:-/bin/sh}" -l; else exec su - "$1"; fi'
            command = [manager.CTL, 'exec', '-it', qualified_name(info), '/bin/sh', '-lc', shell, 'lightos-shell', username]
        master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        if host_mode:
            command = [sys.executable, str(Path(__file__).with_name('pty-shell.py'))] + command
        proc = subprocess.Popen(command,
                                stdin=slave, stdout=slave, stderr=slave,
                                start_new_session=True, env=({'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TERM': 'xterm-256color', 'HOME': '/root'} if host_mode else dict(os.environ, TERM='xterm-256color')))
        os.close(slave)
        slave = None
        await ws.send(json.dumps({'type': 'ready'}))

        async def output():
            while True:
                try:
                    data = await loop.run_in_executor(None, os.read, master, 65536)
                except OSError:
                    break
                if not data:
                    break
                await ws.send(data)

        async def input_data():
            async for message in ws:
                if isinstance(message, bytes):
                    # Serialise writes and preserve partial writes for pasted input.
                    view = memoryview(message)
                    while view:
                        size = await loop.run_in_executor(None, os.write, master, view)
                        view = view[size:]
                else:
                    payload = json.loads(message)
                    if payload.get('type') == 'ping':
                        await ws.send(json.dumps({'type': 'pong'}))
                        continue
                    if payload.get('type') != 'resize':
                        raise ValueError('终端控制消息无效')
                    columns, rows = payload.get('columns'), payload.get('rows')
                    if not isinstance(columns, int) or not isinstance(rows, int) or not (1 <= columns <= 1000 and 1 <= rows <= 1000):
                        raise ValueError('终端尺寸无效')
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
                    os.killpg(proc.pid, signal.SIGWINCH)

        tasks = [asyncio.ensure_future(output()), asyncio.ensure_future(input_data())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        if not ws.closed:
            message = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else '终端连接失败，请检查客户端在线状态后重试'
            await ws.send(json.dumps({'error': message}, ensure_ascii=False))
    finally:
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                await loop.run_in_executor(None, lambda: proc.wait(timeout=3))
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    await loop.run_in_executor(None, proc.wait)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for fd in (master, slave):
            if fd is not None:
                os.close(fd)
        sessions[user] -= 1
        if not sessions[user]:
            del sessions[user]
        await ws.close()


async def serve():
    broker = manager.access
    spec = importlib.util.spec_from_file_location('session_broker', Path(__file__).with_name('session-broker.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    owner = module.Broker(terminal, broker)
    async with websockets.serve(owner.handler, '127.0.0.1', 9004, create_protocol=module.Protocol,
                                max_size=512*1024, max_queue=8, ping_interval=20, ping_timeout=20), websockets.serve(terminal, '127.0.0.1', 9002, create_protocol=Protocol,
                                max_size=256*1024, max_queue=8, ping_interval=20, ping_timeout=20):
        await asyncio.Future()


def run():
    asyncio.run(serve())
