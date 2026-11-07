"""Account-private terminal backgrounds, bounded raster uploads and atomic settings."""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import struct
import tempfile
from django.http import FileResponse, Http404
from django.core.files.uploadedfile import UploadedFile
from rest_framework.parsers import JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

ROOT=Path('/lzcapp/var/backgrounds')
LIMIT=8*1024*1024
DEFAULT={'enabled':False,'fit':'cover','shade':75}


def image_info(data):
    kind=None;size=None
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data)>=33 and data[12:16]==b'IHDR':
        kind='png';size=struct.unpack('>II',data[16:24])
    elif data[:3]==b'\xff\xd8\xff':
        kind='jpeg';i=2
        while i+4<=len(data):
            if data[i]!=255:break
            while i<len(data) and data[i]==255:i+=1
            if i>=len(data):break
            marker=data[i];i+=1
            if marker in (0xD8,0xD9,0x01) or 0xD0<=marker<=0xD7:continue
            if i+2>len(data):break
            length=int.from_bytes(data[i:i+2],'big')
            if length<2 or i+length>len(data):break
            if marker in (0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF) and length>=7:
                height,width=struct.unpack('>HH',data[i+3:i+7]);size=(width,height);break
            i+=length
    elif len(data)>=30 and data[:4]==b'RIFF' and data[8:12]==b'WEBP':
        kind='webp'
        if data[12:16]==b'VP8X' and not data[20]&2:
            size=(1+int.from_bytes(data[24:27],'little'),1+int.from_bytes(data[27:30],'little'))
        elif data[12:16]==b'VP8 ' and data[23:26]==b'\x9d\x01\x2a':
            width,height=struct.unpack('<HH',data[26:30]);size=(width&0x3fff,height&0x3fff)
        elif data[12:16]==b'VP8L' and data[20]==0x2f:
            value=int.from_bytes(data[21:25],'little');size=((value&0x3fff)+1,((value>>14)&0x3fff)+1)
    if not kind or not size or not all(0<n<=8192 for n in size) or size[0]*size[1]>16_000_000:
        raise ValueError('请选择有效的静态 PNG、JPEG 或 WebP 图片，尺寸不超过 8192 边长及 1600 万像素')
    return kind,size


def directory(user):
    path=ROOT/hashlib.sha256(str(user).encode()).hexdigest()
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    return path


def read(user):
    file=directory(user)/'settings.json'
    return dict(DEFAULT,**(json.loads(file.read_text()) if file.exists() else {}))


def atomic(path,data):
    fd,temp=tempfile.mkstemp(prefix='.background-',dir=str(path.parent))
    try:
        with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
        os.replace(temp,str(path))
    finally:
        if os.path.exists(temp):os.unlink(temp)


def public(value):
    result={k:value[k] for k in DEFAULT}
    result['hasImage']=bool(value.get('image'))
    result['url']='/api/1/background/image/?v='+value['digest'] if result['hasImage'] else None
    if value.get('width'):result.update(width=value['width'],height=value['height'])
    return result


class BackgroundView(APIView):
    permission_classes=[IsAuthenticated]
    parser_classes=[JSONParser,MultiPartParser]
    def get(self,request):return Response(public(read(request.user.pk)),headers={'Cache-Control':'no-store'})
    def post(self,request):
        with (directory(request.user.pk)/'.lock').open('a') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX)
            return self.save(request)
    def save(self,request):
        root=directory(request.user.pk);value=read(request.user.pk)
        try:
            image=request.data.get('image')
            if isinstance(image,UploadedFile):
                if image.size>LIMIT:raise ValueError('图片不能超过 8 MiB')
                data=image.read(LIMIT+1)
                if len(data)>LIMIT:raise ValueError('图片不能超过 8 MiB')
                kind,size=image_info(data);digest=hashlib.sha256(data).hexdigest();name='image-'+digest+'.'+kind
                atomic(root/name,data)
                value.update(image=name,digest=digest,width=size[0],height=size[1],enabled=True)
            elif request.data.get('action')=='remove':
                value=dict(DEFAULT,fit=value['fit'],shade=value['shade'])
            else:
                fit=request.data.get('fit');shade=request.data.get('shade');enabled=request.data.get('enabled')
                if fit not in ('cover','contain','stretch') or type(shade) is not int or not 65<=shade<=95 or type(enabled) is not bool:
                    raise ValueError('背景设置无效：遮罩深度应为 65–95，显示方式请选择铺满、完整显示或拉伸')
                value.update(fit=fit,shade=shade,enabled=enabled and bool(value.get('image')))
            atomic(root/'settings.json',json.dumps(value).encode())
            for old in root.glob('image-*'):
                if old.name!=value.get('image'):
                    try:old.unlink()
                    except FileNotFoundError:pass
            return Response(public(value),headers={'Cache-Control':'no-store'})
        except (ValueError,struct.error) as error:return Response({'error':str(error)},status=400)


class BackgroundImageView(APIView):
    permission_classes=[IsAuthenticated]
    def get(self,request):
        value=read(request.user.pk)
        if not value.get('image'):raise Http404
        file=directory(request.user.pk)/value['image']
        if not file.is_file():raise Http404
        kind=file.suffix[1:]
        response=FileResponse(file.open('rb'),content_type='image/'+kind)
        response['Cache-Control']='private, no-cache';response['ETag']='"'+value['digest']+'"';response['X-Content-Type-Options']='nosniff'
        return response
