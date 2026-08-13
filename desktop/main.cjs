const { app, BrowserWindow, Menu, nativeImage, shell, Tray, dialog } = require("electron");
const { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const applicationName = "CodexGatewayControl";
app.setPath("userData", userDataRoot());
const singleInstance = app.requestSingleInstanceLock();
const preferredControllerPort = Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000);
const controllerPortIsExplicit = Boolean(process.env.GATEWAY_PORT || process.env.CONTROLLER_PORT);
let tray = null;
let keepAliveWindow = null;
let controller = null;
let stopping = false;
let controllerOrigin = null;

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
 * @returns {string} 可启动 Controller 的 Node.js 路径。
 * @remarks 开发模式允许使用环境变量或 PATH 中的 node；安装模式必须使用 resources/node-runtime。
 */
function nodeExecutable() {
  if (!app.isPackaged) return process.env.CODEX_NODE_PATH || process.env.npm_node_execpath || "node";
  const directory = path.join(process.resourcesPath, "node-runtime");
  return process.platform === "win32" ? path.join(directory, "node.exe") : path.join(directory, "bin", "node");
}

/**
 * 判断值是否可作为 Gateway 的稳定本机端口。
 * @param {unknown} value 待校验的端口值。
 * @returns {boolean} 值为 1024 到 65535 的整数时返回 true。
 * @remarks 排除特权端口和损坏状态，避免应用启动到无法写入 Codex 配置的地址。
 */
function isGatewayPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * 返回 Gateway 端口状态文件路径。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @returns {string} 状态文件的绝对路径。
 * @remarks 文件只保存稳定代理端口和配置迁移标记，不包含令牌或中转信息。
 */
function gatewayPortStatePath(dataDirectory) {
  return path.join(dataDirectory, "gateway-port.json");
}

/**
 * 读取已保存的 Gateway 稳定端口状态。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @returns {{controllerPort: number, codexConfigurationRequired: boolean}|null} 有效状态；不存在或格式不正确时返回 null。
 * @remarks 格式错误时回退到默认端口，并在首次迁移前要求用户明确确认。
 */
function readGatewayPortState(dataDirectory) {
  const statePath = gatewayPortStatePath(dataDirectory);
  if (!existsSync(statePath)) return null;
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (!isGatewayPort(value?.controllerPort) || typeof value.codexConfigurationRequired !== "boolean") return null;
    return { controllerPort: value.controllerPort, codexConfigurationRequired: value.codexConfigurationRequired };
  } catch (_) {
    return null;
  }
}

/**
 * 原子保存 Gateway 的稳定端口状态。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @param {{controllerPort: number, codexConfigurationRequired: boolean}} state 需要持久化的端口和迁移标记。
 * @returns {void} 状态文件替换完成后返回。
 * @throws 端口无效或文件系统无法写入时抛出错误。
 * @remarks 使用同目录临时文件替换，避免桌面应用中断时写出不完整 JSON。
 */
function writeGatewayPortState(dataDirectory, state) {
  if (!isGatewayPort(state.controllerPort)) throw new Error("本地 Gateway 端口无效，无法保存启动状态。");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const statePath = gatewayPortStatePath(dataDirectory);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  renameSync(temporaryPath, statePath);
}

/**
 * 检查指定 loopback 端口是否可由当前应用绑定。
 * @param {number} port 待检查的 TCP 端口。
 * @returns {Promise<boolean>} 可绑定时返回 true。
 * @remarks 探测监听器会立即关闭；真正的 Controller 仍负责处理极小竞争窗口内的失败。
 */
async function canBindLoopbackPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
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
    const available = await canBindLoopbackPort(port);
    if (available) return port;
  }
  throw new Error(`从端口 ${firstPort} 开始没有可用的本机端口。`);
}

/**
 * 选择本轮必须使用的稳定 Gateway HTTP 代理端口。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @returns {Promise<{controllerPort: number, initialized: boolean}|null>} 已确认端口；用户取消时返回 null。
 * @throws 显式端口或已保存端口被占用时抛出错误。
 * @remarks 端口仅供 Gateway 自身使用；不会因为端口变化自动启动或修改 Codex。
 */
