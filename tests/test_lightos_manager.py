import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('manager', Path(__file__).parents[1] / 'content/lightos-manager.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ManagerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = m.ThreadingHTTPServer(('127.0.0.1', 0), m.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:%s' % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, data=None, role='ADMIN', extra=None):
        headers = {'X-HC-User-Role': role, 'X-HC-User-ID': 'test-admin'}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        headers.update(extra or {})
        req = Request(self.url + path, headers=headers, data=json.dumps(data).encode() if data is not None else None)
        try:
            r = urlopen(req)
        except HTTPError as exc:
            r = exc
        with r:
            return r.code, json.loads(r.read())

    def test_admin_only(self):
        with patch.object(m, 'call') as call:
            self.assertEqual(self.request('/api/instances', role='NORMAL')[0], 403)
            call.assert_not_called()

    def test_native_manager_entry_is_dynamic_and_admin_only(self):
        with patch.object(m.clients, 'admin_info', return_value={'base_url': 'https://lightos.example.test/?token=discard-this-value'}) as info:
            self.assertEqual(self.request('/api/admin-info', role='NORMAL')[0], 403)
            info.assert_not_called()
            self.assertEqual(self.request('/api/admin-info'), (200, {'home_url': 'https://lightos.example.test/?view=home'}))
        for value in ('javascript:alert(1)', 'https://user:password@lightos.example.test/', '/relative', 'https://lightos.example.test/\r\n'):
            with patch.object(m.clients, 'admin_info', return_value={'base_url': value}):
                self.assertEqual(self.request('/api/admin-info')[0], 502)

    def test_host_entry_does_not_require_ssh_and_ticket_is_admin_only(self):
        with patch.dict(m.os.environ, {'LAZYCAT_BOX_DOMAIN': '', 'HOST_TERMINAL_SECRET': 'synthetic-terminal-key-for-tests-only'}):
            self.assertEqual(self.request('/api/local-terminal')[0], 200)
            self.assertEqual(self.request('/api/local-terminal', role='NORMAL')[0], 403)
            self.assertEqual(self.request('/api/local-terminal-ticket', {}, role='NORMAL')[0], 403)
            status, data = self.request('/api/local-terminal-ticket', {})
            self.assertEqual(status, 200)
            origin = self.url
            self.assertEqual(m.access.consume(data['ticket'], origin, {}), 'test-admin')

    def test_client_list_and_terminal_are_admin_only(self):
        with patch.object(m.clients, 'list_clients') as call:
            self.assertEqual(self.request('/api/client-instances', role='NORMAL')[0], 403)
            self.assertEqual(self.request('/api/client-terminal', {'id': 'pc'}, role='NORMAL')[0], 403)
            call.assert_not_called()

    def test_local_host_uses_installation_environment(self):
        for domain in ('device-a.example.test', 'device-b.example.test'):
            with patch.dict(m.os.environ, {'LAZYCAT_BOX_DOMAIN': domain}):
                status, data = self.request('/api/local-host')
                self.assertEqual(status, 200)
                self.assertEqual(data, {'host': domain, 'port': 22, 'user': 'root'})
                self.assertNotIn('password', data)

    def test_local_host_requires_administrator(self):
        self.assertEqual(self.request('/api/local-host', role='NORMAL')[0], 403)

    def test_missing_local_host_does_not_fall_back_to_development_device(self):
        with patch.dict(m.os.environ, {'LAZYCAT_BOX_DOMAIN': ''}):
            self.assertEqual(self.request('/api/local-host')[0], 502)

    def test_path_traversal_rejected(self):
        with patch.object(m, 'call') as call:
            self.assertEqual(self.request('/api/stop', {'name': '../demo'})[0], 400)
            call.assert_not_called()

    def test_cross_site_rejected(self):
        with patch.object(m, 'call') as call:
            self.assertEqual(self.request('/api/stop', {'name': 'demo'}, extra={'Sec-Fetch-Site': 'cross-site'})[0], 403)
            call.assert_not_called()

    def test_exec_preserves_arguments_without_shell_interpolation(self):
        with patch.object(m, 'call', side_effect=[{'name': 'demo', 'owner_deploy_id': 'cloud.lazycat.lightos.entry'}, {'stdout': 'ok'}]) as call:
            self.assertEqual(self.request('/api/exec', {'name': 'demo', 'argv': ['printf', 'a; $(id)']})[0], 200)
            self.assertEqual(call.call_args_list[-1].args[0], ['exec', 'demo@cloud.lazycat.lightos.entry', 'printf', 'a; $(id)'])
            self.assertEqual(call.call_args_list[-1].kwargs, {'stream': True})

    def test_invalid_image_rejected(self):
        with patch.object(m, 'call') as call:
            self.assertEqual(self.request('/api/create', {'name': 'demo', 'image': 'alpine:latest'})[0], 400)
            call.assert_not_called()

    def test_create_build_progress_before_status(self):
        result = m.subprocess.CompletedProcess([], 0, b'Docker build: example\nExtract rootfs\n__LIGHTOS_STATUS__:200\n{"ok":true}', b'')
        with patch.object(m.os.path, 'isfile', return_value=True), patch.object(m.subprocess, 'run', return_value=result):
            self.assertEqual(m.call(['create']), {'ok': True})

    def test_status_protocol_error_is_not_success(self):
        result = m.subprocess.CompletedProcess([], 0, b'__LIGHTOS_STATUS__:403\n{"error":"denied"}', b'')
        with patch.object(m.os.path, 'isfile', return_value=True), patch.object(m.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'denied'):
                m.call(['ps'])


if __name__ == '__main__':
    unittest.main()
