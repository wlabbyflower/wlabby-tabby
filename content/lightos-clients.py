"""LightOS client discovery and server-side terminal ticket/device authorization."""
import asyncio
import json
from pathlib import Path
import platform
import ssl
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit, urlencode, quote
from urllib.request import Request, urlopen

FORWARDED = ('Cookie', 'Lzc-Auth-Token', 'Lzc-Api-Auth-Token', 'X-HC-User-Ticket')
# Device API endpoints use mesh device certificates, as in the upstream SDK.
DEVICE_TLS = ssl._create_unverified_context()


def admin_info():
    result = subprocess.run(['/lzcinit/lightosctl', 'system', 'admin-info', '--json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    if result.returncode:
        raise RuntimeError('系统未提供 LightOS 客户端接口，请检查 LightOS 和系统版本')
    info = json.loads(result.stdout)
    deploy_id = info.get('deploy_id', '')
    if not deploy_id or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in deploy_id):
        raise RuntimeError('LightOS 服务标识无效')
    return info


def admin_request(headers, path, body=None):
    info = admin_info()
    request = Request('http://app.' + info['deploy_id'] + '.lzcx' + path,
                      data=json.dumps(body).encode() if body is not None else None)
    for name in FORWARDED:
        value = headers.get(name)
        if value:
            request.add_header(name, value)
    request.add_header('Accept', 'application/json')
    if body is not None:
        request.add_header('Content-Type', 'application/json')
    try:
        with urlopen(request, timeout=15) as response:
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise ValueError('LightOS 响应过大')
            return json.loads(data)
    except HTTPError as error:
        if error.code in (401, 403):
            raise RuntimeError('LightOS 客户端授权被拒绝，请重新登录并确认该实例属于当前账号')
        if error.code in (404, 405, 501):
            raise RuntimeError('当前 LightOS 未提供客户端终端票据接口')
        raise RuntimeError('LightOS 客户端接口暂不可用，请稍后重试')
    except (URLError, OSError):
        raise RuntimeError('无法访问 LightOS，请确认服务已启动并已授权跨应用访问')


def list_clients(headers):
    items = admin_request(headers, '/api/client-instances')
    if not isinstance(items, list):
        raise RuntimeError('LightOS 客户端列表格式不受支持')
    user = headers.get('X-HC-User-ID')
    result = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
            continue
        if item.get('owner_user_id') and item['owner_user_id'] != user:
            continue
        result.append({'id': item['id'], 'name': item.get('name') or 'PC Client',
                       'status': item.get('status') or 'running', 'platform': item.get('platform') or '',
                       'terminal_available': True})
    return result


def authorize(headers, identifier):
    if not isinstance(identifier, str) or not identifier or len(identifier) > 512:
        raise ValueError('客户端实例标识无效')
    item = next((item for item in list_clients(headers) if item['id'] == identifier), None)
    if item is None:
        raise ValueError('客户端实例不可访问，请刷新列表')
    if item['status'] not in ('running', 'online', 'connected'):
        raise ValueError('客户端不在线，请先在该设备上登录并接入 LightOS')
    return item


def device_auth_token(device_url):
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    if not arch:
        raise RuntimeError('当前微服 CPU 架构暂不支持客户端终端')
    executable = Path(__file__).parent / 'client-auth-token' / arch
    try:
        result = subprocess.run([str(executable), device_url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
        if result.returncode:
            raise RuntimeError('无法获取客户端设备授权，请检查应用的系统 API 授权和客户端在线状态')
        value = json.loads(result.stdout).get('token')
        if not isinstance(value, str) or not value or '\r' in value or '\n' in value:
            raise ValueError('empty device token')
        return value
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise RuntimeError('客户端设备授权失败，请重新登录后重试')


def dial_info(headers, identifier):
    authorize(headers, identifier)
    ticket = admin_request(headers, '/api/client-instances/terminal-ticket', {'id': identifier})
    if not isinstance(ticket, dict) or ticket.get('client_instance_id', identifier) != identifier:
        raise RuntimeError('LightOS 返回的客户端终端票据不匹配')
    parsed = urlsplit(ticket.get('device_api_url', ''))
    service = ticket.get('terminal_service_name', '')
    value = ticket.get('ticket', '')
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('客户端设备 API 地址无效')
    if not isinstance(service, str) or not service or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in service):
        raise RuntimeError('客户端终端服务标识无效')
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise RuntimeError('客户端终端票据无效')
    token = device_auth_token(ticket['device_api_url'])
    base = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '/s/' + quote(service, safe=''), '', ''))
    return {'base': base, 'ticket': value, 'token': token}


