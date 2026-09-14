// features/quick-create/content.js — a small floating button (or stack
// of buttons) on GitHub Projects board views, each linking straight to
// "new issue" for a repo you've configured in Settings.
//
// Deliberately knows nothing about any specific repo, org, or project:
// every shortcut is user-defined (label, target URL, project scope,
// color) via the Settings page. Floating rather than anchored to a
// specific piece of GitHub's own markup, on purpose: Projects board
// markup isn't a stable place to anchor on, and this sidesteps that
// entirely at the cost of not looking quite as "native."

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

  function render(shortcuts) {
    document.getElementById(ROOT_ID)?.remove();
    const currentKey = currentProjectKey();
    const visible = shortcuts.filter((s) => matchesProject(s, currentKey));
    if (!currentKey || !visible.length) return;

    const root = buildRoot(visible);
    root.classList.add("is-floating");
    document.body.appendChild(root);
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
