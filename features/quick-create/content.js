// features/quick-create/content.js — a button (or stack of buttons) in
// a GitHub Projects page's own top bar, between its last two button
// groups (Insights/Workflows, and Project details/"..."), each linking
// straight to "new issue" for a repo you've configured in Settings.
// Falls back to a floating button if that bar isn't found.
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

  // Accepts either the "owner/number" shorthand or a full board URL
  // pasted straight from the address bar (the more natural thing to
  // copy) — both normalize to the same "owner/number" key.
  function normalizeProjectScope(raw) {
    const trimmed = (raw || "").trim();
    const m = /\/(orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(trimmed);
    return m ? `${m[2]}/${m[3]}` : trimmed;
  }

  function matchesProject(shortcut, currentKey) {
    const scope = normalizeProjectScope(shortcut.project);
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

  // The project header's top bar carries two button groups on the
  // right: [Insights, Workflows] and [Project details, "..."]. Insert
  // right after the second-to-last one — i.e. between those two groups
  // — rather than trying to append at the very end, so it doesn't end
  // up wedged inside the last group or after the "..." menu.
  function findTopBarInsertionPoint() {
    const topBar = document.querySelector('[class*="index-module__topBarActions"]');
    if (!topBar) return null;
    const groups = Array.from(topBar.children).filter((el) =>
      (el.className || "").toString().includes("index-module__ButtonGroup")
    );
    return groups.length >= 2 ? groups[groups.length - 2] : null;
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

  async function render(shortcuts) {
    document.getElementById(ROOT_ID)?.remove();
    const currentKey = currentProjectKey();
    const visible = shortcuts.filter((s) => matchesProject(s, currentKey));
    if (!currentKey || !visible.length) return;

    const root = buildRoot(visible);
    const anchor = await waitFor(findTopBarInsertionPoint);

    if (document.getElementById(ROOT_ID)) return; // a later render() already handled this
    if (anchor) {
      anchor.insertAdjacentElement("afterend", root);
    } else {
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
