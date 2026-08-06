const { app, Menu, nativeImage, shell, Tray, dialog } = require("electron");
const { existsSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const applicationName = "CodexGatewayControl";
app.setPath("userData", userDataRoot());
const singleInstance = app.requestSingleInstanceLock();
const preferredControllerPort = Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000);
const preferredUiTlsPort = Number(process.env.GATEWAY_UI_TLS_PORT ?? 4401);
let tray = null;
let controller = null;
let launcher = null;
let stopping = false;
let controllerOrigin = null;
let gatewayUiOrigin = null;
let startupPromise = null;

/**
 * 返回不包含人为添加空格目录名的安装版用户数据根目录。
 * @returns {string} 当前平台的 CodexGatewayControl 数据根目录。
 * @remarks 用户账户名称本身可能包含空格，该系统路径无法由应用改变。
 */
function userDataRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), applicationName);
  }
  return path.join(os.homedir(), "Library", applicationName);
}

/**
 * 返回安装包内 Gateway runtime 的路径。
 * @returns {string} Gateway runtime 目录。
 * @remarks 开发模式使用仓库生成的 dist-runtime，安装模式使用 resources 下的只读资源。
 */
function runtimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "gateway-runtime")
    : path.resolve(__dirname, "..", "dist-runtime");
}

/**
 * 返回当前平台内置 Node.js 可执行文件路径。
 * @returns {string} 可启动 Controller 和 launcher 的 Node.js 路径。
 * @remarks 开发模式允许使用环境变量或 PATH 中的 node；安装模式必须使用 resources/node-runtime。
 */
function nodeExecutable() {
  if (!app.isPackaged) return process.env.CODEX_NODE_PATH || process.env.npm_node_execpath || "node";
  const directory = path.join(process.resourcesPath, "node-runtime");
  return process.platform === "win32" ? path.join(directory, "node.exe") : path.join(directory, "bin", "node");
}

/**
 * 将本机端口探测为可绑定的 loopback 端口。
 * @param {number} preferredPort 优先尝试的端口。
 * @param {number[]} reservedPorts 需要跳过的已选端口。
 * @param {number} fallbackPort 首选端口无效时使用的安全默认端口。
 * @returns {Promise<number>} 可绑定的端口号。
 * @throws 连续尝试到端口上限仍无可用端口时抛出错误。
 */
async function findLoopbackPort(preferredPort, reservedPorts = [], fallbackPort = 4000) {
  const firstPort = Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535
    ? preferredPort
    : fallbackPort;
  const reserved = new Set(reservedPorts);
  for (let port = firstPort; port <= 65535; port += 1) {
    if (reserved.has(port)) continue;
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`从端口 ${firstPort} 开始没有可用的本机端口。`);
}

/**
 * 等待 Controller HTTP 健康检查成功。
 * @param {string} url 健康检查 URL。
 * @param {number} timeoutMs 最大等待时间。
 * @returns {Promise<void>} 服务可达时完成。
 * @throws 超时仍未收到成功响应时抛出错误。
 */
async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (_) {
      // Controller 尚未监听端口，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Gateway Controller 启动超时。");
}

/**
 * 返回当前平台的 ChatGPT Desktop 应用候选路径。
 * @returns {string} 应用路径，允许通过 CODEX_APP_PATH 覆盖。
 */
function defaultCodexPath() {
  if (process.env.CODEX_APP_PATH) return process.env.CODEX_APP_PATH;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "ChatGPT", "ChatGPT.exe");
  if (process.platform === "darwin") return "/Applications/ChatGPT.app";
  return "";
}

/**
 * 将应用路径转换成 launcher 可直接 spawn 的主进程路径。
 * @param {string} appPath Windows 可执行文件或 macOS app bundle 路径。
 * @returns {string} 可执行文件路径。
 */
function desktopExecutable(appPath) {
  if (process.platform === "win32") return appPath;
  if (process.platform === "darwin" && appPath.endsWith(".app")) return path.join(appPath, "Contents", "MacOS", path.basename(appPath, ".app"));
  return appPath;
}

/**
 * 启动本地 Controller 子进程。
 * @param {number} controllerPort HTTP 代理端口。
 * @param {number} uiTlsPort HTTPS 管理页端口。
 * @param {string} dataDirectory 私密数据目录。
 * @returns {import("node:child_process").ChildProcess} 已启动的 Controller 子进程。
 * @throws 内置 Node 或 Controller 入口不存在时抛出错误。
 */
function startController(controllerPort, uiTlsPort, dataDirectory) {
  const runtime = runtimeRoot();
  const entry = path.join(runtime, "controller.mjs");
  if (app.isPackaged && (!existsSync(nodeExecutable()) || !existsSync(entry))) {
    throw new Error("安装包缺少 Gateway runtime 文件。");
  }
  const child = spawn(nodeExecutable(), [entry], {
    cwd: userDataRoot(),
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      CONTROLLER_HOST: "127.0.0.1",
      GATEWAY_PORT: String(controllerPort),
      GATEWAY_UI_TLS_PORT: String(uiTlsPort),
      GATEWAY_DATA_DIR: dataDirectory,
      GATEWAY_WEB_DIR: path.join(runtime, "dist-web")
    }
  });
  child.once("error", (error) => {
    if (!stopping) dialog.showErrorBox("Gateway 启动失败", error.message);
  });
  return child;
}

