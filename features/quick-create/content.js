// features/quick-create/content.js — a button (or row of buttons) right
// after a GitHub Projects board's own title, each linking straight to
// "new issue" for a repo you've configured in Settings.
//
// Deliberately knows nothing about any specific repo, org, or project:
// every shortcut is user-defined (label, target URL, project scope,
// color) via the Settings page.

(function () {
  const ROOT_ID = "ghqc-root";

  // Reloading/updating the extension while this content script is still
  // running on an already-open tab orphans it: chrome.* calls start
  // throwing "Extension context invalidated" instead of doing anything.
  // There's nothing useful to do at that point except stop trying — the
  // tab needs a real reload to get a fresh, working instance.
  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // "owner/number" for the project the current page is on, or null if
  // we're not on a Projects board view at all.
  function currentProjectKey() {
    const m = /^\/(orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(location.pathname);
    return m ? `${m[2]}/${m[3]}` : null;
  }

  function matchesProject(shortcut, currentKey) {
    const scope = (shortcut.project || "").trim();
    if (!scope) return true; // no scope set — show on every board
    if (!currentKey) return false;
    return scope.toLowerCase() === currentKey.toLowerCase();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function waitFor(fn, { timeout = 4000, interval = 200 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // The board's own title row (lock icon + editable name + pencil
  // button, wrapped in a "memex-title-module__Box" container) is the
  // real "after the title" anchor. A plain `document.querySelector("h1")`
  // isn't specific enough: GitHub pages often carry an earlier,
  // visually-hidden <h1> elsewhere for accessibility, and that one wins
  // a bare tag match — landing our button somewhere invisible instead.
  // Anchoring on the whole title row (not just the inner <h1>) also
  // means our button renders as its own line below the title, rather
  // than getting wedged between the title text and its edit-pencil
  // button inside that row's own flex layout.
  function findTitleAnchor() {
    return (
      document.querySelector('[class*="memex-title-module__Box__"]') ||
      document.querySelector('[class*="memex-title-module__Box"] h1') ||
      document.querySelector("h1")
    );
  }

  function buildRoot(shortcuts) {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = shortcuts
      .map((s) => {
        const url = escapeHtml(s.url || "");
        const color = escapeHtml(s.color || "#1f883d");
        const label = escapeHtml(s.label || "New");
        return `
          <a class="ghqc-btn" href="${url}" target="_blank" rel="noopener"
             style="background:${color};" title="${url}">
            ${label}
          </a>`;
      })
      .join("");
    return root;
  }

  async function render(shortcuts) {
    document.getElementById(ROOT_ID)?.remove();
    const currentKey = currentProjectKey();
    const visible = shortcuts.filter((s) => matchesProject(s, currentKey));
    if (!currentKey || !visible.length) return;

    const root = buildRoot(visible);
    const anchor = await waitFor(findTitleAnchor);

    if (document.getElementById(ROOT_ID)) return; // a later render() already handled this
    if (anchor) {
      anchor.insertAdjacentElement("afterend", root);
    } else {
      // Couldn't find the title (GitHub redesign, or it just hasn't
      // rendered yet) — fall back to a floating button rather than
      // showing nothing.
      root.classList.add("is-floating");
      document.body.appendChild(root);
    }
  }

  async function load() {
    if (!extensionAlive()) return;
    const { quickCreateShortcuts, quickCreateEnabled } = await chrome.storage.local.get([
      "quickCreateShortcuts",
      "quickCreateEnabled",
    ]);
    if (quickCreateEnabled === false) {
      document.getElementById(ROOT_ID)?.remove();
      return;
    }
    render((quickCreateShortcuts || []).filter((s) => s && s.url));
  }

  // Re-render on GitHub's SPA navigation (switching views/boards is a URL
  // change without a full page load) and whenever Settings are edited
  // while a board tab is open.
  let lastUrl = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) {
      clearInterval(pollId);
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      load();
    }
  }, 800);

  chrome.storage.onChanged.addListener((changes) => {
    if (extensionAlive() && (changes.quickCreateShortcuts || changes.quickCreateEnabled)) load();
  });

  load();
})();
