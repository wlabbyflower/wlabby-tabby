import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
import json
spec=importlib.util.spec_from_file_location('clients',Path(__file__).parents[1]/'content/lightos-clients.py')
clients=importlib.util.module_from_spec(spec);spec.loader.exec_module(clients)

class ClientTests(unittest.TestCase):
    def test_no_webshell_url_is_required_and_accounts_are_isolated(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps([
            {'id':'pc-a','name':'PC','owner_user_id':'alice','platform':'windows'},
            {'id':'pc-b','owner_user_id':'bob'},
        ]).encode()
        with patch.object(clients,'admin_info',return_value={'deploy_id':'test.lightos'}),patch.object(clients,'urlopen',return_value=response) as fetch:
            result=clients.list_clients({'X-HC-User-ID':'alice','X-HC-User-Ticket':'synthetic-delegation-ticket'})
        self.assertEqual([i['id'] for i in result],['pc-a'])
        self.assertTrue(result[0]['terminal_available'])
        self.assertNotIn('_url',result[0])
        request=fetch.call_args[0][0]
        self.assertEqual(request.full_url,'http://app.test.lightos.lzcx/api/client-instances')
        self.assertIsNone(request.get_header('X-hc-user-id'))
        self.assertEqual(request.get_header('X-hc-user-ticket'),'synthetic-delegation-ticket')

    def test_ticket_and_device_auth_are_required_but_never_in_metadata(self):
        ticket={'client_instance_id':'pc-a','device_api_url':'https://device.example.test:8443','terminal_service_name':'terminal-v1','ticket':'synthetic-ticket'}
        with patch.object(clients,'authorize') as authorize,patch.object(clients,'admin_request',return_value=ticket) as request,patch.object(clients,'device_auth_token',return_value='synthetic-sdk-token') as token:
            info=clients.dial_info({'X-HC-User-ID':'alice'},'pc-a')
        authorize.assert_called_once()
        self.assertEqual(request.call_args[0][1:],('/api/client-instances/terminal-ticket',{'id':'pc-a'}))
        token.assert_called_once_with('https://device.example.test:8443')
        self.assertEqual(info['base'],'https://device.example.test:8443/s/terminal-v1')
        self.assertEqual(info['token'],'synthetic-sdk-token')

    def test_foreign_offline_and_invalid_ticket_never_get_device_auth(self):
        for items in [[],[{'id':'pc-a','status':'offline'}]]:
            with patch.object(clients,'list_clients',return_value=items),patch.object(clients,'device_auth_token') as token:
                with self.assertRaises(ValueError):clients.dial_info({},'pc-a')
                token.assert_not_called()
        for ticket in [{'device_api_url':'javascript:alert(1)'},{'client_instance_id':'other'},{'device_api_url':'https://device.example.test','terminal_service_name':'../escape','ticket':'test'}]:
            with patch.object(clients,'authorize'),patch.object(clients,'admin_request',return_value=ticket),patch.object(clients,'device_auth_token') as token:
                with self.assertRaises(RuntimeError):clients.dial_info({},'pc-a')
                token.assert_not_called()

    def test_workspace_uses_active_live_pane(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'active_tab_id':'tab-b','tabs':[{'id':'tab-a','panes':[{'id':'a'}]},{'id':'tab-b','active_pane_id':'b-live','panes':[{'id':'b-exited','exited':True},{'id':'b-live'}]}]}).encode()
        info={'base':'https://device.example.test/s/terminal','token':'synthetic-sdk-token','ticket':'synthetic-ticket'}
        with patch.object(clients,'urlopen',return_value=response) as request:
            self.assertEqual(clients.workspace_pane(info),'b-live')
        self.assertEqual(request.call_args[0][0].get_header('Lzc_dapi_auth_token'),'synthetic-sdk-token')
