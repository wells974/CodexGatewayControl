#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.GATEWAY_RUNTIME_ROOT ?? path.join(scriptDirectory, ".."));
const defaultPort = Number(process.env.CODEX_CDP_PORT ?? 9237);
const defaultControllerPort = Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000);
const defaultUiTlsPort = Number(process.env.GATEWAY_UI_TLS_PORT ?? 4401);
let controllerUrl = process.env.GATEWAY_ORIGIN ?? `http://127.0.0.1:${defaultControllerPort}`;
let gatewayUiOrigin = process.env.GATEWAY_UI_ORIGIN ?? `https://127.0.0.1:${defaultUiTlsPort}`;
const gatewayDataDirectory = path.resolve(process.env.GATEWAY_DATA_DIR ?? ".data");
const gatewayTlsCertificatePath = path.join(gatewayDataDirectory, "gateway-ui-cert.pem");
const injectionPath = path.resolve(process.env.CODEX_INJECTION_PATH ?? path.join(root, "inject", "codex-gateway.user.js"));
const controllerEntryPath = path.resolve(process.env.GATEWAY_CONTROLLER_ENTRY ?? path.join(root, "dist-controller", "controller", "index.js"));
const controllerPortIsExplicit = Boolean(process.env.GATEWAY_ORIGIN || process.env.GATEWAY_PORT || process.env.CONTROLLER_PORT);
const gatewayPortStatePath = path.join(gatewayDataDirectory, "gateway-port.json");

function parseArgs(argv) {
  const options = {
    port: defaultPort,
    launch: false,
    attachExisting: false,
    watch: false,
    open: false,
    forceReload: false,
    appPath: process.env.CODEX_APP_PATH || defaultDesktopPath(),
    userDataDir: path.resolve(process.env.CODEX_CDP_USER_DATA_DIR || ".data/codex-cdp-profile")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--force-reload") options.forceReload = true;
    else if (arg === "--skip-reload") options.forceReload = false;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else if (arg === "--user-data-dir") options.userDataDir = path.resolve(argv[++index]);
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

/**
 * 根据当前操作系统选择 Codex Desktop 的默认安装位置。
 * @returns {string} 可供 launcher 尝试启动的应用路径。
 * @remarks Windows 安装位置可能因商店版或企业部署而异，调用方可通过 `CODEX_APP_PATH` 覆盖。
 */
function defaultDesktopPath() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || ".", "Programs", "ChatGPT", "ChatGPT.exe");
  }
  if (process.platform === "darwin") return "/Applications/ChatGPT.app";
  return process.env.CODEX_DESKTOP_EXECUTABLE || "codex";
}

async function reachable(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 检查 Gateway 本机 HTTPS 管理页是否可达。
 * @param {string} url 仅指向本机 HTTPS 管理页的健康检查地址。
 * @param {number} timeoutMs 单次连接的超时时间。
 * @returns {Promise<boolean>} 收到成功 HTTP 响应时返回 true。
 * @remarks 仅对 loopback 自签名证书关闭本次 Node 健康检查的证书验证；不会改变 Desktop 或系统的 TLS 策略。
 */
async function reachableGatewayUi(url, timeoutMs = 1_500) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "127.0.0.1") return false;
  return new Promise((resolve) => {
    const request = https.get({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      rejectUnauthorized: false,
      timeout: timeoutMs
    }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400));
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

/**
 * 判断值是否可作为 Gateway 的稳定本机端口。
 * @param {unknown} value 待校验的端口值。
 * @returns {boolean} 值为 1024 到 65535 的整数时返回 true。
 * @remarks 与 Controller 端口状态格式保持一致，避免读取损坏状态后绑定无效端口。
 */
function isGatewayPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * 读取 launcher 保存的 Gateway 稳定端口状态。
 * @returns {Promise<{controllerPort: number, codexConfigurationRequired: boolean}|null>} 有效状态；不存在或无效时返回 null。
 * @remarks 状态文件仅保存本机端口和迁移标记，不保存认证材料或上游配置。
 */
async function readGatewayPortState() {
  try {
    const value = JSON.parse(await readFile(gatewayPortStatePath, "utf8"));
    if (!isGatewayPort(value?.controllerPort) || typeof value.codexConfigurationRequired !== "boolean") return null;
    return { controllerPort: value.controllerPort, codexConfigurationRequired: value.codexConfigurationRequired };
  } catch {
    return null;
  }
}

/**
 * 保存首次成功使用的 Gateway 代理端口。
 * @param {number} controllerPort 已启动并通过健康检查的代理端口。
 * @returns {Promise<void>} 状态文件成功替换后完成。
 * @throws 数据目录或状态文件无法创建、写入或替换时抛出错误。
 * @remarks 仅在未设置显式环境变量且状态不存在时调用，不会覆盖一键配置写入的迁移标记。
 */
async function persistInitialControllerPort(controllerPort) {
  if (controllerPortIsExplicit || !isGatewayPort(controllerPort)) return;
  if (await readGatewayPortState()) return;
  await mkdir(gatewayDataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${gatewayPortStatePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ controllerPort, codexConfigurationRequired: false })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, gatewayPortStatePath);
}

