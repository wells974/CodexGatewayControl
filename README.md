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

在 Codex 中一次性配置：

```text
Base URL: http://127.0.0.1:4000/v1
API key: .env 中的 GATEWAY_ACCESS_TOKEN
Model: 当前中转支持的任意模型名
```

Gateway 会使用保存的上游 API Key 向中转发请求，不会将它暴露给 Codex 或浏览器。

## API

管理接口仅监听本机。写操作需要打开管理页时创建的本地 `HttpOnly` 会话令牌 Cookie。

- `GET /health`
- `GET /api/status`
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

附加到已通过其他方式启用 CDP 的实例：

```bash
npm run codex:attach -- --port 9222
```

如果选定端口不是存活的 Codex CDP endpoint，附加模式会明确报错。CDP 是未认证的 loopback 调试接口，只应在运行受信任本地代码时启用。本项目尚未提供已签名的 macOS companion app、Keychain 集成或 Notarization。

## 当前范围

第一版只实现人工选择中转，不实现自动 fallback、重试、cooldown、多租户、计费、审计、自动扩缩容或通用 LiteLLM Admin UI。
