import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, sessionCookieValue } from "./config.js";
import {
  activeUpstream,
  activeUpstreamId,
  clearActiveUpstream,
  createUpstream,
  deleteUpstream,
  getUpstream,
  listUpstreams,
  setActiveUpstream,
  updateUpstream,
  type Upstream
} from "./database.js";
import { proxyRequest } from "./proxy.js";
import { configureCodex, resolveCodexHome } from "./codex-config.js";
import { configureImageEnvironment, configureMacProxyBypass, configureWindowsProxyBypass } from "./image-environment.js";
import { parse as parseToml } from "@iarna/toml";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { markCodexConfigurationCurrent } from "./gateway-port-state.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Probe = { healthy: boolean; latencyMs?: number; error?: string; checkedAt?: string };
type GatewayTestResult = { endpoint: "/v1/responses"; stream: boolean; status: number; outputText: string | null; truncated: boolean };
type ConfigurationSelection = { software: boolean; image: boolean; softwareBaseUrl: string; imageBaseUrl: string; softwareApiKey: string; imageApiKey: string };
const probes = new Map<string, Probe>();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const app = express();
app.disable("x-powered-by");

/**
 * 判断请求来源是否是本机管理页。
 * @param origin 浏览器发送的 Origin 请求头。
 * @returns 来源允许访问本机 Controller 时返回 true。
 * @remarks 不接受任意 Origin，避免将本地管理接口暴露给其他网页。
 */
function isAllowedControllerOrigin(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
}

/**
 * 写入仅由浏览器自动携带的本地管理会话 Cookie。
 * @param _request Express 请求对象，保留以与 Express 中间件签名一致。
 * @param response Express 响应对象。
 * @returns 无返回值。
 * @remarks Cookie 仅由本机浏览器自动携带；其值不会进入 HTML、日志或其他客户端代码。
 */
function issueSessionCookie(_request: Request, response: Response): void {
  response.cookie("gateway_session", sessionCookieValue(), {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/"
  });
}

app.use("/api", express.json({ limit: "32kb" }));

function cookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.header("cookie") ?? "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]] : [];
  }));
}

function requireLocalToken(request: Request, response: Response, next: NextFunction): void {
  const supplied = cookies(request).gateway_session ? Buffer.from(cookies(request).gateway_session) : undefined;
  const expected = Buffer.from(sessionCookieValue());
  const valid = Boolean(supplied && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected));
  const origin = request.header("origin");
  if (!valid || !isAllowedControllerOrigin(origin)) {
    response.status(401).json({ error: "需要本地 Controller 会话令牌。" });
    return;
  }
  next();
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : null;
}

