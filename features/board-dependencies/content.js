// features/board-dependencies/content.js — on a GitHub Projects **Board**
// (kanban) view, optionally draws an arrow between any two currently-
// rendered cards where one blocks the other. Off by default: a switch,
// mounted in the filter row, left of GitHub's View button, turns it on —
// only shown while the currently-selected view is actually a Board, since
// an arrow between two points only reads as meaningful there. The choice
// is remembered across reloads via chrome.storage.local.
//
// Card discovery is layout-agnostic (any issue/PR link currently in the
// DOM), but the switch itself is Board-only per the above.

(function () {
  const GEO = globalThis.GHBD_GEOMETRY;
  const ROOT_ID = "ghbd-root";
  const TOGGLE_ID = "ghbd-toggle";
  const STORAGE_KEY = "ghbdEnabled";
  // The filter row above the board: a flex region labelled "View filters"
  // holding the filter box and GitHub's own "View" button. Found by role
  // and visible text, never by a CSS-module class (those churn: see
  // AGENTS.md). The buttons are mounted as children of this row, just left
  // of the View button's wrapper; the row's own gap spaces them. If either
  // anchor is missing nothing is mounted and the next scan retries.
  const FILTER_ROW_SELECTOR = '[role="region"][aria-label="View filters"]';
  const STANDUP_ID = "ghsm-enter";
  const SELECTED_TAB_SELECTOR = 'nav[aria-label="Select view"] [role="tab"][aria-selected="true"], nav[aria-label="Select view"] [role="tab"].selected';

  // { row, view } — the filter row and its child that holds the "View"
  // button — or null. Same small helper as standup-mode's, duplicated so
  // each feature still ships on its own.
  function findFilterRow() {
    const row = document.querySelector(FILTER_ROW_SELECTOR);
    if (!row) return null;
    const view = Array.from(row.children).find((c) =>
      Array.from(c.querySelectorAll("button")).some((b) => (b.textContent || "").trim() === "View")
    );
    return view ? { row, view } : null;
  }

  function isProjectsPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
  }

  // The selected view tab's own icon tells us its layout: Table
  // (`octicon-table`), Roadmap (`octicon-project-roadmap`), or Board
  // (`octicon-project` — three columns of different heights, GitHub's
  // actual kanban-board glyph). Anything else (no selected tab found,
  // e.g. a single-view project with no tab bar at all) degrades to "not
  // a board" rather than guessing.
  function isBoardLayout() {
    const tab = document.querySelector(SELECTED_TAB_SELECTOR);
    const icon = tab?.querySelector('svg[class*="octicon-project"]');
    return !!icon && icon.classList.contains("octicon-project");
  }

  // A card can render more than one link matching this (e.g. the title
  // link plus a repo-name link) — first match per issue wins, see
  // collectCards().
  const ISSUE_HREF_RE = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:[/?#]|$)/;

  function parseIssueHref(href) {
    let path;
    try {
      path = new URL(href, location.origin).pathname;
    } catch {
      return null;
    }
    const m = ISSUE_HREF_RE.exec(path);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: Number(m[4]) };
  }

  function keyOf(owner, repo, number) {
    return `${owner}/${repo}#${number}`;
  }

  // Walks up from the matching <a> (which is usually just the issue
  // title, a small element) to the actual card box, so the arrow anchors
  // on the whole card rather than on a sliver of text.
  function cardElementFor(anchor) {
    // Board layout's real card box carries this exact, un-hashed class
    // — the most precise anchor available. Matters because the grid
    // cell wrapping it (what the width-climb fallback below would
    // otherwise land on) can be taller than the card itself, e.g. when
    // it shares a grouped row with a taller card in another column —
    // anchoring there put arrows in the empty space below a short card
    // instead of on the card.
    const boardCard = anchor.closest(".board-view-column-card");
    if (boardCard) return boardCard;

    // Table/grid layouts use these roles on the actual row — prefer that
    // exact anchor when present rather than the width heuristic below.
    let el = anchor;
    for (let i = 0; i < 6 && el; i++) {
      const role = el.getAttribute?.("role");
      if (role === "row" || role === "gridcell" || role === "listitem" || el.tagName === "LI") {
        return el;
      }
      el = el.parentElement;
    }

    el = anchor;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      const parent = el.parentElement;
      const curWidth = el.getBoundingClientRect().width;
      const parentWidth = parent.getBoundingClientRect().width;
      if (parentWidth > 260 && parentWidth > curWidth * 1.4) break; // stepped out into the column
      el = parent;
    }
    return el;
  }

  // One entry per unique issue/PR currently in the DOM: { key, owner,
  // repo, number, el }. Skips anything not inside the main page content
  // (nav, header) so a link in GitHub's own chrome never gets treated as
  // a card.
  function collectCards() {
    const main = document.querySelector("main") || document.body;
    const seen = new Map();
    for (const a of main.querySelectorAll("a[href]")) {
      const info = parseIssueHref(a.getAttribute("href"));
      if (!info) continue;
      const key = keyOf(info.owner, info.repo, info.number);
      if (seen.has(key)) continue;
      seen.set(key, { key, ...info, el: cardElementFor(a) });
    }
    return Array.from(seen.values());
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const COLUMN_SELECTOR = "[data-board-column], .board-view-column";

  function ensureOverlay() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = '<svg class="ghbd-edges"></svg>';
    document.body.appendChild(root);
    return root;
  }

  // The column frame holding a card. Its own scroller (the nearest
  // scrolling ancestor, found by computed style, not by class) is the
  // viewport the card is visible in.
  function viewportOf(el, column) {
    for (let n = el.parentElement; n && n !== column; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === "auto" || oy === "scroll") return n.getBoundingClientRect();
    }
    return column.getBoundingClientRect();
  }

  function plainRect(r) {
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }

  function cardState(el) {
    const icon = el.querySelector("svg[aria-label]");
    return GEO.stateFromLabel(icon?.getAttribute("aria-label"));
  }

  // Two crossing arrows (a "shuffle"-style glyph) rather than anything
  // link/share-shaped — reads as "these two are connected, in either
  // direction" without implying navigation to somewhere else.
  function iconHtml() {
    return `
      <svg class="ghbd-toggle-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 4 L5.5 4 L14 12"></path>
        <path d="M11 12 L14 12 L14 9"></path>
        <path d="M2 12 L5.5 12 L14 4"></path>
        <path d="M11 4 L14 4 L14 7"></path>
      </svg>`;
  }

  // Mounted in the filter row, between Standup (when present) and View — a
  // native-looking icon button, only ever shown where a Board view is
  // being looked at. GitHub's SPA re-renders the row on its own, which
  // silently drops our node — re-checking on every sync() call, not just
  // once, is what keeps it from disappearing after that happens. The
  // position is re-derived each time, so it holds whichever feature
  // mounted first.
  function ensureToggleMounted() {
    const found = findFilterRow();
    if (!found) {
      document.getElementById(TOGGLE_ID)?.remove();
      return null;
    }
    let toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.id = TOGGLE_ID;
      toggle.type = "button";
      toggle.setAttribute("aria-pressed", "false");
      toggle.setAttribute("aria-label", "Dependency arrows (experimental)");
      toggle.innerHTML = iconHtml();
      toggle.addEventListener("click", async () => {
        const next = toggle.getAttribute("aria-pressed") !== "true";
        await chrome.storage.local.set({ [STORAGE_KEY]: next });
      });
    }
    if (toggle.parentElement !== found.row || toggle.nextElementSibling !== found.view) {
      found.row.insertBefore(toggle, found.view);
    }
    // Standup mounts before us, or after us — either way it ends up on our left.
    const standup = document.getElementById(STANDUP_ID);
    if (standup && standup.parentElement === found.row && standup.nextElementSibling !== toggle) {
      found.row.insertBefore(standup, toggle);
    }
    return toggle;
  }

  function toggleNeedsMount() {
    const toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) return true;
    const found = findFilterRow();
    return !found || toggle.parentElement !== found.row || toggle.nextElementSibling !== found.view;
  }

  function renderToggle(enabled) {
    const toggle = ensureToggleMounted();
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.title = enabled
      ? "Dependency arrows (experimental): on — hide arrows between dependent cards"
      : "Dependency arrows (experimental): off — show arrows between dependent cards";
  }

  // State for the currently-running render loop, so tearing down (toggle
  // switched off, or navigated off a Board view) can cleanly stop
  // everything started here.
  let cleanup = null;

  function teardownGraph() {
    document.getElementById(ROOT_ID)?.remove();
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  }

  function startGraph() {
    if (cleanup) return; // already running
    const overlay = ensureOverlay();
    const svg = overlay.querySelector(".ghbd-edges");
    let edges = []; // [{from, to}] as "owner/repo#number" keys
    let states = {}; // key -> "open" | "closed" from the dependency API
    let cardsByKey = new Map();
    let activeKey = null;
    let raf = null;

    function applyHighlight() {
      for (const g of svg.querySelectorAll(".ghbd-edge-group")) {
        const on = activeKey && (g.dataset.from === activeKey || g.dataset.to === activeKey);
        g.classList.toggle("is-active", !!on);
        g.classList.toggle("is-faded", !!activeKey && !on);
      }
    }

    function draw() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      // Every end must be a rendered card, in a column, inside that column's
      // scroll viewport; its rect is clipped to what is actually visible.
      const info = new Map();
      for (const [key, c] of cardsByKey) {
        const col = c.el.closest(COLUMN_SELECTOR);
        const r = c.el.getBoundingClientRect();
        if (!col || r.width === 0 || r.height === 0) continue;
        const vp = viewportOf(c.el, col);
        const rect = { left: r.left, right: r.right, top: Math.max(r.top, vp.top), bottom: Math.min(r.bottom, vp.bottom) };
        if (rect.bottom - rect.top < 12) continue;
        info.set(key, { key, el: c.el, col, colRect: plainRect(col.getBoundingClientRect()), rect, done: GEO.isDone(cardState(c.el), states[key]) });
      }
      const doneByKey = new Map([...cardsByKey.keys()].map((k) => [k, info.has(k) ? info.get(k).done : false]));
      for (const k of cardsByKey.keys()) if (!info.has(k)) doneByKey.set(k, GEO.isDone(cardState(cardsByKey.get(k).el), states[k]));
      const shown = GEO.visibleEdges(edges, doneByKey)
        .filter((e) => info.has(e.from) && info.has(e.to))
        .map((e) => ({ e, src: info.get(e.from), dst: info.get(e.to) }));

      // Ports: the arrows on one side of a card spread along it, ordered by
      // where the other end is so they do not cross.
      const ends = new Map();
      shown.forEach((s, i) => {
        s.sides = GEO.sides(s.src.colRect, s.dst.colRect);
        for (const [role, side, self, other] of [["src", s.sides.from, s.src, s.dst], ["dst", s.sides.to, s.dst, s.src]]) {
          const k = `${self.key}|${side}`;
          if (!ends.has(k)) ends.set(k, []);
          ends.get(k).push({ s, role, self, otherY: (other.rect.top + other.rect.bottom) / 2 + (other.rect.left > self.rect.left ? 0.1 : 0) });
        }
      });
      for (const list of ends.values()) {
        list.sort((p, q) => p.otherY - q.otherY);
        list.forEach((x, i) => {
          x.s[x.role + "Y"] = GEO.portY(x.self.rect.top, x.self.rect.bottom, i, list.length);
        });
      }

      // Gutter between two column frames, read from the page (8px live).
      const cols = [...new Set([...info.values()].map((c) => c.colRect.left))].sort((a, b) => a - b);
      let gap = 8;
      const colRights = new Map([...info.values()].map((c) => [c.colRect.left, c.colRect.right]));
      for (let i = 1; i < cols.length; i++) {
        const g = cols[i] - colRights.get(cols[i - 1]);
        if (g > 0 && g < 40) { gap = g; break; }
      }

      // Lanes: routes that share a gutter and overlap vertically stack.
      const groups = new Map();
      shown.forEach((s) => {
        const toRight = s.dst.colRect.left > s.src.colRect.left;
        const k = s.sides.kind === "same" ? `same|${s.dst.colRect.left}` : `gap|${Math.round(toRight ? s.dst.colRect.left : s.dst.colRect.right + gap)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      });
      for (const list of groups.values()) {
        const lanes = GEO.lanesFor(list.map((s) => [s.srcY, s.dstY]));
        list.forEach((s, i) => {
          s.lane = lanes[i];
          s.lanes = Math.max(...lanes) + 1;
        });
      }

      // Clip to the board: the union of the columns' parents (one row per
      // group on a grouped board), inside the window.
      let clip = null;
      for (const parent of new Set([...info.values()].map((c) => c.col.parentElement).filter(Boolean))) {
        const b = parent.getBoundingClientRect();
        clip = clip
          ? { left: Math.min(clip.left, b.left), top: Math.min(clip.top, b.top), right: Math.max(clip.right, b.right), bottom: Math.max(clip.bottom, b.bottom) }
          : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
      clip = clip
        ? { left: Math.max(0, clip.left), top: Math.max(0, clip.top), right: Math.min(W, clip.right), bottom: Math.min(H, clip.bottom) }
        : { left: 0, top: 0, right: W, bottom: H };

      // Cards are cut out of the lines: every card box in a column, also the
      // ones that are not linked issues (draft items, notes).
      const cut = [...info.values()].map((c) => c.rect);
      const known = new Set([...info.values()].map((c) => c.el));
      for (const el of document.querySelectorAll(".board-view-column-card, [data-board-card-id]")) {
        if (known.has(el) || el.parentElement?.closest(".board-view-column-card, [data-board-card-id]")) continue;
        const col = el.closest(COLUMN_SELECTOR);
        const r = el.getBoundingClientRect();
        if (!col || r.width === 0 || r.height === 0) continue;
        const vp = viewportOf(el, col);
        const rect = { left: r.left, right: r.right, top: Math.max(r.top, vp.top), bottom: Math.min(r.bottom, vp.bottom) };
        if (rect.bottom > rect.top) cut.push(rect);
      }
      const rects = cut.map((r) => `<rect x="${r.left}" y="${r.top}" width="${r.right - r.left}" height="${r.bottom - r.top}" fill="black"></rect>`);
      const body = shown.map((s) => {
        const { d, sides } = GEO.routeEdge({
          src: { rect: s.src.rect, col: s.src.colRect, y: s.srcY },
          dst: { rect: s.dst.rect, col: s.dst.colRect, y: s.dstY },
          gap,
          lane: s.lane,
          lanes: s.lanes,
        });
        const reversed = sides.kind === "cross" && sides.from === "right";
        const cls = reversed ? " is-reversed" : "";
        const marker = reversed ? "ghbd-arrow-reversed" : "ghbd-arrow";
        return `<g class="ghbd-edge-group" data-from="${s.e.from}" data-to="${s.e.to}"><path class="ghbd-halo" d="${d}"></path><path class="ghbd-edge${cls}" marker-end="url(#${marker})" d="${d}"></path></g>`;
      });
      svg.innerHTML = `<defs>
        <marker id="ghbd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" class="ghbd-arrowhead"></path>
        </marker>
        <marker id="ghbd-arrow-reversed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" class="ghbd-arrowhead-reversed"></path>
        </marker>
        <clipPath id="ghbd-clip"><rect x="${clip.left}" y="${clip.top}" width="${Math.max(0, clip.right - clip.left)}" height="${Math.max(0, clip.bottom - clip.top)}"></rect></clipPath>
        <mask id="ghbd-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="white"></rect>${rects.join("")}</mask>
      </defs><g clip-path="url(#ghbd-clip)"><g mask="url(#ghbd-mask)">${body.join("")}</g></g>`;
      applyHighlight();
    }

    function scheduleDraw() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        draw();
      });
    }

    async function refetch() {
      const cards = collectCards();
      cardsByKey = new Map(cards.map((c) => [c.key, c]));
      if (!cards.length) {
        edges = [];
        scheduleDraw();
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: "GHBD_FETCH_BOARD_DEPS",
          payload: { items: cards.map((c) => ({ owner: c.owner, repo: c.repo, number: c.number })) },
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) return; // silent — the graph just stays empty
          edges = resp.edges || [];
          states = resp.states || {};
          scheduleDraw();
        }
      );
    }

    const debouncedRefetch = debounce(refetch, 400);
    const debouncedRedraw = debounce(scheduleDraw, 50);

    // Card positions change on scroll (board-wide and per-column) and on
    // drag-and-drop; the set of visible cards changes on scroll (if the
    // view virtualizes off-screen ones) and on any DOM mutation inside
    // the board. Recompute positions cheaply and often; only re-fetch
    // dependency data (a network round trip) when the visible set of
    // cards actually changes.
    window.addEventListener("scroll", debouncedRedraw, { passive: true, capture: true });
    window.addEventListener("resize", debouncedRedraw, { passive: true });

    const observer = new MutationObserver(() => {
      debouncedRedraw();
      debouncedRefetch();
    });
    observer.observe(document.querySelector("main") || document.body, {
      childList: true,
      subtree: true,
    });

    // Hover or keyboard focus on a card highlights its own arrows.
    function keyFor(target) {
      if (!(target instanceof Node)) return null;
      for (const [key, c] of cardsByKey) if (c.el.contains(target)) return key;
      return null;
    }
    function setActive(key) {
      if (key === activeKey) return;
      activeKey = key;
      applyHighlight();
    }
    const onOver = (e) => {
      const key = keyFor(e.target);
      if (key) setActive(key);
    };
    const onOut = (e) => {
      const key = keyFor(e.target);
      if (key && key === activeKey && keyFor(e.relatedTarget) !== key) setActive(null);
    };
    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("focusin", onOver, true);
    document.addEventListener("focusout", onOut, true);

    refetch();

    cleanup = () => {
      window.removeEventListener("scroll", debouncedRedraw, { capture: true });
      window.removeEventListener("resize", debouncedRedraw);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("focusin", onOver, true);
      document.removeEventListener("focusout", onOut, true);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }

  async function sync() {
    if (!isProjectsPage() || !isBoardLayout()) {
      document.getElementById(TOGGLE_ID)?.remove();
      teardownGraph();
      return;
    }
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    renderToggle(!!enabled);
    if (enabled) startGraph();
    else teardownGraph();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) sync();
  });

  // Re-run on GitHub's SPA navigation — same belt-and-suspenders pattern
  // as the other features: Turbo events plus a URL-polling fallback.
  // Also re-checked on a light interval regardless of URL, since
  // switching view tabs or the tab bar re-rendering can both happen
  // without the switch (or the whole toggle node) surviving.
  const debouncedSync = debounce(sync, 150);
  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedSync();
    } else if (isProjectsPage() && toggleNeedsMount()) {
      // Same URL, but the filter row re-rendered and dropped our node, or
      // React inserted its own Discard / divider after it (a view that
      // became dirty): put it back directly before View.
      sync();
    }
  }, 800);

  sync();
})();
