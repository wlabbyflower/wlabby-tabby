#!/usr/bin/env python3
"""Build the browser plugin from reviewable source, with no downloaded dependencies."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
base = root / 'content/tabby-lightos'
source, output = base / 'src', base / 'dist'
helpers = ['connection-health.js', 'gateway-defaults.js', 'terminal-actions.js',
           'sidebar-toggle.js', 'credential-storage.js', 'connection-ui.js', 'terminal-scroll.js', 'webshell-entry.js', 'ssh-reconnect.js', 'file-channel.js']
output.mkdir(exist_ok=True)
for name in helpers:
    subprocess.run(['node', '--check', str(source / name)], check=True)
    (output / name).write_text((source / name).read_text())
main = (source / 'main.js').read_text()
for name in ('connection-hub.js', 'file-browser.js', 'connection-status.js'):
    main = main.replace('    // @include ' + name, (source / name).read_text())
(output / 'index.js').write_text(''.join((source / name).read_text() + '\n' for name in helpers) + main)
subprocess.run(['node', '--check', str(output / 'index.js')], check=True)
print('Tabby plugin built and JavaScript syntax checked.')
