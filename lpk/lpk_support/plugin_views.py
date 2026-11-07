import mimetypes
from pathlib import PurePosixPath
from django.http import FileResponse, Http404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from tabby.app.api.app_version import AppVersionViewSet, AppVersionSerializer
from tabby.app.views import AppDistView
from . import plugins


class PluginsView(APIView):
    permission_classes=[IsAuthenticated]
    def get(self,request):
        try:
            if 'q' in request.query_params:
                data={'items':plugins.search(request.query_params['q'])}
            else:data={'items':[plugins.public(p) for p in plugins.index(request.user.pk).values()]}
            return Response(data,headers={'Cache-Control':'no-store'})
        except ValueError as error:return Response({'error':str(error)},status=400)
        except Exception:return Response({'error':'插件仓库暂不可用，请稍后重试'},status=502)
    def post(self,request):
        action=request.data.get('action');name=request.data.get('name')
        try:
            if action=='install':result=plugins.install(request.user.pk,name,request.data.get('version',''))
            else:plugins.update(request.user.pk,name,action);result={'ok':True}
            return Response(result,headers={'Cache-Control':'no-store'})
        except (ValueError,UnicodeError) as error:return Response({'error':str(error)},status=400)
        except Exception:return Response({'error':'插件下载或保存失败，请检查网络后重试'},status=502)


class PluginVersionsView(APIView):
    permission_classes=[IsAuthenticated]
    def get(self,request):
        installed=plugins.index(request.user.pk)
        versions=AppVersionViewSet()._get_versions()
        names=[name for name,p in installed.items() if p['enabled']]
        for version in versions:
            version.plugins.extend(name for name in names if name not in version.plugins)
        return Response(AppVersionSerializer(versions,many=True).data,headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'})


class PluginAssetsView(APIView):
    permission_classes=[IsAuthenticated]
    def get(self,request,version,path):
        parts=PurePosixPath(path).parts
        if not parts or '..' in parts or path.startswith('/'):
            raise Http404
        name=parts[0]
        # Packaged components still use the upstream view, third-party bundles
        # resolve exclusively inside the requesting account's installation.
        if name in plugins.BUILTIN:return AppDistView.as_view()(request._request,version=version,path=path)
        item=plugins.index(request.user.pk).get(name)
        if not item or not item['enabled'] or len(parts)<2:raise Http404
        root=(plugins.user_root(request.user.pk)/item['directory']).resolve()
        file=root.joinpath(*parts[1:]).resolve()
        if root not in file.parents or not file.is_file():raise Http404
        response=FileResponse(file.open('rb'),content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
        response['Cache-Control']='no-store';response['X-Content-Type-Options']='nosniff'
        return response
