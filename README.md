# Codex Gateway Control

这是一个本地单进程的 Codex OpenAI 兼容网关。它使用 SQLite 保存多个中转地址，并把每个 `/v1/*` 请求转发给当前选中的中转。

Gateway 不会修改 Codex 请求中的模型名。无论 Codex 请求 `gpt-4.1`、`o3` 或其他模型，都会将原始请求体直接转发到当前中转。切换只改变后续请求的目标；已经开始的流保持原有连接。

## 启动

只需要 Node.js 22.13+。不需要 Docker、Postgres、LiteLLM 或独立数据库服务。

```bash
cp .env.example .env
npm install
npm run build
npm start
```

打开 http://127.0.0.1:4000，添加每个 OpenAI 兼容中转的 URL 和 API Key，测试后点击“使用此中转”。数据保存在本地 `.data/gateway.sqlite`，文件权限仅允许当前用户访问。管理 API 不会返回 API Key，嵌入式浏览器页面也无法访问它。

Codex 内嵌管理页使用独立的 HTTPS loopback 地址 `https://127.0.0.1:4401`。这是为了让 `blob:app://-` iframe 能使用浏览器自动携带的 `HttpOnly; Secure; Partitioned` 本地会话 Cookie；模型代理地址仍固定为 HTTP `http://127.0.0.1:4000`。首次启动会在 `.data/` 生成仅本机使用的自签名证书和私钥，二者均不会提交或发送到浏览器页面。

在 Codex 中配置：

```text
Base URL: http://127.0.0.1:4000/v1
API key: .env 中的 GATEWAY_ACCESS_TOKEN
Model: 当前中转支持的任意模型名
```

Gateway 会使用保存的上游 API Key 向中转发请求，不会将它暴露给 Codex 或浏览器。

也可以在管理页“Codex 请求入口”区域点击“一键配置”。已有自定义 `model_provider` 时，操作会保留其名称并在原 provider 表中更新本机 Gateway 地址；没有 `model_provider` 时，才会创建并选择 `codex_gateway`。内置 `openai` provider 不能定义在 `model_providers` 中，因此会保留其名称并更新顶层 `openai_base_url`。Gateway 使用 `.env` 中的 `GATEWAY_ACCESS_TOKEN`，原 provider 的环境变量、直接令牌或命令认证会切换为该本地令牌，原始内容保存在自动备份中。它兼容 macOS 与 Windows，使用 `CODEX_HOME`，未设置时使用当前用户目录下的 `.codex`；操作前会在本机创建带时间戳的备份。配置会保留当前模型名，完成后需要重启 Codex。

## API

管理接口仅监听本机。写操作需要打开管理页时创建的本地 `HttpOnly` 会话令牌 Cookie。

- `GET /health`
- `GET /api/status`
- `POST /api/codex/configure`
- `GET /api/upstreams`
- `GET /api/upstreams/:id/models`
- `POST /api/upstreams`
- `PATCH /api/upstreams/:id`
- `DELETE /api/upstreams/:id`
- `POST /api/upstreams/:id/test`
- `POST /api/upstreams/:id/test-request`
- `POST /api/upstreams/:id/activate`
- `POST /api/test-request`

所有 `/v1/*` 路径由可选的 `GATEWAY_ACCESS_TOKEN` 验证，然后透明流式转发到当前中转。Gateway 不会缓冲 SSE 输出，也不会改写 `model`、tools、messages 或请求路径。

## 验证当前中转

中转卡片上的“测试”会打开该中转的测试窗口并读取其 `GET /v1/models` 列表。管理页右上角的“测试当前中转”会通过 Gateway 对当前中转发起一次真实的 `POST /v1/responses` 流式请求；填写当前 Codex 项目实际使用的模型名后，页面会在收到每个文本增量时实时显示模型回复。

这一次测试会产生真实上游调用，并可能消耗中转额度。模型名和请求路径会原样经过 Gateway，不会替换成固定别名。

## Codex 侧栏嵌入

可选 launcher 会保留当前 Codex 窗口，并启动一个启用 Gateway 的独立 Codex Desktop 窗口：

```bash
npm run codex
```

它会在需要时启动本地 Gateway、使用 loopback CDP 端口启动 ChatGPT/Codex、注入“网关管理”侧栏入口，并持续处理 renderer 替换和页面重载。项目已不再使用 Docker，因此该命令不会启动 Docker。

为避免 macOS 将启动参数转发给当前已打开的 ChatGPT，launcher 会直接启动 app bundle 内的可执行文件，并使用独立的持久 profile（默认 `.data/codex-cdp-profile`）。这不会影响当前 Codex 窗口；首次使用该独立窗口时需要重新登录。可通过环境变量或命令行指定 profile：

```bash
CODEX_CDP_USER_DATA_DIR=/绝对路径/到/codex-gateway-profile npm run codex
# 或
npm run codex -- --user-data-dir /绝对路径/到/codex-gateway-profile
```

Codex 的 renderer CSP 默认会拦截 `http://127.0.0.1:4000` iframe。launcher 会把 Gateway 的公开 HTML 作为 `blob:` 文档嵌入，启用 CDP CSP bypass、注册 document-start 注入脚本并排除头像和听写等浮层 target；后续 renderer 重建会由常驻守护自动恢复。侧栏会在“插件”下方插入“网关管理”入口；按 `Esc` 或切换到任一原生侧栏页面即可回到 Codex。

当前本机安装的 ChatGPT Desktop 会在 CDP `Page.reload` 后进入“ChatGPT failed to start / ERR_FAILED (-2)”页面，因此默认不 reload 主 renderer。Taskboard 使用的 CSP bypass + reload 流程不兼容这一个 Desktop 版本。可以仅用于确认兼容性的诊断命令显式开启 reload：

```bash
npm run codex -- --force-reload
```

ChatGPT Desktop 151 还会阻止 `app://-` blob 页面访问 loopback 网络。为使 Gateway 页面能读取 Controller 且保持 `HttpOnly` 会话，`npm run codex` 仅为它创建的独立 profile 关闭本地网络检查，并以证书的原始 SPKI SHA-256 base64 指纹精确放行本机 Gateway HTTPS 证书；不会使用全局忽略 HTTPS 证书错误的参数。这会降低该独立 profile 中网页的本地网络访问保护，因此只应在其中运行受信任的本地 Codex 内容，不能把日常浏览或不受信任网页放入这个 profile。

附加到已通过其他方式启用 CDP 的实例：

```bash
npm run codex:attach -- --port 9222
```

推荐始终使用 `npm run inject`（等同于 `npm run codex`），因为它会创建带本机 HTTPS 证书 SPKI 白名单的专用 profile。`attach-existing` 不会、也不能修改已运行 Codex 的启动参数；只有目标实例已在启动时同时配置 loopback CDP、本地网络访问和该证书的 SPKI 白名单时，嵌入管理页的安全会话才可用。普通现有 Codex 窗口不满足这些条件时，请改用推荐命令启动独立实例。

如果选定端口不是存活的 Codex CDP endpoint，附加模式会明确报错。CDP 是未认证的 loopback 调试接口，只应在运行受信任本地代码时启用。本项目尚未提供已签名的 macOS companion app、Keychain 集成或 Notarization。

## 当前范围

第一版只实现人工选择中转，不实现自动 fallback、重试、cooldown、多租户、计费、审计、自动扩缩容或通用 LiteLLM Admin UI。
