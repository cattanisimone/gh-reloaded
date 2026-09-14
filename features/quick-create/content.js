// features/quick-create/content.js — a small floating button (or stack of
// buttons) on GitHub Projects board views, each linking straight to
// "new issue" for a repo you've configured in Settings.
//
// Deliberately knows nothing about any specific repo, org, or project:
// every shortcut is user-defined (label, target URL, color) via the
// Settings page. Floating rather than injected into GitHub's own toolbar
// on purpose — GitHub's Projects board markup isn't a stable place to
// anchor on, and a fixed-position button sidesteps that entirely.

(function () {
  const ROOT_ID = "ghqc-root";

  function isProjectsBoardPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
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

  function render(shortcuts) {
    document.getElementById(ROOT_ID)?.remove();
    if (!isProjectsBoardPage() || !shortcuts.length) return;

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
    document.body.appendChild(root);
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
