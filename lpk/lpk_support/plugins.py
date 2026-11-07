"""Per-account npm plugin bundles. No npm lifecycle scripts or server execution."""
import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

NAME = re.compile(r'^(?:tabby|terminus)-[a-z0-9][a-z0-9._-]{0,100}$')
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$')
BUILTIN = {'tabby-core','tabby-settings','tabby-terminal','tabby-ssh','tabby-web','tabby-lightos','tabby-telnet','tabby-serial','tabby-community-color-schemes','tabby-plugin-manager','tabby-web-container','tabby-web-demo'}
ALLOWED = {'@angular/core','@angular/common','@angular/forms','@angular/animations','@angular/compiler','@angular/cdk','@angular/cdk/drag-drop','@angular/platform-browser','@angular/platform-browser/animations','@angular/platform-browser-dynamic','@ng-bootstrap/ng-bootstrap','ngx-toastr','rxjs','rxjs/operators','buffer','events','stream','string_decoder','assert','util','path','url','crypto','any-promise','deepmerge','js-yaml','tabby-core','tabby-terminal','tabby-settings','tabby-ssh','tabby-web'}
ROOT = Path('/lzcapp/var/plugins')
LIMIT = 15 * 1024 * 1024


def validate_name(name):
    if not isinstance(name,str) or not NAME.fullmatch(name) or name in BUILTIN:
        raise ValueError('请输入第三方 tabby-* 或 terminus-* 插件名称，不能替换内置组件')
    return name


class RegistryRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        registry_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def registry_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('registry.npmjs.org','registry.npmjs.com') or parsed.username or parsed.password or parsed.port not in (None,443):
        raise ValueError('插件下载地址不属于 npm 官方仓库')
    return url


def fetch(url, limit=LIMIT):
    registry_url(url)
    opener = build_opener(RegistryRedirect())
    with opener.open(Request(url,headers={'User-Agent':'Tabby-LPK-plugin-manager','Accept':'application/json'}),timeout=25) as response:
        data = response.read(limit+1)
    if len(data)>limit:
        raise ValueError('插件下载超过大小限制')
    return data


def search(query):
    if not isinstance(query,str) or len(query)>120:
        raise ValueError('搜索词过长')
    data = json.loads(fetch('https://registry.npmjs.org/-/v1/search?'+urlencode({'text':'keywords:tabby-plugin '+query,'size':50}),2*1024*1024))
    items=[]
    for entry in data.get('objects',[]):
        p=entry.get('package',{});name=p.get('name','')
        if NAME.fullmatch(name) and name not in BUILTIN:
            items.append({'name':name,'version':p.get('version',''),'description':str(p.get('description',''))[:1000]})
    return items


def user_root(user):
    key=hashlib.sha256(str(user).encode()).hexdigest()
    path=ROOT/key
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    return path


def index(user):
    file=user_root(user)/'index.json'
    if not file.exists():return {}
    return json.loads(file.read_text())


@contextlib.contextmanager
def lock(user):
    root=user_root(user)
    with (root/'.lock').open('a') as handle:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('该账号正在更新插件，请稍后再试')
        yield root


def save(root, value):
    fd,name=tempfile.mkstemp(prefix='.index-',dir=str(root))
    try:
        with os.fdopen(fd,'w') as out:
            json.dump(value,out,ensure_ascii=False)
            out.flush();os.fsync(out.fileno())
        os.replace(name,str(root/'index.json'))
    finally:
        if os.path.exists(name):os.unlink(name)