async function selectStableControllerPort(dataDirectory) {
  if (controllerPortIsExplicit && !isGatewayPort(preferredControllerPort)) {
    throw new Error("GATEWAY_PORT 必须是 1024 到 65535 之间的整数。");
  }
  const previousState = readGatewayPortState(dataDirectory);
  const saved = controllerPortIsExplicit ? null : previousState;
  const controllerPort = controllerPortIsExplicit
    ? preferredControllerPort
    : saved?.controllerPort ?? (isGatewayPort(preferredControllerPort) ? preferredControllerPort : 4000);
  if (await canBindLoopbackPort(controllerPort)) {
    return {
      controllerPort,
      initialized: !previousState && !controllerPortIsExplicit
    };
  }
  if (controllerPortIsExplicit) {
    throw new Error(`Gateway 代理端口 ${controllerPort} 已被其他本地程序占用。Codex config.toml 可能仍指向该端口，本次不会自动更换；请释放端口后重试。`);
  }
  const selection = await dialog.showMessageBox({
    type: "warning",
    buttons: ["自动选择并继续", "暂不启动"],
    defaultId: 0,
    cancelId: 1,
    title: "需要调整本机连接",
    message: "Gateway 暂时无法使用默认连接地址。",
    detail: "这通常是因为另一款本地软件正在使用该地址。选择“自动选择并继续”后，应用会自动选择可用地址并继续启动。"
  });
  if (selection.response !== 0) return null;
  const replacementPort = await findLoopbackPort(controllerPort + 1, [], 4000);
  writeGatewayPortState(dataDirectory, { controllerPort: replacementPort, codexConfigurationRequired: false });
  return { controllerPort: replacementPort, initialized: false };
}

/**
 * 保存首次成功启动的默认 Gateway 代理端口。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @param {number} controllerPort 已通过健康检查的代理端口。
 * @returns {void} 初始状态存在或写入完成后返回。
 * @throws 状态文件无法写入时抛出错误。
 * @remarks 不覆盖已存在的迁移标记，也不持久化由环境变量显式指定的端口。
 */
function persistInitialControllerPort(dataDirectory, controllerPort) {
  if (controllerPortIsExplicit || readGatewayPortState(dataDirectory)) return;
  writeGatewayPortState(dataDirectory, { controllerPort, codexConfigurationRequired: false });
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
 * 启动本地 Controller 子进程。
 * @param {number} controllerPort HTTP 代理端口。
 * @param {string} dataDirectory 私密数据目录。
 * @returns {import("node:child_process").ChildProcess} 已启动的 Controller 子进程。
 * @throws 内置 Node 或 Controller 入口不存在时抛出错误。
 */
function startController(controllerPort, dataDirectory) {
  const runtime = runtimeRoot();
  const entry = path.join(runtime, "controller.mjs");
  if (app.isPackaged && (!existsSync(nodeExecutable()) || !existsSync(entry))) {
    throw new Error("安装包缺少 Gateway runtime 文件。");
  }
  const webDirectory = prepareWebDirectory(runtime, dataDirectory);
  const child = spawn(nodeExecutable(), [entry], {
    cwd: userDataRoot(),
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      GATEWAY_HOST: "127.0.0.1",
      CONTROLLER_HOST: "127.0.0.1",
      GATEWAY_PORT: String(controllerPort),
      GATEWAY_DATA_DIR: dataDirectory,
      GATEWAY_WEB_DIR: webDirectory
    }
  });
  child.once("error", (error) => {
    if (!stopping) dialog.showErrorBox("Gateway 启动失败", error.message);
  });
  return child;
}

/**
 * 将管理页静态资源复制到用户数据目录中的稳定缓存。
 * @param {string} runtime Gateway runtime 目录。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @returns {string} Controller 应使用的静态资源目录。
 * @throws 安装包首次启动且 runtime 与缓存都缺少入口文件时抛出错误。
 * @remarks 安装包更新可能移走旧的 Contents 目录；缓存放在用户数据目录可让已运行或重启中的 Controller 继续提供管理页。
 */
