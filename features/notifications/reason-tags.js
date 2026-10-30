// features/notifications/reason-tags.js — the first visible module of the
// notifications engine: a tag on every inbox row saying why it is there
// (Direct review request, Team review request, Re-review requested, Mention,
// Subscribed, CI or Unverifiable) and a "Why is this here?" panel with the
// evidence. The rules live in reason-tag.js; this file renders them.
//
// Placement: one div.ghnt-line, the last child of the row's li, aligned to the
// title column. Never inside the title link (a button cannot sit in a link and
// its click would open the thread) and never in GitHub's right cluster. If the
// row cannot hold it (no native label found, no container, no title text in
// the link, or the li is a non-wrapping flex row) nothing is rendered and the next scan tries again:
// no other container is used.
//
// The tag is a disclosure button. Opening it inserts one li.ghnt-why right
// after the row's li, in the page flow: no overlay, so no positioning, no
// closing on scroll or resize, and the tab order is the DOM order (tag, panel
// link, next row). While open, row and panel read as one item: the script
// mirrors the row's state (unread, read, hovered, focused, j/k selected) onto
// the panel through data-ghnt-* attributes (never GitHub's classes), and
// moves the row's divider under the panel.
//
// Events on a tag or the panel are handled by one capture listener on
// window and stopped there, so GitHub's row handlers (open the thread, mark
// read, the checkbox, its hotkeys) never see them. Anything else is left alone.
// stop() removes every node and listener: the page is GitHub's own again.

