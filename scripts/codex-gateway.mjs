#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultPort = Number(process.env.CODEX_CDP_PORT ?? 9237);
const controllerUrl = process.env.GATEWAY_ORIGIN ?? "http://127.0.0.1:4000";
const injectionPath = path.join(root, "inject", "codex-gateway.user.js");

function parseArgs(argv) {
  const options = {
    port: defaultPort,
    launch: false,
    attachExisting: false,
    watch: false,
    open: false,
    appPath: process.env.CODEX_APP_PATH || "/Applications/ChatGPT.app"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`未知选项：${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error("--port 必须是 1024 到 65535 之间的整数");
  }
  if (options.launch && options.attachExisting) {
    throw new Error("请只使用 --launch 或 --attach-existing 其中之一");
  }
  if (!options.launch && !options.attachExisting) options.launch = true;
  return options;
}

async function reachable(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待${label}超时`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)));
  });
}

function startController() {
  const entry = path.join(root, "dist-controller", "controller", "index.js");
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: "inherit" });
  child.once("error", (error) => console.error(`Controller 进程错误：${error.message}`));
  return child;
}

async function ensureController() {
  if (await reachable(`${controllerUrl}/health`)) return { child: null, started: false };
  console.log("正在启动本地 Gateway Controller...");
  const child = startController();
  try {
    await waitFor(`${controllerUrl}/health`, 15_000, "Gateway Controller 服务");
    return { child, started: true };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

function launchCodex(appPath, port) {
  console.log(`正在 CDP 端口 ${port} 启动独立的 Gateway-enabled Codex 实例...`);
  return spawn("/usr/bin/open", [
    "-n", "-a", appPath, "--args",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`
  ], { stdio: "ignore" });
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.waiters = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("CDP WebSocket 连接失败")));
    });
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (!message.id) {
        const waiters = this.waiters.get(message.method) || [];
        this.waiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        for (const handler of this.handlers.get(message.method) || []) {
          Promise.resolve(handler(message.params)).catch((error) => console.error(`CDP ${message.method} 错误：${error.message}`));
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.on("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket 已关闭");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.handlers.clear();
      this.waiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.waiters.clear();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.set(method, (this.waiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve));
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const waiters = this.waiters.get(method) || [];
      waiters.push({ resolve: wrappedResolve, reject });
      this.waiters.set(method, waiters);
    });
  }

  close() { this.socket.close(); }
}

async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CDP target 发现请求返回 ${response.status}`);
  const targets = await response.json();
  return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl && (
    target.url?.startsWith("app://") || target.url?.startsWith("codex://") || /codex|chatgpt/i.test(target.title || "")
  ));
}

async function waitForCodexTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets(port);
      if (targets.length) return targets;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP 端口 ${port} 上未出现 Codex renderer target`);
}

async function currentSource() {
  const userSource = await readFile(injectionPath, "utf8");
  const runtime = `window.__CODEX_GATEWAY_URL__ = ${JSON.stringify(`${controllerUrl}/`)};\n${userSource}`;
  const hash = createHash("sha256").update(runtime).digest("hex");
  return {
    hash,
    source: `window.__CODEX_GATEWAY_SOURCE_HASH__ = ${JSON.stringify(hash)};\n${runtime}\n//# sourceURL=codex-gateway.user.js`
  };
}

function frameTreeContains(tree, expectedUrl) {
  if (tree.frame?.url === expectedUrl) return true;
  return tree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree")
    ]);
    if (targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) || frameTreeContains(frameTree, expectedUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function injectionStatus(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "window.__codexGatewayInjection__?.status?.() || null",
    returnByValue: true
  });
  return result.result.value;
}

async function waitForStatus(cdp, sourceHash, shouldOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await injectionStatus(cdp);
    const ready = status?.sourceHash === sourceHash && status.entryMounted;
    const frameReady = !shouldOpen || (status?.pageVisible && status.frameUrl && status.frameLoaded);
    if (ready && frameReady) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Gateway 入口或 iframe 未能挂载到 Codex renderer");
}

