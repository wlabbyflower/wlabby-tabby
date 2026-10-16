"""LPK 移植层：补上 tabby-web 上游缺失的 OIDC backend。

上游 `tabby/settings.py` 的 `AUTHENTICATION_BACKENDS` 直接写了

    "social_core.backends.open_id_connect.OpenIdConnectAuth"

但 social_core 4.x 里 `OpenIdConnectAuth` 是一个**抽象基类**，源码注释就是
"Override OIDC_ENDPOINT in your subclass to enable autoconfig of OIDC"：
`name` 继承到的是空字符串，`OIDC_ENDPOINT` 固定为 `None`，必须由子类覆盖才可用。

于是上游这个配置的实际表现是：

* `/api/1/auth/providers` 会把 `oidc` 列出来——那个接口（`tabby/app/api/auth.py`
  的 `is_provider_configured`）只检查 `SOCIAL_AUTH_OIDC_KEY` / `_SECRET` /
  `_OIDC_ENDPOINT` 三个设置项，不看 backend 注册表，所以登录页会显示按钮；
* 但点下去访问 `/api/1/auth/social/login/oidc` 时，social_django 是按 backend 的
  `name` 去找的，找不到就抛 `Http404("Backend not found")`，登录永远走不通。

也就是说「在微服上用 OIDC 免密登录 tabby-web」这件事，上游是坏的；而微服环境又没有
GitHub / Google 这类第三方 OAuth 凭据可用（`oidc_redirect_path` 才是官方推荐的免密
登录路径，见 docs/advanced-oidc.md），所以这一层必须补。

本模块做两件事：

1. 定义一个真正的子类：`name = 'oidc'`（对上前端登录按钮的 id，也是
   `PROVIDER_CONFIG` 里的 key），`OIDC_ENDPOINT` 改成从
   `SOCIAL_AUTH_OIDC_OIDC_ENDPOINT` 读设置——这样 social_core 会去
   `<issuer>/.well-known/openid-configuration` 自动发现 authorization / token /
   userinfo / jwks 等 endpoint，微服只需要给出 issuer。
2. 把 `AUTHENTICATION_BACKENDS` 里那一项换成这个子类，别的 backend 原样保留。

启用方式：环境变量 `DJANGO_SETTINGS_MODULE=tabby.settings_lazycat`。
`manage.py` 与 `tabby/wsgi.py` 都是 `os.environ.setdefault(...)`，环境变量优先，
所以**不需要改动上游任何文件**，本模块是纯叠加。
"""

from social_core.backends.open_id_connect import OpenIdConnectAuth  # type: ignore[import-not-found]
from tabby import settings as upstream_settings  # type: ignore[import-not-found]


def _export_upstream_settings():
    """把上游 settings 里的大写设置项全量搬进本模块。

    Django 是把 settings 模块的命名空间整个当配置用的（django.conf.Settings 会
    遍历 dir(module) 并只取大写名），所以这里语义等价于常见的
    `from tabby.settings import *`；写成显式循环是为了不引入通配 import，也让
    下面的 AUTHENTICATION_BACKENDS 有个明确的来源。非大写名（如 __name__）
    Django 本来就会忽略，不用搬。
    """
    for name, value in vars(upstream_settings).items():
        if name.isupper():
            globals()[name] = value


_export_upstream_settings()


class LazyCatOIDCBackend(OpenIdConnectAuth):
    """可由 SOCIAL_AUTH_OIDC_* 设置驱动的 OIDC backend。"""

    # 必须和 tabby/app/api/auth.py 的 PROVIDER_CONFIG 中的 'oidc' 一致：
    # 前端登录按钮的 href 是 /api/1/auth/social/login/<provider.id>。
    name = "oidc"

    @property
    def OIDC_ENDPOINT(self):
        # BaseAuth.setting() 会按 SOCIAL_AUTH_<NAME>_<KEY> 解析，
        # 即 SOCIAL_AUTH_OIDC_OIDC_ENDPOINT。
        return self.setting("OIDC_ENDPOINT")


AUTHENTICATION_BACKENDS = tuple(
    "tabby.settings_lazycat.LazyCatOIDCBackend"
    if backend.endswith("open_id_connect.OpenIdConnectAuth")
    else backend
    for backend in upstream_settings.AUTHENTICATION_BACKENDS
)


# AuthenticationMiddleware runs inside this outer middleware before response defaults.
MIDDLEWARE = ["tabby.gateway_defaults.DefaultGatewayMiddleware", *MIDDLEWARE]

INSTALLED_APPS = [*INSTALLED_APPS, "tabby.lpk_support.apps.LPKSupportConfig"]
ROOT_URLCONF = "tabby.urls_lazycat"
