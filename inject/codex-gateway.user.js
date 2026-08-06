(() => {
  "use strict";

  const SOURCE_HASH = window.__CODEX_GATEWAY_SOURCE_HASH__;
  const SENTINEL = "__codexGatewayInjection__";
  const ENTRY_ID = "codex-gateway-entry";
  const PAGE_ID = "codex-gateway-page";
  const FRAME_ID = "codex-gateway-frame";
  const STYLE_ID = "codex-gateway-inject-style";
  const OWNED = "data-codex-gateway-owned";
  const HIDDEN = "data-codex-gateway-native-hidden";
  const ACTIVE = "data-codex-gateway-open";
  const GATEWAY_URL = typeof window.__CODEX_GATEWAY_URL__ === "string"
    ? window.__CODEX_GATEWAY_URL__
    : "http://127.0.0.1:4000/";

  const previous = window[SENTINEL];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try { previous?.destroy?.(); } catch (_) {}

  let entry;
  let page;
  let frame;
  let observer;
  let reattachTimer;
  let active = false;
  let destroyed = false;

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] { background: color-mix(in srgb, currentColor 10%, transparent); }
      #${ENTRY_ID}:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      #${PAGE_ID} { position:absolute; inset:0; z-index:100; min-width:0; min-height:0; overflow:hidden; background:Canvas; color:CanvasText; }
      #${PAGE_ID}[hidden] { display:none !important; }
      #${FRAME_ID} { display:block; width:100%; height:100%; border:0; background:Canvas; }
      #${PAGE_ID} [data-gateway-close] { position:absolute; z-index:1; top:10px; right:12px; border:1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius:4px; padding:5px 9px; background:Canvas; color:CanvasText; cursor:pointer; font:12px system-ui,sans-serif; }
      [${HIDDEN}="true"] { visibility:hidden !important; pointer-events:none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function sidebarReference() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (scroll) return Array.from(scroll.querySelectorAll("button")).at(-1) || null;
    return document.querySelector("aside nav button, [role='navigation'] button");
  }

  function createEntry(reference) {
    const button = reference?.cloneNode?.(true) || document.createElement("button");
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED, "true");
    button.setAttribute("aria-label", "Open Gateway");
    button.title = "Gateway";
    button.querySelectorAll?.("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector?.(".text-fade-truncate") || button.querySelector?.("span");
    if (label) label.textContent = "Gateway";
    else button.textContent = "Gateway";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = sidebarReference();
    const host = reference?.parentElement || document.querySelector("aside nav, [role='navigation']") || document.body;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== host) {
      if (reference?.parentElement === host) reference.after(entry);
      else host.appendChild(entry);
    }
    entry.toggleAttribute("aria-current", active);
  }

  function findMount() {
    const frameHost = document.querySelector(".app-shell-main-content-frame");
    const layout = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = layout?.parentElement;
    if (surface?.closest?.("main")) return surface;
    return document.querySelector("main") || document.body;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "Codex Gateway Control");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("data-gateway-close", "true");
    close.addEventListener("click", closeGateway);
    section.appendChild(close);
    return section;
  }

  function createFrame() {
    frame?.remove();
    frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.title = "Codex Gateway Control";
    frame.referrerPolicy = "no-referrer";
    frame.src = GATEWAY_URL;
    frame.addEventListener("load", () => frame?.setAttribute("data-gateway-frame-loaded", "true"));
    page.appendChild(frame);
  }

  function mountActivePage() {
    if (!active || destroyed) return;
    if (!page) page = createPage();
    const surface = findMount();
    if (page.parentElement !== surface) surface.appendChild(page);
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
    });
    if (!frame?.isConnected) createFrame();
    page.hidden = false;
    document.documentElement.setAttribute(ACTIVE, "true");
  }

  function restoreNativePage() {
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    document.documentElement.removeAttribute(ACTIVE);
  }

  function closeGateway() {
    active = false;
    if (page) page.hidden = true;
    restoreNativePage();
    if (entry) entry.removeAttribute("aria-current");
  }

  function open() {
    active = true;
    ensureEntry();
    mountActivePage();
  }

  function nativeNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    return Boolean(clickable && clickable !== entry && !clickable.closest?.(`#${ENTRY_ID}`)
      && clickable.closest?.("aside nav, [role='navigation']"));
  }

  function scheduleRefresh() {
    if (destroyed || reattachTimer) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = undefined;
      ensureEntry();
      mountActivePage();
    }, 120);
  }

  function refresh() { ensureEntry(); mountActivePage(); }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.clearTimeout(reattachTimer);
    observer?.disconnect();
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("popstate", closeGateway);
    window.removeEventListener("hashchange", closeGateway);
    restoreNativePage();
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
  }

  function onDocumentClick(event) { if (active && nativeNavigation(event.target)) closeGateway(); }

  const api = {
    sourceHash: SOURCE_HASH,
    open,
    close: closeGateway,
    refresh,
    destroy,
    status: () => ({
      sourceHash: SOURCE_HASH,
      entryMounted: Boolean(document.getElementById(ENTRY_ID)),
      pageMounted: Boolean(document.getElementById(PAGE_ID)),
      pageVisible: document.getElementById(PAGE_ID)?.hidden === false,
      frameUrl: document.getElementById(FRAME_ID)?.src || null,
      frameLoaded: document.getElementById(FRAME_ID)?.getAttribute("data-gateway-frame-loaded") === "true"
    })
  };
  window[SENTINEL] = api;
  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("popstate", closeGateway);
  window.addEventListener("hashchange", closeGateway);
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureEntry();
})();
