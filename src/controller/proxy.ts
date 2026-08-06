import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { activeUpstream } from "./database.js";
import { config } from "./config.js";

const hopByHopHeaders = new Set(["connection", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

function authorized(request: Request): boolean {
  if (!config.accessToken) return true;
  const value = request.header("authorization") ?? "";
  return value === `Bearer ${config.accessToken}`;
}

function requestHeaders(request: Request, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (hopByHopHeaders.has(name.toLowerCase()) || name.toLowerCase() === "authorization" || name.toLowerCase() === "x-api-key") continue;
    if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export async function proxyRequest(request: Request, response: Response): Promise<void> {
  if (!authorized(request)) {
    response.status(401).json({ error: { message: "Invalid local Gateway API key", type: "authentication_error" } });
    return;
  }
  const upstream = activeUpstream();
  if (!upstream) {
    response.status(503).json({ error: { message: "No active upstream selected in Codex Gateway Control", type: "gateway_error" } });
    return;
  }
  const url = new URL(request.originalUrl, `${upstream.apiBase.replace(/\/$/, "")}/`);
  try {
    const upstreamResponse = await fetch(url, {
      method: request.method,
      headers: requestHeaders(request, upstream.apiKey),
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request,
      // Node requires this for a streamed request body.
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000)
    } as RequestInit);
    response.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== "content-encoding") response.setHeader(name, value);
    });
    if (!upstreamResponse.body) { response.end(); return; }
    Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream).pipe(response);
  } catch (error) {
    response.status(502).json({ error: { message: `Upstream ${upstream.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`, type: "gateway_error" } });
  }
}
