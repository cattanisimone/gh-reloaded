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
  const SLICER_PANEL_SELECTOR = '[class*="SlicerPanel__"], [class*="slicer-items-module__SlicerPanel"]';

  function updateBoardOffset() {
    const container = document.querySelector('[class*="boardContainer__"], [class*="Board-module__boardContainer"]');
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


  // ---- Narrow windows (#59) ----
  const BOARD_VIEW_SELECTOR = '[class*="boardView__"], [class*="Board-module__boardView"]';
  const LANE_AREA_SELECTOR = '[class*="horizontalGroupAreaContainer__"], [class*="Board-module__horizontalGroupAreaContainer"]';
  const LANE_HEADER_SELECTOR = '[class*="styledGroupHeaderWrapper__"]';
  const VIEW_TABS_SELECTOR = 'nav[aria-label="Select view"]';
  const GUTTER_CLASS = "ghfw-gutter";
  const LANE_SCROLL_CLASS = "ghfw-lane-scroll";
  const BADGE_HIDDEN_CLASS = "ghfw-badge-hidden";
  const TITLE_OWNED = "data-ghfw-title";
  // A title with fewer than about six characters of room is not worth
  // showing next to a count: the badge gives way first.
  const MIN_TITLE_PX = 54;

  // The board's first column lines up with the view tabs (and the filter
  // bar above the board): read that gutter from the page instead of
  // assuming GitHub's 16px, and the scrollbar width of the scroller
  // (0 for an overlay scrollbar), since the scrollbar eats into the right
  // padding. No view tabs, no gutter: GitHub's own padding stays.
  function updateGutter() {
    const container = document.querySelector('[class*="boardContainer__"], [class*="Board-module__boardContainer"]');
    const tabs = document.querySelector(VIEW_TABS_SELECTOR);
    const view = document.querySelector(BOARD_VIEW_SELECTOR);
    const root = document.documentElement.style;
    // A hidden nav (Standup mode hides it) reports a zero rect at left 0:
    // not a gutter, so treat it as missing.
    const tabsRect = tabs?.getBoundingClientRect();
    if (!container || !view || !tabsRect || !tabsRect.width || !tabsRect.height) {
      document.body.classList.remove(GUTTER_CLASS);
      return;
    }
    const gutter = tabsRect.left - container.getBoundingClientRect().left;
    if (!(gutter >= 0 && gutter <= 64)) {
      document.body.classList.remove(GUTTER_CLASS);
      return;
    }
    root.setProperty("--ghfw-gutter", `${Math.round(gutter)}px`);
    root.setProperty("--ghfw-scrollbar", `${view.offsetWidth - view.clientWidth}px`);
    document.body.classList.add(GUTTER_CLASS);
  }

  // Titles of the column-header row (the frames that hold a heading but
  // no card). Count badge hides when the title is cut and gets less than
  // MIN_TITLE_PX; the tooltip then carries the full title and the count.
  function updateColumnTitles() {
    for (const h2 of document.querySelectorAll("[data-board-column] h2")) {
      if (h2.closest(".board-view-column-card")) continue;
      const badge = h2.parentElement?.querySelector('[class*="AggregateLabels__"]');
      badge?.classList.remove(BADGE_HIDDEN_CLASS);
      const cut = h2.scrollWidth > h2.clientWidth + 1;
      let hidden = false;
      if (badge && cut && h2.clientWidth < MIN_TITLE_PX) {
        badge.classList.add(BADGE_HIDDEN_CLASS);
        hidden = true;
      }
      const stillCut = hidden ? h2.scrollWidth > h2.clientWidth + 1 : cut;
      const owned = h2.hasAttribute(TITLE_OWNED);
      if (stillCut || hidden) {
        if (owned || !h2.title) {
          const name = h2.textContent.trim();
          const count = badge?.textContent.trim();
          h2.title = count ? `${name} · ${count}` : name;
          h2.setAttribute(TITLE_OWNED, "");
        }
      } else if (owned) {
        h2.removeAttribute("title");
        h2.removeAttribute(TITLE_OWNED);
      }
    }
  }

  // Some boards scroll lane by lane instead of in the one board scroller:
  // a lane (or a wrapper between the lane and the board) is its own
  // horizontal scroller. Then the headers follow their own lane.
  function updateLaneScrollMode() {
    const view = document.querySelector(BOARD_VIEW_SELECTOR);
    let perLane = false;
    const widths = [];
    // Measure without our own previous widths and class, or a stale wide
    // header keeps the overflow alive forever.
    document.body.classList.remove(LANE_SCROLL_CLASS);
    for (const h of document.querySelectorAll(LANE_HEADER_SELECTOR)) h.style.removeProperty("--ghfw-lane-width");
    for (const area of document.querySelectorAll(LANE_AREA_SELECTOR)) {
      for (let n = area; n && n !== view; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) {
          perLane = true;
          widths.push([area.querySelector(LANE_HEADER_SELECTOR), n.scrollWidth]);
          break;
        }
      }
    }
    document.body.classList.toggle(LANE_SCROLL_CLASS, perLane);
    for (const [h, w] of widths) h?.style.setProperty("--ghfw-lane-width", `${w}px`);
  }

  function updateLayout() {
    updateGutter();
    updateColumnTitles();
    updateLaneScrollMode();
  }

  // A scrollbar can appear or disappear (a lane collapses, a filter
  // changes) without any window resize: watch the scroller and its content.
  let observedView = null;
  const viewResizeObserver = new ResizeObserver(updateLayout);

  function watchBoardView() {
    const view = document.querySelector(BOARD_VIEW_SELECTOR);
    if (view === observedView) return;
    viewResizeObserver.disconnect();
    observedView = view;
    if (view) {
      viewResizeObserver.observe(view);
      if (view.firstElementChild) viewResizeObserver.observe(view.firstElementChild);
    }
  }

  function clearLayout() {
    viewResizeObserver.disconnect();
    observedView = null;
    document.body.classList.remove(GUTTER_CLASS, LANE_SCROLL_CLASS);
    for (const e of document.querySelectorAll(`.${BADGE_HIDDEN_CLASS}`)) e.classList.remove(BADGE_HIDDEN_CLASS);
    for (const e of document.querySelectorAll(`[${TITLE_OWNED}]`)) {
      e.removeAttribute("title");
      e.removeAttribute(TITLE_OWNED);
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
      watchBoardView();
      updateLayout();
    } else {
      if (observedPanel) {
        panelResizeObserver.unobserve(observedPanel);
        observedPanel = null;
      }
      clearLayout();
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
      watchBoardView();
      updateLayout();
    }
  }, 800);

  window.addEventListener("resize", () => {
    if (document.body.classList.contains(BODY_CLASS)) {
      updateBoardOffset();
      updateLayout();
    }
  });

  sync();
})();
