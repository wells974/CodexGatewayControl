const { app, BrowserWindow, Menu, nativeImage, shell, Tray, dialog } = require("electron");
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const applicationName = "CodexGatewayControl";
app.setPath("userData", userDataRoot());
const singleInstance = app.requestSingleInstanceLock();
const preferredControllerPort = Number(process.env.GATEWAY_PORT ?? process.env.CONTROLLER_PORT ?? 4000);
const preferredUiTlsPort = Number(process.env.GATEWAY_UI_TLS_PORT ?? 4401);
const controllerPortIsExplicit = Boolean(process.env.GATEWAY_PORT || process.env.CONTROLLER_PORT);
let tray = null;
let keepAliveWindow = null;
let controller = null;
let launcher = null;
let stopping = false;
let controllerOrigin = null;
let gatewayUiOrigin = null;

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
 * @returns {Promise<{controllerPort: number, codexConfigurationRequired: boolean, initialized: boolean, autoConfigureCodex: boolean}|null>} 已确认端口及自动修复标记；用户取消时返回 null。
 * @throws 显式端口或已保存端口被占用时抛出错误。
 * @remarks 已配置过 Codex 的端口绝不静默递增；仅首次无状态且用户确认自动修复后才会选择新端口。
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
    const configurationChanged = controllerPortIsExplicit && Boolean(previousState && previousState.controllerPort !== controllerPort);
    return {
      controllerPort,
      codexConfigurationRequired: configurationChanged || saved?.codexConfigurationRequired === true,
      initialized: !previousState && !controllerPortIsExplicit,
      autoConfigureCodex: false
    };
  }
  if (controllerPortIsExplicit) {
    throw new Error(`Gateway 代理端口 ${controllerPort} 已被其他本地程序占用。Codex config.toml 可能仍指向该端口，本次不会自动更换；请释放端口后重试。`);
  }
  const selection = await dialog.showMessageBox({
    type: "warning",
    buttons: ["自动修复并继续", "暂不启动"],
    defaultId: 0,
    cancelId: 1,
    title: "需要调整本机连接",
    message: "Gateway 暂时无法使用默认连接地址。",
    detail: "这通常是因为另一款本地软件正在使用该地址。选择“自动修复并继续”后，应用会自动选择可用地址、更新 Codex 设置并继续启动，无需关闭或排查其他应用。"
  });
  if (selection.response !== 0) return null;
  const replacementPort = await findLoopbackPort(controllerPort + 1, [], 4000);
  writeGatewayPortState(dataDirectory, { controllerPort: replacementPort, codexConfigurationRequired: true });
  return { controllerPort: replacementPort, codexConfigurationRequired: true, initialized: false, autoConfigureCodex: true };
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
 * 判断当前稳定端口是否尚未同步到 Codex 配置。
 * @param {string} dataDirectory Gateway 私密数据目录。
 * @param {number} controllerPort 当前正在监听的 Gateway 代理端口。
 * @returns {boolean} 需要用户执行一键配置时返回 true。
 * @remarks 每次启动 Codex 前重新读取状态，使管理页完成配置后无需重启 Gateway 应用。
 */
