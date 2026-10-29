// features/notifications/triage.js — the Triage view of the notifications
// inbox: it shows the four categories the engine computes in one of three
// layouts, chosen in the Triage settings panel (prefs.js, ghntLayout):
//   integrated  a "Triage" group at the top of GitHub's own sidebar (one
//               scrollable row above the list where GitHub hides the sidebar)
//   quickbar    four pills under the filter row
//   grouped     four collapsible sections inside GitHub's own row list
// Integrated and Quick bar only hide rows (ghnt-off). Grouped re-orders the
// rows INSIDE GitHub's native list, under inert section headers, and puts
// each row back in its original slot (a comment placeholder) when the layout
// changes or the module stops. Nothing is written to GitHub; the only stored
// value is which sections are collapsed (ghntTriageCollapsed).
//
// Anchors are ARIA and stable classes only, never a CSS-module class. A
// missing anchor means nothing is inserted and the next scan retries; no other
// container is used. Counts cover the rows loaded on the page.
//
// Registers itself with the registry content.js created, so it loads after it.

(function () {
  const M = globalThis.GHNT_TRIAGE_MODEL;
  const COLLAPSED_KEY = "ghntTriageCollapsed";
  const LAYOUT_IDS = ["integrated", "quickbar", "grouped"];
  const HIGHLIGHT_MS = 3000;
  const NARROW = 768; // GitHub hides the sidebar below this width

  const host = globalThis.GHNotifications;
  if (!host || !M) return;
  const registry = host.registry;
  const engine = host.engine;

  let active = false;
  let layout = null; // the layout currently on the page
  let selected = null; // selected category (integrated / quickbar), memory only
  let state = null; // last engine state
  let collapsed = {};
  let offEngine = null;
  let offRegistry = null;
  let observer = null;
  let timer = null;
  let rendering = false;
  const slots = new Map(); // row li -> comment placeholder of its native slot
  const hidden = new Set(); // rows and boxes we set ghnt-off on
  const collapsedRows = new Set(); // rows we set `hidden` on
  const lastSection = new Map(); // row key -> section at the previous render
  let ownIds = 0;
  const live = new Map(); // kind -> the node this module built and still owns

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }

  // ---- the page --------------------------------------------------------------

  function rowEls() {
    return [...document.querySelectorAll("li.notifications-list-item")];
  }

  function itemByKey() {
    return new Map((state?.items || []).map((i) => [i.key, i]));
  }

  // [{ li, key, item }] in the order of the native list (slots count as rows).
  function rows() {
    const by = itemByKey();
    return rowEls().map((li) => {
      const key = globalThis.GHNT_COLLECT.keyOf(li);
      return { li, key, item: key ? by.get(key) : undefined };
    });
  }

  function nativeLists() {
    const lists = [];
    for (const li of rowEls()) {
      // A moved row counts for the list its native slot is in.
      const ul = (slots.get(li)?.parentElement || li).closest("ul");
      if (ul && !lists.includes(ul)) lists.push(ul);
    }
    return lists;
  }

  // The element before which the info block goes: the first box of the list.
  const boxOf = (ul) => ul.closest(".Box") || ul;

  function filterRow() {
    const anchor = globalThis.GHNT_PANEL?.findAnchor(document);
    return anchor ? anchor.parentElement : null;
  }

  function sidebarNav() {
    return document.querySelector('nav[aria-label="Notifications"]');
  }

  const rendered = (node) => !!node && node.getClientRects().length > 0;

  // ---- building blocks -------------------------------------------------------

  function dot(id) {
    return el("span", { class: `ghnt-dot ghnt-dot-${id}`, "aria-hidden": "true" });
  }

  function categoryButton(id, c, cls) {
    const pending = state?.phase === "loading" && c.pending > 0 && c[id] === 0;
    const btn = el(
      "button",
      { type: "button", class: cls, "aria-pressed": String(selected === id), "aria-label": M.ariaLabel(id, c, pending), "data-ghnt-cat": id },
      dot(id),
      el("span", { class: "ghnt-label", text: M.labelOf(id) }),
      el("span", { class: "ghnt-count", text: M.countText(c[id], pending) })
    );
    btn.addEventListener("click", () => {
      selected = selected === id ? null : id;
      render();
    });
    return btn;
  }

  function buildSidebar(c) {
    const items = M.CATEGORIES.map((cat) => el("li", { class: "ghnt-nav-li" }, categoryButton(cat.id, c, "ghnt-nav-item")));
    // GitHub separates its sidebar groups with an hr: the Triage group ends with one too.
    return el("nav", { class: "ghnt-nav", "aria-label": "Triage", "data-ghnt-triage": "nav" }, el("h3", { class: "ghnt-nav-title", text: "Triage" }), el("ul", { class: "ghnt-nav-list" }, items), el("hr", { class: "ghnt-nav-sep" }));
  }

  // How far GitHub's filter controls sit inside the column the bar spans
  // (the filter row's own padding below 768px): the bar takes the same insets,
  // so its edges line up with the controls above it at every width.
  function insetsOf(row) {
    const parent = row.parentElement;
    const rects = [...row.children].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!parent || !rects.length) return [0, 0];
    const box = parent.getBoundingClientRect();
    const cs = getComputedStyle(parent);
    const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    return [Math.min(...rects.map((r) => r.left)) - left, right - Math.max(...rects.map((r) => r.right))].map((v) => Math.max(0, Math.round(v)));
  }

  function buildBar(c, kind, row) {
    const buttons = M.CATEGORIES.map((cat) => categoryButton(cat.id, c, "ghnt-pill"));
    const [left, right] = insetsOf(row);
    const style = left || right ? `margin-left: ${left}px; margin-right: ${right}px;` : null;
    return el("div", { class: `ghnt-bar ${kind === "compact" ? "ghnt-compact" : "ghnt-quickbar"}`, role: "group", "aria-label": "Triage", "data-ghnt-triage": kind, style }, buttons);
  }

  // Replaces the content of a block in place, keeping focus on the same
  // category button, so a re-render never drops the keyboard position.
  function sync(kind, build, place) {
    const old = live.get(kind);
    const next = build();
    if (old && old.isConnected) {
      if (old.outerHTML === next.outerHTML && place(old, true)) return old;
      const focus = old.contains(document.activeElement) ? document.activeElement.getAttribute("data-ghnt-cat") : null;
      if (!place(next, false)) return old;
      old.remove();
      live.set(kind, next);
      if (focus) next.querySelector(`[data-ghnt-cat="${focus}"]`)?.focus();
      return next;
    }
    if (place(next, false)) live.set(kind, next);
    return next;
  }

  // A Turbo snapshot restores dead clones of earlier nodes (no handlers):
  // everything of ours that this module did not build is removed.
  function sweepStrays() {
    const own = new Set(live.values());
    for (const node of document.querySelectorAll("[data-ghnt-triage]")) if (!own.has(node)) node.remove();
  }

  // ---- hide / restore --------------------------------------------------------

  function setOff(node, off) {
    if (off) {
      if (!node.classList.contains("ghnt-off")) node.classList.add("ghnt-off");
      hidden.add(node);
    } else if (hidden.has(node)) {
      node.classList.remove("ghnt-off");
      hidden.delete(node);
    }
  }

  function clearOff() {
    for (const node of hidden) node.classList.remove("ghnt-off");
    hidden.clear();
  }

  function applyFilter(list) {
    for (const r of list) setOff(r.li, !M.keeps(selected, r.item));
    // A native box (Group by Repository) with no visible row is hidden too.
    for (const ul of nativeLists()) {
      const box = boxOf(ul);
      if (box === ul) continue;
      const any = [...box.querySelectorAll("li.notifications-list-item")].some((li) => !li.classList.contains("ghnt-off"));
      setOff(box, !any);
    }
  }

  // GitHub's select-all and its bulk actions reach every checkbox of the
  // list, seen or not: a row the view hides must never stay selected.
  function uncheckHidden() {
    for (const li of document.querySelectorAll("li.notifications-list-item.ghnt-off, li.notifications-list-item[hidden]")) {
      for (const box of li.querySelectorAll('input[type="checkbox"]:checked')) {
        box.checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
  const afterSelect = (e) => {
    if (e.target?.matches?.('input[type="checkbox"]')) setTimeout(() => active && uncheckHidden(), 0);
  };

  // ---- info (status + coverage), outside the native list ---------------------

  // GitHub's own link to the next page of the inbox, or null on the last page.
  function nextLink() {
    return document.querySelector('.paginate-container a[rel="next"], nav[aria-label="Pagination"] a[rel="next"], nav[aria-label="Pagination"] a[href*="after="]');
  }

  // A link to the same target as GitHub's next page, or null.
  function nextPage() {
    const href = nextLink()?.getAttribute("href");
    return href ? el("a", { class: "ghnt-next", href, text: M.NEXT_LABEL }) : null;
  }

  function renderInfo(c, mode) {
    const lists = nativeLists();
    if (!lists.length) return removeInfo();
    const first = boxOf(lists[0]);
    const last = boxOf(lists[lists.length - 1]);

    const status = el("div", { class: "ghnt-status", "data-ghnt-triage": "status", role: "status" });
    if (mode === "filter" && selected) {
      status.append(el("span", { class: "ghnt-status-text", text: M.statusLine(selected, c) }));
      const clear = el("button", { type: "button", class: "ghnt-clear", text: "Clear triage" });
      clear.addEventListener("click", () => {
        const was = selected;
        selected = null;
        render();
        // The status (and the focused button in it) is gone: keep the keyboard position.
        document.querySelector(`[data-ghnt-cat="${was}"]`)?.focus();
      });
      status.append(clear);
    }
    const empty = mode === "filter" ? M.emptyText(selected, c) : "";
    if (empty) {
      const next = nextPage();
      status.append(el("div", { class: "ghnt-empty" }, empty, next && " ", next));
    }
    const pend = M.pendingText(c.pending);
    if (pend) status.append(el("div", { class: "ghnt-pending", text: pend }));
    const showStatus = status.childNodes.length > 0;

    syncInfo("status", showStatus ? status : null, (node) => first.before(node));
    const next = nextPage();
    const cov = el("p", { class: "ghnt-coverage", "data-ghnt-triage": "coverage" }, M.coverageText(c, !!next), next && " ", next);
    syncInfo("coverage", cov, (node) => last.after(node));
  }

  function syncInfo(kind, next, place) {
    const old = live.get(kind);
    if (!next) {
      old?.remove();
      live.delete(kind);
      return;
    }
    if (old && old.isConnected && old.outerHTML === next.outerHTML) return;
    const focus = old?.contains(document.activeElement) ? document.activeElement.className : null;
    old?.remove();
    place(next);
    live.set(kind, next);
    if (focus) next.querySelector(`.${focus.split(" ")[0]}`)?.focus();
  }

  function removeInfo() {
    for (const kind of ["status", "coverage"]) {
      live.get(kind)?.remove();
      live.delete(kind);
    }
  }

  // ---- grouped sections ------------------------------------------------------

  function slotOrder(a, b) {
    const na = slots.get(a.li) || a.li;
    const nb = slots.get(b.li) || b.li;
    if (na === nb) return 0;
    return na.compareDocumentPosition(nb) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function rowId(li) {
    if (!li.id) {
      li.id = `ghnt-row-${++ownIds}`;
      li.setAttribute("data-ghnt-id", "1");
    }
    return li.id;
  }

  // Octicons chevron-down / chevron-right (16px).
  const CHEVRON = {
    down: "M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 9.94l3.72-3.72a.749.749 0 0 1 1.06 0Z",
    right: "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
  };
  function chevron(expanded) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [k, v] of Object.entries({ class: "ghnt-chevron", width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", expanded ? CHEVRON.down : CHEVRON.right);
    svg.append(path);
    return svg;
  }

  // Inert text under an expanded header: never a row, so j/k never stop on it.
  function buildNote(cat, n) {
    const lines = M.sectionNote(cat, n);
    return lines.length ? el("div", { class: "ghnt-sec-note" }, lines.map((t) => el("p", { text: t }))) : null;
  }

  function buildHeader(cat, c, expanded, ids) {
    const btn = el("button", { type: "button", class: "ghnt-sec-btn", "aria-expanded": String(expanded), "aria-controls": ids.join(" ") || false, "aria-label": `${M.labelOf(cat)}, ${c[cat]} of ${c.loaded} loaded notifications`, "data-ghnt-sec": cat }, dot(cat), el("span", { class: "ghnt-label", text: M.labelOf(cat) }), el("span", { class: "ghnt-count", text: M.countText(c[cat], false) }), chevron(expanded));
    btn.addEventListener("click", () => {
      collapsed = { ...collapsed, [cat]: expanded };
      try {
        chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
      } catch {
        /* storage is a convenience */
      }
      render();
    });
    btn.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      const heads = [...document.querySelectorAll(".ghnt-sec-btn")];
      const next = heads[M.moveFocus(heads.indexOf(btn), e.key, heads.length)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    });
    return btn;
  }

  function renderGrouped(list, c) {
    const lists = nativeLists();
    if (!lists.length) return;
    const target = lists[0];
    // Rows move under the reader: the browser's own scroll anchoring would fight the compensation below.
    target.classList.add("ghnt-grouped");
    // A row's native slot is remembered the first time it moves.
    const classified = list.filter((r) => M.categoryOf(r.item));
    for (const r of classified) {
      if (!slots.has(r.li) && r.li.parentNode) {
        const mark = document.createComment("ghnt-slot");
        r.li.before(mark);
        slots.set(r.li, mark);
      }
    }
    // Rows still being classified wait, hidden, until they have a section.
    for (const r of list) if (!M.categoryOf(r.item)) setOff(r.li, true);
    for (const r of classified) setOff(r.li, false);
    const groups = Object.fromEntries(M.IDS.map((id) => [id, classified.filter((r) => M.categoryOf(r.item) === id).sort(slotOrder)]));

    const desired = [];
    const heads = [];
    for (const id of M.IDS) {
      const isOpen = collapsed[id] !== true;
      let li = live.get(`sec-${id}`);
      if (!li || !li.isConnected) li = el("li", { class: "ghnt-sec", "data-ghnt-sec": id, "data-ghnt-triage": "sec" });
      live.set(`sec-${id}`, li);
      const btn = buildHeader(id, c, isOpen, groups[id].map((r) => rowId(r.li)));
      const kids = [btn, isOpen ? buildNote(id, c[id]) : null].filter(Boolean);
      const prev = li.querySelector(".ghnt-sec-btn");
      const focused = prev && prev === document.activeElement;
      if (!prev || li.innerHTML !== kids.map((k) => k.outerHTML).join("")) {
        li.replaceChildren(...kids);
        if (focused) btn.focus();
      }
      heads.push(li);
      desired.push(li, ...groups[id].map((r) => r.li));
      for (const r of groups[id]) {
        if (isOpen && collapsedRows.has(r.li)) {
          r.li.removeAttribute("hidden");
          collapsedRows.delete(r.li);
        } else if (!isOpen && !collapsedRows.has(r.li)) {
          r.li.setAttribute("hidden", "");
          collapsedRows.add(r.li);
        }
      }
    }

    const current = [...target.children].slice(0, desired.length);
    const same = current.length === desired.length && current.every((n, i) => n === desired[i]);
    if (!same) {
      // The scroll anchor is a visible node that stays in its section: moving
      // the rows around it must not move it on screen.
      const stay = new Set(classified.filter((r) => lastSection.get(r.key) === M.categoryOf(r.item)).map((r) => r.li));
      const onScreen = (n) => n.getBoundingClientRect().bottom > 0 && n.getBoundingClientRect().top < window.innerHeight;
      const ref = [...stay].filter((n) => n.isConnected).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).find(onScreen) || [...document.querySelectorAll("li.ghnt-sec")].find(onScreen);
      const before = ref ? ref.getBoundingClientRect().top : 0;
      let cursor = target.firstChild;
      for (const node of desired) {
        if (node === cursor) cursor = cursor.nextSibling;
        else target.insertBefore(node, cursor);
      }
      if (ref && ref.isConnected) {
        const delta = ref.getBoundingClientRect().top - before;
        if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
      }
    }

    // Native boxes (Group by Repository) emptied by the move are hidden.
    for (const ul of lists) {
      const box = boxOf(ul);
      if (box === ul || ul === target) continue;
      const any = [...ul.children].some((n) => n.matches?.("li.notifications-list-item"));
      setOff(box, !any);
    }

    // A row that changed category is highlighted for a moment.
    for (const r of classified) {
      const id = M.categoryOf(r.item);
      const was = lastSection.get(r.key);
      if (was && was !== id) highlight(r.li);
      lastSection.set(r.key, id);
    }
  }

  function highlight(li) {
    li.classList.add("ghnt-moved");
    setTimeout(() => li.classList.remove("ghnt-moved"), HIGHLIGHT_MS);
  }

  function unrenderGrouped() {
    for (const [li, mark] of slots) {
      if (mark.parentNode) mark.replaceWith(li);
      else li.remove();
    }
    slots.clear();
    for (const id of M.IDS) {
      live.get(`sec-${id}`)?.remove();
      live.delete(`sec-${id}`);
    }
    document.querySelectorAll("ul.ghnt-grouped").forEach((ul) => ul.classList.remove("ghnt-grouped"));
    for (const li of collapsedRows) li.removeAttribute("hidden");
    collapsedRows.clear();
    for (const li of rowEls()) {
      li.classList.remove("ghnt-moved");
      if (li.hasAttribute("data-ghnt-id")) {
        li.removeAttribute("id");
        li.removeAttribute("data-ghnt-id");
      }
    }
    lastSection.clear();
  }

  // ---- render ----------------------------------------------------------------

  function removeChrome() {
    for (const kind of ["nav", "quickbar", "compact"]) {
      live.get(kind)?.remove();
      live.delete(kind);
    }
  }

  function unrender() {
    removeChrome();
    removeInfo();
    unrenderGrouped();
    clearOff();
  }

  function narrowNow() {
    const nav = sidebarNav();
    if (nav) return !rendered(nav);
    return window.innerWidth < NARROW;
  }

  function render() {
    if (!active || rendering) return;
    const want = registry.layout();
    if (!LAYOUT_IDS.includes(want)) return;
    rendering = true;
    try {
      if (layout && layout !== want) {
        unrender();
        selected = null;
      }
      layout = want;
      sweepStrays();
      if (!state || state.phase === "idle") return;
      const list = rows();
      const c = M.counts(list.map((r) => r.item || { inPage: true, pending: true }));
      if (want === "grouped") {
        selected = null;
        removeChrome();
        clearOff();
        renderGrouped(list, c);
        renderInfo(c, "grouped");
      } else {
        unrenderGrouped();
        renderChrome(want, c);
        applyFilter(list);
        renderInfo(c, "filter");
      }
    } finally {
      uncheckHidden();
      observer?.takeRecords();
      rendering = false;
    }
  }

  function renderChrome(want, c) {
    const row = filterRow();
    const compact = want === "integrated" && narrowNow();
    for (const kind of ["nav", "quickbar", "compact"]) {
      const wanted = want === "integrated" ? (compact ? "compact" : "nav") : "quickbar";
      if (kind !== wanted) {
        live.get(kind)?.remove();
        live.delete(kind);
      }
    }
    if (want === "integrated" && !compact) {
      const nav = sidebarNav();
      if (!nav) return; // anchor missing: nothing, retried on the next scan
      sync("nav", () => buildSidebar(c), (node, inPlace) => {
        if (inPlace) return nav.firstElementChild === node;
        nav.prepend(node);
        return true;
      });
      return;
    }
    if (!row) return; // the filter row is the anchor of the pills
    const kind = compact ? "compact" : "quickbar";
    sync(kind, () => buildBar(c, kind, row), (node, inPlace) => {
      if (inPlace) return node.previousElementSibling === row;
      row.after(node);
      return true;
    });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      render();
    }, 120);
  }

  // ---- module ----------------------------------------------------------------

  async function loadCollapsed() {
    try {
      const got = await chrome.storage.local.get(COLLAPSED_KEY);
      const v = got[COLLAPSED_KEY];
      collapsed = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      collapsed = {};
    }
    render();
  }

  // Turbo snapshots the page before leaving it: take the view out first, so a
  // restored snapshot is GitHub's plain list (render() rebuilds it).
  function leaveForCache() {
    if (!active) return;
    unrender();
    layout = null;
    selected = null;
  }

  function start(api) {
    if (active) return;
    active = true;
    layout = null;
    selected = null;
    const source = api || engine;
    state = source.getState();
    offEngine = source.subscribe((next) => {
      state = next;
      render();
    });
    offRegistry = registry.onChange(() => schedule());
    observer = new MutationObserver((records) => {
      if (rendering) return;
      // Our own insertions are not news; GitHub re-rendering the list or sidebar is.
      // Our own changes are drained with takeRecords() after each render, so
      // whatever arrives here (a re-rendered list, a removed node of ours) is
      // GitHub's.
      const foreign = records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1));
      if (foreign) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("change", afterSelect, true);
    document.addEventListener("click", afterSelect, true);
    document.addEventListener("turbo:before-cache", leaveForCache);
    // A restored Turbo snapshot can carry marks of a view that is gone.
    document.querySelectorAll(".ghnt-off").forEach((n) => n.classList.remove("ghnt-off"));
    loadCollapsed();
    render();
  }

  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    timer = null;
    offEngine?.();
    offRegistry?.();
    offEngine = offRegistry = null;
    observer?.disconnect();
    observer = null;
    window.removeEventListener("resize", schedule);
    document.removeEventListener("change", afterSelect, true);
    document.removeEventListener("click", afterSelect, true);
    document.removeEventListener("turbo:before-cache", leaveForCache);
    unrender();
    layout = null;
    selected = null;
    state = null;
  }

  registry.register({ id: "triage", label: "Triage", defaultOn: true, layouts: LAYOUT_IDS, start, stop });
})();
