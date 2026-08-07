(() => {
  "use strict";

  const SOURCE_HASH = window.__CODEX_GATEWAY_SOURCE_HASH__;
  const SENTINEL = "__codexGatewayInjection__";
  const ENTRY_ID = "codex-gateway-entry";
  const PAGE_ID = "codex-gateway-page";
  const FRAME_ID = "codex-gateway-frame";
  const STATUS_ID = "codex-gateway-status";
  const STYLE_ID = "codex-gateway-inject-style";
  const OWNED = "data-codex-gateway-owned";
  const HIDDEN = "data-codex-gateway-native-hidden";
  const NATIVE_SELECTED = "data-codex-gateway-native-selected";
  const ACTIVE = "data-codex-gateway-open";
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4000/";
  const PLUGIN_LABELS = ["插件", "plugins"];

  const previous = window[SENTINEL];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try { previous?.destroy?.(); } catch (_) {}

  let entry;
  let page;
  let frame;
  let status;
  let observer;
  let reattachTimer;
  let frameReadyTimer;
  let frameOrigin = "";
  let frameBlobUrl = "";
  let frameLoadGeneration = 0;
  let frameReady = false;
  let frameError = "";
  const mutedNativeSelections = new Map();
  let active = false;
  let destroyed = false;

  /**
   * 解析本地 Gateway 页面地址，并拒绝非 HTTP(S) 的注入配置。
   * @returns {URL} 可安全作为 iframe 地址使用的本地 Gateway URL。
   * @remarks URL 无效时回退到固定 loopback 地址，不读取任何认证材料。
   */
  function gatewayUrl() {
    try {
      const url = new URL(typeof window.__CODEX_GATEWAY_URL__ === "string"
        ? window.__CODEX_GATEWAY_URL__
        : DEFAULT_GATEWAY_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("不支持的协议");
      return url;
    } catch (_) {
      return new URL(DEFAULT_GATEWAY_URL);
    }
  }

  /**
   * 注入用于入口、覆盖页和诊断状态的局部样式。
   * @returns {void} 无返回值。
   * @remarks 只创建一个带所属标记的 style，热更新时不会重复插入。
   */
  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] { background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 10%, transparent)); color:var(--color-token-foreground, inherit); }
      #${ENTRY_ID}:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      #${PAGE_ID} { position:absolute; inset:0; z-index:100; min-width:0; min-height:0; overflow:hidden; background:#f4f6fb; color:CanvasText; }
      #${PAGE_ID}[hidden] { display:none !important; }
      #${FRAME_ID} { display:block; width:100%; height:calc(100% - 12px); margin-top:12px; border:0; background:Canvas; }
      #${FRAME_ID}[hidden] { display:none !important; }
      #${STATUS_ID} { position:absolute; inset:0; display:grid; z-index:1; place-items:center; padding:24px; color:color-mix(in srgb, CanvasText 65%, transparent); font:13px/1.5 system-ui,sans-serif; text-align:center; }
      #${STATUS_ID}[hidden] { display:none !important; }
      #${STATUS_ID} div { max-width:360px; }
      #${STATUS_ID} button { margin:10px 4px 0; border:1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius:7px; padding:5px 10px; background:Canvas; color:CanvasText; cursor:pointer; font:12px system-ui,sans-serif; }
      [${HIDDEN}="true"] { visibility:hidden !important; pointer-events:none !important; }
      [${NATIVE_SELECTED}="true"] { background-color:transparent !important; }
      [${NATIVE_SELECTED}="true"] [class*="text-token-list-active-selection"] { color:var(--color-token-foreground, inherit) !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 归一化原生侧栏显示文案，供中英文入口匹配使用。
   * @param {string|null|undefined} value 待比较的文字或可访问名称。
   * @returns {string} 去除空白并转为小写后的文案。
   * @remarks 不修改原始 DOM，仅用于识别 Codex 的内置入口。
   */
  function normalizedLabel(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * 判断一个原生按钮是否匹配指定的侧栏文案。
   * @param {Element|null|undefined} button 待检查的按钮。
   * @param {string[]} labels 允许的归一化文案集合。
   * @returns {boolean} 按钮文字或可访问名称命中时返回 true。
   * @remarks 侧栏本地化后优先读取文字，缺少文字时回退到 aria-label。
   */
  function buttonMatches(button, labels) {
    if (!button) return false;
    return labels.includes(normalizedLabel(button.textContent || button.getAttribute("aria-label")));
  }

  /**
   * 查找“插件”入口，并返回可用于插入 Gateway 的稳定原生按钮。
   * @returns {HTMLButtonElement|null} 插入点按钮；侧栏尚未完成渲染时返回 null。
   * @remarks 不使用侧栏最后一个按钮，因为项目和对话列表中的操作图标也会出现在该查询结果中。
   */
  function sidebarReference() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin?.parentElement) {
      const siblings = Array.from(plugin.parentElement.children).filter((child) => child.tagName === "BUTTON");
      if (siblings.length >= 3) return plugin;
    }
    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  /**
   * 将克隆入口的图标替换为 Gateway 路由图标。
   * @param {HTMLButtonElement} button 已克隆的 Gateway 入口。
   * @returns {void} 无返回值。
   * @remarks 只修改克隆节点，不影响 Codex 原生“插件”图标。
   */
  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = "<circle cx=\"6\" cy=\"7\" r=\"2\"></circle><circle cx=\"18\" cy=\"7\" r=\"2\"></circle><circle cx=\"12\" cy=\"17\" r=\"2\"></circle><path d=\"M7.7 8.2 10.3 15M16.3 8.2 13.7 15M8 7h8\"></path>";
  }

  /**
   * 创建一次性的 Gateway 侧栏入口。
   * @param {Element|null} reference 原生入口的克隆参考。
   * @returns {HTMLButtonElement} 已绑定打开事件的入口按钮。
   */
  function createEntry(reference) {
    const button = reference?.cloneNode?.(true) || document.createElement("button");
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED, "true");
    button.setAttribute("aria-label", "打开网关管理");
    button.title = "网关管理";
    button.querySelectorAll?.("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector?.(".text-fade-truncate")
      || Array.from(button.querySelectorAll?.("span") || []).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = "网关管理";
    else button.textContent = "网关管理";
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  /**
   * 将 Gateway 入口插入或重新挂回当前 Codex 侧栏。
   * @returns {void} 无返回值。
   * @remarks renderer 重建侧栏时会复用已有入口，避免重复 observer 和按钮。
   */
  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = sidebarReference();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) reference.after(entry);
    if (active) entry.setAttribute("aria-current", "page");
    else entry.removeAttribute("aria-current");
  }

  /**
   * 暂时取消原生侧栏页面的视觉选中态。
   * @returns {void} 无返回值。
   * @remarks 保留原有 `aria-current` 值，Gateway 关闭后会完整恢复；不修改 Codex 的路由或会话状态。
   */
  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll("[data-app-action-sidebar-scroll] [aria-current]").forEach((node) => {
      if (node === entry || node.closest?.(`#${ENTRY_ID}`)) return;
      if (!mutedNativeSelections.has(node)) mutedNativeSelections.set(node, node.getAttribute("aria-current"));
      node.removeAttribute("aria-current");
      node.setAttribute(NATIVE_SELECTED, "true");
    });
  }

  /**
   * 恢复打开 Gateway 前原生侧栏页面的选中态。
   * @returns {void} 无返回值。
   * @remarks renderer 替换导致节点失联时跳过该节点，并清理所有注入所属标记。
   */
  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      if (ariaCurrent === null) node.removeAttribute("aria-current");
      else node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED}="true"]`).forEach((node) => node.removeAttribute(NATIVE_SELECTED));
  }

  /**
   * 隐藏会浮在 Gateway 内容上方的 Codex 原生标题栏内容。
   * @returns {void} 无返回值。
   * @remarks 只隐藏 header surface 的直接子项，保留窗口本身的拖拽区域；关闭 Gateway 时由 restoreNativePage 恢复。
   */
  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]').forEach((surface) => {
      Array.from(surface.children).forEach((child) => {
        if (child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
      });
    });
  }

  /**
   * 取得 Codex 主工作区的稳定挂载表面。
   * @returns {Element|null} 主工作区父表面；原生布局尚未完成时返回 null。
   * @remarks 不回退到 body，防止启动期意外遮住整个 Codex 窗口。
   */
  function findMount() {
    const frameHost = document.querySelector(".app-shell-main-content-frame");
    const layout = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = layout?.parentElement;
    return surface?.closest?.("main") ? surface : null;
  }

  /**
   * 创建含诊断区域的 Gateway 覆盖页。
   * @returns {HTMLElement} 尚未挂载的页面容器。
   */
  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "Codex 网关管理");
    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.append(status);
    return section;
  }

  /**
   * 显示 iframe 等待应用确认时的加载状态。
   * @returns {void} 无返回值。
   */
  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在加载 Gateway 管理页…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  /**
   * 显示已通过 Gateway 应用层就绪确认的 iframe。
   * @returns {void} 无返回值。
   */
  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  /**
   * 显示可恢复的 iframe 加载错误，避免以空白页覆盖原生工作区。
   * @param {string} message 不含凭据的本地诊断信息。
   * @returns {void} 无返回值。
   */
  function showLoadError(message) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    retry.addEventListener("click", reloadFrame);
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "返回 Codex";
    back.addEventListener("click", closeGateway);
    content.append(text, retry, back);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  /**
   * 清除当前 iframe 的应用层就绪超时计时器。
   * @returns {void} 无返回值。
   */
  function clearFrameReadyTimer() {
    window.clearTimeout(frameReadyTimer);
    frameReadyTimer = undefined;
  }

  /**
   * 在 Gateway HTML 中写入资源与 API 请求共用的本地 base URL。
   * @param {string} html Controller 返回的公开 HTML 文本。
   * @param {URL} url Gateway 页面 URL。
   * @returns {string} 可作为 blob 文档加载的 HTML。
   * @remarks URL 由固定本地配置解析而来；函数不处理用户输入或认证材料。
   */
  function withGatewayBase(html, url) {
    const base = `<base href="${url.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
    if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${base}`);
    return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  }

  /**
   * 撤销已不再使用的 blob URL，避免多次重新加载累积内存。
   * @returns {void} 无返回值。
   */
  function revokeFrameBlobUrl() {
    if (!frameBlobUrl) return;
    URL.revokeObjectURL(frameBlobUrl);
    frameBlobUrl = "";
  }

  /**
   * 创建并装载 CSP 兼容的 Gateway blob iframe。
   * @param {boolean} cacheBust 是否为重新加载追加无语义的缓存参数。
   * @returns {Promise<void>} HTML 读取和 blob iframe 创建完成后的 Promise。
   * @remarks 公开 HTML 由本地 launcher 读取后随注入源码提供，避免 renderer 的 `connect-src` CSP 阻止初始读取；不把会话 Cookie 或令牌写入 blob。
   */
  async function createFrame(cacheBust = false) {
    const generation = ++frameLoadGeneration;
    clearFrameReadyTimer();
    frame?.remove();
    revokeFrameBlobUrl();
    frame = undefined;
    frameReady = false;
    frameError = "";
    const url = gatewayUrl();
    if (cacheBust) url.searchParams.set("__codex_gateway_refresh", Date.now().toString(36));
    try {
      const html = typeof window.__CODEX_GATEWAY_BLOB_HTML__ === "string"
        ? window.__CODEX_GATEWAY_BLOB_HTML__
        : "";
      if (!html) throw new Error("本地启动器未提供 Gateway 公开页面，请重新运行 npm run codex");
      if (destroyed || !active || generation !== frameLoadGeneration || !page?.isConnected) return;
      frameOrigin = window.location.origin;
      frameBlobUrl = URL.createObjectURL(new Blob([withGatewayBase(html, url)], { type: "text/html" }));
      const nextFrame = document.createElement("iframe");
      nextFrame.id = FRAME_ID;
      nextFrame.hidden = true;
      nextFrame.title = "Codex 网关管理";
      nextFrame.referrerPolicy = "no-referrer";
      nextFrame.src = frameBlobUrl;
      nextFrame.addEventListener("load", () => nextFrame.setAttribute("data-gateway-frame-loaded", "true"));
      frame = nextFrame;
      page.appendChild(nextFrame);
      frameReadyTimer = window.setTimeout(() => {
        if (!active || destroyed || frame !== nextFrame || frameReady) return;
        frameError = "Gateway 管理页未能完成加载。请确认本机 Controller 正常运行后重试。";
        showLoadError(frameError);
      }, FRAME_READY_TIMEOUT_MS);
    } catch (error) {
      if (destroyed || !active || generation !== frameLoadGeneration) return;
      frameError = `无法读取本机 Gateway 页面：${error instanceof Error ? error.message : "网络请求失败"}`;
      showLoadError(frameError);
    }
  }

  /**
   * 在用户请求或超时后重新创建 Gateway iframe。
   * @returns {void} 无返回值。
   */
  function reloadFrame() {
    if (!active || destroyed || !page) return;
    showLoading();
    void createFrame(true);
  }

  /**
   * 覆盖当前工作区，并确保 iframe 已开始加载。
   * @returns {void} 无返回值。
   * @remarks 原生布局未就绪时保留其可见状态并等待 MutationObserver 重试。
   */
  function mountActivePage() {
    if (!active || destroyed) return;
    if (!page) page = createPage();
    const surface = findMount();
    if (!surface) {
      scheduleRefresh();
      return;
    }
    if (page.parentElement !== surface) surface.appendChild(page);
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
    });
    muteNativeSelection();
    hideNativeHeader();
    if (!frame?.isConnected) {
      showLoading();
      void createFrame();
    }
    page.hidden = false;
    document.documentElement.setAttribute(ACTIVE, "true");
  }

  /**
   * 恢复之前被 Gateway 暂时隐藏的 Codex 原生工作区。
   * @returns {void} 无返回值。
   */
  function restoreNativePage() {
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    restoreNativeSelection();
    document.documentElement.removeAttribute(ACTIVE);
  }

  /**
   * 关闭 Gateway 覆盖页并恢复原生 Codex 页面。
   * @returns {void} 无返回值。
   */
  function closeGateway() {
    active = false;
    clearFrameReadyTimer();
    revokeFrameBlobUrl();
    if (page) page.hidden = true;
    restoreNativePage();
    if (entry) entry.removeAttribute("aria-current");
  }

  /**
   * 打开 Gateway 管理页。
   * @returns {void} 无返回值。
   */
  function open() {
    active = true;
    ensureEntry();
    mountActivePage();
  }

  /**
   * 判断点击是否是在原生 Codex 侧栏中切换页面。
   * @param {EventTarget|null} target 当前点击目标。
   * @returns {boolean} 命中原生导航时返回 true。
   */
  function nativeNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    return Boolean(clickable && clickable !== entry && !clickable.closest?.(`#${ENTRY_ID}`)
      && clickable.closest?.("aside nav, [role='navigation']"));
  }

  /**
   * 合并短时间内多次 DOM 变动，并重新检查入口和挂载页。
   * @returns {void} 无返回值。
   */
  function scheduleRefresh() {
    if (destroyed || reattachTimer) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = undefined;
      ensureEntry();
      mountActivePage();
    }, 120);
  }

  /**
   * 接收 Gateway React 应用的非敏感就绪通知。
   * @param {MessageEvent} event 浏览器跨 frame 消息事件。
   * @returns {void} 无返回值。
   * @remarks 必须同时校验 blob iframe 窗口和继承的 Codex app origin，避免其他页面伪造消息。
   */
  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    if (!event.data || event.data.type !== "codex-gateway:ready") return;
    frameReady = true;
    frameError = "";
    clearFrameReadyTimer();
    if (active) showFrame();
  }

  /**
   * 刷新已注入的入口和覆盖页挂载状态。
   * @returns {void} 无返回值。
   */
  function refresh() {
    ensureEntry();
    mountActivePage();
  }

  /**
   * 销毁本次注入创建的 DOM、监听器和定时器。
   * @returns {void} 无返回值。
   * @remarks 仅清理带所属标记的节点，不影响 Codex 原生 DOM。
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.clearTimeout(reattachTimer);
    clearFrameReadyTimer();
    revokeFrameBlobUrl();
    observer?.disconnect();
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("message", onFrameMessage);
    restoreNativePage();
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
  }

  /**
   * 在打开 Gateway 时响应原生侧栏切换并恢复 Codex 页面。
   * @param {MouseEvent} event 捕获阶段的点击事件。
   * @returns {void} 无返回值。
   */
  function onDocumentClick(event) {
    if (active && nativeNavigation(event.target)) closeGateway();
  }

  /**
   * 处理 Gateway 覆盖页的键盘退出操作。
   * @param {KeyboardEvent} event 当前键盘事件。
   * @returns {void} 无返回值。
   * @remarks Esc 只在 Gateway 打开时恢复原生工作区，不干扰 iframe 内的普通输入。
   */
  function onKeyDown(event) {
    if (active && event.key === "Escape") closeGateway();
  }

  const api = {
    sourceHash: SOURCE_HASH,
    open,
    close: closeGateway,
    refresh,
    reloadFrame,
    destroy,
    status: () => ({
      sourceHash: SOURCE_HASH,
      entryMounted: Boolean(document.getElementById(ENTRY_ID)),
      pageMounted: Boolean(document.getElementById(PAGE_ID)),
      pageVisible: document.getElementById(PAGE_ID)?.hidden === false,
      frameUrl: document.getElementById(FRAME_ID)?.src || null,
      frameLoaded: document.getElementById(FRAME_ID)?.getAttribute("data-gateway-frame-loaded") === "true",
      frameReady,
      frameError: frameError || null
    })
  };
  window[SENTINEL] = api;
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("message", onFrameMessage);
  // Codex 会在会话状态同步时自行触发 history 事件；原生侧栏点击已由捕获监听处理，不能把任意路由事件当成离开 Gateway。
  observer = new MutationObserver(scheduleRefresh);
  const observerOptions = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-current", "data-app-action-sidebar-thread-active"]
  };
  if (document.documentElement) observer.observe(document.documentElement, observerOptions);
  else document.addEventListener("DOMContentLoaded", () => observer?.observe(document.documentElement, observerOptions), { once: true });
  ensureEntry();
})();
