"""Account-scoped terminal ownership independent of a browser WebSocket.

Only live process state and a bounded output tail are kept in memory. No input,
SSH secrets, device tickets or terminal history is written to a file/database.
"""
import asyncio
import base64
from collections import deque
from http import HTTPStatus
import json
import os
from pathlib import Path
import platform
import secrets
import time
from urllib.parse import urlencode, urlsplit
import websockets

MAX_HISTORY = 2 * 1024 * 1024
MAX_USER = 8
MAX_TOTAL = 32


class Session:
    def __init__(self, broker, user, profile, headers):
        self.broker, self.user, self.profile, self.request_headers = broker, user, profile, headers
        self.id = secrets.token_urlsafe(24)
        self.created = time.time()
        self.history, self.history_bytes, self.sequence = deque(), 0, 0
        self.queue = asyncio.Queue(maxsize=32)
        self.peer = None
        self.closed, self.ready, self.error = False, False, None
        self.finished = None
        self.path = '/?' + urlencode({k: v for k, v in profile['options'].items() if k in ('name', 'owner')})
        if profile['options'].get('kind') == 'client':
            self.path = '/?' + urlencode({'client': profile['options']['id']})
        self.task = None

    def metadata(self):
        return dict(id=self.id, profile=self.profile, created=self.created, exited=self.closed)

    async def send(self, data):
        if isinstance(data, bytes):
            # Keep each replay/output packet bounded even if a client sends a huge frame.
            for offset in range(0, len(data), 32768):
                chunk = data[offset:offset + 32768]
                self.sequence += 1
                item = dict(type='output', seq=self.sequence, data=base64.b64encode(chunk).decode())
                self.history.append((len(chunk), item))
                self.history_bytes += len(chunk)
                while self.history_bytes > MAX_HISTORY:
                    self.history_bytes -= self.history.popleft()[0]
                self.publish(item)
        else:
            value = json.loads(data)
            if value.get('error'):
                self.error = value['error']
                self.publish(dict(type='error', error=self.error))
            elif value.get('type') == 'ready':
                self.ready = True
                self.publish(dict(type='ready'))

    def publish(self, item):
        if self.peer is not None:
            ws, queue = self.peer
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                # A slow/hidden page must never block the actual terminal process.
                asyncio.ensure_future(ws.close(1013, 'Reconnect to replay terminal output'))
                self.peer = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.queue.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def close(self, *args):
        self.closed = True

    async def run(self, ssh):
        try:
            kind = self.profile['options'].get('kind')
            if self.profile['type'] == 'ssh':
                await self.broker.ssh(self, ssh)
            elif kind == 'host':
                await self.broker.host(self)
            else:
                # Existing LightOS authorization and lifecycle stay authoritative.
                await self.broker.terminal(self, self.path, user=self.user)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.error = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else '后台终端连接失败，请重新连接'
            self.publish(dict(type='error', error=self.error))
        finally:
            self.closed = True
            self.finished = time.time()
            self.publish(dict(type='exit', error=self.error))