/**
 * 返回本轮必须使用的 Gateway HTTP 代理端口。
 * @returns {Promise<number>} 显式环境变量、已持久化状态或默认地址中的稳定端口。
 * @throws Controller 地址格式无效时由 URL 构造函数抛出异常。
 * @remarks HTTP 代理地址会写入 Codex config.toml，因此不使用自动递增端口策略。
 */
async function stableControllerPort() {
  const configuredPort = Number(new URL(controllerUrl).port) || 4000;
  if (controllerPortIsExplicit) return configuredPort;
  return (await readGatewayPortState())?.controllerPort ?? configuredPort;
}

/**
 * 检查指定 loopback 端口是否可被当前进程绑定。
 * @param {number} port 待检查的 TCP 端口。
 * @returns {Promise<boolean>} 可绑定时返回 true。
 * @remarks 检查完成即释放监听器，实际 Controller 仍会处理极小竞争窗口中的绑定失败。
 */
async function canBindLoopbackPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * 在 loopback 上寻找从指定端口开始的空闲 TCP 端口。
 * @param {number} preferredPort 优先尝试的端口。
 * @param {number[]} reservedPorts 本次启动已经预留、不可重复使用的端口。
 * @returns {Promise<number>} 可绑定的端口号。
 * @throws 从起始端口连续尝试到上限仍无空闲端口时抛出错误。
 * @remarks 只绑定 `127.0.0.1` 做探测，探测结束立即释放监听器；实际服务启动仍会处理并报告竞争占用。
 */
async function findLoopbackPort(preferredPort, reservedPorts = []) {
  const firstPort = Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
    ? preferredPort
    : 4000;
  const reserved = new Set(reservedPorts);
  for (let port = firstPort; port <= 65535; port += 1) {
    if (reserved.has(port)) continue;
    const available = await canBindLoopbackPort(port);
    if (available) return port;
  }
  throw new Error(`从端口 ${firstPort} 开始没有可用的本机端口。`);
}

/**
 * 将本地管理页 origin 替换为 launcher 实际选定的端口。
 * @param {string} origin 原始 HTTP(S) origin。
 * @param {number} port 新的 loopback 端口。
 * @returns {string} 保留协议和主机、仅更新端口后的 origin。
 * @throws origin 不是有效的 HTTP(S) URL 时抛出错误。
 */
