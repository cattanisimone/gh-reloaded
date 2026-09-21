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

  // The full-bleed CSS trick (`calc(50% - 50vw)`) only breaks a board out
  // to the viewport edges correctly when the board sits centered in a
  // symmetric, viewport-wide wrapper — true with no slice-by panel open.
  // Slicing by a field adds a real sibling column (the slice-by panel)
  // to the board's *left*, so the board's own ancestor is no longer
  // viewport-wide or symmetric: the fixed viewport-based margin then
  // drags the board further left than its actual position, past the
  // edge of an `overflow: hidden` ancestor — the board renders, just
  // entirely clipped out of view (item counts elsewhere on the page
  // still show, since those sit outside the clipped box).
  // Measuring the board's own current left offset — which already
  // correctly reflects the sidebar and any open slice panel, since
  // those are what put it there — and sizing to the viewport's right
  // edge from that point sidesteps the symmetry assumption entirely.
  const LEFT_VAR = "--ghfw-board-left";
  const SLICER_PANEL_SELECTOR = '[class*="slicer-items-module__SlicerPanel"]';

  function updateBoardOffset() {
    const container = document.querySelector('[class*="Board-module__boardContainer"]');
    if (!container) return;
    const left = container.getBoundingClientRect().left;
    document.documentElement.style.setProperty(LEFT_VAR, `${Math.max(left, 0)}px`);
  }

  // The slice panel's width changes live as the user drags its resizer
  // sash, which shifts the board's left offset without any navigation
  // event firing — a ResizeObserver on the panel is what catches that.
  let observedPanel = null;
  const panelResizeObserver = new ResizeObserver(updateBoardOffset);

  function watchSlicerPanel() {
    const panel = document.querySelector(SLICER_PANEL_SELECTOR);
    if (panel === observedPanel) return;
    if (observedPanel) panelResizeObserver.unobserve(observedPanel);
    observedPanel = panel;
    if (panel) panelResizeObserver.observe(panel);
  }

  // The "+" (add column) button has no class of its own to select —
  // identified only by its tooltip's text. It sits as the columns'
  // own direct sibling inside the board's scrollable region (no
  // dedicated wrapper div around it), so once the row's columns
  // expand to fill the new width, the button just gets knocked out of
  // its normal spot with nothing to realign it against — simplest fix
  // is to hide it rather than fight that layout. Tagging and hiding
  // the button itself (not btn.parentElement) matters here: that
  // parent IS the board's whole scrollable region — tagging it would
  // hide every column along with the button. Tagged with a class
  // (rather than hidden directly) so the CSS rule stays scoped to
  // ghfw-active and the button reappears on its own the moment this
  // feature is off.
  const ADD_COLUMN_CLASS = "ghfw-add-column";

  function tagAddColumnButton() {
    for (const btn of document.querySelectorAll("button[aria-labelledby]")) {
      if (btn.classList.contains(ADD_COLUMN_CLASS)) continue;
      const label = document.getElementById(btn.getAttribute("aria-labelledby"));
      if (label && /add a new column to the board/i.test(label.textContent || "")) {
        btn.classList.add(ADD_COLUMN_CLASS);
      }
    }
  }

  async function sync() {
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    const shouldApply = enabled !== false && isProjectsPage() && isBoardLayout();
    const changed = document.body.classList.contains(BODY_CLASS) !== shouldApply;
    document.body.classList.toggle(BODY_CLASS, shouldApply);
    if (shouldApply) {
      tagAddColumnButton();
      watchSlicerPanel();
      updateBoardOffset();
    } else if (observedPanel) {
      panelResizeObserver.unobserve(observedPanel);
      observedPanel = null;
    }
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
      // recreate the "+" button, or the slice-by panel itself, without
      // any URL change — re-tag/re-observe whenever full width is
      // active, not just right after sync().
      tagAddColumnButton();
      watchSlicerPanel();
      updateBoardOffset();
    }
  }, 800);

  window.addEventListener("resize", () => {
    if (document.body.classList.contains(BODY_CLASS)) updateBoardOffset();
  });

  sync();
})();