async function evaluate(cdp, source) {
  const result = await cdp.send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Gateway 注入失败");
}

async function replaceDocumentScript(cdp, state, source) {
  if (state.scriptIdentifier) {
    try { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.scriptIdentifier }); } catch (_) {}
  }
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  state.scriptIdentifier = registration.identifier;
}

async function injectTarget(target, source, hash, shouldOpen, states) {
  let state = states.get(target.id);
  if (!state || state.cdp.closed) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    state = { cdp, scriptIdentifier: null, sourceHash: null, reloaded: false, target };
    states.set(target.id, state);
  }
  state.target = target;
  const { cdp } = state;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.setBypassCSP", { enabled: true });

  if (state.sourceHash !== hash) {
    await replaceDocumentScript(cdp, state, source);
    state.sourceHash = hash;
    await evaluate(cdp, source);
  }
  if (!state.reloaded) {
    state.reloaded = true;
    const loaded = cdp.waitFor("Page.loadEventFired", 15_000);
    await cdp.send("Page.reload", { ignoreCache: true });
    await loaded;
  }
  await evaluate(cdp, source);
  if (shouldOpen) await cdp.send("Runtime.evaluate", { expression: "window.__codexGatewayInjection__?.open()", returnByValue: true });
  const status = await waitForStatus(cdp, hash, shouldOpen, 15_000);
  const frameLoaded = shouldOpen ? await waitForFrame(cdp, status.frameUrl, 15_000) : false;
  if (shouldOpen && !frameLoaded) throw new Error("Gateway iframe 元素已挂载，但其 frame 未完成加载");
  return { targetId: target.id, title: target.title, url: target.url, cspBypassed: true, frameLoaded, ...status };
}

async function reconcile(port, source, hash, shouldOpen, states) {
  const targets = await cdpTargets(port);
  if (!targets.length) throw new Error("未找到 Codex renderer target");
  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, state] of states) {
    if (!activeIds.has(id) || state.cdp.closed) {
      state.cdp.close();
      states.delete(id);
    }
  }
  const results = [];
  for (const target of targets) {
    const openThisTarget = shouldOpen && results.length === 0 && ![...states.values()].some((state) => state.opened);
    const result = await injectTarget(target, source, hash, openThisTarget, states);
    if (openThisTarget) states.get(target.id).opened = true;
    results.push(result);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cdpVersion = `http://127.0.0.1:${options.port}/json/version`;
  let controller = null;
  const states = new Map();
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    states.forEach((state) => state.cdp.close());
    if (controller?.started && controller.child?.exitCode === null) controller.child.kill("SIGTERM");
    // 此启动器不管理任何外部服务。
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    controller = await ensureController();
    const cdpAvailable = await reachable(cdpVersion);
    if (options.attachExisting && !cdpAvailable) {
      throw new Error(`无法附加：Codex CDP 未监听 127.0.0.1:${options.port}。请使用 --remote-debugging-port=${options.port} 启动 Codex，或运行 npm run codex 创建独立的 Gateway-enabled 实例。`);
    }
    if (!cdpAvailable && options.launch) {
      launchCodex(options.appPath, options.port);
      await waitFor(cdpVersion, 30_000, `Codex CDP on port ${options.port}`);
    }
    await waitForCodexTarget(options.port, 30_000);
    let current = await currentSource();
    const first = await reconcile(options.port, current.source, current.hash, options.open, states);
    console.log(JSON.stringify({ injected: first }, null, 2));
    if (!options.watch) return;

    while (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        if (!(await reachable(`${controllerUrl}/health`))) {
          controller = await ensureController();
        }
        const latest = await currentSource();
        current = latest;
        const results = await reconcile(options.port, latest.source, latest.hash, false, states);
        if (results.length) console.log(JSON.stringify({ reconciled: results }, null, 2));
      } catch (error) {
        if (!stopping) console.error(`Gateway 启动器正在等待 Codex：${error.message}`);
      }
    }
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
