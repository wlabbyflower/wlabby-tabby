#!/usr/bin/env python3
"""Inspect the finished LPK, including nested content and embedded OCI layers."""
import argparse
import gzip
import io
import re
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('package')
parser.add_argument('--forbid', action='append', default=[])
args = parser.parse_args()
patterns = [rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', rb'/(?:home|Users)/[A-Za-z0-9_.-]+',
            rb'\b[A-Za-z0-9][A-Za-z0-9.-]*\.heiyu\.space\b',
            rb'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b']
errors = []
count = 0

def inspect(data, path, depth=0):
    global count
    if depth > 6:
        raise SystemExit('Nested archive exceeds audit depth')
    try:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
    except tarfile.ReadError:
        archive = None
    if archive is not None:
        with archive:
            for member in archive:
                if member.isfile():
                    inspect(archive.extractfile(member).read(), path + ':' + member.name, depth + 1)
        return
    count += 1
    if any(re.search(pattern, data) for pattern in patterns) or any(value.encode() in data for value in args.forbid):
        errors.append(path)
    if path.endswith(('.pyc', '.sqlite', '.db', '.pem', '.key')) or '/__pycache__/' in path:
        errors.append(path)

with open(args.package, 'rb') as handle:
    inspect(handle.read(), 'LPK')
if errors:
    raise SystemExit('Package audit rejected: ' + ', '.join(sorted(set(errors))))
print('Finished LPK audit passed: %s files, nested content and embedded image layers inspected.' % count)
