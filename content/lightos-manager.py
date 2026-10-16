#!/usr/local/bin/python
"""Admin-only LightOS bridge. Authentication is supplied by micro-server ingress."""
import json
import os
import re
import subprocess
import threading
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CTL = '/lzcinit/lightosctl'
NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$')
ROOT = '/lzcapp/var/lightos'
spec_access = importlib.util.spec_from_file_location('terminal_access', Path(__file__).with_name('terminal-access.py'))
access = importlib.util.module_from_spec(spec_access)
spec_access.loader.exec_module(access)
spec_clients = importlib.util.spec_from_file_location('lightos_clients', Path(__file__).with_name('lightos-clients.py'))
clients = importlib.util.module_from_spec(spec_clients)
spec_clients.loader.exec_module(clients)


def call(args, stream=False):
    if not os.path.isfile(CTL):
        raise RuntimeError('lightosctl 未注入，请确认已授权 lightos.manage 且系统支持 LightOS')
    command = [CTL] + ([] if stream else ['--print-status']) + args
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=180 if args[0] == 'create' else 45)
    output = result.stdout.decode('utf-8', 'replace')
    status = 200
    if not stream:
        # create --rootfs-source-image prints Docker build progress before status.
        match = re.search(r'^__LIGHTOS_STATUS__:(\d+)\r?$', output, re.MULTILINE)
        if not match:
            raise RuntimeError(result.stderr.decode('utf-8', 'replace') or 'lightosctl 响应缺少状态码')
        status = int(match.group(1))
        output = output[match.end():].lstrip('\r\n')
    if result.returncode or status >= 400:
        raise RuntimeError(output or result.stderr.decode('utf-8', 'replace') or 'LightOS 操作失败')
    if stream:
        return {'stdout': output, 'stderr': result.stderr.decode('utf-8', 'replace')}
    return json.loads(output) if output.strip() else {'ok': True}


class Handler(BaseHTTPRequestHandler):
    def send(self, status, value, html=False):
        data = value if html else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def admin(self):
        # Never accept direct requests with no identity; ingress overwrites these headers.
        if self.headers.get('X-HC-User-Role') != 'ADMIN' or not self.headers.get('X-HC-User-ID'):
            self.send(403, {'error': '仅微服管理员可管理 LightOS'})
            return False
        return True

    def do_GET(self):
        if self.path == '/health':
            self.send(200, {'ok': True, 'lightos_available': os.path.isfile(CTL)})
            return
        if not self.admin():
            return
        if self.path in ('/', '/index.html'):
            self.send(200, Path(__file__).with_name('lightos.html').read_bytes(), html=True)
            return
        try:
            if self.path == '/api/admin-info':
                self.send(200, {'home_url': clients.admin_home()})
            elif self.path == '/api/local-terminal':
                self.send(200, {'mode': 'host-terminal', 'user': 'root'})
            elif self.path == '/api/local-host':
                host = os.environ.get('LAZYCAT_BOX_DOMAIN', '').strip().rstrip('.')
                if not host or not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host):
                    raise RuntimeError('系统未提供有效的当前微服域名，无法创建本机 SSH 连接')
                self.send(200, {'host': host, 'port': 22, 'user': 'root'})
            elif self.path == '/api/client-instances':
                self.send(200, [{k: v for k, v in item.items() if k != '_url'} for item in clients.list_clients(self.headers)])
            elif self.path == '/api/instances':
                self.send(200, call(['ps']))
            elif self.path == '/api/capabilities':
                self.send(200, call(['capabilities']))
            elif self.path == '/api/security-levels':
                self.send(200, call(['security-levels']))
            else:
                self.send(404, {'error': '接口不存在'})
        except Exception as exc:
            self.send(502, {'error': str(exc)})

    def do_POST(self):
        if not self.admin():
            return
        # Require JSON + browser Fetch Metadata to prevent cross-site form submissions.
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none'):
            self.send(403, {'error': '拒绝跨站请求'})
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send(415, {'error': '需要 application/json'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536:
                raise ValueError('请求体大小无效')
            body = json.loads(self.rfile.read(size))
            if self.path == '/api/client-terminal':
                identifier = body.get('id')
                if not isinstance(identifier, str) or not identifier or len(identifier) > 512:
                    raise ValueError('客户端实例标识无效')
                clients.authorize(self.headers, identifier)
                self.send(200, {'mode': 'native-client'})
                return
            if self.path == '/api/local-terminal-ticket':
                ticket = access.issue(self.headers['X-HC-User-ID'], self.headers.get('Host', ''))
                self.send(200, {'ticket': ticket})
                return
            name = body.get('name', '')
            if not isinstance(name, str) or not NAME.fullmatch(name):
                raise ValueError('实例名仅允许字母、数字、点、下划线和短横线，最长 63 字符')
            action = self.path[5:]
            if self.path != '/api/' + action:
                raise ValueError('接口不存在')
            if action == 'create':
                image = body.get('image', '')
                if not isinstance(image, str) or not image.startswith('registry.lazycat.cloud/') or not re.search(r'[:@][^/]+$', image):
                    raise ValueError('请输入带版本或摘要的 registry.lazycat.cloud 镜像地址')
                level = body.get('security_level', 'sandbox')
                network = body.get('network', 'nat')
                caps = call(['capabilities'])
                if level not in caps.get('allowed_security_levels', []):
                    raise ValueError('当前权限不允许此安全级别')
                if network not in caps.get('network_modes', []):
                    raise ValueError('当前权限不允许此网络模式')
                rootfs = ROOT + '/' + name
                os.makedirs(ROOT, exist_ok=True)
                args = ['create', '--name', name, '--rootfs', rootfs, '--rootfs-source-image', image,
                        '--security-level', level, '--network', network]
            elif action in ('start', 'stop', 'rm', 'inspect'):
                args = [action, name]
            elif action == 'exec':
                argv = body.get('argv')
                if not isinstance(argv, list) or not argv or not all(isinstance(v, str) and '\x00' not in v for v in argv):
                    raise ValueError('argv 必须是非空字符串数组')
                info = call(['inspect', name])
                owner = info.get('owner_deploy_id', '')
                selector = name + ('@' + owner if owner else '')
                self.send(200, call(['exec', selector] + argv, stream=True))
                return
            else:
                raise ValueError('不支持的操作')
            self.send(200, call(args))
        except (ValueError, TypeError) as exc:
            self.send(400, {'error': str(exc)})
        except Exception as exc:
            self.send(502, {'error': str(exc)})


if __name__ == '__main__':
    spec = importlib.util.spec_from_file_location('lightos_terminal', Path(__file__).with_name('lightos-terminal.py'))
    terminal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terminal)
    threading.Thread(target=terminal.run, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', 9001), Handler).serve_forever()
