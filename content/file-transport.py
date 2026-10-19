"""Private file channels for host namespaces and non-SSH LightOS instances."""
import asyncio
import base64
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import tempfile
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = Path(__file__).parent
CHUNK = 65536
MAX_FILE = 2 * 1024**3


def helper(architecture=None):
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get((architecture or platform.machine()).strip())
    if not arch:
        raise ValueError('当前设备架构不支持文件传输')
    return HERE / 'file-worker' / arch


def instance_command(manager, name, owner):
    if not isinstance(name, str) or not manager.NAME.fullmatch(name):
        raise ValueError('实例名无效')
    items = manager.call(['ps'])
    matches = [i for i in items if i['name'] == name and (not owner or i.get('owner_deploy_id') == owner)]
    if len(matches) != 1 or matches[0].get('status') != 'running':
        raise ValueError('实例不可访问或未运行，请刷新实例列表')
    info = matches[0]
    owner = info.get('owner_deploy_id', '')
    if not owner or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in owner):
        raise ValueError('实例所属应用标识无效')
    target = name + '@' + owner
    architecture = subprocess.run([manager.CTL, 'exec', target, 'uname', '-m'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if architecture.returncode:
        raise RuntimeError('无法读取实例架构，请确认实例运行正常')
    data = helper(architecture.stdout.decode().strip()).read_bytes()
    username = info.get('username') or 'root'
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*\$?', username):
        raise ValueError('实例用户名无效')
    # Fixed script and positional size only; no filesystem path is interpolated.
    script = 'umask 077; d=$(mktemp -d /tmp/tabby-files.XXXXXXXX) || exit 1; trap \'rm -f "$d/worker"; rmdir "$d"\' EXIT; head -c "$1" > "$d/worker" || exit 1; chmod 700 "$d/worker" || exit 1; "$d/worker" --ephemeral'
    args = ['/bin/sh', '-c', script, 'tabby-files', str(len(data))]
    if username != 'root':
        args = ['su', '-', username, '-c', ' '.join(shlex.quote(a) for a in args)]
    return [manager.CTL, 'exec', '-i', target] + args, data


async def process_channel(ws, command, initial=None, host=False):
    process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=8*1024*1024,
                env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'} if host else None)
    tasks = []
    try:
        if initial:
            process.stdin.write(initial)
            await process.stdin.drain()
        ready = await asyncio.wait_for(process.stdout.readline(), 30)
        if not ready or json.loads(ready).get('type') != 'files-ready':
            raise RuntimeError('文件传输服务无法启动，请检查实例临时目录是否可写且允许执行')
        await ws.send(ready.decode())
        async def output():
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                await ws.send(line.decode())
        async def input_data():
            async for message in ws:
                if not isinstance(message, str) or len(message) > 256*1024:
                    raise ValueError('文件请求无效')
                value = json.loads(message)
                if value.get('type') == 'ping':
                    await ws.send(json.dumps({'type': 'pong'}))
                    continue
                process.stdin.write(json.dumps(value, ensure_ascii=True).encode() + b'\n')
                await process.stdin.drain()
        tasks = [asyncio.ensure_future(output()), asyncio.ensure_future(input_data())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if process.returncode is None:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                import signal
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()


class ClientFiles:
    def __init__(self, clients, headers, identifier):
        self.clients, self.headers, self.identifier = clients, headers, identifier
        self.upload = self.download = None
        self.expected = self.written = 0

    def close(self):
        for f in (self.upload, self.download):
            if f:
                f.close()
        self.upload = self.download = None

    def request(self, route, query=None, data=None, headers=None):
        info = self.clients.dial_info(self.headers, self.identifier)
        request = Request(self.clients.device_url(info, route, **(query or {})), data=data,
                          headers=dict({'lzc_dapi_auth_token': info['token']}, **(headers or {})))
        try:
            return urlopen(request, timeout=60, context=self.clients.DEVICE_TLS)
        except HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError('客户端文件授权被拒绝，请重新登录并连接')
            if error.code in (404, 405, 501):
                raise RuntimeError('当前客户端未提供文件传输接口，请更新客户端')
            raise RuntimeError('客户端文件操作失败，请检查路径和文件权限')

    def json(self, route, query=None):
        with self.request(route, query) as response:
            data = response.read(4*1024*1024+1)
            if len(data) > 4*1024*1024:
                raise ValueError('客户端目录过大，请选择其他目录')
            return json.loads(data)

    def execute(self, value):
        action = value.get('action')
        if action == 'list':
            result = self.json('/attachments/files', {'path': value.get('path', '/')})
            if not isinstance(result, dict) or not isinstance(result.get('entries'), list):
                raise ValueError('客户端文件列表格式无效')
            return result
        if action == 'upload-start':
            self.close()
            name = value.get('filename', '')
            if not isinstance(name, str) or not name or len(name) > 255 or any(c in name for c in '\r\n/\\\x00') or name in ('.', '..'):
                raise ValueError('文件名无效')
            size = value.get('size')
            if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_FILE:
                raise ValueError('单文件不能超过 2 GiB')
            self.clients.authorize(self.headers, self.identifier)
            self.upload = tempfile.TemporaryFile()
            self.filename, self.expected, self.written = name, size, 0
            return {}
        if action == 'upload-chunk':
            if not self.upload:
                raise ValueError('上传尚未开始')
            data = base64.b64decode(value.get('data', ''), validate=True)
            if len(data) > CHUNK or self.written+len(data) > self.expected:
                raise ValueError('上传数据大小无效')
            self.upload.write(data)
            self.written += len(data)
            return {'written': self.written}
        if action == 'upload-finish':
            if not self.upload or self.written != self.expected:
                raise ValueError('上传尚未完成')
            boundary = 'tabby-files-' + os.urandom(16).hex()
            prefix = ('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+self.filename.replace('"', '\\"')+'"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
            suffix = ('\r\n--'+boundary+'--\r\n').encode()
            with tempfile.TemporaryFile() as body:
                body.write(prefix)
                self.upload.seek(0)
                import shutil
                shutil.copyfileobj(self.upload, body, CHUNK)
                body.write(suffix)
                size = body.tell()
                body.seek(0)
                with self.request('/attachments', data=body, headers={'Content-Type': 'multipart/form-data; boundary='+boundary, 'Content-Length': str(size)}) as response:
                    result = json.loads(response.read(1024*1024))
            self.close()
            files = result.get('files') or []
            if not files or not isinstance(files[0].get('path'), str):
                raise ValueError('客户端未返回上传保存路径')
            return {'path': files[0]['path']}
        if action == 'download-start':
            self.close()
            path = value.get('path', '')
            items = self.json('/attachments/stat', {'path': path})
            if not items or items[0].get('type') != 'file' or not 0 <= items[0].get('size', -1) <= MAX_FILE:
                raise ValueError('请选择不超过 2 GiB 的普通文件')
            self.download = self.request('/attachments/open', {'path': path})
            self.expected, self.written = items[0]['size'], 0
            return {'size': self.expected, 'name': items[0]['name']}
        if action == 'download-chunk':
            if not self.download:
                raise ValueError('下载尚未开始')
            data = self.download.read(CHUNK)
            self.written += len(data)
            if self.written > MAX_FILE:
                raise ValueError('文件超出大小限制')
            eof = not data
            if eof:
                if self.written != self.expected:
                    raise ValueError('下载期间文件大小发生变化，请重新下载')
                self.close()
            return {'data': base64.b64encode(data).decode(), 'eof': eof}
        if action == 'cancel':
            self.close()
            return {}
        raise ValueError('客户端暂不支持此文件操作')


async def client_channel(ws, clients, headers, identifier):
    loop = asyncio.get_event_loop()
    backend = ClientFiles(clients, headers, identifier)
    try:
        await loop.run_in_executor(None, clients.authorize, headers, identifier)
        await ws.send(json.dumps({'type': 'files-ready', 'path': '/', 'capabilities': {'write': False, 'upload': True, 'staging': True}}))
        async for message in ws:
            if not isinstance(message, str) or len(message) > 256*1024:
                raise ValueError('文件请求无效')
            value = json.loads(message)
            if value.get('type') == 'ping':
                await ws.send(json.dumps({'type': 'pong'}))
                continue
            try:
                result = await loop.run_in_executor(None, backend.execute, value)
            except Exception as exc:
                backend.close()
                result = {'error': str(exc) if isinstance(exc, (ValueError, RuntimeError)) else '客户端文件操作失败，请重试'}
            result['id'] = value.get('id')
            await ws.send(json.dumps(result, ensure_ascii=False))
    finally:
        backend.close()
