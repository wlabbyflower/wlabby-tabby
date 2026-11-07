"""Offline plugin install regression: account isolation, integrity and rollback."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('plugins',Path(__file__).parents[1]/'lpk/lpk_support/plugins.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

def archive(name='tabby-fixture',source='module.exports={default:function(){}};',extra=None):
    files={'package.json':json.dumps({'name':name,'version':'1.0.0','main':'dist/index.js'}).encode(),'dist/index.js':source.encode()}
    files.update(extra or {})
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w:gz') as tar:
        for name,data in files.items():
            info=tarfile.TarInfo('package/'+name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
    return stream.getvalue()

class PluginsTest(unittest.TestCase):
    def test_install_isolated_toggle_uninstall_and_integrity_rollback(self):
        data=archive();metadata={'version':'1.0.0','dist':{'tarball':'https://registry.npmjs.org/tabby-fixture/-/tabby-fixture-1.0.0.tgz','integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}}
        with tempfile.TemporaryDirectory() as directory,patch.object(p,'ROOT',Path(directory)),patch.object(p,'fetch',side_effect=lambda url,*args:json.dumps(metadata).encode() if url.endswith('/latest') else data):
            result=p.install('alice','tabby-fixture')
            self.assertTrue(result['enabled']);self.assertNotIn('directory',result)
            self.assertEqual(p.index('bob'),{})
            self.assertTrue((p.user_root('alice')/p.index('alice')['tabby-fixture']['directory']/'dist/index.js').is_file())
            before=p.index('alice')
            metadata['dist']['integrity']='sha512-invalid'
            with self.assertRaises(ValueError):p.install('alice','tabby-fixture')
            self.assertEqual(p.index('alice'),before)
            p.update('alice','tabby-fixture','disable');self.assertFalse(p.index('alice')['tabby-fixture']['enabled'])
            p.update('alice','tabby-fixture','enable');self.assertTrue(p.index('alice')['tabby-fixture']['enabled'])
            p.update('alice','tabby-fixture','uninstall');self.assertEqual(p.index('alice'),{})
    def test_builtin_native_unbundled_and_archive_traversal_rejected(self):
        with self.assertRaises(ValueError):p.validate_name('tabby-lightos')
        for code in ['module.exports=require("electron")','module.exports=require("fs")','module.exports=require("./unbundled")']:
            with self.assertRaises(ValueError):p.inspect_bundle(archive(source=code),'tabby-fixture','1.0.0')
        with self.assertRaises(ValueError):p.inspect_bundle(archive(extra={'../../escape':b'bad'}),'tabby-fixture','1.0.0')
        with self.assertRaises(ValueError):p.registry_url('https://evil.example.test/archive.tgz')
        with self.assertRaises(ValueError):p.registry_url('http://registry.npmjs.org/package')
        with self.assertRaises(ValueError):p.inspect_bundle(archive(name='tabby-other'),'tabby-fixture','1.0.0')
if __name__=='__main__':unittest.main()
