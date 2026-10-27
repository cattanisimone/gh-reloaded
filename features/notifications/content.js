// features/notifications/content.js — wires the headless engine into the page:
// reads the stored preferences, keeps the registry in sync with them and with
// the current route, and starts or stops the engine accordingly. The engine
// only runs on the inbox list (see route.js) and only when a registered
// module is enabled and "Native inbox" is off; otherwise it is not even
// started and no request is made. Loaded on every github.com page because
// the inbox is often reached by soft navigation (the bell icon).
//
// The registry and the engine are exposed on GHNotifications for the modules
// that later register themselves; this script renders nothing.

(function () {
  const KEYS = { modules: "ghntModules", nativeInbox: "ghntNativeInbox", windowDays: "ghntMentionWindowDays" };
  const MESSAGE_TYPE = "GHNT_FETCH"; // matches background/notifications.js

  const registry = globalThis.GHNT_REGISTRY.createRegistry();
  let windowDays = 7;

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function parseWindow(value) {
    return Number.isInteger(value) && value > 0 ? value : 7;
  }

  const engine = globalThis.GHNT_ENGINE.createEngine({
    collect: () => globalThis.GHNT_COLLECT.readPage(document),
    mergeApi: globalThis.GHNT_COLLECT.mergeApi,
    fromApiItem: globalThis.GHNT_COLLECT.fromApiItem,
    classify: globalThis.GHNT_CLASSIFY.classify,
    needsFacts: globalThis.GHNT_CLASSIFY.needsFacts,
    getWindowDays: () => windowDays,
    send: async (payload) => {
      if (!extensionAlive()) return null;
      return chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload });
    },
  });

  function sync() {
    if (!extensionAlive()) return;
    const run = globalThis.GHNT_ROUTE.isInboxRoute(location.href) && registry.hasActive();
    if (run && !engine.isActive()) {
      engine.start();
      registry.setRunning(true, { getState: engine.getState, subscribe: engine.subscribe });
    } else if (!run && engine.isActive()) {
      registry.setRunning(false);
      engine.stop();
    } else if (run) {
      engine.scan();
    }
  }

  async function loadPrefs() {
    if (!extensionAlive()) return;
    let stored = {};
    try {
      stored = await chrome.storage.local.get(Object.values(KEYS));
    } catch {
      return;
    }
    windowDays = parseWindow(stored[KEYS.windowDays]);
    registry.setConfig({ modules: stored[KEYS.modules], nativeInbox: stored[KEYS.nativeInbox] === true });
    sync();
  }

  registry.onChange(sync);

  globalThis.GHNotifications = { registry, engine };

  document.addEventListener("turbo:load", sync);
  document.addEventListener("turbo:render", sync);
  window.addEventListener("popstate", sync);

  chrome.storage.onChanged.addListener((changes) => {
    if (!extensionAlive()) return;
    if (changes[KEYS.modules] || changes[KEYS.nativeInbox]) loadPrefs();
    if (changes[KEYS.windowDays]) {
      windowDays = parseWindow(changes[KEYS.windowDays].newValue);
      engine.reclassify();
    }
  });

  // New rows (infinite scroll, filters, pagination) and soft navigations
  // without a turbo event: re-scan while the engine runs.
  let pending = false;
  const observer = new MutationObserver(() => {
    if (!extensionAlive()) return observer.disconnect();
    if (pending || !engine.isActive()) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      sync();
    }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // The URL can change with no event we hear (history.pushState by GitHub).
  let lastHref = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) return clearInterval(pollId);
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    }
  }, 500);

  loadPrefs();
})();
