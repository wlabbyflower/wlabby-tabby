"""Expose the shipped SSH authentication class to our lifecycle adapter only."""
from pathlib import Path
for path in Path('/app-dist').glob('*/tabby-ssh/dist/index.js'):
    value = path.read_text()
    marker = '  "ALGORITHM_BLACKLIST": () =>'
    if '"LazycatSSHTab"' not in value:
        if value.count(marker) != 1 or 'class SSHSession {' not in value or 'let SSHTabComponent = class' not in value:
            print('[patch-ssh] native SSH retained for unsupported upstream version: ' + path.parent.parent.parent.name)
            continue
        if '"LazycatSSHSession"' not in value:
            value = value.replace(marker, '  "LazycatSSHSession": () => SSHSession,\n' + marker, 1)
        value = value.replace(marker, '  "LazycatSSHTab": () => SSHTabComponent,\n' + marker, 1)
        path.write_text(value)