(function () {
  const registry = globalThis.GHNotifications?.registry;
  if (!registry) return;

  const MODULE_ID = "reasonTags";
  const HIGHLIGHT_MS = 3000;
  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    person: { fill: true, d: "M8 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM2 14.5c0-3.2 2.7-5 6-5s6 1.8 6 5z" },
    people: { fill: true, d: "M5.5 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM1 14c0-2.8 2-4.5 4.5-4.5S10 11.2 10 14zM11 2.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM11.5 9.6c2 .1 3.5 1.5 3.5 4.4h-3.6c0-1.8-.5-3.2-1.4-4.1z" },
    sync: { d: "M13.5 8a5.5 5.5 0 0 0-9.7-3.5M2.5 8a5.5 5.5 0 0 0 9.7 3.5M3.2 1.8l.6 2.7 2.7-.6M12.8 14.2l-.6-2.7-2.7.6" },
    mention: { d: "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10.5 5.5v3.2c0 1.6 3 1.6 3-.7A5.5 5.5 0 1 0 10.5 13" },
    bell: { fill: true, d: "M8 1.5a4 4 0 0 0-4 4V9l-1.5 2.5h11L12 9V5.5a4 4 0 0 0-4-4zM6.3 13h3.4a1.7 1.7 0 0 1-3.4 0z" },
    play: { fill: true, d: "M4.5 2.5l9 5.5-9 5.5z" },
    question: { d: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6 6.3a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.3M8 11.6v.3" },
  };

  const lines = new Map(); // key -> { line, button, tagId, li, lead }
  const timers = new Map(); // li -> timer id
  let lastState = null;
  let panel = null; // { li, card, key, button, rowLi, rowHover, panelHover }
  let focusedKey = null; // key of the tag or panel that last had focus
  let rowObserver = null;
  const watched = new WeakSet();
  let observer = null;
  let sizeObserver = null;
  let unsubscribe = null;
  let renderTimer = null;
  let panelSeq = 0;

  const T = () => globalThis.GHNT_REASON_TAG;
  const C = () => globalThis.GHNT_COLLECT;
  const extensionAlive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  // --- tag line ------------------------------------------------------------

  function icon(name) {
    const spec = ICONS[name];
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "ghnt-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", spec.d);
    if (spec.fill) path.setAttribute("fill", "currentColor");
    else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
    return svg;
  }

  // The li can hold the line only when a new child sits under the row, not
  // beside it: a non-wrapping flex row cannot.
  function canHold(li) {
    const cs = getComputedStyle(li);
    return !(cs.display.includes("flex") && cs.flexDirection.startsWith("row") && cs.flexWrap === "nowrap");
  }

  // The title text column: the link's first child that carries text (on the
  // live inbox the div.flex-auto holding the repository line and the title),
  // past the status icon that leads the link. Null when the link has no such
  // child: the row then gets no tag and the next scan tries again.
  function titleText(link) {
    if (!link) return null;
    for (const el of link.children) if (el.textContent.trim()) return el;
    return null;
  }

  // Title column offset, measured, not hardcoded: the title text's left edge
  // from the li's border box, minus the li's own padding.
  function indent(li, title) {
    const cs = getComputedStyle(li);
    const px = title.getBoundingClientRect().left - li.getBoundingClientRect().left - (parseFloat(cs.paddingLeft) || 0);
    return Math.max(0, Math.round(px * 100) / 100);
  }

  // What decides the title column: the li and everything laid out before the
  // title text (checkbox, unread dot, the link's status icon). Any of them
  // changing size moves the column, even when the list keeps its width
  // (breakpoint, font load, selection mode).
  function leadOf(li, title) {
    const out = [li, title];
    for (let n = title; n && n !== li; n = n.parentElement) {
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) out.push(s);
    }
    return out;
  }

  function watchLead(entry, li, title) {
    if (!sizeObserver || (entry.lead?.[0] === li && entry.lead[1] === title)) return;
    for (const el of entry.lead || []) sizeObserver.unobserve(el);
    entry.lead = leadOf(li, title);
    for (const el of entry.lead) sizeObserver.observe(el);
  }

  function fillTag(button, t) {
    button.className = `ghnt-tag ghnt-tone-${t.tone}`;
    button.setAttribute("aria-label", t.aria);
    button.dataset.ghntTag = t.id;
    button.replaceChildren(icon(t.icon));
    const text = document.createElement("span");
    text.className = "ghnt-tag-text";
    text.textContent = t.label;
    button.appendChild(text);
  }

  function removeLine(key) {
    const entry = lines.get(key);
    if (!entry) return;
    if (panel?.key === key) closePanel(false);
    for (const el of entry.lead || []) sizeObserver?.unobserve(el);
    entry.line.remove();
    clearHighlight(entry.li);
    lines.delete(key);
  }

  function clearHighlight(li) {
    clearTimeout(timers.get(li));
    timers.delete(li);
    li.classList.remove("ghnt-hl");
  }

  function highlight(li) {
    clearTimeout(timers.get(li));
    li.classList.add("ghnt-hl");
    timers.set(li, setTimeout(() => clearHighlight(li), HIGHLIGHT_MS));
  }

  function renderItem(item) {
    const t = T().tagFor(item);
    const row = item.inPage === false ? null : C().findRow(document, item.key);
    // A row being read again after its reason changed keeps its line until the
    // new answer arrives, so the change is shown as an update, not a new tag.
    if (!t && item.pending && lines.has(item.key) && row) return;
    const title = titleText(row?.link);
    if (!t || !row || !row.container || !row.label || !title || !canHold(row.li)) return removeLine(item.key);

    let entry = lines.get(item.key);
    let replaced = false;
    if (entry && entry.li !== row.li) {
      // GitHub replaced the row's li. An open panel survives on the new li.
      const keep = panel?.key === item.key ? panel : null;
      if (keep) panel = null;
      removeLine(item.key);
      panel = keep;
      entry = null;
      replaced = true;
    }
    if (!entry) {
      const line = document.createElement("div");
      line.className = "ghnt-line";
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("aria-expanded", "false");
      button.dataset.ghntKey = item.key;
      fillTag(button, t);
      line.appendChild(button);
      entry = { line, button, tagId: t.id, li: row.li };
      lines.set(item.key, entry);
      if (panel?.key === item.key) {
        panel.button = button;
        button.setAttribute("aria-expanded", "true");
        button.setAttribute("aria-controls", panel.li.id);
      }
    } else if (entry.tagId !== t.id) {
      // Reason changed while the page is open: update in place and highlight.
      fillTag(entry.button, t);
      entry.tagId = t.id;
      highlight(row.li);
    }
    // Last child of the li, after GitHub's own children.
    if (row.li.lastElementChild !== entry.line) row.li.appendChild(entry.line);
    const pad = `${indent(row.li, title)}px`;
    if (entry.line.style.paddingLeft !== pad) entry.line.style.paddingLeft = pad;
    watchLead(entry, row.li, title);
    if (panel?.key === item.key) renderPanel(item, row.li);
    else if (replaced && focusedKey === item.key) refocus(entry.button);
  }

  // Focus left on <body> because its node was replaced goes to the new tag.
  // Focus the user moved elsewhere is never taken back.
  function refocus(target) {
    const a = document.activeElement;
    if (!a || a === document.body) target.focus({ preventScroll: true });
  }

  // The panel is rebuilt only when what it shows changed: a rebuild drops focus.
  let panelSignature = "";

  // The first row the reader sees, once they have scrolled. Lines added or
  // removed above it would move it: the browser's scroll anchoring usually
  // absorbs that, but not where it is off (Triage's Grouped sections turn it
  // off to move rows themselves), so render() holds this row in place.
  function readingRow() {
    if (window.scrollY <= 0) return null;
    for (const li of document.querySelectorAll("li.notifications-list-item")) {
      const r = li.getBoundingClientRect();
      if (r.height && r.bottom > 0 && r.top < window.innerHeight) return li;
    }
    return null;
  }

  function render(state) {
    if (!state) return;
    lastState = state;
    const ref = readingRow();
    const before = ref ? ref.getBoundingClientRect().top : 0;
    const keys = new Set();
    for (const item of state.items || []) {
      keys.add(item.key);
      renderItem(item);
    }
    for (const key of [...lines.keys()]) if (!keys.has(key) || !lines.get(key).line.isConnected) removeLine(key);
    if (panel && !lines.has(panel.key)) closePanel(false);
    if (ref?.isConnected) {
      const delta = ref.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    }
  }

  // --- panel ---------------------------------------------------------------

  const MARKS = { ok: "✓", info: "i", warn: "!" };

  function fillPanel(model) {
    const card = panel.card;
    const hadFocus = card.contains(document.activeElement) ? document.activeElement.dataset?.ghntAction || "" : "";
    card.replaceChildren();
    const title = document.createElement("h2");
    title.className = "ghnt-why-title";
    title.id = `${panel.li.id}-title`;
    title.textContent = model.title;
    card.setAttribute("aria-labelledby", title.id);
    const list = document.createElement("ul");
    list.className = "ghnt-why-list";
    for (const l of model.lines) {
      const li = document.createElement("li");
      li.className = `ghnt-why-line ghnt-why-${l.kind}`;
      if (l.kind === "rule") {
        li.textContent = l.text;
      } else if (l.kind === "link") {
        li.className = "ghnt-why-line ghnt-why-linkrow";
        const mark = document.createElement("span");
        mark.className = "ghnt-why-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "→";
        li.appendChild(mark);
        if (l.action === "tokens") {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ghnt-why-link";
          b.dataset.ghntAction = "tokens";
          b.textContent = l.text;
          li.appendChild(b);
        } else {
          const a = document.createElement("a");
          a.className = "ghnt-why-link";
          a.href = l.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = l.text;
          li.appendChild(a);
        }
      } else {
        const mark = document.createElement("span");
        mark.className = "ghnt-why-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = MARKS[l.kind] || "";
        const text = document.createElement("span");
        text.textContent = l.text;
        li.append(mark, text);
      }
      list.appendChild(li);
    }
    card.append(title, list);
    if (hadFocus) card.querySelector(`[data-ghnt-action="${hadFocus}"]`)?.focus({ preventScroll: true });
  }

  // --- row <-> panel state ----------------------------------------------------

  // Unread or read comes from the row's own class; anything else counts as read.
  const isUnread = (li) => li.classList.contains("notification-unread");

  // No further row after this one in its list: GitHub's own :last-child rule
  // no longer applies once the panel follows the row, so the script restores it.
  function isLastRow(rowLi) {
    for (let n = (panel.li.previousElementSibling === rowLi ? panel.li : rowLi).nextElementSibling; n; n = n.nextElementSibling) {
      if (n.matches("li.notifications-list-item")) return false;
    }
    return true;
  }

  function setAttr(el, name, on, value = "") {
    if (on) {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    } else el.removeAttribute(name);
  }

  function sync() {
    if (!panel) return;
    const { li, rowLi } = panel;
    const active =
      panel.rowHover || panel.panelHover || rowLi.matches(":focus-within") || li.matches(":focus-within") || rowLi.classList.contains("navigation-focus");
    const last = isLastRow(rowLi);
    setAttr(rowLi, "data-ghnt-why-open", true);
    setAttr(rowLi, "data-ghnt-last", last);
    setAttr(rowLi, "data-ghnt-active", active);
    li.setAttribute("data-ghnt-state", isUnread(rowLi) ? "unread" : "read");
    setAttr(li, "data-ghnt-last", last);
    setAttr(li, "data-ghnt-active", active);
    setAttr(li, "data-ghnt-hl", rowLi.classList.contains("ghnt-hl"));
  }

  function clearRowAttrs(rowLi) {
    for (const a of ["data-ghnt-why-open", "data-ghnt-last", "data-ghnt-active"]) rowLi.removeAttribute(a);
  }

  function watch(el, side) {
    if (watched.has(el)) return;
    watched.add(el);
    el.addEventListener("pointerenter", () => panel && ((panel[side] = true), sync()));
    el.addEventListener("pointerleave", () => panel && ((panel[side] = false), sync()));
  }

  function renderPanel(item, rowLi) {
    if (rowLi !== panel.rowLi) {
      clearRowAttrs(panel.rowLi);
      panel.rowLi = rowLi;
      panel.rowHover = rowLi.matches(":hover");
    }
    if (panel.li.previousElementSibling !== rowLi) {
      panel.li.remove();
      rowLi.after(panel.li);
    }
    watch(rowLi, "rowHover");
    rowObserver?.disconnect();
    rowObserver?.observe(rowLi, { attributes: true, attributeFilter: ["class"] });
    const ctx = { now: Date.now(), me: lastState?.me || "", retryAt: lastState?.retryAt ?? null, rateLimited: !!lastState?.rateLimited };
    const model = T().popover(item, ctx);
    const signature = JSON.stringify(model);
    if (signature !== panelSignature || !panel.card.firstChild) {
      panelSignature = signature;
      fillPanel(model);
    }
    // The card starts where the tag starts, measured: the panel li sits outside the
    // row, so the row's own paddings, borders or insets cannot be summed into it.
    const offset = panel.button.getBoundingClientRect().left - panel.li.getBoundingClientRect().left;
    const pad = `${Math.max(0, Math.round(offset * 100) / 100)}px`;
    if (panel.li.style.paddingLeft !== pad) panel.li.style.paddingLeft = pad;
    sync();
    if (focusedKey === item.key) refocus(panel.button);
  }

  function openPanel(key) {
    const entry = lines.get(key);
    const item = lastState?.items.find((i) => i.key === key);
    if (!entry || !item) return;
    if (panel) closePanel(false);
    const li = document.createElement("li");
    li.className = "ghnt-why";
    li.id = `ghnt-why-${++panelSeq}`;
    li.dataset.ghntKey = key;
    const card = document.createElement("div");
    card.className = "ghnt-why-card";
    card.setAttribute("role", "region");
    li.appendChild(card);
    watch(li, "panelHover");
    panelSignature = "";
    rowObserver = new MutationObserver(() => sync());
    panel = { li, card, key, button: entry.button, rowLi: entry.li, rowHover: entry.li.matches(":hover"), panelHover: false };
    entry.button.setAttribute("aria-expanded", "true");
    entry.button.setAttribute("aria-controls", li.id);
    renderPanel(item, entry.li);
  }

  function closePanel(restoreFocus) {
    if (!panel) return;
    const { li, button, rowLi } = panel;
    panel = null;
    rowObserver?.disconnect();
    rowObserver = null;
    li.remove();
    clearRowAttrs(rowLi);
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-controls");
    if (restoreFocus) button.focus({ preventScroll: true });
  }

  // --- event isolation -----------------------------------------------------

  const inside = (target) => target instanceof Element && !!target.closest(".ghnt-line, .ghnt-why");
  // A tracked line or panel that is no longer in the page.
  const gone = (n) => !n.isConnected && (n === panel?.li || [...lines.values()].some((e) => e.line === n));
  const tagOf = (target) => (target instanceof Element ? target.closest(".ghnt-tag") : null);

  function toggle(button) {
    const key = button.dataset.ghntKey;
    if (panel?.key === key) closePanel(true);
    else openPanel(key);
  }

  function onClick(e) {
    if (!inside(e.target)) return;
    e.stopImmediatePropagation();
    const action = e.target.closest?.("[data-ghnt-action]");
    const anchor = e.target.closest?.("a");
    if (!anchor) e.preventDefault();
    if (action?.dataset.ghntAction === "tokens" && extensionAlive()) {
      chrome.runtime.sendMessage({ type: "GHNT_OPEN_SETTINGS" }).catch?.(() => {});
      closePanel(false);
      return;
    }
    const button = tagOf(e.target);
    if (button) toggle(button);
  }

  function onKeyDown(e) {
    if (!inside(e.target)) return;
    const button = tagOf(e.target);
    // Esc belongs to the open panel only from its tag or inside it.
    if (e.key === "Escape" && panel && (e.target === panel.button || panel.li.contains(e.target))) {
      e.stopImmediatePropagation();
      e.preventDefault();
      closePanel(true);
      return;
    }
    if (button && (e.key === "Enter" || e.key === " " || e.key === "?")) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === "?") {
        if (panel?.key !== button.dataset.ghntKey) openPanel(button.dataset.ghntKey);
      } else toggle(button);
      return;
    }
    // Any other key inside our nodes (Tab moves focus natively, in DOM order) must not reach
    // GitHub's row hotkeys (j, k, x, e…).
    if (e.key !== "Tab") e.stopImmediatePropagation();
  }

  function onKeyUp(e) {
    if (!inside(e.target)) return;
    e.stopImmediatePropagation();
    if (tagOf(e.target) && (e.key === " " || e.key === "Enter")) e.preventDefault();
  }

  // Which of our nodes last had focus, so a re-rendered row gets it back.
  function onFocusIn(e) {
    const node = e.target instanceof Element ? e.target.closest(".ghnt-tag, .ghnt-why") : null;
    focusedKey = node ? node.dataset.ghntKey || null : null;
    sync();
  }
  // A press outside our nodes is the user leaving, decided now: a render that runs
  // before onFocusOut's timer (a slow machine) must not pull focus back.
  function onPointerDown(e) {
    if (!inside(e.target)) focusedKey = null;
  }
  function onFocusOut(e) {
    // A focus that leaves for nowhere is kept only if its node was removed (GitHub
    // replaced the row); a click on empty page space is the user leaving.
    if (e.relatedTarget) focusedKey = null;
    else {
      const key = focusedKey;
      const node = e.target;
      setTimeout(() => {
        if (focusedKey === key && node instanceof Node && node.isConnected) focusedKey = null;
      }, 0);
    }
    setTimeout(sync, 0);
  }
  const onResize = () => relayout();
  const onNavigate = () => closePanel(false);

  const CAPTURE = { capture: true };
  const listeners = [
    ["click", onClick],
    ["dblclick", (e) => inside(e.target) && e.stopImmediatePropagation()],
    ["auxclick", (e) => inside(e.target) && e.stopImmediatePropagation()],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
    ["keypress", (e) => inside(e.target) && e.stopImmediatePropagation()],
    ["pointerdown", onPointerDown],
    ["focusin", onFocusIn],
    ["focusout", onFocusOut],
    ["resize", onResize],
  ];

  function relayout() {
    for (const [key, entry] of lines) {
      const row = C().findRow(document, key);
      const title = titleText(row?.link);
      if (title) {
        const pad = `${indent(row.li, title)}px`;
        if (entry.line.style.paddingLeft !== pad) entry.line.style.paddingLeft = pad;
      }
    }
    if (panel && lastState) {
      const item = lastState.items.find((i) => i.key === panel.key);
      if (item) renderPanel(item, panel.rowLi);
    }
  }

  // --- lifecycle -----------------------------------------------------------

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (lastState) render(lastState);
    }, 150);
  }

  function start(api) {
    stop();
    for (const [type, fn] of listeners) window.addEventListener(type, fn, CAPTURE);
    document.addEventListener("turbo:load", onNavigate);
    window.addEventListener("popstate", onNavigate);
    document.fonts?.addEventListener?.("loadingdone", onResize);
    sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => relayout()) : null;
    unsubscribe = api.subscribe((state) => render(state));
    render(api.getState());
    // GitHub re-renders rows (filters, pagination, live updates): put the lines back.
    observer = new MutationObserver((records) => {
      // Our own changes (a line, the panel, its rebuilt children) are not news; a line
      // or panel we still track that someone else took out of the page is.
      const ours = (n) => n.nodeType !== 1 || (inside(n) && !gone(n));
      if (records.every((r) => inside(r.target) || [...r.addedNodes, ...r.removedNodes].every(ours))) return;
      scheduleRender();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const list = document.querySelector("li.notifications-list-item")?.parentElement;
    if (sizeObserver && list) sizeObserver.observe(list);
  }

  function stop() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, CAPTURE);
    document.removeEventListener("turbo:load", onNavigate);
    window.removeEventListener("popstate", onNavigate);
    document.fonts?.removeEventListener?.("loadingdone", onResize);
    unsubscribe?.();
    unsubscribe = null;
    observer?.disconnect();
    observer = null;
    sizeObserver?.disconnect();
    sizeObserver = null;
    clearTimeout(renderTimer);
    renderTimer = null;
    closePanel(false);
    focusedKey = null;
    for (const key of [...lines.keys()]) removeLine(key);
    for (const li of document.querySelectorAll(".ghnt-hl")) clearHighlight(li);
    lastState = null;
  }

  registry.register({ id: MODULE_ID, label: "Notification reason tags", defaultOn: true, start, stop });
})();
