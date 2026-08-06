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
    response.status(401).json({ error: "A local Controller session token is required." });
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
    notice: "The Gateway forwards each Codex request unchanged to the active upstream. Model names and streaming responses are not rewritten. Switching affects later requests only."
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

app.get("/health", (_request, response) => response.json({ ok: true, activeUpstreamId: activeUpstreamId() }));
app.get("/api/status", (_request, response) => response.json(publicStatus()));
app.get("/api/upstreams", (_request, response) => response.json({ upstreams: publicStatus().upstreams }));
app.post("/api/upstreams", requireLocalToken, (request, response) => {
  const id = normalizeId(request.body?.id);
  const name = typeof request.body?.name === "string" ? request.body.name.trim().slice(0, 100) : "";
  const apiBase = normalizeUrl(request.body?.apiBase);
  const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
  if (!id || !name || !apiBase || !apiKey) return response.status(400).json({ error: "id, name, apiBase, and apiKey are required." });
  if (getUpstream(id)) return response.status(409).json({ error: "An upstream with this id already exists." });
  response.status(201).json(createUpstream({ id, name, apiBase, apiKey }));
});
app.patch("/api/upstreams/:id", requireLocalToken, (request, response) => {
  const id = routeId(request);
  const existing = id ? getUpstream(id) : undefined;
  if (!existing) return response.status(404).json({ error: "Unknown upstream" });
  const update: Partial<Pick<Upstream, "name" | "apiBase" | "apiKey">> = {};
  if (request.body?.name !== undefined) {
    const name = typeof request.body.name === "string" ? request.body.name.trim().slice(0, 100) : "";
    if (!name) return response.status(400).json({ error: "name must not be empty." });
    update.name = name;
  }
  if (request.body?.apiBase !== undefined) {
    const apiBase = normalizeUrl(request.body.apiBase);
    if (!apiBase) return response.status(400).json({ error: "apiBase must be an http(s) URL." });
    update.apiBase = apiBase;
  }
  if (request.body?.apiKey !== undefined) {
    if (typeof request.body.apiKey !== "string" || !request.body.apiKey.trim()) return response.status(400).json({ error: "apiKey must not be empty." });
    update.apiKey = request.body.apiKey.trim();
  }
  response.json(updateUpstream(existing.id, update));
});
app.delete("/api/upstreams/:id", requireLocalToken, (request, response) => {
  const id = routeId(request);
  if (!id || !getUpstream(id)) return response.status(404).json({ error: "Unknown upstream" });
  if (activeUpstreamId() === id) clearActiveUpstream();
  deleteUpstream(id);
  response.status(204).end();
});
app.post("/api/upstreams/:id/test", requireLocalToken, async (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  if (!upstream) return response.status(404).json({ error: "Unknown upstream" });
  response.json(await probe(upstream));
});
app.post("/api/upstreams/:id/activate", requireLocalToken, (request, response) => {
  const id = routeId(request);
  const upstream = id ? getUpstream(id) : undefined;
  if (!upstream) return response.status(404).json({ error: "Unknown upstream" });
  setActiveUpstream(upstream.id);
  response.json({ ok: true, activeUpstream: { id: upstream.id, name: upstream.name, apiBase: upstream.apiBase }, message: "Applied to future requests only. Model names are forwarded unchanged." });
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

app.listen(config.port, config.host, () => console.log(`Codex Gateway listening on http://${config.host}:${config.port}`));
