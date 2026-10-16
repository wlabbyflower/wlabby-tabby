#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
version=$(python3 -c 'import re; print(re.search(r"^version: (.+)$", open("package.yml").read(), re.M).group(1))')
output=${1:-tabby-web-${version}.lpk}
if [ -e "$output" ]; then
    echo "Refusing to overwrite existing package: $output" >&2
    exit 1
fi
lzc-cli project release -o "$output"
lzc-cli lpk lint "$output"
python3 scripts/audit-package.py "$output"
sha256sum "$output" > "$output.sha256"
