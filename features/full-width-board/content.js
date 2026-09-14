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

  // The "+" (add column) button has no class of its own to select —
  // it's a bare <div><button ...></button></div>, identified only by
  // its tooltip's text. Its wrapper sits as the header row's own
  // sibling rather than inside it, so once the row's columns expand to
  // fill the new width, the button just gets knocked out of its normal
  // spot with nothing to realign it against — simplest fix is to hide
  // it rather than fight that layout. Tagged with a class (rather than
  // hidden directly) so the CSS rule stays scoped to ghfw-active and
  // the button reappears on its own the moment this feature is off.
  const ADD_COLUMN_CLASS = "ghfw-add-column";

  function tagAddColumnButton() {
    for (const btn of document.querySelectorAll("button[aria-labelledby]")) {
      if (btn.parentElement?.classList.contains(ADD_COLUMN_CLASS)) continue;
      const label = document.getElementById(btn.getAttribute("aria-labelledby"));
      if (label && /add a new column to the board/i.test(label.textContent || "")) {
        btn.parentElement?.classList.add(ADD_COLUMN_CLASS);
      }
    }
  }

  async function sync() {
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    const shouldApply = enabled !== false && isProjectsPage() && isBoardLayout();
    const changed = document.body.classList.contains(BODY_CLASS) !== shouldApply;
    document.body.classList.toggle(BODY_CLASS, shouldApply);
    if (shouldApply) tagAddColumnButton();
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
    } else if (document.body.classList.contains(BODY_CLASS)) {
      // A re-render (adding/removing a column, filtering, etc.) can
      // recreate the "+" button without any URL change — re-tag it
      // whenever full width is active, not just right after sync().
      tagAddColumnButton();
    }
  }, 800);

  sync();
})();
