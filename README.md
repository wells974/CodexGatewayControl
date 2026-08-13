# Codex Gateway Control

这是一个本地单进程的 Codex OpenAI 兼容网关。它使用 SQLite 保存多个中转地址，并把每个 `/v1/*` 请求转发给当前选中的中转。

Gateway 不会修改 Codex 请求中的模型名。无论 Codex 请求 `gpt-5.5`、`image2` 或其他模型，都会将原始请求体直接转发到当前中转。切换只改变后续请求的目标；已经开始的流保持原有连接。

## 启动

运行环境需要 Node.js 22.13+。

```bash
cp .env.example .env
npm install
npm run build
npm start
```

打开启动日志中显示的本机管理地址，添加每个 OpenAI 兼容中转的 URL 和 API Key，测试后点击“使用此中转”。Gateway HTTP 代理端口默认使用 4000，并会在首次成功启动后固定保存，因为该地址会写入 Codex 的 `config.toml`；后续若被占用会明确报错，不会静默改到其他端口。数据保存在本地 `.data/gateway.sqlite`，文件权限仅允许当前用户访问。管理 API 不会返回 API Key。

管理页和模型代理共用 Controller 实际选定的本机 HTTP 端口。管理写操作使用仅由浏览器自动携带的 `HttpOnly; SameSite=Strict` 本地会话 Cookie；会话令牌不会发送给页面脚本或写入日志。

在 Codex 中配置：

```text
Base URL: http://127.0.0.1:<实际 Gateway 端口>/v1
API key: .env 中的 GATEWAY_ACCESS_TOKEN
Model: 当前中转支持的任意模型名
```

Gateway 会使用保存的上游 API Key 向中转发请求，不会将它暴露给 Codex 或浏览器。

如果需要主动更换 HTTP 代理端口，请通过 `GATEWAY_PORT` 设置新端口，启动 Gateway 后在管理页执行“一键配置”，再重启 Codex。安装版发现既定本机地址不可用时会提供“自动选择并继续”，选择新的可用端口后请在管理页执行“一键配置”。

## 构建安装包

安装包会内置 Node.js 运行时，使用 Electron Builder 启动 Gateway；使用者不需要安装 Node.js、npm 或其他开发工具。构建过程只把编译后的 Controller 和前端静态资源放入安装包，不会分发 `src`、测试文件、Vite 配置或 `node_modules`。

```bash
# Windows x64
npm run package:win

# macOS Intel
npm run package:mac:intel

# macOS Apple Silicon
npm run package:mac:arm64
```

Node.js runtime 会从官方发布地址下载并校验 SHA-256。构建需要网络和系统 `tar` 工具；Windows 安装包需要在 Windows 构建机上生成，macOS 安装包需要在 macOS 构建机上生成。首版安装包未签名，首次运行可能需要用户在系统安全提示中手动允许。

安装版的本地数据目录固定为 `CodexGatewayControl`：Windows 使用 `%APPDATA%/CodexGatewayControl`，macOS 使用 `~/Library/CodexGatewayControl`。首次启动会在其中生成本地访问令牌、SQLite 数据库和 Gateway 管理页证书。

也可以在管理页“Codex 请求入口”区域点击“一键配置”。确认框会展示当前软件配置和将写入的生图环境配置。软件配置会备份并更新 `config.toml`、`auth.json`：已有自定义 `model_provider` 时保留其名称并在原 provider 表中更新本机 Gateway 地址；没有 `model_provider` 时保持 Codex 内置 OpenAI provider，只更新顶层 `openai_base_url`，绝不新建或改名 `model_providers`。生图配置会为当前用户持久化 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`：macOS 除了写入图形会话，还会在 `~/.zprofile`、`~/.zshrc`、`~/.bash_profile` 与 `~/.bashrc` 中维护带标记的环境变量区块，覆盖 Zsh 和 Bash 的常见启动场景；这些文件会改为仅当前用户可读。macOS 和 Windows 都会自动将 `127.0.0.1`、`localhost` 与 `::1` 加入 `NO_PROXY` 和 `no_proxy`，避免系统代理拦截本机 Gateway 请求；新开的进程才会读取新值。Windows 使用 `setx` 写入当前用户环境。若管理员配置了同名系统变量，应移除或修改该系统变量，避免其覆盖当前用户配置。Gateway 使用 `.env` 中的 `GATEWAY_ACCESS_TOKEN`，原 provider 的环境变量、直接令牌或命令认证会切换为该本地令牌，原始内容保存在自动备份中。它兼容 macOS 与 Windows，使用 `CODEX_HOME`，未设置时使用当前用户目录下的 `.codex`；操作前会在本机创建带时间戳的备份。配置会保留当前模型名，完成后请由用户自行重启 Codex，并新开终端或生图进程。

## API

管理接口仅监听本机。写操作需要打开管理页时创建的本地 `HttpOnly` 会话令牌 Cookie。

- `GET /health`
- `GET /api/status`
- `POST /api/codex/configure`
- `GET /api/codex/configuration-preview`
- `POST /api/codex/configure/stream`
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

## Codex 使用方式

CGC 不会自动启动 Codex，也不会通过 CDP 修改 Codex 界面。请先在管理页完成中转配置；需要时点击“一键配置”更新本机 Codex 配置，然后由用户从系统原有入口启动或重启 Codex。Gateway 仍只监听本机地址，Codex 请求入口保持为管理页显示的本地 Gateway 地址。

## 当前范围

第一版只实现人工选择中转，不实现自动 fallback、重试、cooldown、多租户、计费、审计、自动扩缩容或通用中转管理后台。
