import json
from types import SimpleNamespace
import unittest
from django.conf import settings
if not settings.configured:
    settings.configure(DEFAULT_CHARSET='utf-8', ALLOWED_HOSTS=['*'])
from django.http import JsonResponse
from django.test import RequestFactory
from tabby.gateway_defaults import DefaultGatewayMiddleware


class GatewayDefaultsTests(unittest.TestCase):
    def request(self, path, authenticated=True, host='device-a.example.test', **meta):
        request = RequestFactory().get(path, HTTP_HOST=host, **meta)
        request.user = SimpleNamespace(is_authenticated=authenticated)
        return request

    def test_empty_gateway_is_generated_for_each_device_and_slash_variant(self):
        for host in ('device-a.example.test', 'device-b.example.test'):
            for path in ('/api/1/user', '/api/1/user/'):
                request = self.request(path, host=host, HTTP_X_FORWARDED_PROTO='https')
                response = DefaultGatewayMiddleware(lambda _: JsonResponse({'custom_connection_gateway': None}))(request)
                data = json.loads(response.content)
                self.assertEqual(data['custom_connection_gateway'], 'wss://' + host + '/gateway/')
                self.assertEqual(data['custom_connection_gateway_token'], '')

    def test_explicit_custom_gateway_is_preserved(self):
        request = self.request('/api/1/user')
        response = DefaultGatewayMiddleware(lambda _: JsonResponse({'custom_connection_gateway':'wss://custom.example.test/'}))(request)
        self.assertEqual(json.loads(response.content)['custom_connection_gateway'], 'wss://custom.example.test/')

    def test_empty_gateway_pool_has_local_fallback(self):
        request = self.request('/api/1/gateways/choose', HTTP_X_FORWARDED_PROTO='https')
        response = DefaultGatewayMiddleware(lambda _: JsonResponse({}, status=503))(request)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)['url'], 'wss://device-a.example.test/gateway/')

    def test_anonymous_user_does_not_gain_backend_access(self):
        response = DefaultGatewayMiddleware(lambda _: JsonResponse({}, status=503))(self.request('/api/1/gateways/choose', authenticated=False))
        self.assertEqual(response.status_code, 503)