function routeId(request: Request): string | null {
  return typeof request.params.id === "string" ? request.params.id : null;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

function publicStatus() {
  const active = activeUpstream();
  return {
    gateway: { healthy: true, baseUrl: `http://${config.host}:${config.port}`, proxyPath: "/v1/*" },
    codexConfiguration: { available: Boolean(config.accessToken.trim()), automaticMigrationError: null },
    activeUpstream: active ? { id: active.id, name: active.name, apiBase: active.apiBase } : null,
    upstreams: listUpstreams().map((upstream) => ({ ...upstream, ...probes.get(upstream.id) })),
    notice: "网关会将每个 Codex 请求原样转发到当前中转，不改写模型名或流式响应。切换只影响后续请求。"
  };
}

/**
 * 读取一键配置对话框可安全展示的当前 Codex 配置摘要。
 * @returns 不含认证材料的 provider、模型与目标地址摘要。
 * @throws 配置文件无法读取或 TOML 格式损坏时抛出错误。
 */
async function codexConfigurationPreview(): Promise<{ software: { provider: string; model: string | null; currentBaseUrl: string | null; plannedBaseUrl: string }; image: { currentBaseUrl: string | null; currentApiKeyConfigured: boolean; gatewayApiKeyAvailable: boolean; plannedBaseUrl: string; persistence: string } }> {
  const codexHome = resolveCodexHome();
  const configPath = path.join(codexHome, "config.toml");
  let provider = "openai（Codex 默认）";
  let model: string | null = null;
  let currentBaseUrl: string | null = null;
  try {
    const parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const currentProvider = typeof parsed.model_provider === "string" && parsed.model_provider.trim() ? parsed.model_provider.trim() : null;
    if (currentProvider) provider = currentProvider;
    if (typeof parsed.model === "string" && parsed.model.trim()) model = parsed.model.trim();
    if (!currentProvider || currentProvider === "openai") {
      currentBaseUrl = typeof parsed.openai_base_url === "string" && parsed.openai_base_url.trim() ? parsed.openai_base_url.trim() : null;
    } else {
      const providers = parsed.model_providers;
      const providerConfig = providers && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as Record<string, unknown>)[currentProvider]
        : null;
      if (providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig)) {
        const baseUrl = (providerConfig as Record<string, unknown>).base_url;
        currentBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const targetBaseUrl = `http://127.0.0.1:${config.port}/v1`;
  return {
    software: { provider, model, currentBaseUrl, plannedBaseUrl: targetBaseUrl },
    image: {
      currentBaseUrl: process.env.OPENAI_BASE_URL?.trim() || null,
      currentApiKeyConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      gatewayApiKeyAvailable: Boolean(config.accessToken.trim()),
      plannedBaseUrl: targetBaseUrl,
      persistence: process.platform === "darwin" ? "macOS 图形会话、Zsh 与 Bash" : process.platform === "win32" ? "Windows 当前用户环境" : "当前系统不支持自动持久化"
    }
  };
}

/**
 * 将本地配置失败原因转换为不包含路径、凭据或底层错误详情的管理页提示。
 * @param error 配置服务抛出的原始错误。
 * @returns 可安全返回给浏览器的中文错误。
 */
function publicCodexConfigurationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    "未设置 GATEWAY_ACCESS_TOKEN，无法配置 Codex 认证。",
    "当前 Codex config.toml 格式无效，未执行配置。",
    "当前 Codex auth.json 格式无效，未执行配置。",
    "当前 model_provider 未定义可更新的 provider，未执行配置。",
    "本地 Gateway 端口无效，未执行配置。",
    "本地 Gateway 地址无效，未执行配置。",
    "配置地址无效，请填写 http:// 或 https:// 地址。",
    "配置密钥无效，请填写非空密钥。",
    "Codex 配置目录无效，未执行配置。",
    "本地 Gateway 认证信息不完整，无法配置生图环境变量。",
    "当前系统暂不支持自动配置生图环境变量。"
  ];
  return allowed.includes(message) ? message : "无法写入 Codex 配置，请确认当前用户拥有本地 Codex 配置目录的访问权限。";
}

/**
 * 将当前用户的 Codex 全局配置安全切换到本地 Gateway。
 * @param _request 已通过本地会话校验的管理请求。
 * @param response Express 响应对象。
 * @returns 配置完成后的 Promise。
 * @remarks 响应仅返回执行状态，绝不返回访问令牌、认证内容或配置文件路径。
 */
async function configureLocalCodex(_request: Request, response: Response): Promise<void> {
  try {
    const result = await configureCodex({
      accessToken: config.accessToken,
      gatewayHost: "127.0.0.1",
      gatewayPort: config.port
    });
    try {
      markCodexConfigurationCurrent(config.dataDir, config.port);
      response.json(result);
    } catch {
      response.json({
        ...result,
        message: "Codex 已配置为使用本地 Gateway，但未能保存启动状态。请在重启 Gateway 后再次执行一键配置。"
      });
    }
  } catch (error) {
    response.status(400).json({ error: publicCodexConfigurationError(error) });
  }
}

/**
 * 向浏览器写入一条不含凭据的一键配置进度事件。
 * @param response SSE 响应对象。
 * @param message 要显示的中文进度文本。
 * @returns 无返回值。
 */
function writeConfigurationEvent(response: Response, message: string): void {
  response.write(`event: log\ndata: ${JSON.stringify({ message })}\n\n`);
}

