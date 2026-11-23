// features/quick-jump/content.js — the page side of "Quick jump": the browser shortcut and the optional
// ⌘K/Ctrl+K key, the panel, and the recorder of visited issues, pull requests and repositories.
// With no token saved, or with the feature off, it does nothing: no panel, no request, no recording and
// the keystroke is not taken from the page. Talks to the background only (background/quick-jump.js).

(function () {
  const M = globalThis.GHQJ_MODEL;
  const P = globalThis.GHQJ_PANEL;
  if (!M || !P) return;

  let state = { active: false, choice: "browser", shortcut: "", platform: "other" };
  let handle = null;

  const send = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });

  async function refreshState() {
    const res = await send("GHQJ_STATE");
    state = res && res.ok ? { active: !!res.active, choice: res.choice, shortcut: res.shortcut || "", platform: res.platform } : { ...state, active: false };
    syncListeners();
    if (!state.active && handle?.isOpen()) handle.close(false);
    handle?.isOpen() && handle.refreshFooter();
    if (state.active) recordVisit();
  }

  // ---- editable elements -----------------------------------------------------------

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isEditable(node) {
    if (!node || node === document.body || node === document.documentElement) return false;
    const tag = node.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") return !["button", "checkbox", "radio", "submit", "reset", "image", "file", "range", "color"].includes((node.type || "text").toLowerCase());
    if (node.isContentEditable) return true;
    const role = node.getAttribute && node.getAttribute("role");
    return role === "textbox" || role === "combobox" || role === "searchbox";
  }

  // ---- panel -----------------------------------------------------------------------

  const env = {
    state: () => state,
    pathname: () => location.pathname,
    nwo: () => declaredRepo(),
    notFound: () => /^page not found/i.test(document.title) || !!document.querySelector('img[alt*="404"], [data-testid="404"]'),
    request: (payload) => send("GHQJ_LISTS", payload).then((r) => (r && r.ok ? r : null)),
    goto: (url, newTab) => {
      if (!/^https:\/\/github\.com\//.test(url)) return;
      if (newTab) window.open(url, "_blank", "noopener,noreferrer");
      else location.assign(url);
    },
    openSettings: (hash) => send("GHQJ_OPEN_SETTINGS", { hash }),
    closed: (h) => {
      if (handle === h) handle = null;
    },
  };

  function openPanel() {
    if (!state.active || handle?.isOpen()) return;
    handle = P.open(env);
  }

  function toggle(fromKey) {
    if (handle?.isOpen()) {
      handle.close();
      return;
    }
    if (!state.active) return;
    if (isEditable(deepActive())) return;
    openPanel();
    void fromKey;
  }

  // The browser shortcut: Chrome consumes the keystroke and the background asks this tab to toggle.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "GHQJ_TOGGLE") toggle(false);
  });

  // The ⌘K / Ctrl+K value: a key listener that exists only while it is chosen. Outside editable elements
  // it opens and closes the panel and GitHub's own action on that key does not run; in an editable element
  // the key reaches the page untouched, except inside the panel's own input where it closes the panel.
  function onKeyDown(e) {
    if (!(state.active && state.choice === "cmdk")) return;
    if (!M.isCmdK(e, state.platform === "mac")) return;
    const inPanel = handle?.isOpen() && handle.containsFocus();
    if (!inPanel && isEditable(deepActive())) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle(true);
  }

  // ---- recording visits ---------------------------------------------------------------

  let lastSig = "";
  let lastAt = 0;
  let timer = 0;

  function declaredRepo() {
    const meta = document.querySelector('meta[name="octolytics-dimension-repository_nwo"]');
    if (meta && meta.content) return meta.content;
    // Variant without the meta: the repository header links to /owner/repo.
    const m = /^\/([^/]+)\/([^/]+)/.exec(location.pathname);
    if (!m) return "";
    const want = `/${m[1]}/${m[2]}`.toLowerCase();
    for (const a of document.querySelectorAll("header a[href], [data-testid='breadcrumbs'] a[href], #repository-container-header a[href]")) {
      let p = "";
      try {
        p = new URL(a.getAttribute("href"), location.href).pathname.replace(/\/$/, "");
      } catch {
        continue;
      }
      if (p.toLowerCase() === want) return `${m[1]}/${m[2]}`;
    }
    return "";
  }

  function recordVisit() {
    if (!state.active) return;
    const v = M.parseVisit(location.pathname, document.title, declaredRepo());
    if (!v) return;
    const sig = `${v.key}|${v.title}|${location.pathname}`;
    const now = Date.now();
    if (sig === lastSig && now - lastAt < 1200) return;
    lastSig = sig;
    lastAt = now;
    send("GHQJ_VISIT", { kind: v.kind, repo: v.repo, number: v.number, title: v.title });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(recordVisit, 350);
  }

  // GitHub swaps the <title> element on navigation, so watch the head, not one node.
  const headObserver = new MutationObserver(schedule);
  const NAV_EVENTS = [[window, "popstate"], [window, "pageshow"], [document, "turbo:load"], [document, "turbo:render"], [window.navigation, "navigatesuccess"]];

  // Nothing is registered on the page while the feature is off or no token is saved: the navigation hooks
  // that record visits exist only while it is active, and the key listener only while ⌘K / Ctrl+K is chosen.
  let hooked = false;
  let keyed = false;
  function syncListeners() {
    const wantHooks = !!state.active;
    if (wantHooks && !hooked) {
      for (const [t, n] of NAV_EVENTS) t?.addEventListener?.(n, schedule);
      headObserver.observe(document.head, { childList: true, characterData: true, subtree: true });
    } else if (!wantHooks && hooked) {
      for (const [t, n] of NAV_EVENTS) t?.removeEventListener?.(n, schedule);
      headObserver.disconnect();
      clearTimeout(timer);
    }
    hooked = wantHooks;
    const wantKey = wantHooks && state.choice === "cmdk";
    if (wantKey && !keyed) window.addEventListener("keydown", onKeyDown, true);
    else if (!wantKey && keyed) window.removeEventListener("keydown", onKeyDown, true);
    keyed = wantKey;
  }

  // The state follows Settings without a reload: the switch, the shortcut choice and the saved tokens.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.ghqjEnabled || changes.ghqjShortcut || changes.githubTokens || changes.defaultTokenId) refreshState();
  });

  refreshState().then(() => {
    if (state.active) schedule();
  });
})();
