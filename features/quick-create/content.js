// features/quick-create/content.js — a button (or row of buttons) right
// after a GitHub Projects board's own title, each linking straight to
// "new issue" for a repo you've configured in Settings.
//
// Deliberately knows nothing about any specific repo, org, or project:
// every shortcut is user-defined (label, target URL, project scope,
// color) via the Settings page.

(function () {
  const ROOT_ID = "ghqc-root";

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

  // The board's own title is the most reliable "after the title" anchor —
  // it's the one true <h1> GitHub renders for this kind of page,
  // regardless of what the project happens to be named.
  function findTitleAnchor() {
    return document.querySelector("h1");
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
    const { quickCreateShortcuts } = await chrome.storage.local.get("quickCreateShortcuts");
    render((quickCreateShortcuts || []).filter((s) => s && s.url));
  }

  // Re-render on GitHub's SPA navigation (switching views/boards is a URL
  // change without a full page load) and whenever Settings are edited
  // while a board tab is open.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      load();
    }
  }, 800);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.quickCreateShortcuts) load();
  });

  load();
})();