def device_url(info, path, **query):
    return info['base'] + path + '?' + urlencode(dict(query, ticket=info['ticket']))


def workspace_pane(info):
    request = Request(device_url(info, '/workspace', cols=80, rows=24), headers={'lzc_dapi_auth_token': info['token']})
    try:
        with urlopen(request, timeout=15, context=DEVICE_TLS) as response:
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('workspace too large')
            workspace = json.loads(data)
    except HTTPError as error:
        if error.code in (401, 403):
            raise RuntimeError('客户端终端授权已失效，请重新连接')
        raise RuntimeError('客户端终端服务未就绪，请稍后重新连接')
    except (ValueError, OSError):
        raise RuntimeError('无法读取客户端终端工作区，请确认客户端在线')
    tabs = workspace.get('tabs') or []
    if not isinstance(tabs, list):
        raise RuntimeError('客户端终端工作区格式无效')
    active = next((tab for tab in tabs if tab.get('id') == workspace.get('active_tab_id')), None)
    for tab in ([active] if active else []) + [tab for tab in tabs if tab is not active]:
        panes = tab.get('panes') or []
        pane = next((pane for pane in panes if pane.get('id') == tab.get('active_pane_id') and not pane.get('exited')), None)
        pane = pane or next((pane for pane in panes if not pane.get('exited')), None)
        if pane and isinstance(pane.get('id'), str) and pane['id']:
            return pane['id']
    raise RuntimeError('客户端没有可用的终端窗格，请先在 LightOS 中打开该客户端终端')


async def terminal(ws, headers, identifier):
    import websockets
    loop = asyncio.get_event_loop()
    info = await asyncio.wait_for(loop.run_in_executor(None, dial_info, headers, identifier), 45)
    if ws.closed:
        return
    pane = await asyncio.wait_for(loop.run_in_executor(None, workspace_pane, info), 20)
    if ws.closed:
        return
    # Refresh short-lived tickets before the WebSocket handshake. No token or
    # device address is returned to the browser or persisted in a profile.
    info = await asyncio.wait_for(loop.run_in_executor(None, dial_info, headers, identifier), 45)
    url = device_url(info, '/ws', pane=pane, cols=80, rows=24, history_replay_mode='snapshot')
    url = ('wss:' if url.startswith('https:') else 'ws:') + url.split(':', 1)[1]
    tasks = []
    try:
        async with websockets.connect(url, extra_headers={'lzc_dapi_auth_token': info['token']},
                                      ssl=DEVICE_TLS if url.startswith('wss:') else None,
                                      max_size=4 * 1024 * 1024, max_queue=8, open_timeout=15,
                                      ping_interval=15, ping_timeout=15) as target:
            if ws.closed:
                return
            await ws.send(json.dumps({'type': 'ready'}))

            async def output():
                async for data in target:
                    if isinstance(data, bytes):
                        await ws.send(data)
                    else:
                        message = json.loads(data)
                        if message.get('type') == 'process-exit':
                            await ws.send(json.dumps({'error': message.get('message') or '客户端终端已退出'}, ensure_ascii=False))
                            return
                        if message.get('type') in ('error', 'pane-error'):
                            await ws.send(json.dumps({'error': '客户端终端连接失败，请重新连接'}, ensure_ascii=False))
                            return

            async def input_data():
                async for data in ws:
                    if isinstance(data, bytes):
                        await target.send(data)
                    else:
                        message = json.loads(data)
                        if message.get('type') == 'ping':
                            waiter = await target.ping()
                            await asyncio.wait_for(waiter, 10)
                            await ws.send(json.dumps({'type': 'pong'}))
                        elif message.get('type') == 'resize':
                            cols, rows = message.get('columns'), message.get('rows')
                            if isinstance(cols, bool) or isinstance(rows, bool) or not isinstance(cols, int) or not isinstance(rows, int) or not (1 <= cols <= 1000 and 1 <= rows <= 1000):
                                raise ValueError('终端尺寸无效')
                            await target.send(json.dumps({'type': 'resize', 'cols': cols, 'rows': rows}))
                        else:
                            raise ValueError('终端控制消息无效')

            tasks = [asyncio.ensure_future(output()), asyncio.ensure_future(input_data())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except websockets.InvalidStatusCode as error:
        if error.status_code in (401, 403):
            raise RuntimeError('客户端拒绝终端授权，请重新登录并连接')
        raise RuntimeError('客户端终端服务暂不可用，请稍后重试')
    except (OSError, asyncio.TimeoutError):
        raise RuntimeError('连接客户端超时或网络中断，请确认客户端在线')
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
