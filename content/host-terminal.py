#!/usr/local/bin/python
"""Host PTY endpoint. Only this service receives host PID and namespace privileges."""
import asyncio
import importlib.util
import os
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import websockets

HERE = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


access = load('terminal_access', 'terminal-access.py')
bridge = load('terminal_bridge', 'lightos-terminal.py')
used = {}
COMMAND = ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '-r', '-w',
           '--', '/bin/sh', '-lc', 'cd / && exec su - root']


class Protocol(bridge.gateway.DiagnosticProtocol):
    async def process_request(self, path, headers):
        await super().process_request(path, headers)
        try:
            if os.environ.get('HOST_TERMINAL_ENABLED') != '1':
                raise ValueError('本机终端未启用')
            ticket = parse_qs(urlsplit(path).query).get('ticket', [''])[0]
            self.user_id = access.consume(ticket, headers.get('Origin'), used)
        except Exception:
            return HTTPStatus.FORBIDDEN, [('Content-Type', 'text/plain; charset=utf-8')], '本机终端授权无效，请重新登录并连接'.encode()


async def terminal(ws, path):
    await bridge.terminal(ws, path, command=COMMAND, user=ws.user_id)


async def serve():
    access.key()
    async with websockets.serve(terminal, '0.0.0.0', 9003, create_protocol=Protocol,
                                max_size=65536, max_queue=8, ping_interval=20, ping_timeout=20):
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(serve())
