from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('tabby_lpk_support', '0001_initial')]
    operations = [migrations.CreateModel(
        name='ConnectionHistory',
        fields=[
            ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('profile_id', models.CharField(max_length=512)),
            ('fingerprint', models.CharField(max_length=64)),
            ('opened_at', models.DateTimeField(auto_now=True)),
            ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL)),
        ],
        options={'unique_together': {('user', 'fingerprint')}},
    )]