/**
 * 校验并规范化管理页提交的配置地址。
 * @param value 候选的 API 基础地址。
 * @param fallback 未提供值时使用的本机 Gateway API 基础地址。
 * @returns 可安全写入配置的规范化 HTTP(S) 地址。
 * @throws 地址格式错误、包含认证信息或携带查询片段时抛出中文错误。
 * @remarks URL 中禁止用户名、密码、查询参数和片段，防止认证材料进入配置文件或日志。
 */
function configurationBaseUrl(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error("配置地址无效，请填写 http:// 或 https:// 地址。");
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("无效地址");
    return url.href.replace(/\/$/, "");
  } catch (_) {
    throw new Error("配置地址无效，请填写 http:// 或 https:// 地址。");
  }
}

/**
 * 校验用户选择写入的 API Key，空值时回退到 Controller 内存中的网关密钥。
 * @param value 候选 API Key；仅由本地管理页在用户主动输入后提交。
 * @param fallback 不输入自定义密钥时使用的本地 Gateway 认证材料。
 * @returns 可安全写入本地配置或环境变量的 API Key。
 * @throws 输入不是字符串、只包含空白或超过允许长度时抛出中文错误。
 * @remarks 返回值仅传给本地文件或本地系统环境，不写入 SSE、日志或管理接口响应。
 */
function configurationApiKey(value: unknown, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string") throw new Error("配置密钥无效，请填写非空密钥。");
  const key = value.trim();
  if (!key || key.length > 8_192 || /\r|\n/.test(value)) throw new Error("配置密钥无效，请填写非空且不含换行的密钥。");
  return key;
}

/**
 * 校验管理页提交的配置步骤选择。
 * @param value 请求体中的候选选择对象。
 * @returns 合法且至少选中一项时的步骤选择，否则返回 null。
 * @throws 用户填写的地址不符合安全格式时抛出中文错误。
 * @remarks 仅接受布尔字段，避免错误请求意外写入用户的本地配置或环境变量。
 */
function selectedConfigurationSteps(value: unknown): ConfigurationSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selection = value as Record<string, unknown>;
  if (typeof selection.software !== "boolean" || typeof selection.image !== "boolean") return null;
  if (!selection.software && !selection.image) return null;
  const fallback = `http://127.0.0.1:${config.port}/v1`;
  return {
    software: selection.software,
    image: selection.image,
    softwareBaseUrl: selection.software ? configurationBaseUrl(selection.softwareBaseUrl, fallback) : fallback,
    imageBaseUrl: selection.image ? configurationBaseUrl(selection.imageBaseUrl, fallback) : fallback,
    softwareApiKey: selection.software ? configurationApiKey(selection.softwareApiKey, config.accessToken) : config.accessToken,
    imageApiKey: selection.image ? configurationApiKey(selection.imageApiKey, config.accessToken) : config.accessToken
  };
}

/**
 * 执行软件与生图配置，并以 SSE 分阶段返回可逐字展示的安全日志。
 * @param request 已通过本地会话校验且包含步骤选择的管理请求。
 * @param response SSE 响应对象。
 * @returns 流结束后的 Promise。
 * @remarks 不会发送 config.toml、auth.json、环境变量值或访问令牌。
 */
