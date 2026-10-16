from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [migrations.CreateModel(name='Credential', fields=[
        ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
        ('service', models.CharField(max_length=512)),
        ('account', models.CharField(max_length=256)),
        ('fingerprint', models.CharField(max_length=64)),
        ('ciphertext', models.TextField()),
        ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
    ], options={'unique_together': {('user', 'fingerprint')}})]
