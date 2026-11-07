from django.urls import path
from tabby.urls import urlpatterns as upstream
from tabby.lpk_support.views import CredentialView
from tabby.lpk_support.entry import EntryView, TerminalEntryView
from tabby.lpk_support.views import ConnectionHistoryView

from tabby.lpk_support.background import BackgroundView, BackgroundImageView

urlpatterns = [
    path("api/1/background/", BackgroundView.as_view()),
    path("api/1/background/image/", BackgroundImageView.as_view()),
    path('', EntryView.as_view()),
    path('login', EntryView.as_view()),
    path('app', EntryView.as_view()),
    path('terminal', TerminalEntryView.as_view()),
    path('api/1/credentials/<str:action>/', CredentialView.as_view()),
    path('api/1/connections/history/', ConnectionHistoryView.as_view()),
] + upstream
