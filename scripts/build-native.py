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
for name in ('client-auth-token', 'file-worker'):
    output = root / 'content' / name
    output.mkdir(exist_ok=True)
    for arch in ('amd64', 'arm64'):
        target = output / arch
        temporary = output / ('.' + arch + '.building')
        env = dict(os.environ, CGO_ENABLED='0', GOOS='linux', GOARCH=arch)
        subprocess.run([go, 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', str(temporary), '.'], cwd=root/'native'/name, env=env, check=True)
        temporary.chmod(0o755)
        temporary.replace(target)
print('Authorization and file helpers built: linux/amd64 and linux/arm64.')
