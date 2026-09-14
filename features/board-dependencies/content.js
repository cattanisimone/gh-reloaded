// features/board-dependencies/content.js — on a GitHub Projects board
// view, optionally draws an arrow between any two currently-rendered
// cards where one blocks the other. Off by default: a toggle (fixed,
// top-right of the viewport) turns it on, and the choice is remembered
// across reloads via chrome.storage.local.
//
// Layout-agnostic on purpose: rather than special-casing the Board
// (kanban) layout, it just finds every issue/PR link currently in the
// DOM, wherever the current view happens to render it (columns, table
// rows, grouped rows). If a view lays cards out in a way where "an
// arrow between two points" doesn't read as meaningful, the toggle is
// still there, but the result may not be useful — that's a call left to
// whoever's looking at it, not something worth detecting up front.

(function () {
  const ROOT_ID = "ghbd-root";
  const TOGGLE_ID = "ghbd-toggle";
  const STORAGE_KEY = "ghbdEnabled";

  function isProjectsPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
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

  // Walks up from the matching <a> to whatever ancestor looks like "the
  // whole card" (a row/gridcell/listitem), so the arrow anchors on the
  // card's edge rather than just the link's own text. Falls back to the
  // link itself if nothing card-shaped is found within a few levels —
  // still draws an arrow, just anchored more tightly.
  function cardElementFor(anchor) {
    let el = anchor;
    for (let i = 0; i < 6 && el; i++) {
      const role = el.getAttribute?.("role");
      if (role === "row" || role === "gridcell" || role === "listitem" || el.tagName === "LI") {
        return el;
      }
      el = el.parentElement;
    }
    return anchor;
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
        </defs>
      </svg>`;
    document.body.appendChild(root);
    return root;
  }

  function renderToggle(enabled) {
    let toggle = document.getElementById(TOGGLE_ID);
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.id = TOGGLE_ID;
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        const next = !toggle.classList.contains("is-on");
        await chrome.storage.local.set({ [STORAGE_KEY]: next });
      });
      document.body.appendChild(toggle);
    }
    toggle.classList.toggle("is-on", enabled);
    toggle.textContent = enabled ? "Dependencies: on" : "Dependencies: off";
    toggle.title = enabled
      ? "Hide arrows between dependent cards"
      : "Show arrows between dependent cards";
  }

  // State for the currently-running render loop, so tearing down (toggle
  // switched off, or navigated off a Projects page) can cleanly stop
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
        paths.push(
          `<path class="ghbd-edge" marker-end="url(#ghbd-arrow)" d="${edgePathD(pa.x, pa.y, pb.x, pb.y)}"></path>`
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
    if (!isProjectsPage()) {
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
