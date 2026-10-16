from django.contrib.auth import get_user_model
from django.test import TestCase, Client
from rest_framework.test import APITestCase
from tabby.lpk_support.models import ConnectionHistory


class HistoryTests(APITestCase):
    url = '/api/1/connections/history/'

    def setUp(self):
        self.alice = get_user_model().objects.create_user(username='history-alice')
        self.bob = get_user_model().objects.create_user(username='history-bob')
        self.client.force_authenticate(self.alice)

    def touch(self, profile_id):
        return self.client.post(self.url, {'action': 'touch', 'profile_id': profile_id}, format='json')

    def test_history_is_unique_ordered_and_per_user(self):
        self.touch('ssh:first')
        self.touch('ssh:second')
        self.touch('ssh:first')
        data = self.client.get(self.url)
        self.assertEqual([item['profile_id'] for item in data.data['items']], ['ssh:first', 'ssh:second'])
        self.assertEqual(data['Cache-Control'], 'no-store')
        self.assertEqual(ConnectionHistory.objects.count(), 2)
        self.client.force_authenticate(self.bob)
        self.assertEqual(self.client.get(self.url).data['items'], [])
        self.client.post(self.url, {'action': 'clear'})
        self.assertEqual(ConnectionHistory.objects.count(), 2)
        self.client.force_authenticate(self.alice)
        self.client.post(self.url, {'action': 'clear'})
        self.assertEqual(ConnectionHistory.objects.count(), 0)

    def test_limits_and_permissions(self):
        self.assertEqual(self.touch('').status_code, 400)
        for i in range(55):
            self.touch('ssh:' + str(i))
        self.assertEqual(ConnectionHistory.objects.count(), 50)
        self.assertEqual(len(self.client.get(self.url).data['items']), 12)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(self.url).status_code, (401, 403))
        self.assertIn(self.touch('ssh:anonymous').status_code, (401, 403))

    def test_csrf_is_required(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.alice, backend='django.contrib.auth.backends.ModelBackend')
        self.assertEqual(client.post(self.url, {'action': 'clear'}).status_code, 403)


class LoginEntryTests(TestCase):
    def test_guest_starts_with_large_oidc_login_and_no_terminal(self):
        for path in ('/', '/login', '/app', '/terminal'):
            response = self.client.get(path)
            self.assertContains(response, '<h1>OIDC 登录</h1>', html=True)
            self.assertContains(response, '/api/1/auth/social/login/oidc/')
            self.assertEqual(response['Cache-Control'], 'no-store')
            self.assertNotContains(response, 'index.js')

    def test_query_is_preserved_without_external_redirect(self):
        response = self.client.get('/?lightos=test&owner=test.app')
        self.assertContains(response, 'next=%2F%3Flightos%3Dtest%26owner%3Dtest.app')
        response = self.client.get('/login?next=https://external.example.test')
        self.assertNotContains(response, 'external.example.test')