function originWithPort(origin, port) {
  const parsed = new URL(origin);
  if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== "127.0.0.1") {
    throw new Error("Gateway Controller 和管理页必须监听 127.0.0.1。请检查 GATEWAY_ORIGIN/GATEWAY_UI_ORIGIN。");
  }
  parsed.port = String(port);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待${label}超时`);
}

/**
 * 等待 Gateway 本机 HTTPS 管理页可达。
 * @param {string} url 管理页健康检查地址。
 * @param {number} timeoutMs 最大等待时间。
 * @param {string} label 面向用户的服务名称。
 * @returns {Promise<void>} 服务可达时完成。
 * @throws 超过最大等待时间仍未收到成功响应时抛出错误。
 */
async function waitForGatewayUi(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachableGatewayUi(url)) return;
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

function startController(ports) {
  const child = spawn(process.execPath, [controllerEntryPath], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      CONTROLLER_HOST: "127.0.0.1",
      GATEWAY_PORT: String(ports.controllerPort),
      GATEWAY_UI_TLS_PORT: String(ports.uiTlsPort)
    }
  });
  child.once("error", (error) => console.error(`Controller 进程错误：${error.message}`));
  return child;
}

/**
 * 结束 launcher 自己启动的 Controller 进程。
 * @param {import("node:child_process").ChildProcess} child Controller 子进程。
 * @returns 无返回值。
 * @remarks Windows 使用 `taskkill /T` 清理进程树；不会触碰用户原有 Desktop 进程。
 */
function stopController(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function ensureController() {
  const controllerPort = await stableControllerPort();
  controllerUrl = originWithPort(controllerUrl, controllerPort);
  const proxyHealthy = await reachable(`${controllerUrl}/health`);
  const uiHealthy = await reachableGatewayUi(`${gatewayUiOrigin}/health`);
  if (proxyHealthy && uiHealthy) {
    await persistInitialControllerPort(controllerPort);
    return { child: null, started: false };
  }
  if (proxyHealthy) {
    throw new Error(`Gateway 代理端口 ${controllerPort} 已有正在运行的服务，但管理页不可用。为避免 Codex 配置指向错误端口，本次不会自动更换代理端口；请重启现有 Gateway 或释放该端口后重试。`);
  }
  if (!(await canBindLoopbackPort(controllerPort))) {
    throw new Error(`Gateway 代理端口 ${controllerPort} 已被其他本地程序占用。Codex config.toml 可能仍指向该端口，本次不会自动更换；请释放端口，或显式设置 GATEWAY_PORT 后重新执行一键配置。`);
  }
  const uiOrigin = new URL(gatewayUiOrigin);
  const uiTlsPort = await findLoopbackPort(Number(uiOrigin.port) || 4401, [controllerPort]);
  gatewayUiOrigin = originWithPort(gatewayUiOrigin, uiTlsPort);
  console.log(`Gateway 将使用代理端口 ${controllerPort}，管理页 HTTPS 端口 ${uiTlsPort}。`);
  console.log("正在启动本地 Gateway Controller...");
  const child = startController({ controllerPort, uiTlsPort });
  try {
    await waitFor(`${controllerUrl}/health`, 15_000, "Gateway Controller 服务");
    await waitForGatewayUi(`${gatewayUiOrigin}/health`, 15_000, "Gateway HTTPS 管理页");
    await persistInitialControllerPort(controllerPort);
    return { child, started: true };
  } catch (error) {
    stopController(child);
    throw error;
  }
}

/**
 * 计算本地 Gateway HTTPS 证书的 SPKI 指纹，供独立 Codex 精确放行该证书。
 * @returns {Promise<string>} 以 base64 编码的 SHA-256 SPKI 指纹。
 * @throws Controller 尚未生成证书或证书格式无效时抛出错误。
 * @remarks 只读取公开证书，不读取私钥、Controller 令牌或上游凭据。
 */
async function gatewayTlsSpki() {
  try {
    const certificate = new X509Certificate(await readFile(gatewayTlsCertificatePath));
    const publicKey = certificate.publicKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(publicKey).digest("base64");
  } catch {
    throw new Error("未找到 Gateway 本地 HTTPS 证书。请重启 Controller 后重试。");
  }
}

/**
 * 返回当前平台可直接启动的 Desktop 主进程路径。
 * @param {string} appPath macOS `.app`、Windows `.exe` 或 Linux 可执行文件路径。
 * @returns {string} 可由 Node 直接启动的 Desktop 主进程路径。
 * @throws 路径不存在时由后续 `spawn` 以系统错误形式报告。
 */
function desktopExecutable(appPath) {
  if (process.platform === "win32") return appPath.toLowerCase().endsWith(".exe") ? appPath : path.join(appPath, "ChatGPT.exe");
  if (process.platform === "darwin") return path.join(appPath, "Contents", "MacOS", path.basename(appPath, ".app"));
  return appPath;
}

/**
 * 使用独立 profile 启动可调试的 Codex，避免系统应用启动器将参数转发给当前已打开的实例。
 * @param {string} appPath macOS `.app`、Windows `.exe` 或 Linux 可执行文件路径。
 * @param {number} port 仅绑定到 loopback 的 CDP 端口。
 * @param {string} userDataDir 独立实例的持久用户数据目录。
 * @returns {Promise<import("node:child_process").ChildProcess>} 已提交启动请求的子进程。
 * @throws 创建 profile 目录失败时抛出文件系统错误。
 * @remarks 直接运行 Desktop 主可执行文件，确保 CDP、独立 profile 与 TLS 参数传给同一 Electron 进程；不得用当前日常 Codex profile 启动该实例。
 */
async function launchCodex(appPath, port, userDataDir) {
  await mkdir(userDataDir, { recursive: true });
  const tlsSpki = await gatewayTlsSpki();
  console.log(`正在 CDP 端口 ${port} 启动独立的 Gateway-enabled Codex 实例...`);
  console.log(`独立 Codex profile：${userDataDir}`);
  const launchArguments = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    "--disable-features=LocalNetworkAccessChecks",
    `--ignore-certificate-errors-spki-list=${tlsSpki}`
  ];
  const child = spawn(desktopExecutable(appPath), launchArguments, {
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return child;
}

/**
 * 查找正在监听指定 CDP 端口的 Codex 主进程。
 * @param {number} port CDP loopback 端口。
 * @returns {{pid: number}|null} 可用于停止的主进程标识；无法确定时返回 null。
 * @remarks 仅在 macOS 直接启动 Desktop 后使用，端口由本轮 launcher 自动选择，不会匹配用户普通 Codex 实例。
 */
function cdpOwnerProcess(port) {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pid = Number(result.stdout.trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/**
 * 选择可用 CDP 端口并启动一轮独立 Codex。
 * @param {{port: number, appPath: string, userDataDir: string}} options launcher 启动选项。
 * @param {boolean} cdpAlreadyAvailable 首选端口是否已被其他 CDP 实例占用。
 * @param {(child: import("node:child_process").ChildProcess) => void} onLaunched 子进程创建后立即登记的回调。
 * @returns {Promise<{cdpVersion: string, launchedCodex: {pid: number}|import("node:child_process").ChildProcess}>} 实际 CDP 地址和对应进程。
 * @throws 无可用端口、Codex 启动失败或 CDP 未在时限内监听时抛出错误。
 * @remarks 回调在等待 CDP 前执行，使退出信号能够关闭正在启动中的进程；仅使用本轮独立 profile 的 CDP 端口，不会附加用户日常 Codex。
 */
async function startCodexWithAvailableCdp(options, cdpAlreadyAvailable, onLaunched) {
  const requestedCdpPort = options.port;
  const preferredCdpPort = cdpAlreadyAvailable ? requestedCdpPort + 1 : requestedCdpPort;
  options.port = await findLoopbackPort(preferredCdpPort);
  if (options.port !== requestedCdpPort) {
    console.log(`CDP 端口 ${requestedCdpPort} 已占用，改用 ${options.port}。`);
  }
  const cdpVersion = `http://127.0.0.1:${options.port}/json/version`;
  const child = await launchCodex(options.appPath, options.port, options.userDataDir);
  onLaunched(child);
  await waitFor(cdpVersion, 30_000, `Codex CDP on port ${options.port}`);
  return { cdpVersion, launchedCodex: cdpOwnerProcess(options.port) ?? child };
}