async function streamLocalConfiguration(request: Request, response: Response): Promise<void> {
  let selection: ConfigurationSelection | null;
  try {
    selection = selectedConfigurationSteps(request.body);
  } catch (error) {
    response.status(400).json({ error: publicCodexConfigurationError(error) });
    return;
  }
  if (!selection) {
    response.status(400).json({ error: "请至少选择一项配置。" });
    return;
  }
  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();
  try {
    if (selection.software) {
      writeConfigurationEvent(response, "[软件配置] 正在校验本机 Codex 配置...");
      await configureCodex({ accessToken: selection.softwareApiKey, gatewayHost: "127.0.0.1", gatewayPort: config.port, gatewayBaseUrl: selection.softwareBaseUrl });
      markCodexConfigurationCurrent(config.dataDir, config.port);
      writeConfigurationEvent(response, "[软件配置] config.toml 与 auth.json 已安全更新。");
    }
    if (selection.image) {
      writeConfigurationEvent(response, "[生图配置] 正在写入 OPENAI_API_KEY...");
      await configureImageEnvironment({ accessToken: selection.imageApiKey, baseUrl: selection.imageBaseUrl });
      writeConfigurationEvent(response, "[生图配置] OPENAI_BASE_URL 已指向本机 Gateway。");
    }
    if (process.platform === "win32") {
      await configureWindowsProxyBypass();
      writeConfigurationEvent(response, "[本机网络] Windows 本机地址已加入代理绕过列表。");
    } else if (process.platform === "darwin") {
      await configureMacProxyBypass();
      writeConfigurationEvent(response, "[本机网络] macOS 本机地址已加入代理绕过列表。");
    }
    const message = selection.software && selection.image
      ? "两类配置均已完成。请重启 Codex；新的终端或生图进程会读取环境变量。"
      : selection.software
        ? "软件配置已完成。请重启 Codex 使新的请求入口生效。"
        : "生图配置已完成。请新开终端或生图进程以读取环境变量。";
    response.write(`event: complete\ndata: ${JSON.stringify({ message })}\n\n`);
  } catch (error) {
    response.write(`event: error\ndata: ${JSON.stringify({ error: publicCodexConfigurationError(error) })}\n\n`);
  } finally {
    response.end();
  }
}

