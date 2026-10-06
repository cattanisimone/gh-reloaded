// features/standup-mode/content.js — a temporary "Standup mode" for
// GitHub Projects **Board** (kanban) views: a presentation layer for
// walking a board on a shared screen during standup. It reclaims the
// viewport, enlarges the board for legibility, and spotlights one card
// at a time in the board's own left-to-right, top-to-bottom order, with
// keyboard and on-screen prev/next controls plus a panel showing the
// current card's title, column, assignee, and a link to its issue.
//
// Everything here is read-only and local to this tab: it only adds an
// overlay and some body/element classes, never touching issues, Project
// fields, or card order. The "currently presenting" state is deliberately
// kept in memory (not chrome.storage), so entering/exiting never leaks to
// other tabs or survives a reload — it is a per-session presentation, not
// a saved preference. Only the feature's on/off switch (shown in Settings
// alongside the others) lives in storage; when it's off, no entry button
// is offered at all.

(function () {
  const ENTER_ID = "ghsm-enter";
  const ROOT_ID = "ghsm-root";
  const ACTIVE_CLASS = "ghsm-active";
  const CURRENT_CLASS = "ghsm-current";
  const STORAGE_KEY = "ghsmEnabled"; // feature on/off, like the other features; unset = on
  const LEFT_VAR = "--ghsm-board-left";

  const SELECTED_TAB_SELECTOR =
    'nav[aria-label="Select view"] [role="tab"][aria-selected="true"], nav[aria-label="Select view"] [role="tab"].selected';
  // Same board-only mounting anchor the other board features use — a
  // stable part of every project page's chrome, matched by class prefix
  // since the build-hash suffix churns across deploys.
  const VIEW_NAV_CONTAINER_SELECTOR = '[class*="view-navigation-module__ViewNavigationContainer"]';
  const BOARD_CONTAINER_SELECTOR = '[class*="Board-module__boardContainer"]';
  // Board layout's real card box carries this exact, un-hashed class —
  // the same anchor board-dependencies keys on. Columns are its own
  // ancestors; a column's heading text is the card's status/column.
  const CARD_SELECTOR = ".board-view-column-card";
  const COLUMN_SELECTOR = ".board-view-column";

  function isProjectsPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
  }

  // The selected view tab's own icon says whether this is a Board
  // (kanban), Table, or Roadmap layout — standup mode only makes sense on
  // a Board. Degrades to "not a board" when no selected tab is found.
  function isBoardLayout() {
    const tab = document.querySelector(SELECTED_TAB_SELECTOR);
    const icon = tab?.querySelector('svg[class*="octicon-project"]');
    return !!icon && icon.classList.contains("octicon-project");
  }

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
    return { owner: m[1], repo: m[2], number: Number(m[4]), path };
  }

  // Reads what a card can offer for the spotlight panel, each piece
  // degrading to null when absent rather than failing the whole card:
  //  - the issue/PR link (title text + an absolute href),
  //  - the column heading text (its status),
  //  - an assignee, taken from an avatar's alt/aria-label if present.
  function readCard(cardEl) {
    let link = null;
    for (const a of cardEl.querySelectorAll("a[href]")) {
      const info = parseIssueHref(a.getAttribute("href"));
      if (info) {
        link = { info, text: (a.textContent || "").trim(), href: new URL(a.getAttribute("href"), location.origin).href };
        break;
      }
    }
    const column = cardEl.closest(COLUMN_SELECTOR);
    // Anchor on the column's heading text over any hashed class — a
    // heading element inside the column, else the column's own
    // aria-label, is the status/column name we show.
    let columnName = null;
    if (column) {
      const heading = column.querySelector('h1,h2,h3,h4,[role="heading"]');
      columnName = (heading?.textContent || column.getAttribute("aria-label") || "").trim() || null;
    }
    let assignee = null;
    for (const img of cardEl.querySelectorAll("img[alt]")) {
      const alt = (img.getAttribute("alt") || "").trim().replace(/^@/, "");
      if (alt) {
        assignee = alt;
        break;
      }
    }
    if (!assignee) {
      const labelled = cardEl.querySelector('[aria-label*="assigned" i], [aria-label*="assignee" i]');
      if (labelled) assignee = (labelled.getAttribute("aria-label") || "").trim() || null;
    }
    const title = (link?.text && link.text) || (cardEl.textContent || "").trim().split("\n")[0].slice(0, 120) || "Untitled";
    return {
      key: link ? `${link.info.owner}/${link.info.repo}#${link.info.number}` : null,
      title,
      columnName,
      assignee,
      href: link?.href || null,
    };
  }

  // Cards in the board's visible order: columns left → right (their DOM
  // order matches their on-screen order), cards top → bottom within each.
  // document order over the columns then their cards gives exactly that,
  // so a flat querySelectorAll of the card class is already in board
  // order. Skips cards with a zero-size rect (collapsed/virtualized away)
  // so the walk only ever lands on something actually visible.
  function collectCards() {
    const container = document.querySelector(BOARD_CONTAINER_SELECTOR) || document.querySelector("main") || document.body;
    return Array.from(container.querySelectorAll(CARD_SELECTOR)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  // ---- presentation state (in-memory only, never persisted) ----
  let active = false;
  let cards = []; // current ordered list of card elements
  let index = 0; // spotlight position within cards
  let currentKey = null; // issue key of the spotlit card, to re-find it across re-renders
  let savedScroll = null; // { x, y } to restore on exit
  let savedFocus = null; // element focused before entering, to restore on exit
  let raf = null;

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---- entry button (board-only, mounted in the view-tabs bar) ----

  // A labelled text+icon button rather than a bare switch: entering a
  // mode is a more deliberate action than flipping a visual default, and
  // the label makes it self-explanatory on a shared screen. Mounted into
  // the same view-nav bar the other board controls use and positioned to
  // the left of board-dependencies' own switch (right:16px there) so the
  // two never overlap when both are shown.
  function enterButtonHtml() {
    return `
      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
        <path d="M2 2.75C2 1.784 2.784 1 3.75 1h8.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 12.25 12H8.75v1.5h2.25a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5h2.25V12H3.75A1.75 1.75 0 0 1 2 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
      </svg>
      <span>Standup</span>`;
  }

  function ensureEnterMounted() {
    const existing = document.getElementById(ENTER_ID);
    if (existing) return existing;
    const container = document.querySelector(VIEW_NAV_CONTAINER_SELECTOR);
    if (!container) return null;
    const btn = document.createElement("button");
    btn.id = ENTER_ID;
    btn.type = "button";
    btn.innerHTML = enterButtonHtml();
    btn.title = "Standup mode — present this board one card at a time (Esc to exit)";
    btn.setAttribute("aria-label", "Enter standup mode");
    btn.addEventListener("click", enter);
    container.appendChild(btn);
    return btn;
  }

  function removeEnterButton() {
    document.getElementById(ENTER_ID)?.remove();
  }

  // ---- overlay (panel + spotlight), built once on enter ----

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div id="ghsm-spotlight" aria-hidden="true"></div>
      <section id="ghsm-panel" role="dialog" aria-label="Standup mode" tabindex="-1">
        <div class="ghsm-meta">
          <div class="ghsm-counter" id="ghsm-counter"></div>
          <a class="ghsm-title" id="ghsm-title" target="_blank" rel="noopener"></a>
          <div class="ghsm-sub">
            <span class="ghsm-chip" id="ghsm-column" hidden></span>
            <span class="ghsm-chip ghsm-assignee" id="ghsm-assignee" hidden></span>
          </div>
        </div>
        <div class="ghsm-controls">
          <button type="button" id="ghsm-prev" class="ghsm-btn" aria-label="Previous card" title="Previous (←)">‹ Prev</button>
          <button type="button" id="ghsm-next" class="ghsm-btn" aria-label="Next card" title="Next (→)">Next ›</button>
          <button type="button" id="ghsm-exit" class="ghsm-btn ghsm-exit" aria-label="Exit standup mode" title="Exit (Esc)">Exit</button>
        </div>
      </section>`;
    document.body.appendChild(root);
    root.querySelector("#ghsm-prev").addEventListener("click", () => step(-1));
    root.querySelector("#ghsm-next").addEventListener("click", () => step(1));
    root.querySelector("#ghsm-exit").addEventListener("click", exit);
    return root;
  }

  // Positions the spotlight cut-out over the current card's rect. The
  // cut-out is a transparent box with a huge spreading box-shadow (the
  // dimming) plus a bright ring — so everything but the current card is
  // darkened. Recomputed on scroll/resize via rAF; hidden when there is
  // no current card to point at.
  function positionSpotlight() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const spot = root.querySelector("#ghsm-spotlight");
    const el = cards[index];
    if (!el) {
      spot.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      spot.style.display = "none";
      return;
    }
    const pad = 6;
    spot.style.display = "block";
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
  }

  function scheduleReposition() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      positionSpotlight();
    });
  }

  function renderPanel() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const el = cards[index];
    const counter = root.querySelector("#ghsm-counter");
    const titleEl = root.querySelector("#ghsm-title");
    const columnEl = root.querySelector("#ghsm-column");
    const assigneeEl = root.querySelector("#ghsm-assignee");
    const prevBtn = root.querySelector("#ghsm-prev");
    const nextBtn = root.querySelector("#ghsm-next");

    if (!el) {
      counter.textContent = "No cards on this board";
      titleEl.textContent = "";
      titleEl.removeAttribute("href");
      columnEl.hidden = true;
      assigneeEl.hidden = true;
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }
    const data = readCard(el);
    counter.textContent = `Card ${index + 1} of ${cards.length}`;
    titleEl.textContent = data.title;
    if (data.href) titleEl.href = data.href;
    else titleEl.removeAttribute("href");
    columnEl.hidden = !data.columnName;
    if (data.columnName) columnEl.textContent = data.columnName;
    assigneeEl.hidden = !data.assignee;
    if (data.assignee) assigneeEl.textContent = `@${data.assignee}`;
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= cards.length - 1;
  }

  // Marks the current card (and clears any previous mark) so a CSS rule
  // can lift it, then renders the panel and positions the spotlight, and
  // scrolls the card into view. Always clears every existing mark first,
  // so a re-render or navigation can never leave a stale highlight behind.
  function highlightCurrent(scroll = true) {
    for (const el of document.querySelectorAll(`.${CURRENT_CLASS}`)) el.classList.remove(CURRENT_CLASS);
    const el = cards[index];
    currentKey = el ? readCard(el).key : null;
    if (el) {
      el.classList.add(CURRENT_CLASS);
      if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    renderPanel();
    scheduleReposition();
  }

  function step(delta) {
    if (!cards.length) return;
    index = Math.min(cards.length - 1, Math.max(0, index + delta));
    highlightCurrent();
  }

  // Re-reads the board's cards (after a scroll, filter, or dynamic load)
  // and keeps the spotlight on the same issue when it's still present,
  // clamping to a valid position when it isn't — so stale highlights and
  // out-of-range indexes can't survive a board change.
  function refreshCards() {
    if (!active) return;
    cards = collectCards();
    if (!cards.length) {
      index = 0;
      highlightCurrent(false);
      return;
    }
    let nextIndex = currentKey ? cards.findIndex((el) => readCard(el).key === currentKey) : -1;
    if (nextIndex < 0) nextIndex = Math.max(0, Math.min(index, cards.length - 1));
    index = nextIndex;
    highlightCurrent(false);
  }

  const debouncedRefresh = debounce(refreshCards, 150);

  // ---- keyboard ----
  // Captured at the document so it works regardless of what's focused,
  // and the keys we act on have their default (page scroll, etc.)
  // suppressed. Only bound while active.
  function onKeydown(e) {
    if (!active) return;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        exit();
        break;
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
      case " ":
      case "Spacebar":
        e.preventDefault();
        step(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home":
        e.preventDefault();
        index = 0;
        highlightCurrent();
        break;
      case "End":
        e.preventDefault();
        index = Math.max(0, cards.length - 1);
        highlightCurrent();
        break;
      default:
        break;
    }
  }

  // Keeps the standup board using the full viewport width even when the
  // Full-width board feature is off — measuring the board container's own
  // live left offset (same technique full-width-board uses) and sizing to
  // the viewport's right edge from there. When full-width IS active, its
  // own rules win and this is a no-op (the CSS only applies to
  // `.ghsm-active:not(.ghfw-active)`), so the two coexist without fighting.
  function updateBoardOffset() {
    const container = document.querySelector(BOARD_CONTAINER_SELECTOR);
    if (!container) return;
    const left = container.getBoundingClientRect().left;
    document.documentElement.style.setProperty(LEFT_VAR, `${Math.max(left, 0)}px`);
  }

  const observer = new MutationObserver(() => {
    if (!active) return;
    debouncedRefresh();
  });

  function onScrollResize() {
    if (!active) return;
    updateBoardOffset();
    scheduleReposition();
  }

  // ---- enter / exit ----
  function enter() {
    if (active) return;
    if (!isProjectsPage() || !isBoardLayout()) return;
    active = true;
    savedScroll = { x: window.scrollX, y: window.scrollY };
    savedFocus = document.activeElement;
    document.body.classList.add(ACTIVE_CLASS);
    ensureRoot();
    updateBoardOffset();
    cards = collectCards();
    index = 0;
    highlightCurrent();
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("scroll", onScrollResize, { passive: true, capture: true });
    window.addEventListener("resize", onScrollResize, { passive: true });
    observer.observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
    // Move focus into the panel so keyboard nav and screen readers pick
    // it up immediately; the caret-free dialog is focusable via tabindex.
    document.getElementById(ROOT_ID)?.querySelector("#ghsm-panel")?.focus();
  }

  function exit() {
    if (!active) return;
    active = false;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("scroll", onScrollResize, { capture: true });
    window.removeEventListener("resize", onScrollResize);
    observer.disconnect();
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    for (const el of document.querySelectorAll(`.${CURRENT_CLASS}`)) el.classList.remove(CURRENT_CLASS);
    document.body.classList.remove(ACTIVE_CLASS);
    document.documentElement.style.removeProperty(LEFT_VAR);
    document.getElementById(ROOT_ID)?.remove();
    cards = [];
    currentKey = null;
    // Restore the pre-entry scroll and focus as reasonably as possible.
    if (savedScroll) window.scrollTo(savedScroll.x, savedScroll.y);
    if (savedFocus && document.contains(savedFocus) && typeof savedFocus.focus === "function") {
      savedFocus.focus();
    }
    savedScroll = null;
    savedFocus = null;
  }

  // ---- sync: offer or withdraw the entry button, and bail out of an
  // active session if we've left a Board view ----
  async function sync() {
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    const onBoard = isProjectsPage() && isBoardLayout();
    const featureOn = enabled !== false;
    if (active && !onBoard) exit(); // switched view/navigated away while presenting
    if (featureOn && onBoard) ensureEnterMounted();
    else removeEnterButton();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) sync();
  });

  // Re-run on GitHub's SPA navigation and view-tab switches — same
  // belt-and-suspenders pattern as the other board features: Turbo events
  // plus a URL-polling fallback that also re-mounts the entry button when
  // a view-nav re-render drops it.
  const debouncedSync = debounce(sync, 150);
  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      debouncedSync();
    } else if (!active && isProjectsPage() && isBoardLayout() && !document.getElementById(ENTER_ID)) {
      // Same URL, but the view-nav bar re-rendered and dropped our button.
      sync();
    }
  }, 800);

  sync();
})();
