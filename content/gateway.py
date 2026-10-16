"""Upstream gateway compatibility, bounded I/O and connection lifecycle fixes."""
import asyncio
import json
import logging
import socket
import websockets
from websockets.legacy.server import WebSocketServerProtocol
from tabby_connection_gateway.base import BaseWorker
from tabby_connection_gateway.gateway_server import GatewayWorker
from tabby_connection_gateway.cli import main


class DiagnosticProtocol(WebSocketServerProtocol):
    async def process_request(self, path, headers):
        for name in ('Sec-WebSocket-Key', 'Sec-WebSocket-Version'):
            values = headers.get_all(name)
            if len(values) > 1 and len(set(values)) == 1:
                del headers[name]
                headers[name] = values[0]
                logging.getLogger('gateway.handshake').info('Normalized duplicate %s', name)
        return await super().process_request(path, headers)

    async def handshake(self, *args, **kwargs):
        try:
            return await super().handshake(*args, **kwargs)
        except websockets.exceptions.InvalidHandshake as exc:
            logging.getLogger('gateway.handshake').warning('Handshake rejected: %s: %s', type(exc).__name__, exc)
            raise


async def worker_socket_reader(self):
    sock = self.writer.get_extra_info('socket')
    if sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, value in (('TCP_KEEPIDLE', 60), ('TCP_KEEPINTVL', 15), ('TCP_KEEPCNT', 3)):
            if hasattr(socket, name):
                sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), value)
    while not self.closed:
        data = await self.reader.read(65536)
        if not data:
            return
        await self.websocket.send(data)


async def worker_websocket_reader(self):
    async for data in self.websocket:
        if isinstance(data, str):
            # Control frames never enter the SSH byte stream.
            message = json.loads(data)
            if message.get('_') == 'ping':
                await self.send_service_message({'_': 'pong'})
                continue
            raise ValueError('Unsupported gateway control message')
        self.writer.write(data)
        await self.writer.drain()


async def worker_close(self):
    await BaseWorker.close(self)
    # Upstream sets closed=True and then tests "if not closed", leaking this socket.
    if self.writer:
        self.writer.close()
        if hasattr(self.writer, 'wait_closed'):
            try:
                await asyncio.wait_for(self.writer.wait_closed(), timeout=3)
            except (ConnectionError, asyncio.TimeoutError):
                pass
    await self.websocket.close()


async def worker_wait(self):
    tasks = [t for t in (self._socket_reader, self._websocket_reader) if t]
    try:
        if tasks:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                try:
                    task.result()
                except (ConnectionError, websockets.exceptions.ConnectionClosed):
                    pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.close()


original_serve = websockets.serve


def serve(*args, **kwargs):
    kwargs['create_protocol'] = DiagnosticProtocol
    kwargs.update(ping_interval=15, ping_timeout=30, close_timeout=3)
    return original_serve(*args, **kwargs)


def install_worker_fixes():
    GatewayWorker.socket_reader = worker_socket_reader
    GatewayWorker.websocket_reader = worker_websocket_reader
    GatewayWorker.wait = worker_wait
    GatewayWorker.close = worker_close


if __name__ == '__main__':
    install_worker_fixes()
    websockets.serve = serve
    main()
