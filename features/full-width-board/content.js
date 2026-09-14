// features/full-width-board/content.js — on a GitHub Projects **Board**
// (kanban) view, stretches the board to the full viewport width instead
// of sitting inside the page's normal centered/padded column. On by
// default; toggled from Settings only (no in-page control — it's a
// visual default the user either wants or doesn't, not something to
// flip per-session).

(function () {
  const BODY_CLASS = "ghfw-active";
  const STORAGE_KEY = "ghfwEnabled";
  const SELECTED_TAB_SELECTOR = 'nav[aria-label="Select view"] [role="tab"][aria-selected="true"], nav[aria-label="Select view"] [role="tab"].selected';

  function isProjectsPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
  }

  // Same signal features/board-dependencies uses: the selected view
  // tab's own icon says whether this is a Board (kanban), Table, or
  // Roadmap layout — full width only makes sense for a Board.
  function isBoardLayout() {
    const tab = document.querySelector(SELECTED_TAB_SELECTOR);
    const icon = tab?.querySelector('svg[class*="octicon-project"]');
    return !!icon && icon.classList.contains("octicon-project");
  }

  async function sync() {
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    const shouldApply = enabled !== false && isProjectsPage() && isBoardLayout();
    const changed = document.body.classList.contains(BODY_CLASS) !== shouldApply;
    document.body.classList.toggle(BODY_CLASS, shouldApply);
    // Anything that measured card/column positions before this class
    // flip (board-dependencies' arrows, for one) is now holding stale
    // coordinates — the class change itself fires no DOM event a
    // MutationObserver would catch (it's on <body>, and it's an
    // attribute, not a childList change). A synthetic resize is a
    // generic "layout changed, re-measure" signal any such feature is
    // already listening for, without this needing to know who.
    if (changed) requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) sync();
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // Re-run on GitHub's SPA navigation and view-tab switches — same
  // belt-and-suspenders pattern as the other features.
  const debouncedSync = debounce(sync, 150);
  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedSync();
    }
  }, 800);

  sync();
})();