function prepareWebDirectory(runtime, dataDirectory) {
  const sourceDirectory = path.join(runtime, "dist-web");
  const cachedDirectory = path.join(dataDirectory, "dist-web");
  const sourceIndex = path.join(sourceDirectory, "index.html");
  const cachedIndex = path.join(cachedDirectory, "index.html");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  if (existsSync(sourceIndex)) {
    const temporaryDirectory = `${cachedDirectory}.${process.pid}.tmp`;
    rmSync(temporaryDirectory, { recursive: true, force: true });
    cpSync(sourceDirectory, temporaryDirectory, { recursive: true, force: true });
    rmSync(cachedDirectory, { recursive: true, force: true });
    renameSync(temporaryDirectory, cachedDirectory);
  }
  if (!existsSync(cachedIndex)) throw new Error("安装包缺少管理页静态资源。");
  return cachedDirectory;
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
 * 等待指定的 Electron 受管子进程退出。
 * @param {import("node:child_process").ChildProcess|null} child 需要等待的子进程。
 * @param {number} timeoutMs 最大等待时间。
 * @returns {Promise<boolean>} 子进程在时限内退出时返回 true，否则返回 false。
 * @remarks 只观察 Electron 自己创建的 Controller，不会探测或操作外部进程。
 */
function waitForChildExit(child, timeoutMs = 3_000) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/**
 * 结束并确认 Electron 自己启动的子进程已经退出。
 * @param {import("node:child_process").ChildProcess|null} child 需要结束的 Controller。
 * @returns {Promise<void>} 退出信号完成处理后返回。
 * @remarks 常规 SIGTERM 超时后仅对本子进程发送 SIGKILL，避免 CGC 退出后遗留 Node 进程。
 */
async function stopChildAndWait(child) {
  stopChild(child);
  if (await waitForChildExit(child)) return;
  if (child?.pid && process.platform !== "win32") child.kill("SIGKILL");
  await waitForChildExit(child, 1_000);
}

/**
 * 创建托盘入口并绑定常用操作。
 * @returns {void} 托盘菜单创建完成后返回。
 */
function createTray() {
  // macOS 菜单栏会把模板图按系统主题着色；Windows/Linux 托盘需要保留应用图标的彩色像素。
  const iconName = process.platform === "darwin" ? "cgc-tray-template.png" : "cgc-app-icon.png";
  const sourceIcon = nativeImage.createFromPath(path.join(__dirname, "assets", iconName));
  if (sourceIcon.isEmpty()) throw new Error("无法加载菜单栏图标资源。");
  const icon = sourceIcon.resize({ width: 18, height: 18, quality: "best" });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Codex Gateway Control");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开管理页", click: () => void openManagementPage() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
}

/**
 * 隐藏 macOS Dock 中的应用图标。
 * @returns {void} 非 macOS 或 Dock API 不可用时直接返回；否则提交隐藏请求。
 * @remarks 应用只提供菜单栏托盘入口，隐藏 Dock 图标不会影响托盘菜单或本地管理页。
 */
function hideDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  app.dock.hide();
}

/**
 * 创建不可见的保活窗口，确保无 BrowserWindow 的菜单栏应用不会被 macOS 自动结束。
 * @returns {void} 保活窗口创建完成后返回。
 * @remarks 窗口不加载页面、不出现在 Dock 或任务栏，用户仅通过菜单栏托盘与应用交互。
 */
function createKeepAliveWindow() {
  keepAliveWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1,
    height: 1,
    webPreferences: { sandbox: true }
  });
}

/**
 * 启动 Gateway Controller 和本地管理页。
 * @returns {Promise<void>} 所有本地服务初始化完成后结束。
 * @throws 端口、Node runtime 或 Controller 启动失败时抛出错误。
 */
async function startApplication() {
  const root = userDataRoot();
  const dataDirectory = path.join(root, "data");
  const selection = await selectStableControllerPort(dataDirectory);
  if (!selection) {
    app.quit();
    return;
  }
  const controllerPort = selection.controllerPort;
  controllerOrigin = `http://127.0.0.1:${controllerPort}`;
  controller = startController(controllerPort, dataDirectory);
  await waitForHealth(`${controllerOrigin}/health`);
  if (selection.initialized) persistInitialControllerPort(dataDirectory, controllerPort);
  await openManagementPage();
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("window-all-closed", (event) => event.preventDefault());
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void stopChildAndWait(controller).finally(() => {
      tray?.destroy();
      keepAliveWindow?.destroy();
      app.exit(0);
    });
  });
  app.whenReady().then(() => {
    hideDockIcon();
    createKeepAliveWindow();
    createTray();
    return startApplication();
  }).catch((error) => {
    dialog.showErrorBox("Codex Gateway Control 启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