def inspect_bundle(archive,name,version):
    files={};total=0
    try:
        with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
            for i,member in enumerate(tar):
                if i>1500:raise ValueError('插件文件数量超出限制')
                path=PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!='package' or member.issym() or member.islnk():
                    raise ValueError('插件压缩包包含不安全的路径或链接')
                if member.isdir():continue
                if not member.isfile():raise ValueError('插件压缩包包含特殊文件')
                total+=member.size
                if total>40*1024*1024 or member.size>LIMIT:raise ValueError('插件解压后超过大小限制')
                relative=str(PurePosixPath(*path.parts[1:]))
                files[relative]=tar.extractfile(member).read()
    except (tarfile.TarError,EOFError):raise ValueError('插件压缩包无效')
    try:package=json.loads(files['package.json'])
    except (KeyError,ValueError,UnicodeError):raise ValueError('插件缺少有效的 package.json')
    if package.get('name')!=name or package.get('version')!=version:raise ValueError('插件名称或版本不匹配')
    main=package.get('main','')
    if not isinstance(main,str) or not main.endswith('.js') or PurePosixPath(main).is_absolute() or '..' in PurePosixPath(main).parts:
        raise ValueError('插件未提供可加载的 JavaScript 入口')
    main=str(PurePosixPath(main))
    if main not in files:raise ValueError('插件入口不存在')
    source=files[main].decode('utf-8')
    # Webpack bundles expose their externals through static require calls. Native
    # modules and unbundled dependencies cannot run in the terminal renderer.
    dependencies=set(re.findall(r'\brequire\(\s*[\'"]([^\'"]+)[\'"]\s*\)',source))
    unsupported=sorted(dependencies-ALLOWED)
    if unsupported:raise ValueError('该插件依赖当前环境不支持的模块：'+', '.join(unsupported[:8]))
    if 'module.exports' not in source and 'exports.' not in source:raise ValueError('插件不是可加载的 Tabby 模块')
    return files,package


def install(user,name,requested=''):
    name=validate_name(name)
    if requested and (not isinstance(requested,str) or not VERSION.fullmatch(requested)):
        raise ValueError('版本号无效，请填写完整版本号，例如 1.2.3')
    suffix=quote(requested or 'latest',safe='')
    metadata=json.loads(fetch('https://registry.npmjs.org/'+quote(name,safe='')+'/'+suffix,2*1024*1024))
    version=metadata.get('version','')
    if not VERSION.fullmatch(version):raise ValueError('npm 返回的版本号无效')
    dist=metadata.get('dist',{})
    archive=fetch(dist.get('tarball',''))
    integrity=dist.get('integrity','')
    hashes=[x for x in integrity.split() if x.startswith(('sha512-','sha256-'))]
    if hashes:
        if not any(base64.b64encode(hashlib.new(x.split('-',1)[0],archive).digest()).decode()==x.split('-',1)[1] for x in hashes):
            raise ValueError('插件完整性校验失败')
    elif re.fullmatch(r'[a-f0-9]{40}',dist.get('shasum','')):
        if hashlib.sha1(archive).hexdigest()!=dist['shasum']:raise ValueError('插件完整性校验失败')
    else:raise ValueError('npm 未提供插件完整性校验')
    files,package=inspect_bundle(archive,name,version)
    directory=name+'/'+version+'-'+hashlib.sha256(archive).hexdigest()[:16]
    with lock(user) as root:
        current=index(user)
        if name not in current and len(current)>=20:raise ValueError('最多安装 20 个第三方插件')
        stage=Path(tempfile.mkdtemp(prefix='.install-',dir=str(root)))
        try:
            for path,data in files.items():
                file=stage/path;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data)
            target=root/directory;target.parent.mkdir(exist_ok=True)
            if not target.exists():os.replace(str(stage),str(target))
            current[name]={'name':name,'version':version,'description':str(package.get('description',''))[:1000], 'enabled':True,'directory':directory}
            save(root,current)
        finally:
            if stage.exists():shutil.rmtree(str(stage))
    return public(current[name])


def public(item):return {k:item[k] for k in ('name','version','description','enabled')}


def update(user,name,action):
    validate_name(name)
    with lock(user) as root:
        current=index(user)
        if name not in current:raise ValueError('插件未安装')
        if action=='uninstall':del current[name]
        elif action in ('enable','disable'):current[name]['enabled']=action=='enable'
        else:raise ValueError('插件操作无效')
        save(root,current)
        if action=='uninstall':shutil.rmtree(str(root/name),ignore_errors=True)
