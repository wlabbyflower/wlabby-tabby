"""Short-lived, single-use capabilities for the isolated host terminal service."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from urllib.parse import urlsplit


def key():
    value = os.environ.get('HOST_TERMINAL_SECRET', '')
    if len(value) < 32:
        raise ValueError('本机终端授权密钥未配置')
    return value.encode()


def issue(user, host, now=None):
    payload = {'user': user, 'host': host, 'expires': int(time.time() if now is None else now) + 45,
               'nonce': secrets.token_hex(24)}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode().rstrip('=')
    signature = hmac.new(key(), body.encode(), hashlib.sha256).hexdigest()
    return body + '.' + signature


def consume(ticket, origin, used, now=None):
    now = time.time() if now is None else now
    if not isinstance(ticket, str) or len(ticket) > 4096:
        raise ValueError('本机终端授权无效，请重新连接')
    body, signature = ticket.rsplit('.', 1)
    expected = hmac.new(key(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError('本机终端授权无效，请重新连接')
    payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    if not isinstance(payload['expires'], int) or not 0 < payload['expires'] - now <= 45:
        raise ValueError('本机终端授权已过期，请重新连接')
    parsed = urlsplit(origin or '')
    if parsed.scheme not in ('http', 'https') or parsed.netloc != payload['host']:
        raise ValueError('拒绝跨站终端连接')
    if not isinstance(payload['user'], str) or not payload['user']:
        raise ValueError('本机终端授权缺少账号')
    for nonce, expiry in list(used.items()):
        if expiry <= now:
            del used[nonce]
    nonce = payload['nonce']
    if nonce in used or len(used) >= 1024:
        raise ValueError('本机终端授权已使用，请重新连接')
    used[nonce] = payload['expires']
    return payload['user']
