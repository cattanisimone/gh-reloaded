// features/board-dependencies/content.js — on a GitHub Projects **Board**
// (kanban) view, optionally draws an arrow between any two currently-
// rendered cards where one blocks the other. Off by default: a switch,
// inserted into the view tabs bar's own trailing controls, turns it on —
// only shown while the currently-selected view is actually a Board, since
// an arrow between two points only reads as meaningful there. The choice
// is remembered across reloads via chrome.storage.local.
//
// Card discovery is layout-agnostic (any issue/PR link currently in the
// DOM), but the switch itself is Board-only per the above.

(function () {
  const ROOT_ID = "ghbd-root";
  const TOGGLE_ID = "ghbd-toggle";
  const STORAGE_KEY = "ghbdEnabled";
  // GitHub Projects v2's view-tabs bar — a stable, always-present part of
  // every project page's chrome, unlike the board's own card markup. CSS
  // module class names carry a build-specific hash suffix that will churn
  // across deploys, so matched by prefix rather than in full. Mounting
  // inside the trailing "view options" box specifically (not the outer
  // tabs bar as a whole) is what puts the switch in the same flex row,
  // right-aligned and vertically in line with that box's own kebab
  // button, instead of dropping to its own line below everything.
  const VIEW_OPTIONS_CONTAINER_SELECTOR = '[class*="view-navigation-module__viewOptionsMenuContainer"]';
  const SELECTED_TAB_SELECTOR = 'nav[aria-label="Select view"] [role="tab"][aria-selected="true"], nav[aria-label="Select view"] [role="tab"].selected';

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
  // on the whole card rather than on a sliver of text. Board cards don't
  // carry a stable class or ARIA role to key off, but they DO have a
  // roughly fixed width regardless of how many wrapper <div>s sit between
  // the title and the card's outer edge — so climb until the next parent
  // is clearly wider (that's the column, which holds many cards side by
  // side vertically and is much wider than one card).
  function cardElementFor(anchor) {
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

  function edgePathD(x1, y1, x2, y2) {
    const dx = Math.max(30, Math.abs(x2 - x1) / 3);
    const sign = x2 >= x1 ? 1 : -1;
    return `M ${x1} ${y1} C ${x1 + dx * sign} ${y1}, ${x2 - dx * sign} ${y2}, ${x2} ${y2}`;
  }

  // Picks the pair of edge midpoints (left/right/top/bottom) closest to
  // each other between two card rects, so the line reads as "shortest
  // path between these two boxes" instead of always leaving from the
  // same side regardless of where the other card actually is.
  function closestAnchors(a, b) {
    const pointsOf = (r) => [
      { x: r.left, y: r.top + r.height / 2 }, // left
      { x: r.right, y: r.top + r.height / 2 }, // right
      { x: r.left + r.width / 2, y: r.top }, // top
      { x: r.left + r.width / 2, y: r.bottom }, // bottom
    ];
    let best = null;
    for (const pa of pointsOf(a)) {
      for (const pb of pointsOf(b)) {
        const d = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
        if (!best || d < best.d) best = { d, pa, pb };
      }
    }
    return [best.pa, best.pb];
  }

  // Board columns read left → right as workflow progress. `from` (the
  // blocker) SHOULD sit at or ahead of `to` (the card it blocks) — that's
  // the arrow pointing back toward an earlier column, which is the
  // correct order and stays neutral. A blocker still behind the card it's
  // blocking is the interesting case: that card is moving before its own
  // blocker is done, so the arrow renders as a warning. Same column
  // (within half a card's width) isn't a directional claim either way.
  function edgeDirectionClass(fromRect, toRect) {
    const dx = toRect.left - fromRect.left;
    const tolerance = Math.min(fromRect.width, toRect.width) / 2;
    if (Math.abs(dx) <= tolerance) return "";
    return dx > 0 ? "is-reversed" : "";
  }

  function ensureOverlay() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <svg class="ghbd-edges">
        <defs>
          <marker id="ghbd-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="ghbd-arrowhead"></path>
          </marker>
          <marker id="ghbd-arrow-reversed" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="ghbd-arrowhead-reversed"></path>
          </marker>
        </defs>
      </svg>`;
    document.body.appendChild(root);
    return root;
  }

  function switchHtml() {
    return `
      <span class="ghbd-switch-track"><span class="ghbd-switch-knob"></span></span>`;
  }

  // Mounted into the view tabs bar's own controls, next to the "view
  // options" button — not floating, so it only ever shows up where a
  // Board view is actually being looked at. GitHub's SPA re-renders that
  // bar on its own (switching views, filtering, etc.), which silently
  // drops our injected node — re-checking on every sync() call, not just
  // once, is what keeps it from disappearing after that happens.
  function ensureToggleMounted() {
    if (document.getElementById(TOGGLE_ID)) return document.getElementById(TOGGLE_ID);
    const container = document.querySelector(VIEW_OPTIONS_CONTAINER_SELECTOR);
    if (!container) return null;

    const toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", "false");
    toggle.innerHTML = switchHtml();
    toggle.addEventListener("click", async () => {
      const next = toggle.getAttribute("aria-checked") !== "true";
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
    });
    container.appendChild(toggle);
    return toggle;
  }

  function renderToggle(enabled) {
    const toggle = ensureToggleMounted();
    if (!toggle) return;
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.title = enabled
      ? "Dependency arrows: on — hide arrows between dependent cards"
      : "Dependency arrows: off — show arrows between dependent cards";
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
    let cardsByKey = new Map();
    let raf = null;

    function draw() {
      const paths = [];
      for (const e of edges) {
        const from = cardsByKey.get(e.from);
        const to = cardsByKey.get(e.to);
        if (!from || !to) continue; // one end isn't currently rendered — skip
        const fromRect = from.el.getBoundingClientRect();
        const toRect = to.el.getBoundingClientRect();
        // Off-screen (e.g. scrolled out, or virtualized away) on either
        // end reads as noise more than signal — skip rather than draw an
        // arrow to/from a collapsed or hidden box.
        if (fromRect.width === 0 || toRect.width === 0) continue;
        const [pa, pb] = closestAnchors(fromRect, toRect);
        const dirClass = edgeDirectionClass(fromRect, toRect);
        const marker = dirClass === "is-reversed" ? "ghbd-arrow-reversed" : "ghbd-arrow";
        paths.push(
          `<path class="ghbd-edge ${dirClass}" marker-end="url(#${marker})" d="${edgePathD(pa.x, pa.y, pb.x, pb.y)}"></path>`
        );
      }
      const defs = svg.querySelector("defs").outerHTML;
      svg.innerHTML = defs + paths.join("");
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

    refetch();

    cleanup = () => {
      window.removeEventListener("scroll", debouncedRedraw, { capture: true });
      window.removeEventListener("resize", debouncedRedraw);
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
    } else if (isProjectsPage() && !document.getElementById(TOGGLE_ID)) {
      // Same URL, but the view-nav bar re-rendered and dropped our node.
      sync();
    }
  }, 800);

  sync();
})();