async function probe(upstream: Upstream): Promise<Probe> {
  const started = performance.now();
  try {
    const response = await fetch(`${upstream.apiBase}/models`, {
      headers: { authorization: `Bearer ${upstream.apiKey}` }, signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = { healthy: true, latencyMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() };
    probes.set(upstream.id, value);
    return value;
  } catch (error) {
    const value = { healthy: false, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    probes.set(upstream.id, value);
    return value;
  }
}

function modelIds(value: unknown): string[] {
  const source = record(value)?.data;
  if (!Array.isArray(source)) return [];
  return [...new Set(source.flatMap((model) => {
    if (typeof model === "string") return [model];
    const id = record(model)?.id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))].sort((left, right) => left.localeCompare(right)).slice(0, 500);
}

async function availableModels(upstream: Upstream): Promise<string[]> {
  const started = performance.now();
  try {
    const response = await fetch(`${upstream.apiBase}/models`, {
      headers: { authorization: `Bearer ${upstream.apiKey}` }, signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`中转返回 HTTP ${response.status}`);
    const models = modelIds(await response.json());
    probes.set(upstream.id, { healthy: true, latencyMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString() });
    return models;
  } catch (error) {
    probes.set(upstream.id, { healthy: false, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function responseOutputText(value: unknown): string | null {
  const response = record(value);
  if (!response) return null;
  if (typeof response.output_text === "string") return response.output_text;
  if (record(response.response)) return responseOutputText(response.response);
  const output = Array.isArray(response.output) ? response.output : [];
  const text = output.flatMap((item) => {
    const content = record(item)?.content;
    return Array.isArray(content) ? content.flatMap((part) => {
      const value = record(part);
      return value?.type === "output_text" && typeof value.text === "string" ? [value.text] : [];
    }) : [];
  }).join("");
  return text || null;
}

function streamedOutputText(sse: string): string | null {
  const deltas: string[] = [];
  const completed: string[] = [];
  for (const event of sse.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const payload = record(JSON.parse(data));
      if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") deltas.push(payload.delta);
      else if (payload?.type === "response.output_text.done" && typeof payload.text === "string") completed.push(payload.text);
      else {
        const text = responseOutputText(payload);
        if (text) completed.push(text);
      }
    } catch (_) {}
  }
  return (deltas.length ? deltas : completed).join("") || null;
}

async function simulateCodexRequest(model: string, prompt: string, stream: boolean): Promise<GatewayTestResult> {
  return simulateResponseRequest(`http://127.0.0.1:${config.port}/v1/responses`, config.accessToken, model, prompt, stream);
}

async function simulateUpstreamRequest(upstream: Upstream, model: string, prompt: string, stream: boolean): Promise<GatewayTestResult> {
  return simulateResponseRequest(`${upstream.apiBase}/responses`, upstream.apiKey, model, prompt, stream);
}

async function requestResponse(url: string, apiKey: string, model: string, prompt: string, stream: boolean): Promise<globalThis.Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: prompt, stream }),
    signal: AbortSignal.timeout(60_000)
  });
}

async function simulateResponseRequest(url: string, apiKey: string, model: string, prompt: string, stream: boolean): Promise<GatewayTestResult> {
  const response = await requestResponse(url, apiKey, model, prompt, stream);
  const text = await response.text();
  const truncated = text.length > 65_536;
  const limited = truncated ? text.slice(0, 65_536) : text;
  const json = (response.headers.get("content-type") ?? "").includes("application/json");
  let outputText: string | null = null;
  try { outputText = json ? responseOutputText(JSON.parse(limited)) : streamedOutputText(limited); } catch (_) {}
  return { endpoint: "/v1/responses", stream, status: response.status, outputText, truncated };
}

function writeTestEvent(response: Response, event: "delta" | "complete" | "error", data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function textFromSseFrame(frame: string): string | null {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const payload = record(JSON.parse(data));
    if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") return payload.delta;
    if (payload?.type === "response.output_text.done" && typeof payload.text === "string") return payload.text;
    return responseOutputText(payload);
  } catch (_) {}
  return null;
}

async function streamResponseRequest(controllerResponse: Response, url: string, apiKey: string, model: string, prompt: string): Promise<void> {
  const upstreamResponse = await requestResponse(url, apiKey, model, prompt, true);
  if (!upstreamResponse.ok) {
    const detail = (await upstreamResponse.text()).slice(0, 1_000);
    controllerResponse.status(upstreamResponse.status).json({ error: `中转返回 HTTP ${upstreamResponse.status}${detail ? `：${detail}` : ""}` });
    return;
  }
  if (!upstreamResponse.body) throw new Error("中转没有返回流式响应正文。");

  controllerResponse.status(200);
  controllerResponse.setHeader("content-type", "text/event-stream; charset=utf-8");
  controllerResponse.setHeader("cache-control", "no-cache, no-transform");
  controllerResponse.setHeader("connection", "keep-alive");
  controllerResponse.flushHeaders();

  // 只向浏览器转发模型文本增量，不泄露原始上游事件或认证信息。
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let receivedDelta = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const text = textFromSseFrame(frame);
        if (text) {
          if (receivedDelta && (frame.includes("response.output_text.done") || frame.includes("response.completed"))) {
            // 结束事件会重复携带完整文本，已发送增量时跳过它。
          } else {
            receivedDelta = true;
            writeTestEvent(controllerResponse, "delta", { text });
          }
        }
        boundary = pending.search(/\r?\n\r?\n/);
      }
    }
    const finalText = textFromSseFrame(pending);
    if (finalText && !receivedDelta) writeTestEvent(controllerResponse, "delta", { text: finalText });
    writeTestEvent(controllerResponse, "complete", { endpoint: "/v1/responses", stream: true, status: upstreamResponse.status, outputText: null, truncated: false });
  } catch (error) {
    writeTestEvent(controllerResponse, "error", { error: `接收流式响应失败：${error instanceof Error ? error.message : String(error)}` });
  } finally {
    controllerResponse.end();
  }
}

async function streamCodexRequest(response: Response, model: string, prompt: string): Promise<void> {
  await streamResponseRequest(response, `http://127.0.0.1:${config.port}/v1/responses`, config.accessToken, model, prompt);
}

async function streamUpstreamRequest(response: Response, upstream: Upstream, model: string, prompt: string): Promise<void> {
  await streamResponseRequest(response, `${upstream.apiBase}/responses`, upstream.apiKey, model, prompt);
}

