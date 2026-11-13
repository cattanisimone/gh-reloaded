// features/notifications/content.js — wires the headless engine into the page:
// reads the stored preferences, keeps the registry in sync with them and with
// the current route, and starts or stops the engine accordingly. The engine
// only runs on the inbox list (see route.js) and only when a registered
// module is enabled and "Native inbox" is off; otherwise it is not even
// started and no request is made. Loaded on every github.com page because
// the inbox is often reached by soft navigation (the bell icon).
//
// The registry and the engine are exposed on GHNotifications for the modules
// that register themselves. The only thing rendered here is the settings
// panel's button (panel.js), which follows the route, not the engine.

(function () {
  const KEYS = { ...globalThis.GHNT_PREFS.KEYS, windowDays: "ghntMentionWindowDays" };
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

  const FILL_PAGE_TYPE = "GHNT_FILL_PAGE"; // matches background/notifications.js

  // The native query, as the API read and the fill rebuild it.
  const nativeQuery = () => globalThis.GHNT_QUERY.analyse(location.href);

  const engine = globalThis.GHNT_ENGINE.createEngine({
    collect: () => globalThis.GHNT_COLLECT.readPage(document),
    mergeApi: globalThis.GHNT_COLLECT.mergeApi,
    fromApiItem: globalThis.GHNT_COLLECT.fromApiItem,
    classify: globalThis.GHNT_CLASSIFY.classify,
    needsFacts: globalThis.GHNT_CLASSIFY.needsFacts,
    getWindowDays: () => windowDays,
    getApiQuery: () => {
      const q = nativeQuery();
      // A filter applied in memory (repo:, org:, reason:) is not a new read: only the API parameters are.
      return { key: globalThis.GHNT_QUERY.paramsKey(q), all: q.params.all, participating: q.params.participating };
    },
    send: async (payload) => {
      if (!extensionAlive()) return null;
      return chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload });
    },
  });

  // Reads more of the notifications on intent only (Triage selecting a category,
  // Load more, the Grouped action). It never runs by itself.
  const fill = globalThis.GHNT_FILL.createFill({
    collect: globalThis.GHNT_COLLECT,
    query: globalThis.GHNT_QUERY,
    classify: globalThis.GHNT_CLASSIFY.classify,
    needsFacts: globalThis.GHNT_CLASSIFY.needsFacts,
    getWindowDays: () => windowDays,
    isVisible: () => document.visibilityState !== "hidden",
    getPage: () => {
      const page = globalThis.GHNT_COLLECT.readPage(document);
      const items = engine.getState().items.filter((i) => i.inPage !== false);
      return { rows: page.rows, me: page.me, counts: globalThis.GHNT_TRIAGE_MODEL?.counts(items) || {} };
    },
    sendPage: async (payload) => {
      if (!extensionAlive()) return null;
      try {
        return await chrome.runtime.sendMessage({ type: FILL_PAGE_TYPE, payload });
      } catch {
        return null;
      }
    },
    sendLookup: async (payload) => {
      if (!extensionAlive()) return null;
      try {
        return await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload });
      } catch {
        return null;
      }
    },
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") fill.notifyVisible();
  });

  const panel = globalThis.GHNT_PANEL.create({
    registry,
    engine,
    prefs: globalThis.GHNT_PREFS,
    route: globalThis.GHNT_ROUTE,
    storage: chrome.storage.local,
    openSettings: () => {
      if (extensionAlive()) chrome.runtime.sendMessage({ type: "GHNT_OPEN_SETTINGS" });
    },
  });

  function sync() {
    if (!extensionAlive()) return;
    // The panel's button follows the route and the page's own header, never the engine.
    panel.sync();
    const run = globalThis.GHNT_ROUTE.isInboxRoute(location.href) && registry.hasActive();
    if (run && !engine.isActive()) {
      engine.start();
      registry.setRunning(true, { getState: engine.getState, subscribe: engine.subscribe });
    } else if (!run && engine.isActive()) {
      registry.setRunning(false);
      fill.reset();
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
    const prefs = globalThis.GHNT_PREFS.normalize(stored);
    registry.setConfig({ modules: stored[KEYS.modules], nativeInbox: prefs.nativeInbox, layout: prefs.layout });
    panel.setPrefs(stored);
    sync();
  }

  registry.onChange(sync);

  globalThis.GHNotifications = { registry, engine, fill };
  // Counters of the last fills, for a development build (an unpacked install has
  // no update_url) in DevTools only: nothing is shown or stored.
  try {
    if (!chrome.runtime.getManifest().update_url) globalThis.GHNotifications.fillStats = fill.stats;
  } catch {
    /* no manifest, no counters */
  }

  document.addEventListener("turbo:load", sync);
  document.addEventListener("turbo:render", sync);
  window.addEventListener("popstate", sync);

  chrome.storage.onChanged.addListener((changes) => {
    if (!extensionAlive()) return;
    if (changes[KEYS.modules] || changes[KEYS.nativeInbox] || changes[KEYS.layout]) loadPrefs();
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
    if (pending || !(engine.isActive() || globalThis.GHNT_ROUTE.isInboxRoute(location.href))) return;
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