/**
 * 结束 launcher 自己启动的独立 Codex 进程组。
 * @param {{pid: number}|import("node:child_process").ChildProcess|null} child 由 launcher 启动的 Codex 主进程。
 * @returns {void} 结束信号发送后返回。
 * @remarks macOS/Linux 使用 detached 进程组，Windows 使用 taskkill 递归清理；不会触碰用户手动启动的 Codex。
 */
function stopLaunchedCodex(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (_) {
    try { process.kill(child.pid, "SIGTERM"); } catch (_) { /* 进程已退出。 */ }
  }
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

  /**
   * 向当前 renderer 发送一个 CDP 命令，并在调试连接半断开时主动超时。
   * @param {string} method CDP 协议方法名。
   * @param {object} params CDP 方法参数。
   * @returns {Promise<object>} CDP 返回结果。
   * @throws 连接关闭、WebSocket 写入失败或 15 秒内未收到对应响应时抛出错误。
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.closed = true;
        this.socket.terminate();
        reject(new Error(`CDP ${method} 响应超时`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
  return targets.filter((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
    const url = target.url || "";
    const isOverlay = /initialRoute=%2F(?:avatar-overlay|global-dictation)/i.test(url);
    const looksLikeCodex = url.startsWith("app://") || url.startsWith("codex://") || /codex|chatgpt/i.test(target.title || "");
    return looksLikeCodex && !isOverlay;
  });
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

/**
 * 读取注入脚本和公开 Gateway HTML，并生成可热更新的 document-start 源码。
 * @returns {Promise<{hash: string, source: string}>} 注入源码及包含 HTML 内容的 SHA-256 标识。
 * @throws Controller 不可达、返回非成功状态或本地注入文件无法读取时抛出错误。
 * @remarks HTML 仅包含页面骨架和静态资源引用，不含 Cookie、访问令牌、上游密钥或管理 API 响应。
 */
async function currentSource() {
  const userSource = await readFile(injectionPath, "utf8");
  const pageResponse = await fetch(`${controllerUrl}/`, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!pageResponse.ok) throw new Error(`读取 Gateway 公开页面失败：HTTP ${pageResponse.status}`);
  const pageHtml = await pageResponse.text();
  const runtime = [
    `window.__CODEX_GATEWAY_URL__ = ${JSON.stringify(`${gatewayUiOrigin}/`)};`,
    `window.__CODEX_GATEWAY_BLOB_HTML__ = ${JSON.stringify(pageHtml)};`,
    userSource
  ].join("\n");
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
    if (shouldOpen && status?.frameError) return status;
    const ready = status?.sourceHash === sourceHash && status.entryMounted;
    const frameReady = !shouldOpen || (status?.pageVisible && status.frameUrl && status.frameLoaded && status.frameReady);
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

/**
 * 将 Gateway 注入到一个 renderer target，并保留连接供后续恢复使用。
 * @param {object} target CDP discovery 返回的 Codex page target。
 * @param {string} source 带 source hash 的注入脚本文本。
 * @param {string} hash 当前注入脚本的 SHA-256 标识。
 * @param {boolean} shouldOpen 是否在注入后立即打开 iframe。
 * @param {Map<string, object>} states 已连接 target 的状态表。
 * @param {boolean} forceReload 是否在首次注入时 reload renderer，使 CSP bypass 对 iframe 生效。
 * @returns {Promise<object>} 已注入 target 的状态与 iframe 验证结果。
 * @throws CDP 命令失败、入口未挂载、iframe 未就绪或 iframe 返回加载错误时抛出错误。
 */
async function injectTarget(target, source, hash, shouldOpen, states, forceReload) {
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
  if (forceReload && !state.reloaded) {
    state.reloaded = true;
    const loaded = cdp.waitFor("Page.loadEventFired", 15_000);
    await cdp.send("Page.reload", { ignoreCache: true });
    await loaded;
  }
  await evaluate(cdp, source);
  if (shouldOpen) await cdp.send("Runtime.evaluate", { expression: "window.__codexGatewayInjection__?.open()", returnByValue: true });
  const status = await waitForStatus(cdp, hash, shouldOpen, 15_000);
  const frameLoaded = shouldOpen && !status.frameError ? await waitForFrame(cdp, status.frameUrl, 15_000) : false;
  if (shouldOpen && !status.frameError && !frameLoaded) throw new Error("Gateway iframe 元素已挂载，但其 frame 未完成加载");
  return { targetId: target.id, title: target.title, url: target.url, cspBypassed: true, frameLoaded, ...status };
}

/**
 * 对当前存活的 Codex renderer 进行连接回收、发现与注入。
 * @param {number} port CDP loopback 端口。
 * @param {string} source 注入脚本文本。
 * @param {string} hash 注入脚本的 SHA-256 标识。
 * @param {boolean} shouldOpen 是否立即打开 Gateway。
 * @param {Map<string, object>} states 已连接 target 的状态表。
 * @param {boolean} forceReload 是否在首次注入时 reload renderer。
 * @returns {Promise<object[]>} 所有当前 renderer 的注入状态。
 * @throws 找不到 Codex renderer 或任一首轮注入失败时抛出错误。
 */
async function reconcile(port, source, hash, shouldOpen, states, forceReload) {
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
    const result = await injectTarget(target, source, hash, openThisTarget, states, forceReload);
    if (openThisTarget) states.get(target.id).opened = true;
    results.push(result);
  }
  return results;
}

/**
 * 在 Codex 初始化期间反复发现 renderer 并完成首轮注入。
 * @param {number} port CDP loopback 端口。
 * @param {string} source 注入脚本文本。
 * @param {string} hash 注入脚本的 SHA-256 标识。
 * @param {boolean} shouldOpen 是否在成功后打开 Gateway iframe。
 * @param {Map<string, object>} states 已连接 target 的状态表。
 * @returns {Promise<object[]>} 每个成功注入 renderer 的状态。
 * @throws 超过初始化时限仍无法完成注入时抛出最后一次错误。
 */
async function reconcileUntilReady(port, source, hash, shouldOpen, states, forceReload) {
  const deadline = Date.now() + 30_000;
  let lastError = new Error("Codex renderer 尚未就绪");
  while (Date.now() < deadline) {
    try {
      return await reconcile(port, source, hash, shouldOpen, states, forceReload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      states.forEach((state) => state.cdp.close());
      states.clear();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

/**
 * 启动 Controller 协作、Codex 注入以及持续监控循环。
 * @returns {Promise<void>} 非 watch 模式完成首轮注入后返回；watch 模式在收到终止信号后返回。
 * @throws 启动参数、Controller、Codex CDP 或注入流程不可用时抛出错误。
 * @remarks watch 模式会在独立 Codex 被关闭后自动重新启动新实例，不会影响已开始的 Gateway 流。
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  let cdpVersion = `http://127.0.0.1:${options.port}/json/version`;
  let controller = null;
  let launchedCodex = null;
  const states = new Map();
  let stopping = false;

  const stop = () => {
    if (stopping) return;
    stopping = true;
    states.forEach((state) => state.cdp.close());
    if (controller?.started && controller.child?.exitCode === null) stopController(controller.child);
    stopLaunchedCodex(launchedCodex);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  /**
   * 登记刚创建的 Codex 子进程，并处理其创建时已经收到的退出请求。
   * @param {import("node:child_process").ChildProcess} child 刚由 launcher 创建的独立 Codex 进程。
   * @returns {void} 进程已登记，或已按退出状态发送结束信号后返回。
   * @remarks 必须在等待 CDP 前调用，避免退出与 watcher 重启之间遗漏新进程。
   */
  function registerLaunchedCodex(child) {
    launchedCodex = child;
    if (stopping) stopLaunchedCodex(child);
  }

  try {
    controller = await ensureController();
    if (stopping) return;
    const cdpAvailable = await reachable(cdpVersion);
    if (stopping) return;
    if (options.attachExisting && !cdpAvailable) {
      throw new Error(`无法附加：Codex CDP 未监听 127.0.0.1:${options.port}。请使用 --remote-debugging-port=${options.port} 启动 Codex，或运行 npm run codex 创建独立的 Gateway-enabled 实例。`);
    }
    if (options.launch) {
      const started = await startCodexWithAvailableCdp(options, cdpAvailable, registerLaunchedCodex);
      if (stopping) {
        stopLaunchedCodex(started.launchedCodex);
        return;
      }
      cdpVersion = started.cdpVersion;
      launchedCodex = started.launchedCodex;
    }
    await waitForCodexTarget(options.port, 30_000);
    if (stopping) return;
    let current = await currentSource();
    if (stopping) return;
    if (options.forceReload) console.log("已启用首次 renderer reload，以让 CSP bypass 对 Gateway iframe 生效。");
    const first = await reconcileUntilReady(
      options.port,
      current.source,
      current.hash,
      options.open,
      states,
      options.forceReload,
    );
    console.log(JSON.stringify({ injected: first }, null, 2));
    if (!options.watch) return;

    while (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (stopping) break;
      try {
        if (!(await reachable(`${controllerUrl}/health`))) {
          controller = await ensureController();
        }
        if (stopping) break;
        const cdpReachable = await reachable(cdpVersion);
        if (stopping) break;
        if (options.launch && !cdpReachable) {
          states.forEach((state) => state.cdp.close());
          states.clear();
          const restarted = await startCodexWithAvailableCdp(options, false, registerLaunchedCodex);
          if (stopping) {
            stopLaunchedCodex(restarted.launchedCodex);
            break;
          }
          cdpVersion = restarted.cdpVersion;
          launchedCodex = restarted.launchedCodex;
          await waitForCodexTarget(options.port, 30_000);
          if (stopping) break;
          const restartedTargets = await reconcileUntilReady(
            options.port,
            current.source,
            current.hash,
            options.open,
            states,
            options.forceReload,
          );
          if (stopping) break;
          console.log(JSON.stringify({ restarted: restartedTargets }, null, 2));
          continue;
        }
        const latest = await currentSource();
        if (stopping) break;
        current = latest;
        const results = await reconcile(options.port, latest.source, latest.hash, false, states, options.forceReload);
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
