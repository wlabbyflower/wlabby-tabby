"""Raster boundary checks and account-private storage in the production runtime."""
import io
import json
import tempfile
from pathlib import Path
import struct
from unittest import TestCase
from unittest.mock import patch
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIRequestFactory,force_authenticate
from tabby.app.models import User
from tabby.lpk_support import background as b

class BackgroundTests(TestCase):
    def test_magic_limits_and_private_atomic_settings(self):
        import zlib
        def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
        data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*16)*16))+chunk(b'IEND',b'')
        self.assertEqual(b.image_info(data),('png',(16,16)))
        for bad in (b'<svg onload="bad"/>',b'<html>bad</html>',data[:16],data[:16]+struct.pack('>II',9000,9000)+data[24:]):
            with self.assertRaises(ValueError):b.image_info(bad)
        # Direct API requests avoid a live micro-server and use synthetic identities.
        factory=APIRequestFactory();user=User(id=101,username='background-unit-user');other=User(id=102,username='other')
        def call(view,request,identity=user):force_authenticate(request,user=identity);return view.as_view()(request)
        with tempfile.TemporaryDirectory() as root,patch.object(b,'ROOT',Path(root)):
            response=call(b.BackgroundView,factory.post('/',{'image':SimpleUploadedFile('unsafe-name.png',data,content_type='image/png')},format='multipart'))
            self.assertEqual(response.status_code,200);self.assertTrue(response.data['enabled'])
            self.assertEqual(call(b.BackgroundView,factory.get('/'),other).data['hasImage'],False)
            self.assertEqual(call(b.BackgroundImageView,factory.get('/'),other).status_code,404)
            image_response=call(b.BackgroundImageView,factory.get('/'));self.assertEqual(b''.join(image_response.streaming_content),data);image_response.close()
            value=b.read(user.id)
            rejected=call(b.BackgroundView,factory.post('/',{'enabled':True,'fit':'cover','shade':0},format='json'))
            self.assertEqual(rejected.status_code,400);self.assertEqual(b.read(user.id),value)
            response=call(b.BackgroundView,factory.post('/',{'action':'remove'},format='json'));self.assertFalse(response.data['hasImage'])
            self.assertFalse(list(b.directory(user.id).glob('image-*')))
