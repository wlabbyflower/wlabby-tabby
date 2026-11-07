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

# The browser plugin loader is available before third-party modules bootstrap.
for path in Path('/app-dist').glob('*/tabby-web-container/dist/preload.js'):
    marker = '/* lazycat-plugin-loader */'
    value = path.read_text()
    if marker in value:
        value = value.split(marker, 1)[0]
    path.write_text(value + '\n' + marker + '\n' + Path(__file__).with_name('plugin-loader.js').read_text())
