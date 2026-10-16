from cryptography.fernet import InvalidToken
from django.contrib.auth import get_user_model
from django.test import Client
from rest_framework.test import APITestCase
from tabby.lpk_support.models import Credential
from tabby.lpk_support.views import cipher_for

class CredentialTests(APITestCase):
    def setUp(self):
        self.alice = get_user_model().objects.create_user(username='test-alice')
        self.bob = get_user_model().objects.create_user(username='test-bob')
        self.client.force_authenticate(self.alice)
        self.key = {'service':'ssh@device.example.test:22','account':'root'}

    def post(self, action, **values):
        return self.client.post('/api/1/credentials/' + action + '/', {**self.key, **values}, format='json')

    def test_password_is_encrypted_at_rest_and_scoped_to_user(self):
        secret = 'synthetic-test-password'
        self.assertEqual(self.post('write', password=secret).status_code, 200)
        item = Credential.objects.get()
        self.assertNotIn(secret, item.ciphertext)
        self.assertEqual(cipher_for(self.alice.pk).decrypt(item.ciphertext.encode()).decode(), secret)
        with self.assertRaises(InvalidToken):
            cipher_for(self.bob.pk).decrypt(item.ciphertext.encode())
        self.assertEqual(self.post('read').data['password'], secret)
        self.client.force_authenticate(self.bob)
        self.assertIsNone(self.post('read').data['password'])
        self.post('delete')
        self.assertEqual(Credential.objects.count(), 1)

    def test_update_delete_and_missing_password(self):
        self.assertIsNone(self.post('read').data['password'])
        self.post('write', password='first')
        self.post('write', password='second')
        self.assertEqual(Credential.objects.count(), 1)
        self.assertEqual(self.post('read').data['password'], 'second')
        self.assertEqual(self.post('delete').status_code, 200)
        self.assertIsNone(self.post('read').data['password'])

    def test_unauthenticated_requests_are_rejected(self):
        self.client.force_authenticate(None)
        self.assertIn(self.post('read').status_code, (401,403))

    def test_session_authentication_requires_csrf(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.alice, backend='django.contrib.auth.backends.ModelBackend')
        self.assertEqual(client.post('/api/1/credentials/write/', {**self.key, 'password':'not-saved'}).status_code, 403)
        self.assertEqual(Credential.objects.count(), 0)

    def test_username_case_does_not_overwrite_another_credential(self):
        self.post('write', password='lower')
        self.key['account'] = 'Root'
        self.post('write', password='upper')
        self.assertEqual(Credential.objects.count(), 2)
        self.assertEqual(self.post('read').data['password'], 'upper')

    def test_list_is_metadata_only_and_isolated(self):
        self.post('write', password='never-return-this-secret-in-list')
        data = self.client.post('/api/1/credentials/list/', {}, format='json')
        self.assertEqual(data.data, {'items': [self.key]})
        self.assertEqual(data['Cache-Control'], 'no-store')
        self.client.force_authenticate(self.bob)
        self.assertEqual(self.client.post('/api/1/credentials/list/', {}, format='json').data, {'items': []})

    def test_corrupt_credential_can_be_deleted_without_decrypting(self):
        self.post('write', password='synthetic-secret')
        Credential.objects.update(ciphertext='invalid-ciphertext')
        self.assertEqual(self.post('read').status_code, 409)
        self.assertEqual(self.post('delete').status_code, 200)
