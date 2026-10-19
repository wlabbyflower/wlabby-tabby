#!/usr/bin/env python3
"""Fail release builds on machine-specific content or accidentally bundled secrets."""
from pathlib import Path
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
subprocess.run(['python3', str(root/'scripts/build-native.py')], check=True)
subprocess.run(['python3', str(root/'scripts/build-plugin.py')], check=True)
content = root / 'content'
for base in (content, root/'lpk'):
    for directory in base.rglob('__pycache__'):
        shutil.rmtree(directory)
patterns = {
    'private key': r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----',
    'personal home path': r'/(?:home|Users)/[A-Za-z0-9_.-]+',
    'fixed device domain': r'\b[A-Za-z0-9][A-Za-z0-9.-]*\.heiyu\.space\b',
    'private LAN IP': r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b',
}
files = [*(root/'resources').rglob('*'), *content.rglob('*'), root/'package.yml', root/'lzc-manifest.yml', *list((root/'lpk').rglob('*.py'))]
errors = []
for path in files:
    if not path.is_file():
        continue
    if path.suffix in ('.pem', '.key', '.sqlite', '.db', '.pyc') or path.name.startswith('.env'):
        errors.append(str(path.relative_to(root)) + ': unexpected secret/runtime file')
        continue
    if path.parent in (content/'client-auth-token', content/'file-worker'):
        if path.name not in ('amd64', 'arm64') or not path.read_bytes().startswith(b'\x7fELF'):
            errors.append(str(path.relative_to(root)) + ': unexpected native helper')
        text = path.read_bytes().decode('utf-8', 'ignore')
    else:
        text = path.read_text()
    for label, pattern in patterns.items():
        if re.search(pattern, text):
            errors.append(str(path.relative_to(root)) + ': ' + label)
health = content/'tabby-lightos/dist/connection-health.js'
entry = content/'tabby-lightos/dist/index.js'
if not entry.read_text().startswith(health.read_text()):
    errors.append('Plugin heartbeat source is out of sync')
if (content/'tabby-lightos/dist/gateway-defaults.js').read_text() not in entry.read_text():
    errors.append('Plugin gateway defaults source is out of sync')
if (content/'tabby-lightos/dist/terminal-actions.js').read_text() not in entry.read_text():
    errors.append('Plugin terminal actions source is out of sync')
for name in ('sidebar-toggle.js', 'credential-storage.js', 'connection-ui.js', 'terminal-scroll.js', 'webshell-entry.js', 'ssh-reconnect.js', 'file-channel.js'):
    if (content/'tabby-lightos/dist'/name).read_text() not in entry.read_text():
        errors.append('Plugin helper is out of sync: ' + name)
if errors:
    raise SystemExit('\n'.join(errors))
print('Release preflight: no fixed device addresses, personal paths, private keys or runtime databases.')
