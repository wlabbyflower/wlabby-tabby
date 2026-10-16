#!/usr/bin/env python3
"""Build deterministic Linux SDK helpers for both supported micro-server CPUs."""
import os
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
go = os.environ.get('TABBY_GO') or shutil.which('go')
if not go:
    raise SystemExit('Go 1.24.6+ is required; set TABBY_GO to its executable path.')
output = root / 'content/client-auth-token'
output.mkdir(exist_ok=True)
for arch in ('amd64', 'arm64'):
    target = output / arch
    temporary = output / ('.' + arch + '.building')
    env = dict(os.environ, CGO_ENABLED='0', GOOS='linux', GOARCH=arch)
    subprocess.run([go, 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', str(temporary), '.'], cwd=root/'native/client-auth-token', env=env, check=True)
    temporary.chmod(0o755)
    temporary.replace(target)
print('Client SDK authorization helpers built: linux/amd64 and linux/arm64.')