app.get("/health", (_request, response) => response.json({ ok: true, activeUpstreamId: activeUpstreamId() }));
/**
 * 返回公开网关状态，并在嵌入页首次带凭据读取时建立本地管理会话。
 * @param request Express 请求对象，用于区分 Codex blob 嵌入页与普通本地页面。
 * @param response Express 响应对象。
 * @returns 无返回值。
 * @remarks 该接口不返回会话令牌；浏览器仅从 `Set-Cookie` 接收 HttpOnly Cookie，后续写请求会自动携带它。
 */
app.get("/api/status", (request, response) => {
  issueSessionCookie(request, response);
  response.json(publicStatus());
});
app.get("/api/codex/configuration-preview", requireLocalToken, async (_request, response) => {
  try {
    response.json(await codexConfigurationPreview());
  } catch {
    response.status(400).json({ error: "无法读取当前 Codex 配置摘要。" });
  }
});
app.post("/api/codex/configure", requireLocalToken, configureLocalCodex);
app.post("/api/codex/configure/stream", requireLocalToken, streamLocalConfiguration);
app.get("/api/upstreams", (_request, response) => response.json({ upstreams: publicStatus().upstreams }));
app.get("/api/upstreams/:id/models", requireLocalToken, async (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  if (!upstream) return response.status(404).json({ error: "未知中转" });
  try {
    response.json({ models: await availableModels(upstream) });
  } catch (error) {
    response.status(502).json({ error: `读取模型列表失败：${error instanceof Error ? error.message : String(error)}` });
  }
});
app.post("/api/upstreams", requireLocalToken, (request, response) => {
  const id = normalizeId(request.body?.id);
  const name = typeof request.body?.name === "string" ? request.body.name.trim().slice(0, 100) : "";
  const apiBase = normalizeUrl(request.body?.apiBase);
  const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
  if (!id || !name || !apiBase || !apiKey) return response.status(400).json({ error: "必须提供 id、name、apiBase 和 apiKey。" });
  if (getUpstream(id)) return response.status(409).json({ error: "该中转标识符已存在。" });
  response.status(201).json(createUpstream({ id, name, apiBase, apiKey }));
});
app.patch("/api/upstreams/:id", requireLocalToken, (request, response) => {
  const id = routeId(request);
  const existing = id ? getUpstream(id) : undefined;
  if (!existing) return response.status(404).json({ error: "未知中转" });
  const update: Partial<Pick<Upstream, "name" | "apiBase" | "apiKey">> = {};
  if (request.body?.name !== undefined) {
    const name = typeof request.body.name === "string" ? request.body.name.trim().slice(0, 100) : "";
    if (!name) return response.status(400).json({ error: "名称不能为空。" });
    update.name = name;
  }
  if (request.body?.apiBase !== undefined) {
    const apiBase = normalizeUrl(request.body.apiBase);
    if (!apiBase) return response.status(400).json({ error: "apiBase 必须为 http(s) URL。" });
    update.apiBase = apiBase;
  }
  if (request.body?.apiKey !== undefined) {
    if (typeof request.body.apiKey !== "string" || !request.body.apiKey.trim()) return response.status(400).json({ error: "apiKey 不能为空。" });
    update.apiKey = request.body.apiKey.trim();
  }
  response.json(updateUpstream(existing.id, update));
});
app.delete("/api/upstreams/:id", requireLocalToken, (request, response) => {
  const id = routeId(request);
  if (!id || !getUpstream(id)) return response.status(404).json({ error: "未知中转" });
  if (activeUpstreamId() === id) clearActiveUpstream();
  deleteUpstream(id);
  response.status(204).end();
});
app.post("/api/upstreams/:id/test", requireLocalToken, async (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  if (!upstream) return response.status(404).json({ error: "未知中转" });
  response.json(await probe(upstream));
});
app.post("/api/upstreams/:id/activate", requireLocalToken, (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  if (!upstream) return response.status(404).json({ error: "未知中转" });
  setActiveUpstream(upstream.id);
  response.json({ ok: true, activeUpstream: { id: upstream.id, name: upstream.name, apiBase: upstream.apiBase }, message: "已生效，仅影响后续请求；模型名会原样透传。" });
});
app.post("/api/test-request", requireLocalToken, async (request, response) => {
  const model = typeof request.body?.model === "string" ? request.body.model.trim().slice(0, 200) : "";
  const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim().slice(0, 8_000) : "";
  const stream = request.body?.stream === true;
  if (!activeUpstream()) return response.status(400).json({ error: "请先选择当前中转。" });
  if (!model || !prompt) return response.status(400).json({ error: "必须填写模型名和测试消息。" });
  try {
    if (stream) return await streamCodexRequest(response, model, prompt);
    response.json(await simulateCodexRequest(model, prompt, stream));
  } catch (error) {
    response.status(502).json({ error: `模拟 Codex 请求失败：${error instanceof Error ? error.message : String(error)}` });
  }
});
app.post("/api/upstreams/:id/test-request", requireLocalToken, async (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  const model = typeof request.body?.model === "string" ? request.body.model.trim().slice(0, 200) : "";
  const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim().slice(0, 8_000) : "";
  const stream = request.body?.stream === true;
  if (!upstream) return response.status(404).json({ error: "未知中转" });
  if (!model || !prompt) return response.status(400).json({ error: "必须填写模型名和测试消息。" });
  try {
    if (stream) return await streamUpstreamRequest(response, upstream, model, prompt);
    response.json(await simulateUpstreamRequest(upstream, model, prompt, stream));
  } catch (error) {
    response.status(502).json({ error: `测试中转失败：${error instanceof Error ? error.message : String(error)}` });
  }
});

