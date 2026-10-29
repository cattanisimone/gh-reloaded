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
// Everything the view says comes from one pure model (GHNT_TRIAGE_MODEL.view):
// no renderer formats a count or a sentence. Everything we add above the list
// is ONE block placed right after the filter row; the filter row is the anchor
// of the whole view, and without it nothing runs (no block, no sidebar group,
// no hidden or moved row) until the next scan finds it again. Anchors are ARIA
// and stable classes only, never a CSS-module class; no other container is
// used. Counts cover the rows loaded on the page.
//
// Registers itself with the registry content.js created, so it loads after it.

(function () {
  const M = globalThis.GHNT_TRIAGE_MODEL;
  const COLLAPSED_KEY = "ghntTriageCollapsed";
  const LAYOUT_IDS = ["integrated", "quickbar", "grouped"];
  const HIGHLIGHT_MS = 3000;
  const NARROW = 768; // GitHub hides the sidebar below this width
  const GAP = 8; // space above and below the block, whatever the native margins
  const GROUP_WAIT_MS = 2000; // Grouped waits this long for rows still being classified

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
  let resizer = null; // ResizeObserver: refreshes the block's insets and gaps
  let measureQueued = false;
  let watched = [];
  let built = false; // Grouped: the sections of the current list exist
  let groupedTarget = null; // the list Grouped works on
  let groupedSince = 0;
  let groupedTimer = null;
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

  function categoryButton(cat, cls) {
    const btn = el("button", { type: "button", class: cls, "aria-pressed": String(cat.pressed), "aria-label": cat.aria, "data-ghnt-cat": cat.id }, dot(cat.id), el("span", { class: "ghnt-label", text: cat.label }), el("span", { class: "ghnt-count", text: cat.count }));
    btn.addEventListener("click", () => {
      selected = selected === cat.id ? null : cat.id;
      render();
    });
    return btn;
  }

  function buildSidebar(v) {
    const items = v.cats.map((cat) => el("li", { class: "ghnt-nav-li" }, categoryButton(cat, "ghnt-nav-item")));
    // GitHub separates its sidebar groups with an hr: the Triage group ends with one too.
    return el("nav", { class: "ghnt-nav", "aria-label": "Triage", "data-ghnt-triage": "nav" }, el("h3", { class: "ghnt-nav-title", text: "Triage" }), el("ul", { class: "ghnt-nav-list" }, items), el("hr", { class: "ghnt-nav-sep" }));
  }

  function buildBar(v, kind) {
    const buttons = v.cats.map((cat) => categoryButton(cat, "ghnt-pill"));
    return el("div", { class: `ghnt-bar ${kind === "compact" ? "ghnt-compact" : "ghnt-quickbar"}`, role: "group", "aria-label": "Triage", "data-ghnt-triage": kind }, buttons);
  }

  // GitHub's own link to the next page of the inbox, or null on the last page.
  function nextHref() {
    const a = document.querySelector('.paginate-container a[rel="next"], nav[aria-label="Pagination"] a[rel="next"], nav[aria-label="Pagination"] a[href*="after="]');
    return a?.getAttribute("href") || null;
  }

  const nextLink = (v) => (v.next ? el("a", { class: "ghnt-next", href: v.next.href, text: v.next.label }) : null);

  // The one block of ours above the list: [pills] + status + empty + coverage.
  function buildBlockKids(v, barKind, pendingInBlock = true) {
    const kids = [];
    if (barKind) kids.push(buildBar(v, barKind));
    const status = el("div", { class: "ghnt-status", "data-ghnt-triage": "status", role: "status" });
    if (v.status) {
      status.append(el("span", { class: "ghnt-status-text", text: v.status }));
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
    if (v.empty) status.append(el("div", { class: "ghnt-empty" }, v.empty, v.next && " ", nextLink(v)));
    if (v.pending && pendingInBlock) status.append(el("div", { class: "ghnt-pending", text: v.pending }));
    if (status.childNodes.length) kids.push(status);
    kids.push(el("p", { class: "ghnt-coverage", "data-ghnt-triage": "coverage" }, v.coverage, v.next && " ", nextLink(v)));
    return kids;
  }

  const focusKey = (node) => (node?.getAttribute?.("data-ghnt-cat") ? `[data-ghnt-cat="${node.getAttribute("data-ghnt-cat")}"]` : node?.classList?.contains("ghnt-clear") ? ".ghnt-clear" : null);

  // Replaces the sidebar group in place, keeping focus on the same category.
  function sync(kind, build, place) {
    const old = live.get(kind);
    const next = build();
    if (old && old.isConnected) {
      if (old.outerHTML === next.outerHTML && place(old, true)) return old;
      const key = old.contains(document.activeElement) ? focusKey(document.activeElement) : null;
      if (!place(next, false)) return old;
      old.remove();
      live.set(kind, next);
      if (key) next.querySelector(key)?.focus();
      return next;
    }
    if (place(next, false)) live.set(kind, next);
    return next;
  }

  // Puts the block right after the filter row, filling it in place and keeping
  // focus on the same control, so a re-render never drops the keyboard position.
  function syncBlock(row, kids) {
    let block = live.get("block");
    if (!block || !block.isConnected) {
      block = el("div", { class: "ghnt-block", "data-ghnt-triage": "block" });
      live.set("block", block);
    }
    const holder = el("div", null, kids);
    if (block.innerHTML !== holder.innerHTML) {
      const key = block.contains(document.activeElement) ? focusKey(document.activeElement) : null;
      block.replaceChildren(...holder.childNodes);
      if (key) block.querySelector(key)?.focus();
    }
    if (block.previousElementSibling !== row) row.after(block);
    return block;
  }

  // Inset rule: the block is a sibling of the filter row, so its margin-inline
  // is measured against the parent's content box over the row's visible
  // children (zero-width ones are skipped). Spacing rule: with the block's own
  // vertical margins at 0, read the native gaps above and below it and set
  // margins that bring both to GAP (negative when the native ones are bigger;
  // they add to the neighbours' margins whether those collapse or not).
  function nextBox(block) {
    for (let n = block.nextElementSibling; n; n = n.nextElementSibling) {
      const pos = getComputedStyle(n).position;
      if (pos === "absolute" || pos === "fixed") continue;
      if (n.getBoundingClientRect().height > 0) return n;
    }
    return null;
  }

  function insetsOf(row) {
    const parent = row.parentElement;
    const rects = [...row.children].map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!parent || !rects.length) return null;
    const box = parent.getBoundingClientRect();
    const cs = getComputedStyle(parent);
    const left = box.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const right = box.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    return [Math.min(...rects.map((r) => r.left)) - left, right - Math.max(...rects.map((r) => r.right))].map((x) => Math.max(0, Math.round(x)));
  }

  function measure() {
    const block = live.get("block");
    const row = filterRow();
    if (!active || !row || !block?.isConnected || block.previousElementSibling !== row) return;
    const insets = insetsOf(row);
    if (!insets) return;
    block.style.marginTop = block.style.marginBottom = "0px";
    const above = block.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
    const next = nextBox(block);
    const below = next ? next.getBoundingClientRect().top - block.getBoundingClientRect().bottom : 0;
    block.style.setProperty("--ghnt-l", `${insets[0]}px`);
    block.style.setProperty("--ghnt-r", `${insets[1]}px`);
    block.style.marginTop = `${Math.round((GAP - above) * 100) / 100}px`;
    block.style.marginBottom = `${Math.round((GAP - below) * 100) / 100}px`;
    watch(row, block, next);
  }

  // Native size changes (the row, the toasts container, a window resize that
  // flips Primer's lg margins) refresh the measurement without a full render.
  function watch(row, block, next) {
    if (!resizer) return;
    const nodes = [row, block];
    for (let n = block.nextElementSibling; n && n !== next; n = n.nextElementSibling) nodes.push(n);
    if (next) nodes.push(next);
    // observe() reports once at once: only touch the observer when the set changed
    if (nodes.length === watched.length && nodes.every((n, i) => n === watched[i])) return;
    resizer.disconnect();
    for (const n of nodes) resizer.observe(n);
    watched = nodes;
  }

  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      measure();
    });
  }

  // A Turbo snapshot restores dead clones of earlier nodes (no handlers):
  // everything of ours that this module did not build is removed.
  function sweepStrays() {
    const own = [...live.values()];
    for (const node of document.querySelectorAll("[data-ghnt-triage]")) if (!own.some((o) => o === node || o.contains(node))) node.remove();
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
  function buildNote(cat) {
    return cat.note.length ? el("div", { class: "ghnt-sec-note" }, cat.note.map((t) => el("p", { text: t }))) : null;
  }

  function buildHeader(cat, ids) {
    const expanded = cat.expanded;
    const btn = el("button", { type: "button", class: "ghnt-sec-btn", "aria-expanded": String(expanded), "aria-controls": ids.join(" ") || false, "aria-label": cat.aria, "data-ghnt-sec": cat.id }, dot(cat.id), el("span", { class: "ghnt-label", text: cat.label }), el("span", { class: "ghnt-count", text: cat.count }), chevron(expanded));
    btn.addEventListener("click", () => {
      collapsed = { ...collapsed, [cat.id]: expanded };
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

  function renderGrouped(list, v, c) {
    const lists = nativeLists();
    if (!lists.length) return;
    const target = lists[0];
    if (target !== groupedTarget) {
      groupedTarget = target;
      built = false;
      groupedSince = Date.now();
    }
    // Rows still being classified: the native list stays as GitHub drew it and
    // the block says so; the sections are built once, when nothing is pending
    // or after GROUP_WAIT_MS at most, so they never reorder twice.
    if (!built) {
      const left = GROUP_WAIT_MS - (Date.now() - groupedSince);
      if (c.pending > 0 && left > 0) {
        clearTimeout(groupedTimer);
        groupedTimer = setTimeout(render, left);
        return;
      }
      built = true;
    }
    // Rows move under the reader: the browser's own scroll anchoring would fight the compensation below.
    target.classList.add("ghnt-grouped");
    const classified = list.filter((r) => M.categoryOf(r.item));
    // The scroll anchor, taken before anything is hidden or moved: the first
    // visible row that stays in its section, or on the first build (nothing has
    // a section yet) the first visible row that gets one, else a header.
    const onScreen = (n) => n.isConnected && n.getBoundingClientRect().bottom > 0 && n.getBoundingClientRect().top < window.innerHeight;
    const stay = classified.filter((r) => lastSection.get(r.key) === M.categoryOf(r.item));
    const candidates = (lastSection.size ? stay : classified).map((r) => r.li).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const ref = window.scrollY > 0 ? candidates.find(onScreen) || [...document.querySelectorAll("li.ghnt-sec")].find(onScreen) : null;
    const before = ref ? ref.getBoundingClientRect().top : 0;
    // A row's native slot is remembered the first time it moves.
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
    for (const cat of v.cats) {
      const id = cat.id;
      const isOpen = cat.expanded;
      let li = live.get(`sec-${id}`);
      if (!li || !li.isConnected) li = el("li", { class: "ghnt-sec", "data-ghnt-sec": id, "data-ghnt-triage": "sec" });
      live.set(`sec-${id}`, li);
      const btn = buildHeader(cat, groups[id].map((r) => rowId(r.li)));
      const kids = [btn, buildNote(cat)].filter(Boolean);
      const prev = li.querySelector(".ghnt-sec-btn");
      const focused = prev && prev === document.activeElement;
      if (!prev || li.innerHTML !== kids.map((k) => k.outerHTML).join("")) {
        li.replaceChildren(...kids);
        if (focused) btn.focus();
      }
      heads.push(li);
      desired.push(li, ...groups[id].map((r) => r.li));
      if (id === M.IDS[M.IDS.length - 1]) {
        // Sections built at the GROUP_WAIT_MS cap: the rows still being
        // classified are counted after the last section, not in the block above
        // the list, so the line going away never moves the first header up.
        let wait = live.get("sec-pending");
        if (v.pending) {
          if (!wait || !wait.isConnected) wait = el("li", { class: "ghnt-sec-pending ghnt-pending", "data-ghnt-triage": "sec", role: "status" });
          if (wait.textContent !== v.pending) wait.textContent = v.pending;
          live.set("sec-pending", wait);
          desired.push(wait);
        } else if (wait) {
          wait.remove();
          live.delete("sec-pending");
        }
      }
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
      let cursor = target.firstChild;
      for (const node of desired) {
        if (node === cursor) cursor = cursor.nextSibling;
        else target.insertBefore(node, cursor);
      }
    }
    // The page only needs holding in place once the reader has scrolled (ref is null at scrollY 0).
    if (ref && ref.isConnected) {
      const delta = ref.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
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
    for (const id of [...M.IDS, "pending"]) {
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
    clearTimeout(groupedTimer);
    groupedTimer = null;
    built = false;
    groupedTarget = null;
  }

  // ---- render ----------------------------------------------------------------

  function removeChrome() {
    live.get("nav")?.remove();
    live.delete("nav");
  }

  function removeBlock() {
    live.get("block")?.remove();
    live.delete("block");
    resizer?.disconnect();
    watched = [];
  }

  function unrender() {
    removeChrome();
    removeBlock();
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
      // The filter row anchors the whole view: without it nothing of ours runs
      // (no block, no sidebar group, no hidden or moved row), the next scan retries.
      const row = filterRow();
      const compact = want === "integrated" && narrowNow();
      const nav = want === "integrated" && !compact ? sidebarNav() : null;
      if (!row || !insetsOf(row) || (want === "integrated" && !compact && !nav)) {
        unrender();
        return;
      }
      const list = rows();
      const c = M.counts(list.map((r) => r.item || { inPage: true, pending: true }));
      const v = M.view(c, { layout: want, selected, collapsed, nextHref: nextHref() });
      if (want === "grouped") {
        selected = null;
        removeChrome();
        clearOff();
        renderGrouped(list, v, c);
      } else {
        unrenderGrouped();
        if (nav) {
          sync("nav", () => buildSidebar(v), (node, inPlace) => {
            if (inPlace) return nav.firstElementChild === node;
            nav.prepend(node);
            return true;
          });
        } else removeChrome();
        applyFilter(list);
      }
      const barKind = want === "quickbar" ? "quickbar" : compact ? "compact" : null;
      syncBlock(row, buildBlockKids(v, barKind, !(want === "grouped" && built)));
      measure();
    } finally {
      uncheckHidden();
      observer?.takeRecords();
      rendering = false;
    }
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
    resizer = new ResizeObserver(queueMeasure);
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
    resizer?.disconnect();
    resizer = null;
    watched = [];
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
