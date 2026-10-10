// features/standup-mode/content.js — a temporary "Standup mode" for
// GitHub Projects **Board** (kanban) views: the whole board stays visible
// and read-only, but GitHub's chrome is reclaimed (a slim bar replaces the
// header and view tabs, columns fit the window) and the cards carry the
// signals a standup cares about — priority, time in status, and badges for
// work that is stale in review, blocked for no visible reason, or on a
// critical path at risk — with a one-line summary that jumps to them.
//
// The signals come from the background half (background/standup-mode.js).
// Without a token or Projects access the board still gets the space
// reclaim and the DOM-visible signals (a priority chip and a "Blocked"
// label); the API-backed badges are simply absent.
//
// Everything here is read-only and local to this tab: it only adds a bar,
// badges, CSS classes and `data-ghsm-*` marks (to hide GitHub's own title
// row, filter bar and editing controls and to compact the column headers),
// never touching issues, Project fields, or card order. The "currently presenting" state is deliberately kept in memory
// (not chrome.storage), so entering/exiting never leaks to other tabs or
// survives a reload. Only the feature's on/off switch and its two
// thresholds (stale days, review-like status keywords) live in storage,
// set from Settings.

(function () {
  const ENTER_ID = "ghsm-enter";
  const BAR_ID = "ghsm-bar";
  const ACTIVE_CLASS = "ghsm-active";
  const BADGES_CLASS = "ghsm-badges";
  const FOCUS_CLASS = "ghsm-focus";
  const FLAG_CLASSES = ["ghsm-flag-stale", "ghsm-flag-orphan", "ghsm-flag-critical", "ghsm-flag-blocked"];
  const STORAGE_KEY = "ghsmEnabled"; // feature on/off, like the other features; unset = on
  const STALE_DAYS_KEY = "ghsmStaleDays";
  const KEYWORDS_KEY = "ghsmReviewKeywords";
  const MESSAGE_TYPE = "GHSM_FETCH_SIGNALS";
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

  const FLAGS = [
    { id: "stale", chip: "Stale", summary: (n) => `${n} stale in review` },
    { id: "orphan", chip: "Orphan block", summary: (n) => `${n} orphan block${n === 1 ? "" : "s"}` },
    { id: "critical", chip: "Critical path at risk", summary: (n) => `${n} critical path at risk` },
  ];

  function isProjectsPage() {
    return /^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname);
  }

  function projectFromLocation() {
    const m = /^\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(location.pathname);
    if (!m) return null;
    const view = /\/views\/(\d+)/.exec(location.pathname);
    return { owner: m[1], number: Number(m[2]), view: view ? Number(view[1]) : null };
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
    return { owner: m[1], repo: m[2], number: Number(m[4]) };
  }

  function keyOf(owner, repo, number) {
    return `${owner}/${repo}#${number}`;
  }

  // Anchor on the column's heading text over any hashed class — a heading
  // element inside the column, else the column's own aria-label.
  function columnName(column) {
    const heading = column.querySelector('h1,h2,h3,h4,[role="heading"]');
    return (heading?.textContent || column.getAttribute("aria-label") || "").trim() || null;
  }

  // With Group by, the board repeats the same columns in each horizontal
  // section, so a column's position is the order of its visible heading
  // across the whole board, not its flat DOM index, and the column total
  // is the number of distinct headings.
  function columnLayout(container) {
    const order = new Map();
    const indexes = Array.from(container.querySelectorAll(COLUMN_SELECTOR)).map((column, flat) => {
      const name = columnName(column) ?? `\0${flat}`;
      if (!order.has(name)) order.set(name, order.size);
      return order.get(name);
    });
    return { indexes, count: order.size };
  }

  function boardContainer() {
    return document.querySelector(BOARD_CONTAINER_SELECTOR) || document.querySelector("main") || document.body;
  }

  function countColumns() {
    return columnLayout(boardContainer()).count;
  }

  // Cards in the board's visible order, each with the issue it links to
  // and the heading text of its column. A card with no issue link is a
  // draft item: it is kept (flagged `draft`, with a local key) so the DOM
  // signals and the column counts cover it, but there is nothing to look
  // up for it on GitHub.
  function collectCards() {
    const container = boardContainer();
    const { indexes } = columnLayout(container);
    const found = [];
    Array.from(container.querySelectorAll(COLUMN_SELECTOR)).forEach((column, flat) => {
      const columnIndex = indexes[flat];
      const name = columnName(column);
      let draftCount = 0;
      for (const el of column.querySelectorAll(CARD_SELECTOR)) {
        let info = null;
        for (const a of el.querySelectorAll("a[href]")) {
          info = parseIssueHref(a.getAttribute("href"));
          if (info) break;
        }
        if (!info) {
          found.push({ el, column, columnIndex, columnName: name, draft: true, key: `draft:${flat}:${draftCount++}` });
          continue;
        }
        found.push({ el, column, columnIndex, columnName: name, ...info, key: keyOf(info.owner, info.repo, info.number) });
      }
    });
    return found;
  }

  // The board scrolls its columns horizontally and each column its cards
  // vertically, and jumping to a flagged card moves those inner scrollers
  // as well as the window. Snapshot the board container and its columns on
  // entry so exit can put them back where the presenter left them.
  function captureBoardScrolls() {
    const snapshot = [];
    const container = document.querySelector(BOARD_CONTAINER_SELECTOR);
    if (!container) return snapshot;
    snapshot.push({ el: container, left: container.scrollLeft, top: container.scrollTop });
    for (const col of container.querySelectorAll(COLUMN_SELECTOR)) {
      snapshot.push({ el: col, left: col.scrollLeft, top: col.scrollTop });
    }
    return snapshot;
  }

  // DOM-only signals, read straight off the card's visible text so they
  // work with no token: a short priority label (P0-P3, Critical, High,
  // Medium, Low) and a "Blocked" label. Leaf elements only, whole-text
  // match, so a title that merely contains the word never counts.
  const DOM_PRIORITY_RE = /^(p[0-3]|urgent|critical|high|medium|low)$/i;
  function readDomSignals(cardEl) {
    let priority = null;
    let blocked = false;
    for (const node of cardEl.querySelectorAll("*")) {
      if (node.children.length || node.closest(`.${BADGES_CLASS}`)) continue;
      const text = (node.textContent || "").trim();
      if (!text || text.length > 12) continue;
      if (!priority && DOM_PRIORITY_RE.test(text)) priority = text;
      if (/^blocked$/i.test(text)) blocked = true;
    }
    return { priority, blocked };
  }

  function priorityRank(name) {
    const n = (name || "").trim().toLowerCase();
    if (/^(p0|critical|urgent|blocker)\b/.test(n)) return 3;
    if (/^(p1|high)\b/.test(n)) return 2;
    if (/^(p2|medium|med|normal)\b/.test(n)) return 1;
    if (/^(p3|low|minor)\b/.test(n)) return 0;
    return null;
  }

  // ---- presentation state (in-memory only, never persisted) ----
  let active = false;
  let cards = []; // current scanned cards
  let cardSignature = ""; // what the last signals request was made for
  let signals = null; // latest { cards, columns, summary } from the background
  let signalsState = "idle"; // idle | loading | ready | empty | no-token | no-access | no-items | error
  let signalsDetail = ""; // why the state is "error", shown as the note's tooltip
  let signalsWarning = ""; // what went wrong on the cards a partial read could not get
  let requestSeq = 0;
  let savedScroll = null; // { x, y } window scroll to restore on exit
  let savedScrolls = []; // [{ el, left, top }] nested board scrollers to restore on exit
  let savedFocus = null; // element focused before entering, to restore on exit
  let focusTimer = null;
  const jumpIndex = {}; // summary id -> next entry to jump to

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---- entry button (board-only, mounted in the view-tabs bar) ----

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
    btn.title = "Standup mode — a compact board that highlights what needs attention (Esc to exit)";
    btn.setAttribute("aria-label", "Enter standup mode");
    btn.addEventListener("click", enter);
    container.appendChild(btn);
    return btn;
  }

  function removeEnterButton() {
    document.getElementById(ENTER_ID)?.remove();
  }

  // ---- presentation bar: project name, signal summary, exit ----

  function projectName() {
    const fromHeading = (document.querySelector("main h1")?.textContent || "").trim();
    if (fromHeading) return fromHeading;
    return (document.title || "").split(" · ")[0].trim() || "Project";
  }

  function viewName() {
    return (document.querySelector(SELECTED_TAB_SELECTOR)?.textContent || "").trim();
  }

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    bar = el("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Standup mode");

    const title = el("div", "ghsm-title");
    title.append(el("strong", "ghsm-project", projectName()));
    const view = viewName();
    if (view) title.append(el("span", "ghsm-view", view));

    const filter = el("div", "ghsm-filter");
    filter.hidden = true;

    const summary = el("div", "ghsm-summary");
    summary.id = "ghsm-summary";
    summary.setAttribute("aria-live", "polite");

    const exitBtn = el("button", "ghsm-exit", "Exit");
    exitBtn.type = "button";
    exitBtn.id = "ghsm-exit";
    exitBtn.title = "Exit standup mode (Esc)";
    exitBtn.setAttribute("aria-label", "Exit standup mode");
    exitBtn.addEventListener("click", exit);

    bar.append(title, filter, summary, exitBtn);
    document.body.appendChild(bar);
    return bar;
  }

  function summaryEntries() {
    const s = signals?.summary;
    if (!s) return [];
    const entries = FLAGS.map((f) => {
      const count = (s[f.id] || []).length;
      return { id: f.id, count, label: f.summary(count) };
    });
    const b = (s.bottleneck || []).length;
    entries.push({ id: "bottleneck", count: b, label: `${b} bottleneck${b === 1 ? "" : "s"}` });
    return entries.filter((e) => e.count > 0);
  }

  const NOTES = {
    loading: "Reading board signals…",
    empty: "No cards on this board yet.",
    "no-token": "Add a GitHub token in Settings to see stale, blocked and at-risk signals.",
    "no-access": "Board signals are unavailable (the token may lack Projects access).",
    "no-items": "Nothing to check: this board has no issues or pull requests.",
    error: "Board signals could not be loaded.",
  };

  function renderSummary() {
    const box = document.getElementById("ghsm-summary");
    if (!box) return;
    box.replaceChildren();
    if (NOTES[signalsState]) {
      const note = el("span", "ghsm-note", NOTES[signalsState]);
      if (signalsState === "error" && signalsDetail) note.title = signalsDetail;
      box.append(note);
      return;
    }
    const entries = summaryEntries();
    const partial = !!(signals?.incomplete || signals?.edgesIncomplete);
    if (signals?.incomplete) {
      const note = el("span", "ghsm-note", "Some cards could not be read, so bottleneck and critical-path signals are off.");
      if (signalsWarning) note.title = signalsWarning;
      box.append(note);
    } else if (signals?.edgesIncomplete) {
      box.append(el("span", "ghsm-note", "Some dependencies could not be read, so the critical-path signal is off."));
    }
    if (!entries.length) {
      if (!partial) box.append(el("span", "ghsm-note ghsm-ok", "Nothing needs attention."));
      return;
    }
    for (const e of entries) {
      const b = el("button", `ghsm-sum ghsm-sum-${e.id}`, e.label);
      b.type = "button";
      b.title = "Jump to it; click again for the next one";
      b.addEventListener("click", () => jumpTo(e.id));
      box.append(b);
    }
  }

  // Scrolls to the next flagged card (or bottleneck column) of a kind and
  // pulses it, cycling through them on repeated clicks.
  function jumpTo(id) {
    const list = signals?.summary?.[id];
    if (!list?.length) return;
    const i = (jumpIndex[id] || 0) % list.length;
    jumpIndex[id] = i + 1;
    let target = null;
    if (id === "bottleneck") {
      for (const col of document.querySelectorAll(COLUMN_SELECTOR)) if (columnName(col) === list[i]) target = col;
    } else {
      target = cards.find((c) => c.key === list[i])?.el || null;
    }
    if (!target) return;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    for (const old of document.querySelectorAll(`.${FOCUS_CLASS}`)) old.classList.remove(FOCUS_CLASS);
    target.classList.add(FOCUS_CLASS);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => target.classList.remove(FOCUS_CLASS), 2200);
  }

  // ---- card badges and tints ----

  function clearMarks() {
    for (const node of document.querySelectorAll(`.${BADGES_CLASS}`)) node.remove();
    for (const node of document.querySelectorAll("[data-ghsm-sig]")) {
      node.removeAttribute("data-ghsm-sig");
      node.removeAttribute("data-ghsm-priority");
      node.classList.remove(...FLAG_CLASSES);
    }
    for (const node of document.querySelectorAll("[data-ghsm-bottleneck]")) {
      node.removeAttribute("data-ghsm-bottleneck");
      node.removeAttribute("data-ghsm-reason");
    }
    for (const node of document.querySelectorAll(`.${FOCUS_CLASS}`)) node.classList.remove(FOCUS_CLASS);
  }

  function chip(className, text, title) {
    const c = el("span", `ghsm-chip ${className}`, text);
    if (title) c.title = title;
    return c;
  }

  // Applies the latest signals to the scanned cards. Idempotent: a card
  // whose desired state is already on it is left alone, so the board's own
  // re-renders (and our own mutations) can't loop.
  function applySignals() {
    if (!active) return;
    for (const c of cards) {
      const sig = signals?.cards?.[c.key] || null;
      const dom = readDomSignals(c.el);
      const flags = sig?.flags || [];
      const priority = sig?.priority || (dom.priority ? { name: dom.priority, rank: priorityRank(dom.priority) } : null);
      const blockedDom = dom.blocked && !flags.includes("orphan");
      const ageDays = sig?.ageDays > 0 ? sig.ageDays : null;
      const desired = JSON.stringify([flags, sig?.reasons || null, ageDays, priority, blockedDom]);
      const hasBadges = !!c.el.querySelector(`:scope > .${BADGES_CLASS}`);
      const wantsBadges = !!(priority || flags.length || blockedDom || ageDays);
      if (c.el.dataset.ghsmSig === desired && hasBadges === wantsBadges) continue;

      c.el.querySelector(`:scope > .${BADGES_CLASS}`)?.remove();
      c.el.classList.remove(...FLAG_CLASSES);
      for (const f of flags) c.el.classList.add(`ghsm-flag-${f}`);
      if (blockedDom) c.el.classList.add("ghsm-flag-blocked");
      if (priority?.rank != null && priority.rank >= 2) c.el.dataset.ghsmPriority = String(priority.rank);
      else c.el.removeAttribute("data-ghsm-priority");

      const row = el("div", BADGES_CLASS);
      if (priority) {
        const rank = priority.rank != null && priority.rank >= 2 ? ` ghsm-chip-prio-${priority.rank}` : "";
        row.append(chip(`ghsm-chip-priority${rank}`, priority.name, "Priority"));
      }
      for (const f of FLAGS) {
        if (flags.includes(f.id)) row.append(chip(`ghsm-chip-${f.id}`, f.chip, sig.reasons?.[f.id]));
      }
      if (blockedDom) row.append(chip("ghsm-chip-blocked", "Blocked", "Labelled blocked"));
      if (ageDays) row.append(chip("ghsm-chip-age", `${ageDays}d`, `${ageDays} days in this status`));
      if (row.childElementCount) c.el.append(row);
      c.el.dataset.ghsmSig = desired;
    }

    const bottlenecks = new Map((signals?.columns || []).map((b) => [b.column, b.reason]));
    for (const col of document.querySelectorAll(COLUMN_SELECTOR)) {
      const reason = bottlenecks.get(columnName(col));
      if (reason) {
        if (col.dataset.ghsmReason !== reason) col.dataset.ghsmReason = reason;
        if (!col.hasAttribute("data-ghsm-bottleneck")) col.setAttribute("data-ghsm-bottleneck", "");
      } else if (col.hasAttribute("data-ghsm-bottleneck")) {
        col.removeAttribute("data-ghsm-bottleneck");
        col.removeAttribute("data-ghsm-reason");
      }
    }
  }

  // ---- reclaimed layout: hide what a standup does not read, compact headers ----
  //
  // GitHub's own markup is matched by structure and visible text, never by a
  // hashed class: the project title is the page's first heading outside the
  // board, the filter bar is found by its input's label, and a column header
  // is whatever precedes the column's first card. Everything is a
  // `data-ghsm-*` mark that CSS acts on and exit removes; nothing is moved or
  // removed from GitHub's DOM. If an anchor is not found, that part of the
  // page simply stays as it is.
  const LAYOUT_ATTRS = ["data-ghsm-hide", "data-ghsm-flat", "data-ghsm-row", "data-ghsm-pill", "data-ghsm-keep", "data-ghsm-float"];
  const VIEW_NAV_SELECTOR = 'nav[aria-label="Select view"]';
  const HEADING_SELECTOR = 'h1,h2,h3,h4,[role="heading"]';
  const BUTTON_SELECTOR = 'button,[role="button"]';
  const FILTER_HINT_RE = /filter|search/i;
  const ADD_CONTROL_RE = /^(\+\s*)?(add item|new item|add status|add column|new column)/i;
  const COUNT_RE = /^\d+(\s*\/\s*\d+)?$/;
  const SUM_RE = /^[^:]{1,40}:\s*[-+]?\d[\d.,]*\s*[a-z%]{0,3}$/i;
  const GROUP_HEADER_SELECTOR = '[class*="Board-module__horizontalGroupHeader"]';

  function clearLayout() {
    for (const attr of LAYOUT_ATTRS) {
      for (const node of document.querySelectorAll(`[${attr}]`)) node.removeAttribute(attr);
    }
  }

  function mark(node, attr) {
    node.setAttribute(attr, "");
  }

  const textOf = (node) => (node.textContent || "").trim();
  const hasOwnText = (node) => Array.from(node.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim());

  // The board's own anchor, or the parent of its first column when the
  // class prefix has changed.
  function boardRoot() {
    return document.querySelector(BOARD_CONTAINER_SELECTOR) || document.querySelector(COLUMN_SELECTOR)?.parentElement || null;
  }

  // The outermost ancestor of `node` (itself included) that holds neither
  // the board nor the view tabs: the whole row of page chrome `node` is in.
  function chromeRow(node, board) {
    const nav = document.querySelector(VIEW_NAV_SELECTOR);
    const holdsAnchor = (n) => n.contains(board) || !!nav?.contains(n) || !!(nav && n.contains(nav));
    if (holdsAnchor(node)) return null;
    let row = node;
    while (row.parentElement && row.parentElement !== document.body && row.parentElement.tagName !== "MAIN" && !holdsAnchor(row.parentElement)) {
      row = row.parentElement;
    }
    return row;
  }

  function findFilterInput(outside) {
    const candidates = document.querySelectorAll('input, textarea, [role="combobox"], [role="searchbox"]');
    return (
      Array.from(candidates).find((n) => {
        if (!outside(n)) return false;
        const hint = `${n.getAttribute("aria-label") || ""} ${n.getAttribute("placeholder") || ""} ${n.getAttribute("title") || ""}`;
        return FILTER_HINT_RE.test(hint);
      }) || null
    );
  }

  // The project's own title row. It is the page's first level-1 heading
  // outside the board and the view tabs; failing that, the first element
  // before the board whose whole text is the project name from the tab title.
  function findTitle(board, outside) {
    const main = document.querySelector("main") || document.body;
    const heading = Array.from(main.querySelectorAll('h1,[role="heading"][aria-level="1"]')).find(outside);
    if (heading) return heading;
    const name = (document.title || "").split(" · ")[0].trim();
    if (!name) return null;
    return (
      Array.from(main.querySelectorAll("*")).find(
        (n) => !n.children.length && textOf(n) === name && outside(n) && !!(n.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING)
      ) || null
    );
  }

  // Hides the page chrome a standup does not read and returns the active
  // filter's text, so the bar can show which subset of the board this is.
  function hidePageChrome(board) {
    const outside = (n) => !board.contains(n) && !n.closest(`#${BAR_ID}, ${VIEW_NAV_SELECTOR}`);
    const hideRowOf = (node) => {
      const row = node && chromeRow(node, board);
      if (row) mark(row, "data-ghsm-hide");
    };
    hideRowOf(findTitle(board, outside));
    const filterInput = findFilterInput(outside);
    hideRowOf(filterInput);
    for (const b of document.querySelectorAll(BUTTON_SELECTOR)) {
      if (outside(b) && /^view$/i.test(textOf(b))) mark(b, "data-ghsm-hide");
    }
    for (const b of board.querySelectorAll(BUTTON_SELECTOR)) {
      if (b.closest(CARD_SELECTOR)) continue;
      if (ADD_CONTROL_RE.test((b.getAttribute("aria-label") || textOf(b)).trim())) mark(b, "data-ghsm-hide");
    }
    if (!filterInput) return "";
    return (("value" in filterInput ? filterInput.value : filterInput.textContent) || "").trim();
  }

  // Reduces a column header to one row: the status dot and the name on the
  // left and a single metric pill on the right (the field sum when the
  // column has one, else the card count), with the "..." menu and the
  // description hidden. The header is whatever precedes the column's first
  // card, found by position so it does not depend on GitHub's wrappers.
  function compactColumnHeader(column) {
    const heading = column.querySelector(HEADING_SELECTOR);
    if (!heading || heading.closest(CARD_SELECTOR)) return;
    const firstCard = column.querySelector(CARD_SELECTOR);
    const zone = Array.from(column.querySelectorAll("*")).filter(
      (n) => !n.closest(CARD_SELECTOR) && (!firstCard || (!n.contains(firstCard) && n.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING))
    );
    const inHeading = (n) => n === heading || heading.contains(n);
    const inButton = (n) => !!n.closest(BUTTON_SELECTOR);

    const buttons = zone.filter((n) => n.matches(BUTTON_SELECTOR) && !n.contains(heading) && !inHeading(n));
    for (const b of buttons) mark(b, "data-ghsm-hide");

    // Count and field-sum pills: the outermost element whose whole text
    // reads like one.
    const isPill = (n) => !inHeading(n) && !n.contains(heading) && !inButton(n) && !n.querySelector(BUTTON_SELECTOR) && (COUNT_RE.test(textOf(n)) || SUM_RE.test(textOf(n)));
    const pillCandidates = zone.filter(isPill);
    const pills = pillCandidates.filter((n) => !pillCandidates.some((o) => o !== n && o.contains(n)));
    const sum = pills.find((n) => SUM_RE.test(textOf(n)));
    const chosen = sum || pills.find((n) => COUNT_RE.test(textOf(n))) || null;
    for (const pill of pills) if (pill !== chosen) mark(pill, "data-ghsm-hide");

    const inPill = (n) => pills.some((p) => p === n || p.contains(n));
    // The status dot: an icon or empty marker ahead of the name.
    const dots = zone.filter(
      (n) =>
        n.matches("svg, img, span:empty, i:empty") &&
        !n.parentElement?.closest("svg") &&
        !inHeading(n) &&
        !inButton(n) &&
        !inPill(n) &&
        !!(n.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
    // Whatever other text there is (the description) goes.
    for (const n of zone) {
      if (inHeading(n) || n.contains(heading) || inButton(n) || inPill(n) || !hasOwnText(n)) continue;
      mark(n, "data-ghsm-hide");
    }

    const kept = [...dots, heading, ...(chosen ? [chosen] : [])];
    for (const n of kept) mark(n, "data-ghsm-keep");
    if (chosen) mark(chosen, "data-ghsm-pill");

    let row = heading.parentElement;
    while (row && row !== column && !kept.every((n) => row.contains(n))) row = row.parentElement;
    if (!row) return;
    if (row === column || (firstCard && row.contains(firstCard))) {
      if (chosen) mark(chosen, "data-ghsm-float");
      return;
    }
    mark(row, "data-ghsm-row");
    for (const n of kept) {
      for (let wrapper = n.parentElement; wrapper && wrapper !== row; wrapper = wrapper.parentElement) mark(wrapper, "data-ghsm-flat");
    }
  }

  // A swimlane header keeps its name, avatar and totals; the collapse
  // chevron and the menu, icon-only buttons, go.
  function compactGroupHeader(header) {
    for (const b of header.querySelectorAll(BUTTON_SELECTOR)) {
      if (!textOf(b) && !b.querySelector("img")) mark(b, "data-ghsm-hide");
    }
  }

  function updateFilterText(text) {
    const node = document.querySelector(`#${BAR_ID} .ghsm-filter`);
    if (!node) return;
    node.hidden = !text;
    node.textContent = text ? `Filter: ${text}` : "";
    node.title = text ? `Filter: ${text}` : "";
  }

  function applyLayout() {
    if (!active) return;
    const board = boardRoot();
    clearLayout();
    if (!board) {
      updateFilterText("");
      return;
    }
    updateFilterText(hidePageChrome(board));
    for (const column of board.querySelectorAll(COLUMN_SELECTOR)) compactColumnHeader(column);
    for (const header of board.querySelectorAll(GROUP_HEADER_SELECTOR)) compactGroupHeader(header);
  }

  // ---- fetching signals ----

  function scanCards() {
    cards = collectCards();
    return `${countColumns()}:${cards.map((c) => `${c.key}|${c.columnName}`).sort().join(",")}`;
  }

  function describeDetail(detail) {
    if (!detail) return "";
    return `${detail.message || "Unknown error"}${detail.status ? ` (HTTP ${detail.status})` : ""}`;
  }

  function failWith(state, detail) {
    signals = null;
    signalsWarning = "";
    signalsState = state;
    signalsDetail = describeDetail(detail);
    if (state === "error") console.warn(`[gh-reloaded] Standup signals could not be loaded: ${signalsDetail || "unknown error"}`);
  }

  // A thrown background call carries the HTTP status; only a refusal
  // (401/403) says anything about the token.
  function failureFromResponse(resp) {
    if (chrome.runtime.lastError || !resp) {
      failWith("error", { message: chrome.runtime.lastError?.message || "No response from the extension" });
    } else if (resp.hasToken === false) {
      failWith("no-token");
    } else if (!resp.ok) {
      failWith(resp.status === 401 || resp.status === 403 ? "no-access" : "error", { message: resp.error, status: resp.status });
    } else if (resp.reason === "no-token" || resp.reason === "no-access" || resp.reason === "no-items") {
      failWith(resp.reason);
    } else {
      failWith("error", resp.detail || { message: "No signals were returned" });
    }
  }

  async function requestSignals() {
    if (!active) return;
    const project = projectFromLocation();
    const seq = ++requestSeq;
    if (!project) {
      failWith("error", { message: "This is not a Projects page" });
      renderSummary();
      applySignals();
      return;
    }
    if (!cards.length) {
      // No cards yet: either the board is still rendering (no columns
      // either) or it really is empty. Neither is an error, and a card
      // arriving changes the signature, which asks again.
      signals = null;
      signalsWarning = "";
      signalsDetail = "";
      signalsState = countColumns() ? "empty" : "loading";
      renderSummary();
      applySignals();
      return;
    }
    if (!signals) signalsState = "loading";
    renderSummary();
    const stored = await chrome.storage.local.get([STALE_DAYS_KEY, KEYWORDS_KEY]);
    if (!active || seq !== requestSeq) return;
    const payload = {
      project,
      columnCount: countColumns(),
      items: cards
        .filter((c) => !c.draft)
        .map((c) => ({ owner: c.owner, repo: c.repo, number: c.number, column: c.columnName, columnIndex: c.columnIndex })),
      drafts: cards.filter((c) => c.draft).map((c) => ({ column: c.columnName, columnIndex: c.columnIndex })),
      options: { staleDays: stored[STALE_DAYS_KEY], reviewKeywords: stored[KEYWORDS_KEY] },
    };
    chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload }, (resp) => {
      if (!active || seq !== requestSeq) return; // exited, or a newer request superseded this one
      if (chrome.runtime.lastError || !resp?.ok || !resp.hasToken || !resp.signals) {
        failureFromResponse(resp);
      } else {
        signals = resp.signals;
        signalsState = "ready";
        signalsDetail = "";
        signalsWarning = describeDetail(resp.warning);
      }
      renderSummary();
      applySignals();
    });
  }

  function refreshBoard() {
    if (!active) return;
    const signature = scanCards();
    if (signature !== cardSignature) {
      cardSignature = signature;
      requestSignals();
    }
    applySignals();
    applyLayout();
  }

  const debouncedRefreshBoard = debounce(refreshBoard, 250);

  // A card edited in place (label, priority, target date, a new comment)
  // keeps its key and column, so the signature above never changes. Re-read
  // the signals on a timer, just past the API cache lifetime, while the tab
  // is visible.
  const SIGNALS_REFRESH_MS = 75_000;
  let refreshTimer = null;
  function scheduleSignalsRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (active && !document.hidden) requestSignals();
    }, SIGNALS_REFRESH_MS);
  }

  // ---- keyboard: Esc leaves ----
  function onKeydown(e) {
    if (!active || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      exit();
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

  function isOwnNode(node) {
    if (node.nodeType !== 1) return false;
    return node.classList.contains(BADGES_CLASS) || !!node.closest(`#${BAR_ID}`);
  }

  // Ignores the mutations we cause ourselves (badges, the bar), or
  // applySignals() would re-trigger itself forever.
  const observer = new MutationObserver((mutations) => {
    if (!active) return;
    const foreign = mutations.some((m) => {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return !(nodes.length && nodes.every(isOwnNode)) && !isOwnNode(m.target);
    });
    if (foreign) debouncedRefreshBoard();
  });

  const onResize = debounce(() => {
    if (active) updateBoardOffset();
  }, 100);

  // ---- enter / exit ----
  function enter() {
    if (active) return;
    if (!isProjectsPage() || !isBoardLayout()) return;
    active = true;
    savedScroll = { x: window.scrollX, y: window.scrollY };
    savedScrolls = captureBoardScrolls();
    savedFocus = document.activeElement;
    ensureBar();
    document.body.classList.add(ACTIVE_CLASS);
    updateBoardOffset();
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", onResize, { passive: true });
    observer.observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
    signals = null;
    signalsState = "loading";
    cardSignature = scanCards();
    renderSummary();
    applySignals();
    applyLayout();
    requestSignals();
    scheduleSignalsRefresh();
    document.getElementById("ghsm-exit")?.focus();
  }

  function exit() {
    if (!active) return;
    active = false;
    requestSeq++; // drop any in-flight response
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onResize);
    observer.disconnect();
    clearTimeout(focusTimer);
    clearInterval(refreshTimer);
    clearMarks();
    clearLayout();
    document.body.classList.remove(ACTIVE_CLASS);
    document.documentElement.style.removeProperty(LEFT_VAR);
    document.getElementById(BAR_ID)?.remove();
    cards = [];
    cardSignature = "";
    signals = null;
    signalsState = "idle";
    signalsDetail = "";
    signalsWarning = "";
    for (const k of Object.keys(jumpIndex)) delete jumpIndex[k];
    // Restore the pre-entry scroll and focus as reasonably as possible:
    // the nested board scrollers first, then the window, then focus. Skip
    // any scroller that's been detached by a re-render since entry.
    for (const s of savedScrolls) {
      if (!document.contains(s.el)) continue;
      s.el.scrollLeft = s.left;
      s.el.scrollTop = s.top;
    }
    if (savedScroll) window.scrollTo(savedScroll.x, savedScroll.y);
    if (savedFocus && document.contains(savedFocus) && typeof savedFocus.focus === "function") {
      savedFocus.focus();
    }
    savedScroll = null;
    savedScrolls = [];
    savedFocus = null;
  }

  // ---- sync: offer or withdraw the entry button, and bail out of an
  // active session if we've left a Board view ----
  async function sync() {
    const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
    const onBoard = isProjectsPage() && isBoardLayout();
    const featureOn = enabled !== false;
    // Tear down an active session if we've left a Board view *or* the
    // feature was switched off in Settings while presenting — otherwise the
    // bar, body class, observers, and keyboard handler would keep running
    // even though the entry button is gone.
    if (active && (!onBoard || !featureOn)) exit();
    if (featureOn && onBoard) ensureEnterMounted();
    else removeEnterButton();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) sync();
    // A threshold changed in Settings while presenting: re-read the signals.
    if (active && (changes[STALE_DAYS_KEY] || changes[KEYWORDS_KEY])) requestSignals();
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
