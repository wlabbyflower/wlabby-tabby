from pathlib import Path
from urllib.parse import urlencode
from django.http import HttpResponse
from django.utils.html import escape
from django.views import View
from tabby.app.views import IndexView, TerminalView


class EntryView(View):
    def get(self, request):
        if request.user.is_authenticated:
            return IndexView.as_view()(request)
        html = Path(__file__).with_name('login.html').read_text()
        next_path = request.get_full_path() if request.path in ('/', '/app') else '/'
        login_url = '/api/1/auth/social/login/oidc/?' + urlencode({'next': next_path})
        response = HttpResponse(html.replace('{{LOGIN_URL}}', escape(login_url)))
        response['Cache-Control'] = 'no-store'
        return response


class TerminalEntryView(EntryView):
    def get(self, request):
        if request.user.is_authenticated:
            return TerminalView.as_view()(request)
        return super().get(request)