app.all("/v1/{*path}", proxyRequest);

/**
 * 解析管理页静态资源目录。
 * @returns 包含 `index.html` 的管理页目录绝对路径。
 * @throws 所有候选目录都缺少管理页入口时抛出错误。
 * @remarks 优先使用桌面启动器传入的目录；兼容开发构建、runtime 打包和直接启动场景，避免回退到不存在的 `Contents/dist-web`。
 */
function resolveWebRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.GATEWAY_WEB_DIR,
    path.join(moduleDirectory, "dist-web"),
    path.resolve(moduleDirectory, "../../dist-web"),
    path.resolve(process.cwd(), "dist-web")
  ].filter((candidate): candidate is string => Boolean(candidate?.trim())).map((candidate) => path.resolve(candidate));
  const selected = candidates.find((candidate) => existsSync(path.join(candidate, "index.html")));
  if (!selected) throw new Error("管理页静态资源缺失，无法启动 Gateway。");
  return selected;
}

const webRoot = resolveWebRoot();
app.use((request, response, next) => {
  if (request.method === "GET" && !request.path.startsWith("/api") && request.path !== "/health" && !request.path.startsWith("/v1/")) {
    issueSessionCookie(request, response);
  }
  next();
});
app.use(express.static(webRoot));
app.get("/{*path}", (_request, response) => {
  response.sendFile(path.join(webRoot, "index.html"), (error) => {
    if (error && !response.headersSent) response.status(503).send("管理页资源暂不可用，请重启 Codex Gateway Control。\n");
  });
});

const httpServer = app.listen(config.port, config.host, () => console.log(`Codex Gateway 代理已监听 http://${config.host}:${config.port}`));

/**
 * 在本地监听端口不可用时退出，避免留下半可用 Controller。
 * @param protocol 发生错误的监听协议名称。
 * @returns 无返回值。
 * @remarks 不输出底层路径、请求令牌或其他私密配置；启动器可据此报告明确的本地端口冲突。
 */
function failOnListenError(protocol: "HTTP"): (error: NodeJS.ErrnoException) => void {
  return (error) => {
    const port = config.port;
    const reason = error.code === "EADDRINUSE" ? "端口已被其他本地程序占用" : "无法绑定本地端口";
    console.error(`Codex Gateway ${protocol} 启动失败：127.0.0.1:${port} ${reason}。`);
    httpServer.close();
    process.exitCode = 1;
  };
}

httpServer.once("error", failOnListenError("HTTP"));
