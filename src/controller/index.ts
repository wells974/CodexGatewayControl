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
import path from "node:path";
import { fileURLToPath } from "node:url";

type Probe = { healthy: boolean; latencyMs?: number; error?: string; checkedAt?: string };
type GatewayTestResult = { endpoint: "/v1/responses"; stream: boolean; status: number; outputText: string | null; truncated: boolean };
const probes = new Map<string, Probe>();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const app = express();
app.disable("x-powered-by");
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
  if (!valid || (origin && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin))) {
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
    activeUpstream: active ? { id: active.id, name: active.name, apiBase: active.apiBase } : null,
    upstreams: listUpstreams().map((upstream) => ({ ...upstream, ...probes.get(upstream.id) })),
    notice: "网关会将每个 Codex 请求原样转发到当前中转，不改写模型名或流式响应。切换只影响后续请求。"
  };
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
app.get("/api/status", (_request, response) => response.json(publicStatus()));
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

const webRoot = path.join(root, "dist-web");
app.use((request, response, next) => {
  if (request.method === "GET" && !request.path.startsWith("/api") && request.path !== "/health" && !request.path.startsWith("/v1/")) {
    response.cookie("gateway_session", sessionCookieValue(), { httpOnly: true, sameSite: "strict", secure: false, path: "/" });
  }
  next();
});
app.use(express.static(webRoot));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(webRoot, "index.html")));

app.listen(config.port, config.host, () => console.log(`Codex Gateway 已监听 http://${config.host}:${config.port}`));
