import base64
import hashlib
import json
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import Credential, ConnectionHistory


def cipher_for(user_id):
    key = hashlib.sha256(('tabby-credentials-v1:' + str(user_id) + ':' + settings.SECRET_KEY).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


class CredentialView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, action):
        if action == 'list':
            # Only identifiers are listed. Never decrypt passwords for this screen.
            response = Response({'items': list(Credential.objects.filter(user=request.user).order_by('service', 'account').values('service', 'account'))})
            response['Cache-Control'] = 'no-store'
            return response
        service, account = request.data.get('service'), request.data.get('account')
        if not isinstance(service, str) or not service.startswith(('ssh@', 'ssh-private-key:')) or len(service) > 512 or not isinstance(account, str) or not account or len(account) > 256:
            return Response({'error': '凭据标识无效'}, status=400)
        fingerprint = hashlib.sha256(json.dumps([service, account], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        query = Credential.objects.filter(user=request.user, fingerprint=fingerprint)
        if action == 'read':
            item = query.first()
            try:
                value = cipher_for(request.user.pk).decrypt(item.ciphertext.encode()).decode() if item else None
            except InvalidToken:
                return Response({'error': '保存的密码无法解密，请在密码管理中删除后重新连接'}, status=409, headers={'Cache-Control': 'no-store'})
            response = Response({'password': value})
        elif action == 'write':
            password = request.data.get('password')
            if not isinstance(password, str) or len(password) > 16384:
                return Response({'error': '密码内容无效'}, status=400)
            encrypted = cipher_for(request.user.pk).encrypt(password.encode()).decode()
            Credential.objects.update_or_create(user=request.user, fingerprint=fingerprint, defaults={'service': service, 'account': account, 'ciphertext': encrypted})
            response = Response({'ok': True})
        elif action == 'delete':
            query.delete()
            response = Response({'ok': True})
        else:
            return Response({'error': '接口不存在'}, status=404)
        response['Cache-Control'] = 'no-store'
        return response


class ConnectionHistoryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        response = Response({'items': list(ConnectionHistory.objects.filter(user=request.user).order_by('-opened_at')[:12].values('profile_id', 'opened_at'))})
        response['Cache-Control'] = 'no-store'
        return response

    def post(self, request):
        if request.data.get('action') == 'clear':
            ConnectionHistory.objects.filter(user=request.user).delete()
        elif request.data.get('action') == 'touch':
            profile_id = request.data.get('profile_id')
            if not isinstance(profile_id, str) or not profile_id or len(profile_id) > 512:
                return Response({'error': '连接标识无效'}, status=400)
            fingerprint = hashlib.sha256(profile_id.encode()).hexdigest()
            ConnectionHistory.objects.update_or_create(user=request.user, fingerprint=fingerprint, defaults={'profile_id': profile_id})
            stale_ids = list(ConnectionHistory.objects.filter(user=request.user).order_by('-opened_at').values_list('id', flat=True)[50:])
            ConnectionHistory.objects.filter(user=request.user, id__in=stale_ids).delete()
        else:
            return Response({'error': '操作无效'}, status=400)
        return Response({'ok': True}, headers={'Cache-Control': 'no-store'})