/**
 * 启动 Codex Desktop launcher 子进程。
 * @param {number} controllerPort HTTP 代理端口。
 * @param {number} uiTlsPort HTTPS 管理页端口。
 * @param {string} dataDirectory 私密数据目录。
 * @returns {import("node:child_process").ChildProcess|null} 已启动的 launcher，找不到 Desktop 时返回 null。
 */
function startLauncher(controllerPort, uiTlsPort, dataDirectory) {
  const appPath = defaultCodexPath();
  if (!appPath || !existsSync(desktopExecutable(appPath))) {
    tray?.displayBalloon?.({ title: "Codex Gateway Control", content: "未找到 ChatGPT Desktop，已仅启动 Gateway 管理页。" });
    return null;
  }
  const runtime = runtimeRoot();
  const child = spawn(nodeExecutable(), [path.join(runtime, "launcher.mjs"), "--launch", "--watch", "--open"], {
    cwd: userDataRoot(),
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      GATEWAY_ORIGIN: `http://127.0.0.1:${controllerPort}`,
      GATEWAY_UI_ORIGIN: `https://127.0.0.1:${uiTlsPort}`,
      GATEWAY_DATA_DIR: dataDirectory,
      GATEWAY_RUNTIME_ROOT: runtime,
      GATEWAY_CONTROLLER_ENTRY: path.join(runtime, "controller.mjs"),
      CODEX_INJECTION_PATH: path.join(runtime, "inject", "codex-gateway.user.js"),
      CODEX_APP_PATH: appPath
    }
  });
  child.once("error", (error) => {
    if (!stopping) dialog.showErrorBox("Codex 启动失败", error.message);
  });
  return child;
}

/**
 * 用系统默认浏览器打开本地管理页。
 * @returns {Promise<void>} 浏览器打开请求提交后完成。
 * @throws 系统无法处理本地 URL 时抛出错误。
 */
async function openManagementPage() {
  if (!controllerOrigin) throw new Error("Gateway 管理页尚未准备完成。");
  await shell.openExternal(controllerOrigin);
}

/**
 * 结束 Electron 当前启动的子进程。
 * @param {import("node:child_process").ChildProcess|null} child 需要结束的子进程。
 * @returns {void} 进程结束请求提交后返回。
 * @remarks Windows 使用 taskkill 清理可能存在的子进程树；不会触碰外部已运行的 ChatGPT 窗口。
 */
function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * 创建托盘入口并绑定常用操作。
 * @returns {void} 托盘菜单创建完成后返回。
 */
function createTray() {
  const icon = nativeImage.createFromDataURL("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='7' fill='%235b5cf0'/><path d='M8 16h16M16 8v16' stroke='white' stroke-width='3' stroke-linecap='round'/></svg>");
  tray = new Tray(icon);
  tray.setToolTip("Codex Gateway Control");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开管理页", click: () => void openManagementPage() },
    { label: "启动 Codex", click: () => { if (!launcher) launcher = startLauncher(Number(new URL(controllerOrigin).port), Number(new URL(gatewayUiOrigin).port), path.join(userDataRoot(), "data")); } },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
}

/**
 * 启动 Gateway、管理页和可选 Codex 注入流程。
 * @returns {Promise<void>} 所有本地服务初始化完成后结束。
 * @throws 端口、Node runtime、Controller 或浏览器打开失败时抛出错误。
 */
async function startApplication() {
  const root = userDataRoot();
  const dataDirectory = path.join(root, "data");
  const controllerPort = await findLoopbackPort(preferredControllerPort);
  const uiTlsPort = await findLoopbackPort(preferredUiTlsPort, [controllerPort], 4401);
  controllerOrigin = `http://127.0.0.1:${controllerPort}`;
  gatewayUiOrigin = `https://127.0.0.1:${uiTlsPort}`;
  controller = startController(controllerPort, uiTlsPort, dataDirectory);
  await waitForHealth(`${controllerOrigin}/health`);
  createTray();
  await openManagementPage();
  launcher = startLauncher(controllerPort, uiTlsPort, dataDirectory);
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => void (startupPromise ? startupPromise.then(openManagementPage) : openManagementPage()));
  app.on("before-quit", () => {
    stopping = true;
    stopChild(launcher);
    stopChild(controller);
    tray?.destroy();
  });
  app.whenReady().then(() => {
    startupPromise = startApplication();
    return startupPromise;
  }).catch((error) => {
    dialog.showErrorBox("Codex Gateway Control 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
