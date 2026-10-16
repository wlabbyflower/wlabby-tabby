from django.urls import path
from tabby.urls import urlpatterns as upstream
from tabby.lpk_support.views import CredentialView
from tabby.lpk_support.entry import EntryView, TerminalEntryView
from tabby.lpk_support.views import ConnectionHistoryView

urlpatterns = [
    path('', EntryView.as_view()),
    path('login', EntryView.as_view()),
    path('app', EntryView.as_view()),
    path('terminal', TerminalEntryView.as_view()),
    path('api/1/credentials/<str:action>/', CredentialView.as_view()),
    path('api/1/connections/history/', ConnectionHistoryView.as_view()),
] + upstream
