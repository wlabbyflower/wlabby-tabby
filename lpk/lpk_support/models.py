from django.conf import settings
from django.db import models

class Credential(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    service = models.CharField(max_length=512)
    account = models.CharField(max_length=256)
    fingerprint = models.CharField(max_length=64)
    ciphertext = models.TextField()

    class Meta:
        unique_together = [('user', 'fingerprint')]


class ConnectionHistory(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    profile_id = models.CharField(max_length=512)
    fingerprint = models.CharField(max_length=64)
    opened_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [('user', 'fingerprint')]
