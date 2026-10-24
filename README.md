# wlabby-tabby

基于 Tabby 的终端，集成 SSH、LZC OS 本机终端及 LightOS 服务端、客户端实例连接，在一个页面中管理多台设备。

基于 [Eugeny](https://github.com/Eugeny) 创建的 [Tabby Web](https://github.com/Eugeny/tabby-web) 的懒猫微服适配项目，集成 LZC OS、LightOS 与 SSH 终端。终端与 Web 服务的基础能力来自原项目，本仓库维护懒猫微服适配和相关功能扩展。

版本 `0.6.7`，应用 ID `cloud.lazycat.app.tabbyweb`。标准 LPK v2 应用：Tabby 原生终端标签、当前微服本机终端、LightOS 实例管理，以及其他设备的 SSH 连接。

仅支持桌面客户端（Windows、macOS、Linux）；包声明不支持 Android、iOS（含 iPad）和 tvOS 智慧屏。

## 使用

打开应用后先显示 **OIDC 登录** 页面，点击大号登录按钮，使用当前微服账号进入连接首页。

连接首页集中显示本机、LightOS 和其他 SSH 设备。已保存的 SSH 连接支持搜索、导入、导出；成功连接会进入当前账号的最近连接记录。顶部“连接首页”按钮可以随时返回，不关闭现有终端。

- **LZC OS 本机终端**：管理员完成 OIDC 登录后，点击本机入口直接进入当前微服的 root shell。不需要开启 SSHD，也不需要 SSH 密码。宿主命名空间访问仅授予独立的 `hostterm` 服务；其他服务不提升权限。浏览器连接使用管理员接口签发、45 秒有效的一次性授权。
- **LightOS 实例**：右上角终端图标。动态列出实例，选择后打开原生交互终端标签，以实例配置的用户名进入 shell，不要求安装 SSHD。
- **LightOS 客户端实例**：单独列出当前账号接入的 PC 客户端。直接打开 Tabby 原生终端，通过 LightOS 签发的终端票据和设备 API 授权建立 WebSocket，支持输入输出、复制粘贴、尺寸同步、心跳和重连。不要求实例提供 `webshell_url`，不依赖 iframe 或另一张网页。客户端须在线并已开启“接入 LightOS”。
- **管理 LightOS 实例**：点击“管理实例”，打开当前微服的 LightOS 原生管理页面进行部署、启停、删除等操作。管理页面在独立窗口打开，当前 Tabby 终端继续保持连接。
- **新建 SSH 连接**：右上角加号，填主机、端口、用户名及密码，保存并连接。密码可直接填写并加密保存；留空则在连接时输入。默认密码认证；勾选“记住”并成功登录后，密码按登录账号加密保存，后续重连自动读取。可取消勾选以不保存。高级设置仍通过 Tabby 原生配置页面编辑。

- **显示 / 隐藏左侧栏**：侧栏边缘箭头可收起、展开，顶部也保留侧栏图标。当前浏览器会记住选择，刷新后仍生效。
- **终端右键菜单**：复制、粘贴、重新连接、断开连接，适用于 SSH、LZC OS 和 LightOS。
- **复制粘贴**：使用浏览器剪贴板 API；无法直接读取剪贴板时打开手动粘贴框。键盘快捷键与浏览器原生粘贴分别处理，一次操作只发送一次，连续操作两次仍正常发送两次。保留原生多行确认和 bracketed paste 行为。
- **连接状态**：终端顶部显示正在连接、等待密码、等待主机密钥、已连接或已断开，并提供断开 / 重连按钮。连接失败时提示对应排查方向，详细错误仍在终端中显示。
- **密码管理**：连接首页 → 已保存密码，可以替换或删除当前账号保存的 SSH 密码和私钥口令，不会显示密码明文，也不影响当前会话。已有 Tabby 保险库仍在原设置中管理。

LZC OS 和 LightOS 入口仅微服管理员可用。进入本机终端前须完成 Tabby 的微服 OIDC 登录；未登录时显示明确提示。应用不内置任何用户设备、实例或连接配置。`/lightos/` 仅提供原生管理页面的入口，不再维护另一套容器管理表单。切换标签不重新加载其他会话。

## 关闭页面后继续使用终端

直接关闭页面或刷新，终端在微服中继续运行。重新打开应用并使用同一微服账号登录后，会自动恢复终端标签、接回原会话，并补回关页期间的输出；当前目录、环境变量及正在运行的命令仍在。

连接首页的“后台会话”可以回到已有终端，也可以结束不再需要的会话。主动点击“断开连接”“结束会话”或关闭终端标签会结束对应会话；“重新连接”会结束旧会话并创建新连接。另一页面接入同一会话时，原页面会断开显示，后台任务继续运行。

支持普通直连 SSH 的密码、私钥认证，LZC OS 本机，以及 LightOS 服务端和客户端终端。代理、跳板机及其他 SSH 认证方式保留原连接模式，状态栏会提示暂不支持后台托管。SFTP 按需建立独立连接，关闭页面仍会结束正在传输的文件，请等待传输完成后再关页。

每账号最多保留 8 个运行中的会话，应用内最多 32 个会话记录。每个会话保留最近 2 MiB 输出，超过后只恢复末尾内容；已结束记录在 24 小时后清理。会话和输出只保存在服务内存，不写入日志或数据库。应用停止、重启、升级，或者目标设备断开，都会中断会话；这项功能不能恢复升级前的运行中会话。升级后新建的会话开始使用后台托管。

## 文件传输

SSH 设备继续使用原生 **SFTP** 面板。LZC OS 本机、LightOS 服务端实例和客户端实例可点击终端状态栏的 **文件传输**，或在终端右键菜单中打开。

- 本机和 LightOS 服务端：支持目录浏览、上传、下载、新建目录、重命名、删除文件及空目录，不需要开启 SSHD 或填写 SSH 密码。LightOS 文件操作使用实例配置的用户权限。
- 客户端实例：支持浏览与下载当前客户端账号能访问的文件。上传调用客户端现有接口，文件保存在它返回的临时目录，完成后显示实际路径；不将其伪装成上传到当前目录。客户端目前未提供重命名、删除和新建目录接口，因此不显示这些按钮。Windows 客户端可访问范围由客户端自身接口决定。
- 文件传输单独建立连接，关闭文件窗口不关闭当前终端。上传按块写入，保存完成前不替换原文件；取消和断线会清理本机、容器端未完成的临时上传。
- 单文件最大 2 GiB。支持保存文件接口的浏览器可分块写入下载目标；不支持时使用浏览器下载，内存回退上限为 128 MiB。本机、容器目录显示前 5000 项，可在路径栏直接输入具体目录。
- 本机文件访问与本机终端相同，仅管理员可用。一次性授权区分终端与文件用途，不能互换，且不向浏览器暴露内部设备授权令牌。
- 文件选择入口接入[官方文件选择器拦截](https://gitee.com/lazycatcloud/lzc-developer-doc/blob/master/docs/lazycat-file-picker-auto-intercept.md)，可在支持的微服环境选择本地或懒猫网盘。上传、下载仍受目标设备账号权限限制。

LightOS 容器文件助手通过标准输入临时传入并运行，结束后清理；要求实例提供 `/bin/sh`、`head`、`mktemp`、`chmod`，且临时目录可写、允许执行。不安装常驻服务。授权助手和文件助手由构建脚本生成 amd64、arm64 两种静态二进制。

## SSH 重新连接

点击状态栏、右键菜单或原生工具栏的重新连接，都会重新建立当前标签的 SSH 连接，保存的密码照常使用。连续点击合并为一次操作；其他仍使用共享连接的标签不主动关闭。底层网关关闭会清理对应的原生 SSH / SFTP 连接；已经托管的终端由独立后台连接维持。

## LightOS WebShell 接入

本应用通过 LPK 的 `lightos.webshell` 资源导出机制注册终端提供方。安装本版本后，在支持第三方 WebShell 的 LightOS 管理页面选择 **Tabby 终端**，即可打开指定实例的 Tabby 原生终端；客户端实例也支持通过 `client:<实例标识>` 进入。不同版本 LightOS 的菜单名称可能不同。

入口支持 `?name=实例名@owner_deploy_id`、`?target=实例名@owner_deploy_id` 和原有 `?lightos=实例名&owner=owner_deploy_id`。完成 OIDC 登录后会继续打开目标，连接前重新核对当前可访问列表及在线状态；不可访问的目标显示错误，不自动连接其他实例。无目标参数时打开连接首页。

容器部署和启停由 LightOS 管理，终端由 Tabby 提供。管理页地址通过系统 `lightosctl system admin-info --json` 动态读取，不固定微服域名，不向地址附加登录票据。这个入口不是会话迁移：切换到另一终端应用会使用另一终端会话。

## Agent 输出与滚动

普通终端在持续输出时跟随最新内容；向上滚动查看历史后保持正在查看的行，滚到底部、输入键盘内容或使用原生“滚动到底部”操作后恢复跟随。窗口缩放和仍在保留范围内的历史裁剪不会把视图强行拉回。历史已被应用清除或超过保留上限时，无法继续保留已删除的内容。

启用鼠标上报或使用全屏界面的 Agent、编辑器继续使用 xterm 原生鼠标协议。鼠标上报、焦点通知及终端状态回复不会作为键盘输入触发滚到底部。

## 数据持久化

连接配置、主机密钥和加密凭据都通过当前 OIDC 登录账号隔离，数据库位于 `/lzcapp/var/mysql`。密码存储按账号、目标主机/端口、SSH 用户名区分；使用由应用稳定密钥和账号派生的 Fernet 认证加密密钥。数据库内仅保存密文，刷新、重启和正常升级后可继续使用。新建 SSH 表单填写的密码会立即加密保存；留空时，在连接弹窗勾选“记住”并成功登录后保存。原有未真正保存的密码无法从旧版本恢复。

最近连接按当前账号保存，最多保留 50 条，首页显示最近 12 条。可以清空记录，不删除连接配置和密码。导出文件只包含 SSH 名称、分组、地址、端口和用户名，不导出密码、密钥、命令或环境变量。导入仅接受本项目格式，按地址、端口和用户名跳过重复连接。

浏览器原生凭据接口（keytar shim）接入服务端存储，不再使用上游只返回空值的模拟实现。凭据读写要求有效登录，POST 受 CSRF 校验，另一个账号无法读取、覆盖或删除当前账号的凭据。已有 Tabby 加密保险库设置继续沿用。

安装包不包含运行时数据库与凭据。在另一台微服全新安装后使用那台微服和当前账号自己的数据；它不会携带开发设备的连接或密码。

## 空闲连接处理

SSH 网关和 LightOS 终端使用应用层心跳：每 15 秒检测，等待响应最多 45 秒；网络恢复、切回窗口或浏览器休眠后恢复时重新探测，避免因后台计时器暂停立即误判。连接失效后明确显示断线，拒绝继续向关闭的 WebSocket 发送输入；不会自动把用户后续按键重放到新 shell。

SSH 网关使用公开的异步流读写接口和写入背压。当任意一端关闭时，另一端及读取任务随之清理。TCP 开启系统保活。浏览器回到前台时重新触发当前终端焦点恢复。

LightOS 和 SSH 断线后可使用状态栏或右键菜单中的“重新连接”。升级应用会中断现有终端，需要重新打开标签。

## 可移植性和脱敏

- 应用域名、微服域名、OIDC 参数都在安装或运行时取得，不固定设备名、局域网 IP 或用户名。
- 数据库密码与 Django 密钥使用 `stable_secret` 在目标微服派生，包内仅含模板。
- LPK 仅包含声明的应用文件与自有镜像层，不携带数据库、SSH 私钥、浏览器登录态、测试设备或已有连接。
- `buildscript` 自动运行 `scripts/preflight.py`：阻止固定微服域名、私人目录、局域网地址、私钥和运行时数据库进入发布内容，并清理 Python 字节码缓存。
- `scripts/release.sh` 统一执行构建、lint、完整 LPK（含嵌套内容和镜像层）脱敏审计及 SHA-256 校验文件生成。
- Docker 构建上下文通过 `.dockerignore` 仅开放所需文件。所有基础镜像均使用公开懒猫 Registry 引用；自有层通过 `embed:tabby` 分发。
- 本机终端参考 [lzc-my-shell](https://gitee.com/mhwy/lzc-my-shell)，通过独立服务的 `pid: host`、`privileged` 和 `nsenter` 进入宿主命名空间。`compose_override` 只作用于 `hostterm`，不挂载 Docker socket，不使用 host 网络。授权签发接口仍位于仅监听 loopback 的管理员服务中；内部终端端口验证签名、来源与防重放，不能仅伪造身份头进入。

另一个微服安装同一 LPK 后会读取它自己的系统配置。连接其他设备的 SSH 功能需要目标设备开启 SSHD；本机入口不依赖 SSH。LightOS 功能需要系统支持 `lightosctl` 并授权 `lightos.manage`。镜像平台必须匹配目标微服架构；当前发布构建以 lzc-cli 显示的目标平台为准。

## 构建和验证

前置：Node.js 18+、lzc-cli 2+、Python 3、Go 1.24.6+、Docker builder，已配置目标微服。可通过 `TABBY_GO` 指定 Go 可执行文件。构建时为 amd64 和 arm64 生成静态 SDK 授权助手，运行时只读取目标微服注入的应用证书；安装包不包含证书、私钥、用户票据或设备令牌。

```bash
cd tabby-web-lpk
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_lightos_manager.py -v
node tests/test_connection_health.cjs
node tests/test_gateway_defaults.cjs
node tests/test_terminal_actions.cjs
node tests/test_ui_preferences.cjs
node tests/test_credential_storage.cjs
node tests/test_connection_ui.cjs
# 在网关原始运行时验证异步 I/O 与连接清理
# 下列挂载路径由当前工作目录计算，不依赖开发者机器。
docker run --rm --volume "$PWD:/workspace:ro" --workdir /workspace \
  --entrypoint python \
  registry.lazycat.cloud/abby/eugeny/tabby-connection-gateway:d9737cecff2904db \
  -B -m unittest discover -s tests -p test_gateway.py -v
./scripts/release.sh
lzc-cli lpk info tabby-web-0.6.2.lpk
```

发布脚本默认生成带版本号的包及 SHA-256 校验文件，遇到同名包会停止，不覆盖旧产物。构建不包含安装或部署操作。默认开发配置使用独立 `.dev` 应用 ID。

配置保存会等待服务端写入成功，再显示成功或继续连接，避免上游延迟保存导致立即刷新后丢失连接和主机密钥。

插件源码位于 `content/tabby-lightos/src/`。运行 `python3 scripts/build-plugin.py` 生成 `dist/`，同时执行 JavaScript 语法检查；发布前会自动重新生成，避免手动维护编译产物。

`tests/browser-062.cjs` 验证缺少 `webshell_url` 时客户端仍能打开 Tabby 原生终端、等待设备就绪、单次粘贴、断开重连、授权失败和离线限制。`tests/test_client_transport.py` 在实际网关运行时通过 HTTP 和 WebSocket 测试客户端票据、工作区与字节流协议；SDK 查询在该测试中由测试桩替代。`native/client-auth-token/main_test.go` 另用临时证书、真实 TLS/gRPC 和签名校验验证 SDK 设备授权，包含授权拒绝时不返回令牌。宿主终端还在隔离 PID 命名空间中验证了 root shell、Ctrl+C、尺寸同步和心跳；没有为验证而安装应用或接入运行中微服的宿主命名空间。

浏览器回归测试见 `tests/browser-regression.cjs` 和 `tests/browser-ssh.cjs`。新增 `tests/browser-scroll.cjs` 验证真实随包 xterm 的持续输出、双向滚动、窗口缩放、历史裁剪及 TUI 鼠标协议；`tests/browser-webshell.cjs` 验证 WebShell 入口、OIDC 返回目标及原生管理入口。前者验证登录页、连接首页、各粘贴入口的输入次数、状态与重连、历史、密码管理和配置导入导出；后者使用临时 SSH 测试服务验证首次密码保存、刷新与测试后端重启后免输密码，以及 SSH 粘贴和重连。测试只接受回环地址及 `tabby-*-ui-test` 容器名，不使用真实设备凭据。需要 Playwright、Chromium，SSH 测试另需 `ssh2`。通过 `PLAYWRIGHT_MODULE`、`SSH2_MODULE` 可指定本地模块位置，`TEST_BASE_URL` 和 `TEST_CONTAINER` 可指定隔离测试环境。

## 实现与边界

- `content/tabby-lightos/`：Tabby 原生插件、动态连接配置、管理标签、心跳和 SSH 新建表单。
- `content/session-broker.py`、`native/ssh-worker/`：账号隔离的后台会话、输出回放及后台 SSH shell。
- `content/lightos-manager.py`：管理员 API、原生 LightOS 管理入口发现及兼容管理接口。
- `content/lightos-terminal.py`：管理员 WebSocket 与 PTY，支持双向输入输出、Ctrl+C、尺寸同步、登录用户选择，最多同时打开 8 个 LightOS 终端。
- `content/host-terminal.py`、`terminal-access.py`、`pty-shell.py`：独立宿主终端、一次性授权与控制终端分配。
- `content/lightos-clients.py`：当前账号的客户端实例发现、终端票据、设备授权和原生 WebSocket 代理。
- `content/gateway.py`：WebSocket 握手兼容、心跳与双向流生命周期修复。只合并相同的重复 Key/Version 请求头，冲突值仍拒绝。
- `lpk/settings_lazycat.py`：补齐上游 OIDC backend。
- `lpk/gateway_defaults.py`：用户接口和网关选择接口的同源网关默认值，覆盖末尾斜杠变体；前端也直接选择内置网关，避免依赖外部网关池或只靠响应注入。
- `lpk/lpk_support/`：OIDC 登录页、账号隔离的加密凭据与连接历史、迁移和带 CSRF 验证的 API。
- `content/fix-app-dist.sh`：修复上游插件目录并安装本项目原生插件。

LightOS 跨应用流式命令使用系统的 `实例名@owner_deploy_id`，标识从实例列表动态取得。实例 rootfs 位于 `/lzcapp/var/lightos/<name>`，删除实例不主动删除 rootfs。MariaDB 数据位于 `/lzcapp/var/mysql`。LightOS 维护命令最长等待 45 秒。

镜像内置 Tabby `1.0.187-nightly.1`；运行时追加的版本包仍位于临时容器目录，重启后不保留。`/gateway/` 保持微服登录认证，不能设置为公开路径。

客户端实例按原版 [LCMD WebShell](https://github.com/manateelazycat/lazycat-microserver-webshell) 的 `/api/client-instances`、`/api/client-instances/terminal-ticket` 和设备 `/s/<service>/workspace`、`/ws` 接口接入，通过 `lightosctl system admin-info --json` 动态定位 LightOS，不固定域名。跨应用请求使用系统委托票据；用户身份仍由目标 ingress 验证。

开发规范参考[官方开发者文档](https://gitee.com/lazycatcloud/lzc-developer-doc)，本机终端使用官方 `compose_override` 扩展，后续上架需按该机制的要求申报权限。


## 源码仓库

https://github.com/wlabbyflower/wlabby-tabby

仓库不收录安装包、构建缓存、授权助手二进制、运行数据库、证书或登录凭据。授权助手由构建脚本从 `native/client-auth-token` 源码生成。测试中的账号、口令与票据均为虚构测试数据。

## 原项目与致谢

感谢 **[Eugeny](https://github.com/Eugeny)** 及社区贡献者开发和维护 Tabby 系列项目，让我们可以在此基础上完成懒猫微服适配：

- [Tabby Web](https://github.com/Eugeny/tabby-web)：本项目的上游，提供浏览器端承载、配置管理与认证等基础能力。
- [Tabby](https://github.com/Eugeny/tabby)：提供终端界面、标签页、SSH 客户端及插件体系。
- [Tabby Connection Gateway](https://github.com/Eugeny/tabby-connection-gateway)：提供浏览器与 SSH 等 TCP 服务之间的连接网关。

同时感谢以下项目及其作者、维护者提供的实现参考和开发资料：

- [mhwy / lzc-my-shell](https://gitee.com/mhwy/lzc-my-shell)：LZC OS 本机终端的宿主命名空间访问方案参考。
- [manateelazycat / lazycat-microserver-webshell](https://github.com/manateelazycat/lazycat-microserver-webshell)：LightOS 客户端实例的终端票据、设备授权与终端通信流程参考。
- [懒猫微服开发者文档](https://gitee.com/lazycatcloud/lzc-developer-doc)及 [LZC SDK](https://gitee.com/linakesi/lzc-sdk)：提供应用打包、系统能力接入和设备授权支持。

本仓库由 [wlabbyflower](https://github.com/wlabbyflower) 维护适配与扩展，主要包括 OIDC 登录接入、LZC OS 与 LightOS 终端入口、凭据持久化、连接状态检测及交互改进。原项目及相关依赖的版权与许可证归各自权利人所有；Tabby Web 的许可证见[上游 MIT License](https://github.com/Eugeny/tabby-web/blob/master/LICENSE)。欢迎到原仓库了解项目、反馈问题并支持原作者。


生产启动回归测试见 `tests/test_manager_process.py`，需在隔离的随包 Python 3.7 镜像中提供虚构 `lightosctl` 并设置 `TABBY_MANAGER_FIXTURE=1`。测试从真实管理服务入口启动 HTTP 与 WebSocket，验证文件助手子进程、重复上传下载和取消清理。

在项目根目录执行生产启动回归（仅启动隔离测试容器，不安装应用）：

```bash
docker run --rm -e TABBY_MANAGER_FIXTURE=1 \
  -v "$(pwd)/tests/fixtures/lightosctl.py:/lzcinit/lightosctl:ro" \
  -v "$(pwd):/workspace:ro" -w /workspace \
  --entrypoint python \
  registry.lazycat.cloud/abby/eugeny/tabby-connection-gateway:d9737cecff2904db \
  -m unittest discover -s tests -p test_manager_process.py
```

先按前文构建原生助手，测试不使用真实实例或设备凭据。

后台会话回归：`tests/test_session_broker.py` 在随包 Python 3.7 中验证关页、补回输出、账号隔离、主动结束与输出上限；`tests/browser-persistence.cjs` 使用隔离容器、真实随包 xterm 和临时 SSH 服务，验证自动恢复、SSH shell、本机与 LightOS shell 的 PID/环境保持、关页期间任务继续、SFTP 及重连。`tests/test_ssh_worker.cjs` 验证后台 SSH 的密码、私钥、主机密钥拒绝、字节流及尺寸同步。测试客户端 API 与宿主入口使用隔离测试环境，不接入真实宿主命名空间。原有针对旧终端 URL 的浏览器脚本保留为历史版本回归，新版会话入口以 `browser-persistence.cjs` 为准。
