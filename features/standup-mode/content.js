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
// badges and CSS classes, never touching issues, Project fields, or card
// order. The "currently presenting" state is deliberately kept in memory
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
    return m ? { owner: m[1], number: Number(m[2]) } : null;
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

  function countColumns() {
    const container = document.querySelector(BOARD_CONTAINER_SELECTOR) || document.querySelector("main") || document.body;
    return container.querySelectorAll(COLUMN_SELECTOR).length;
  }

  // Cards in the board's visible order, each with the issue it links to
  // and the heading text of its column. A card with no issue link is a
  // draft item: it is kept (flagged `draft`, with a local key) so the DOM
  // signals and the column counts cover it, but there is nothing to look
  // up for it on GitHub.
  function collectCards() {
    const container = document.querySelector(BOARD_CONTAINER_SELECTOR) || document.querySelector("main") || document.body;
    const found = [];
    Array.from(container.querySelectorAll(COLUMN_SELECTOR)).forEach((column, columnIndex) => {
      const name = columnName(column);
      let draftCount = 0;
      for (const el of column.querySelectorAll(CARD_SELECTOR)) {
        let info = null;
        for (const a of el.querySelectorAll("a[href]")) {
          info = parseIssueHref(a.getAttribute("href"));
          if (info) break;
        }
        if (!info) {
          found.push({ el, column, columnIndex, columnName: name, draft: true, key: `draft:${columnIndex}:${draftCount++}` });
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
  let signalsState = "idle"; // idle | loading | ready | no-token | unavailable
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

    const summary = el("div", "ghsm-summary");
    summary.id = "ghsm-summary";
    summary.setAttribute("aria-live", "polite");

    const exitBtn = el("button", "ghsm-exit", "Exit");
    exitBtn.type = "button";
    exitBtn.id = "ghsm-exit";
    exitBtn.title = "Exit standup mode (Esc)";
    exitBtn.setAttribute("aria-label", "Exit standup mode");
    exitBtn.addEventListener("click", exit);

    bar.append(title, summary, exitBtn);
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
    "no-token": "Add a GitHub token in Settings to see stale, blocked and at-risk signals.",
    unavailable: "Board signals are unavailable (the token may lack Projects access).",
  };

  function renderSummary() {
    const box = document.getElementById("ghsm-summary");
    if (!box) return;
    box.replaceChildren();
    if (NOTES[signalsState]) {
      box.append(el("span", "ghsm-note", NOTES[signalsState]));
      return;
    }
    const entries = summaryEntries();
    if (!entries.length) {
      box.append(el("span", "ghsm-note ghsm-ok", "Nothing needs attention."));
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

  // ---- fetching signals ----

  function scanCards() {
    cards = collectCards();
    return cards.map((c) => `${c.key}|${c.columnName}`).sort().join(",");
  }

  async function requestSignals() {
    if (!active) return;
    const project = projectFromLocation();
    const seq = ++requestSeq;
    if (!project || !cards.length) {
      signals = null;
      signalsState = "unavailable";
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
      if (chrome.runtime.lastError || !resp?.ok) {
        signals = null;
        signalsState = resp && resp.hasToken === false ? "no-token" : "unavailable";
      } else if (!resp.hasToken) {
        signals = null;
        signalsState = "no-token";
      } else if (!resp.signals) {
        signals = null;
        signalsState = "unavailable";
      } else {
        signals = resp.signals;
        signalsState = "ready";
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
  }

  const debouncedRefreshBoard = debounce(refreshBoard, 250);

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
    requestSignals();
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
    clearMarks();
    document.body.classList.remove(ACTIVE_CLASS);
    document.documentElement.style.removeProperty(LEFT_VAR);
    document.getElementById(BAR_ID)?.remove();
    cards = [];
    cardSignature = "";
    signals = null;
    signalsState = "idle";
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