function codexConfigurationRequired(dataDirectory, controllerPort) {
  const state = readGatewayPortState(dataDirectory);
  if (!state) return false;
  return state.codexConfigurationRequired || (controllerPortIsExplicit && state.controllerPort !== controllerPort);
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
 * @param {boolean} autoConfigureCodex 用户确认端口迁移后是否自动同步 Codex 设置。
 * @returns {import("node:child_process").ChildProcess} 已启动的 Controller 子进程。
 * @throws 内置 Node 或 Controller 入口不存在时抛出错误。
 */
function startController(controllerPort, uiTlsPort, dataDirectory, autoConfigureCodex = false) {
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
      GATEWAY_WEB_DIR: path.join(runtime, "dist-web"),
      GATEWAY_AUTO_CONFIGURE_CODEX: autoConfigureCodex ? "true" : ""
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
  child.once("exit", () => {
    if (launcher === child) launcher = null;
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
 * 等待指定的 Electron 受管子进程退出。
 * @param {import("node:child_process").ChildProcess|null} child 需要等待的子进程。
 * @param {number} timeoutMs 最大等待时间。
 * @returns {Promise<boolean>} 子进程在时限内退出时返回 true，否则返回 false。
 * @remarks 只观察 Electron 自己创建的 Controller 或 launcher，不会探测或操作外部进程。
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
 * @param {import("node:child_process").ChildProcess|null} child 需要结束的 Controller 或 launcher。
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
 * 重启 launcher 并创建新的 Gateway-enabled Codex 实例。
 * @returns {Promise<void>} 旧 launcher 结束且新 launcher 创建后返回。
 * @throws Gateway 尚未完成启动时抛出错误。
 * @remarks 先结束旧 watcher，防止两个 launcher 对同一独立 profile 或 CDP 端口竞争。
 */
async function restartLauncher() {
  if (!controllerOrigin || !gatewayUiOrigin) throw new Error("Gateway 尚未准备完成。");
  const dataDirectory = path.join(userDataRoot(), "data");
  if (codexConfigurationRequired(dataDirectory, Number(new URL(controllerOrigin).port))) {
    await openManagementPage();
    await dialog.showMessageBox({
      type: "warning",
      title: "需要更新 Codex 配置",
      message: "Gateway 代理端口已更换，尚未同步到 Codex。",
      detail: "请在已打开的管理页执行“一键配置”，然后重启 Codex。"
    });
    return;
  }
  const previous = launcher;
  launcher = null;
  await stopChildAndWait(previous);
  if (stopping) return;
  launcher = startLauncher(
    Number(new URL(controllerOrigin).port),
    Number(new URL(gatewayUiOrigin).port),
    dataDirectory
  );
}

/**
 * 创建托盘入口并绑定常用操作。
 * @returns {void} 托盘菜单创建完成后返回。
 */
function createTray() {
  const iconName = "cgc-tray-template.png";
  const sourceIcon = nativeImage.createFromPath(path.join(__dirname, "assets", iconName));
  if (sourceIcon.isEmpty()) throw new Error("无法加载菜单栏图标资源。");
  const icon = sourceIcon.resize({ width: 18, height: 18, quality: "best" });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Codex Gateway Control");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开管理页", click: () => void openManagementPage() },
    { label: "启动 Codex", click: () => void restartLauncher().catch((error) => dialog.showErrorBox("Codex 启动失败", error.message)) },
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
 * 启动 Gateway 和可选 Codex 注入流程。
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
  const uiTlsPort = await findLoopbackPort(preferredUiTlsPort, [controllerPort], 4401);
  controllerOrigin = `http://127.0.0.1:${controllerPort}`;
  gatewayUiOrigin = `https://127.0.0.1:${uiTlsPort}`;
  controller = startController(controllerPort, uiTlsPort, dataDirectory, selection.autoConfigureCodex);
  await waitForHealth(`${controllerOrigin}/health`);
  if (selection.initialized) persistInitialControllerPort(dataDirectory, controllerPort);
  if (codexConfigurationRequired(dataDirectory, controllerPort)) {
    await openManagementPage();
    await dialog.showMessageBox({
      type: "warning",
      title: selection.autoConfigureCodex ? "无法完成自动修复" : "需要完成设置更新",
      message: selection.autoConfigureCodex ? "Gateway 已准备好，但未能自动更新 Codex 设置。" : "Gateway 的本机连接设置尚未同步到 Codex。",
      detail: "已打开管理页。请点击“一键配置”完成更新，然后再从菜单栏启动 Codex。"
    });
    return;
  }
  launcher = startLauncher(controllerPort, uiTlsPort, dataDirectory);
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("window-all-closed", (event) => event.preventDefault());
  app.on("before-quit", (event) => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void Promise.all([stopChildAndWait(launcher), stopChildAndWait(controller)]).finally(() => {
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