class Broker:
    def __init__(self, terminal, access):
        self.terminal, self.access, self.sessions = terminal, access, {}

    def visible(self, user, admin):
        # Finished sessions are retained for replay, with a bounded retention period.
        for identifier, session in list(self.sessions.items()):
            if session.closed and session.peer is None and time.time() - (session.finished or session.created) > 86400:
                del self.sessions[identifier]
        return [s for s in self.sessions.values() if s.user == user and (admin or s.profile['type'] == 'ssh')]

    def profile(self, value, admin):
        if not isinstance(value, dict) or value.get('type') not in ('lightos', 'ssh'):
            raise ValueError('终端类型无效')
        source = value.get('options') or {}
        if not isinstance(source, dict):
            raise ValueError('终端参数无效')
        if value['type'] == 'ssh':
            options = {k: source.get(k) for k in ('host', 'port', 'user')}
            options['port'] = options['port'] or 22
            if not isinstance(options['host'], str) or not 0 < len(options['host']) <= 253 or not isinstance(options['user'], str) or not 0 < len(options['user']) <= 256 or type(options['port']) is not int or not 1 <= options['port'] <= 65535:
                raise ValueError('SSH 连接参数无效')
        else:
            if not admin:
                raise ValueError('仅管理员可进入本机和 LightOS 终端')
            options = {k: source.get(k, '') for k in ('name', 'owner', 'kind', 'id')}
            if any(not isinstance(v, str) or len(v) > 256 for v in options.values()):
                raise ValueError('实例参数无效')
        return dict(type=value['type'], id=str(value.get('id', ''))[:256], name=str(value.get('name', '终端'))[:256],
                    options=options, disableDynamicTitle=True, behaviorOnSessionEnd='keep')

    async def host(self, session):
        headers = session.request_headers
        origin = headers['Origin']
        ticket = self.access.issue(session.user, urlsplit(origin).netloc)
        url = 'ws://hostterm:9003/?' + urlencode({'ticket': ticket})
        async with websockets.connect(url, origin=origin, max_size=256*1024, ping_interval=20, ping_timeout=20) as remote:
            async def output():
                async for data in remote:
                    await session.send(data)
            async def input_data():
                async for data in session:
                    await remote.send(data)
            await together(output(), input_data())

    async def ssh(self, session, config):
        if not isinstance(config, dict):
            raise ValueError('缺少 SSH 认证信息，请重新连接')
        options = session.profile['options']
        payload = dict(Host=options['host'], Port=options['port'], User=options['user'], Digest=config.get('digest'),
                       Password=config.get('password'), Key=config.get('key', ''), HostAlgorithm=config.get('hostAlgorithm', ''))
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
        if not arch:
            raise ValueError('当前微服架构不支持后台 SSH')
        helper = str(Path(__file__).with_name('ssh-worker') / arch)
        proc = await asyncio.create_subprocess_exec(helper, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.DEVNULL, limit=512*1024)
        try:
            proc.stdin.write(json.dumps(payload).encode() + b'\n')
            await proc.stdin.drain()
            payload.clear()
            config.clear()
            async def output():
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        return
                    message = json.loads(line)
                    if message.get('type') == 'data':
                        await session.send(base64.b64decode(message['data']))
                    else:
                        await session.send(line.decode())
            async def input_data():
                async for data in session:
                    if isinstance(data, bytes):
                        message = dict(type='input', data=base64.b64encode(data).decode())
                    else:
                        message = json.loads(data)
                    proc.stdin.write(json.dumps(message).encode() + b'\n')
                    await proc.stdin.drain()
            await together(output(), input_data())
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), 3)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()

    async def end(self, session):
        self.sessions.pop(session.id, None)
        if session.task and not session.task.done():
            session.task.cancel()
            await asyncio.gather(session.task, return_exceptions=True)

    async def handler(self, ws, path):
        user = ws.request_headers['X-HC-User-ID']
        admin = ws.request_headers.get('X-HC-User-Role') == 'ADMIN'
        session = None
        tasks = []
        try:
            message = json.loads(await asyncio.wait_for(ws.recv(), 15))
            action = message.get('action')
            visible = self.visible(user, admin)
            if action == 'list':
                await ws.send(json.dumps(dict(type='sessions', items=[s.metadata() for s in visible])))
                return
            if action == 'create':
                if len([s for s in visible if not s.closed]) >= MAX_USER or len(self.sessions) >= MAX_TOTAL:
                    raise ValueError('后台会话已达上限，请先关闭不用的终端')
                profile = self.profile(message.get('profile'), admin)
                session = Session(self, user, profile, ws.request_headers)
                self.sessions[session.id] = session
                session.task = asyncio.ensure_future(session.run(message.get('ssh')))
                # Do not retain authentication input in the WebSocket handler.
                message.pop('ssh', None)
            else:
                session = next((s for s in visible if s.id == message.get('id')), None)
                if session is None:
                    raise ValueError('会话已结束或不属于当前账号，请重新连接')
                if action == 'end':
                    await self.end(session)
                    await ws.send(json.dumps(dict(type='ended')))
                    return
                if action != 'attach':
                    raise ValueError('会话操作无效')
            queue = asyncio.Queue(maxsize=64)
            previous = session.peer
            session.peer = (ws, queue)
            history = [item for _, item in session.history]
            await ws.send(json.dumps(dict(type='attached', **session.metadata())))
            if previous:
                await previous[0].close(4001, 'Session opened in another page')
            await ws.send(json.dumps(dict(type='replay-start', truncated=bool(history and history[0]['seq'] > 1))))
            for item in history:
                await ws.send(json.dumps(item))
            await ws.send(json.dumps(dict(type='replay-end')))
            if session.ready:
                await ws.send(json.dumps(dict(type='ready')))
            if session.error:
                await ws.send(json.dumps(dict(type='error', error=session.error)))
            if session.closed:
                await ws.send(json.dumps(dict(type='exit')))
                return

            async def output():
                while True:
                    item = await queue.get()
                    await ws.send(json.dumps(item))
                    if item.get('type') == 'exit':
                        return
            async def input_data():
                async for data in ws:
                    if isinstance(data, str):
                        control = json.loads(data)
                        kind = control.get('type')
                        if kind == 'ping':
                            await ws.send(json.dumps(dict(type='pong')))
                            continue
                        if kind == 'end':
                            await self.end(session)
                            return
                        if kind != 'resize' or type(control.get('columns')) is not int or type(control.get('rows')) is not int or not 1 <= control['columns'] <= 1000 or not 1 <= control['rows'] <= 1000:
                            raise ValueError('终端控制消息无效')
                    await session.queue.put(data)
            await together(output(), input_data())
        except websockets.exceptions.ConnectionClosed:
            pass
        except (ValueError, TypeError, KeyError, asyncio.TimeoutError) as exc:
            if not ws.closed:
                await ws.send(json.dumps(dict(type='error', error=str(exc))))
        finally:
            if session and session.peer and session.peer[0] is ws:
                session.peer = None
            await ws.close()


async def together(*coroutines):
    tasks = [asyncio.ensure_future(c) for c in coroutines]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class Protocol(websockets.WebSocketServerProtocol):
    async def process_request(self, path, headers):
        for name in ('Sec-WebSocket-Key', 'Sec-WebSocket-Version'):
            values = headers.get_all(name)
            if len(values) > 1 and len(set(values)) == 1:
                del headers[name]
                headers[name] = values[0]
        if not headers.get('X-HC-User-ID'):
            return HTTPStatus.FORBIDDEN, [], b'Login required'
        origin = urlsplit(headers.get('Origin', ''))
        if origin.scheme not in ('http', 'https') or origin.netloc != headers.get('Host'):
            return HTTPStatus.FORBIDDEN, [], b'Same-origin session required'
