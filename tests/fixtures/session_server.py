"""Isolated fixture: host shell runs inside this container's own PID namespace."""
import asyncio
import importlib.util
import os
from pathlib import Path
import websockets
root=Path('/workspace/content')
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,root/file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
host=load('test_host','host-terminal.py')
terminal=load('test_terminal','lightos-terminal.py')
broker=load('test_broker','session-broker.py')
# Host test is explicitly unprivileged; it must not enter the real micro-server.
host.COMMAND=['/bin/sh']
async def run():
    owner=broker.Broker(terminal.terminal,host.access)
    async with websockets.serve(owner.handler,'127.0.0.1',29004,create_protocol=broker.Protocol,max_size=512*1024):
        await host.serve()
asyncio.run(run())
