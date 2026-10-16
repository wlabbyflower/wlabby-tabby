"""Provide same-installation gateway defaults independently of ingress injects."""
import json
from django.http import JsonResponse


def gateway_url(request):
    forwarded = request.META.get('HTTP_X_FORWARDED_PROTO', '').split(',')[0].strip()
    secure = request.is_secure() or forwarded == 'https'
    return ('wss://' if secure else 'ws://') + request.get_host() + '/gateway/'


class DefaultGatewayMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not getattr(getattr(request, 'user', None), 'is_authenticated', False):
            return response
        path = request.path.rstrip('/')
        if path == '/api/1/gateways/choose' and response.status_code == 503:
            return JsonResponse({'url': gateway_url(request), 'auth_token': ''})
        if path == '/api/1/user' and response.status_code == 200:
            try:
                data = json.loads(response.content)
            except (ValueError, TypeError):
                return response
            if isinstance(data, dict) and not data.get('custom_connection_gateway'):
                data['custom_connection_gateway'] = gateway_url(request)
                data['custom_connection_gateway_token'] = ''
                response.content = json.dumps(data).encode()
                response['Content-Length'] = str(len(response.content))
        return response
