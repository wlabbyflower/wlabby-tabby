#!/usr/local/bin/python
import json
import os
import platform
import sys
args = sys.argv[1:]
if args == ['--print-status', 'ps']:
    print('__LIGHTOS_STATUS__:200')
    print(json.dumps([{'name':'fixture','owner_deploy_id':'test.owner','status':'running','username':'root'}]))
elif args == ['exec', 'fixture@test.owner', 'uname', '-m']:
    print(platform.machine())
elif args[:3] == ['exec', '-i', 'fixture@test.owner']:
    os.execv(args[3], args[3:])
else:
    sys.exit(2)
