// features/actions-log-shortcuts/content.js — Actions log shortcuts: a small
// row above the content of a GitHub Actions run or job page with
//
//  - "Copy gh command": copies a ready `gh run view ...` command. No request,
//    no token in the text.
//  - "Open raw log" (job pages only): opens the page's own "View raw logs"
//    link in a new tab, shown only when the background says the user's token
//    can read that repository's Actions logs.
//
//  - "Go to failed step" / "Failed steps: N" (job pages only): brings a failed
//    step's title into view. It reads only the step rows already on the page
//    (no request, no token, nothing stored) and lives in GitHub's sticky job
//    header when it fits there without changing GitHub's text, otherwise at the
//    bottom right edge of the window.
//
// The extension never reads log content. Pure rules live in model.js
// (globalThis.GHALS_MODEL). A missing anchor means no row: the next scan
// retries, there is no fallback container.

(function () {
  const M = globalThis.GHALS_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghalsEnabled";
  const FIRST_PAINT_MS = 1500;
  const SCAN_MS = 250;
  const STATE_TTL_MS = 60_000;

  let enabled = true;
  let scanTimer = null;
  const known = new Map(); // owner/repo -> { state, at }: what detection last said, for the first paint
  const live = new WeakSet(); // rows and failed-step controls this script built: a Turbo snapshot clone has the markup but no listeners
  let observer = null;
  let resizeWatch = null;
  let watched = null;
  let fs = null; // the failed-step control: { root, btn, list, status, path, key, steps, sig, place, count }
  const asked = new Set(); // `${path}|${owner/repo}` already asked on this page view

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // --- reading the page -------------------------------------------------

  function anchorFor(route) {
    if (route.kind === "job") {
      const logs = document.getElementById("logs");
      const column = logs && /CheckRun/.test(logs.className) ? logs.parentElement : null;
      return column ? { parent: column, before: column.firstElementChild } : null;
    }
    const card = document.querySelector(".actions-workflow-stats");
    return card && card.parentElement ? { parent: card.parentElement, before: card } : null;
  }

  function jobStatus() {
    const header = document.querySelector(".CheckRun-header");
    if (!header) return "unknown";
    const line = header.querySelector("span.js-updatable-content") || header.querySelector("span.d-block.f6") || header.querySelector(".CheckRun-log-title > span:last-child");
    return M.readJobStatus(line ? line.textContent : "");
  }

  function runStatus() {
    const icon = document.querySelector('[class*="actions-workflow-runs-status"] [aria-label]');
    let value = "";
    const card = document.querySelector(".actions-workflow-stats");
    if (card) {
      for (const n of card.querySelectorAll("span, div, dt, h4")) {
        if (n.children.length === 0 && n.textContent.trim() === "Status") {
          const sib = n.nextElementSibling || (n.parentElement && n.parentElement.nextElementSibling);
          if (sib) value = sib.textContent;
          break;
        }
      }
    }
    return M.readRunStatus(icon ? icon.getAttribute("aria-label") : "", value);
  }

  function attemptLinks() {
    return [...document.querySelectorAll("nav a")].map((a) => ({
      text: a.textContent,
      href: a.getAttribute("href") || "",
      hidden: !!a.closest('[role="menu"], #attempt-navigation-list, [hidden]'),
    }));
  }

  function rawLink(route) {
    const re = new RegExp(`/${route.owner}/${route.repo}/commit/[0-9a-f]{7,40}/checks/${route.job}/logs$`, "i");
    for (const a of document.querySelectorAll('a[href*="/checks/"][href$="/logs"], a.js-steps-dropdown-raw-logs')) {
      let path = "";
      try {
        path = new URL(a.getAttribute("href") || "", location.origin).pathname;
      } catch {
        continue;
      }
      if (re.test(path)) return a;
    }
    return null;
  }

  // --- the row ----------------------------------------------------------

  function currentRow() {
    return document.querySelector(".ghals-row");
  }

  // Run page, narrow layout: the row's left edge follows the first glyph of
  // the Summary card, measured, so no inset is hardcoded.
  function fitRun(row) {
    if (!row || !row.classList.contains("ghals-run")) return;
    row.style.removeProperty("padding-left");
    if (window.innerWidth > 768) return;
    const card = document.querySelector(".actions-workflow-stats");
    if (!card) return;
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const t = w.nextNode();
    if (!t) return;
    const rg = document.createRange();
    rg.selectNodeContents(t);
    const glyph = rg.getBoundingClientRect();
    if (!glyph.width) return;
    row.style.paddingLeft = "0px";
    const inset = glyph.left - row.getBoundingClientRect().left;
    row.style.paddingLeft = `${Math.max(0, Math.round(inset * 10) / 10)}px`;
  }

  function removeRow() {
    for (const r of document.querySelectorAll(".ghals-row")) r.remove();
  }

  function newRow(route, path, anchor) {
    const row = el("div", `ghals-row ghals-${route.kind}`);
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Log shortcuts");
    row.dataset.path = path;
    row.dataset.painted = "no";
    // The live region exists, empty, before any click: a region created and
    // filled in the same tick is often not announced by screen readers.
    const box = el("span", "ghals-msg");
    box.setAttribute("role", "status");
    row.appendChild(box);
    live.add(row);
    anchor.parent.insertBefore(row, anchor.before);
    return row;
  }

  function button(label, onClick) {
    const b = el("button", "ghals-btn", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  const OK_MESSAGE_MS = 3000;
  const sayTimers = new WeakMap();

  function say(row, text, kind, command) {
    const box = row.querySelector(".ghals-msg");
    if (!box) return;
    clearTimeout(sayTimers.get(row));
    box.className = `ghals-msg ${kind || ""}`;
    box.textContent = text;
    if (kind === "ok") sayTimers.set(row, setTimeout(() => say(row, ""), OK_MESSAGE_MS));
    row.querySelector(".ghals-cmd")?.remove();
    if (command) {
      const input = el("input", "ghals-cmd");
      input.type = "text";
      input.readOnly = true;
      input.value = command;
      input.setAttribute("aria-label", "gh command");
      row.appendChild(input);
      input.focus();
      input.select();
    }
  }

  function commandNow(route) {
    const status = route.kind === "job" ? jobStatus() : runStatus();
    return M.buildCommand(route, M.flagFor(status), M.readAttempt(attemptLinks(), route));
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = el("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function paint(row, route, withOpen) {
    row.dataset.painted = "yes";
    row.querySelector(".ghals-copy, .ghals-open")?.remove();
    for (const b of row.querySelectorAll(":scope > .ghals-btn")) b.remove();
    const copyBtn = button("Copy gh command", async () => {
      const cmd = commandNow(route);
      if (await copy(cmd)) say(row, "Copied", "ok");
      else say(row, "Copy failed", "err", cmd);
    });
    copyBtn.classList.add("ghals-copy");
    const own = row.querySelector(":scope > .ghals-fs");
    row.insertBefore(copyBtn, own ? own.nextSibling : row.firstChild);
    if (withOpen) {
      const openBtn = button("Open raw log", async () => {
        const link = rawLink(route);
        const res = link ? await send("GHALS_OPEN", { href: link.getAttribute("href"), path: route.path }) : null;
        if (res && res.state) known.set(`${route.owner}/${route.repo}`.toLowerCase(), { state: res.state, at: Date.now() });
        if (!res || !res.opened) say(row, "Could not open log", "err");
        else say(row, "");
      });
      openBtn.classList.add("ghals-open");
      row.insertBefore(openBtn, copyBtn.nextSibling);
    }
  }

  function clearButtons(row) {
    for (const b of row.querySelectorAll(":scope > .ghals-btn")) b.remove();
    row.dataset.painted = "no";
  }


  // --- Go to failed step / Failed steps: N ----------------------------------

  const logsRoot = () => document.getElementById("logs");
  const titleOf = (step) => step.querySelector(":scope > details > summary");

  function stepName(step, summary) {
    const named = step.getAttribute("data-name");
    if (named && named.trim()) return named;
    const t = summary && summary.querySelector('[class*="CheckStep-titleName"]');
    return t ? t.textContent : "";
  }

  // Steps the page shows as failed whose own title control can be found.
  function readFailed() {
    const root = logsRoot();
    if (!root) return [];
    const items = [];
    for (const step of root.querySelectorAll('check-step[data-conclusion="failure"]')) {
      const summary = titleOf(step);
      if (!summary) continue;
      items.push({ number: step.getAttribute("data-number") || "", name: stepName(step, summary), conclusion: "failure" });
    }
    return M.failedSteps(items);
  }

  function stepByNumber(number) {
    const root = logsRoot();
    if (!root) return null;
    for (const step of root.querySelectorAll('check-step[data-conclusion="failure"]')) {
      if ((step.getAttribute("data-number") || "") === number) return step;
    }
    return null;
  }

  // GitHub's sticky job header and its parts, found by the stable middle of
  // the class names (a hashed `Name__x` suffix or a `uxr_` prefix both match).
  function findHeader() {
    const root = logsRoot();
    const h = root && root.querySelector('[class*="CheckRun-header"]');
    if (!h) return null;
    const pos = getComputedStyle(h).position;
    return pos === "sticky" || pos === "fixed" ? h : null;
  }

  function visibleOf(list) {
    for (const n of list) if (n && n.getClientRects().length) return n;
    return null;
  }

  function headerParts(h) {
    const title = h.querySelector('[class*="CheckRun-log-title"]');
    if (!title || title.parentElement !== h) return null;
    // The whole name element (the h4 holds the workflow, a slash and the job in separate clipped spans), never its first span.
    const name = visibleOf([...title.querySelectorAll("#check-step-header-title, h4")]);
    const sub = title.querySelector("span.js-updatable-content") || title.querySelector("span.d-block.f6") || title.querySelector(".f6");
    if (!name || !sub) return null;
    // GitHub's search block follows the title; our own control may sit between them.
    let search = title.nextElementSibling;
    while (search && search.classList.contains("ghals-fs")) search = search.nextElementSibling;
    return { h, title, name, sub, search };
  }

  // The boxes inside `clip` that clip `n`'s content: every ancestor up to `top` that hides
  // overflow (the h4's css-truncate spans, the two-line clamp), and `top` itself sideways.
  function clipBoxes(n, top, clip) {
    const out = [{ left: clip.left, right: clip.right, top: -Infinity, bottom: Infinity }];
    for (let a = n; a && a !== top; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      out.push({ left: b.left, right: b.right, top: b.top, bottom: b.bottom });
    }
    return out;
  }

  // The visible boxes of the text under `node`, one per text node line, cut by every
  // box that clips it, so a name GitHub truncates with an ellipsis counts only as far as
  // it is drawn. An element that draws its words in a shadow root (<relative-time>)
  // counts by its own box.
  function textRects(node, clip) {
    const out = [];
    const add = (q, from) => {
      if (!q.width || !q.height) return;
      let left = q.left;
      let right = q.right;
      let top = q.top;
      let bottom = q.bottom;
      for (const b of clipBoxes(from, node.closest('[class*="CheckRun-log-title"]'), clip)) {
        left = Math.max(left, b.left);
        right = Math.min(right, b.right);
        top = Math.max(top, b.top);
        bottom = Math.min(bottom, b.bottom);
      }
      if (right > left && bottom > top) out.push({ left, right, top, bottom });
    };
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = node; n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if (!n.nodeValue.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const q of r.getClientRects()) add(q, n.parentElement);
      } else if (n.shadowRoot) {
        for (const q of n.getClientRects()) add(q, n);
      }
    }
    return out;
  }

  const lineCount = (rects) => {
    const tops = [];
    for (const q of rects) if (!tops.some((t) => Math.abs(t - q.top) < 2)) tops.push(q.top);
    return tops.length;
  };

  const overflowOf = (from, to) => {
    const out = [];
    for (let n = from; n; n = n.parentElement) {
      out.push(n.scrollWidth - n.clientWidth, n.scrollHeight - n.clientHeight);
      if (n === to) break;
    }
    return out;
  };

  // Everything the fit test compares, read from the page as it is now.
  function measure(parts, ctrl) {
    const hr = parts.h.getBoundingClientRect();
    const tr = parts.title.getBoundingClientRect();
    const nameRects = textRects(parts.name, tr);
    const subRects = textRects(parts.sub, tr);
    const c = ctrl && ctrl.getBoundingClientRect();
    return {
      header: { top: hr.top, bottom: hr.bottom, height: hr.height, covered: hr.height + (parseFloat(getComputedStyle(parts.h).marginBottom) || 0) },
      lines: [lineCount(nameRects), lineCount(subRects)],
      overflow: [...overflowOf(parts.name, parts.title), ...overflowOf(parts.sub, parts.title)],
      texts: [...nameRects, ...subRects],
      subRects,
      ctrl: c ? { left: c.left, top: c.top, right: c.right, bottom: c.bottom } : null,
      win: { w: document.documentElement.clientWidth, h: window.innerHeight },
    };
  }

  function buildFs(route) {
    const root = el("div", "ghals-fs");
    const btn = el("button", "ghals-btn ghals-fs-btn");
    btn.type = "button";
    const list = el("div", "ghals-fs-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const status = el("span", "ghals-fs-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    root.append(btn, list, status);
    live.add(root);
    const c = { root, btn, list, status, path: route.path, key: "", steps: [], sig: "", place: "", count: 0 };
    btn.addEventListener("click", () => {
      if (c.steps.length === 1) return land(c, c.steps[0]);
      if (c.list.hidden) openList(c, "first");
      else closeList(c, true);
    });
    btn.addEventListener("keydown", (e) => {
      if (c.steps.length > 1 && e.key === "ArrowDown") {
        e.preventDefault();
        openList(c, "first");
      } else if (c.steps.length > 1 && e.key === "ArrowUp") {
        e.preventDefault();
        openList(c, "last");
      }
    });
    list.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      const go = (i) => {
        e.preventDefault();
        e.stopPropagation();
        items[(i + items.length) % items.length]?.focus();
      };
      if (e.key === "ArrowDown") go(at + 1);
      else if (e.key === "ArrowUp") go(at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(items.length - 1);
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeList(c, true);
      } else if (e.key === "Tab") closeList(c, false);
    });
    return c;
  }

  function setLabel(c, short) {
    const n = c.steps.length;
    const text = M.labelFor(n, short);
    if (c.btn.textContent !== text) c.btn.textContent = text;
    c.btn.setAttribute("aria-label", M.fullLabel(n));
    if (n > 1) {
      c.btn.setAttribute("aria-haspopup", "menu");
      c.btn.setAttribute("aria-expanded", c.list.hidden ? "false" : "true");
      c.btn.classList.add("ghals-fs-menu");
    } else {
      c.btn.removeAttribute("aria-haspopup");
      c.btn.removeAttribute("aria-expanded");
      c.btn.classList.remove("ghals-fs-menu");
    }
  }

  function fillList(c) {
    const hadFocus = c.list.contains(document.activeElement);
    c.list.textContent = "";
    for (const st of c.steps) {
      const item = el("button", "ghals-fs-item", st.name);
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.dataset.number = st.number;
      item.tabIndex = -1;
      item.addEventListener("click", () => {
        closeList(c, false);
        land(c, st);
      });
      c.list.appendChild(item);
    }
    if (hadFocus) c.list.querySelector('[role="menuitem"]')?.focus();
  }

  function positionList(c) {
    if (c.list.hidden) return;
    const b = c.btn.getBoundingClientRect();
    const w = document.documentElement.clientWidth;
    // The list ends at its button's right edge (never past the window's): anchored with
    // `right`, so its width is what its text needs inside that edge, not what fitted
    // at its previous position.
    const edge = Math.max(168, Math.min(b.right, w - 8));
    c.list.style.left = "auto";
    c.list.style.right = `${w - edge}px`;
    c.list.style.maxWidth = `${edge - 8}px`;
    if (c.place === "edge") {
      c.list.style.top = "auto";
      c.list.style.bottom = `${window.innerHeight - b.top + 4}px`;
      c.list.style.maxHeight = `${Math.max(80, b.top - 12)}px`;
    } else {
      c.list.style.bottom = "auto";
      c.list.style.top = `${b.bottom + 4}px`;
      c.list.style.maxHeight = `${Math.max(80, window.innerHeight - b.bottom - 12)}px`;
    }
  }

  function outsideClose(e) {
    if (fs && !fs.list.hidden && !fs.root.contains(e.target)) closeList(fs, false);
  }

  function openList(c, which) {
    c.list.hidden = false;
    c.btn.setAttribute("aria-expanded", "true");
    positionList(c);
    const items = c.list.querySelectorAll('[role="menuitem"]');
    (which === "last" ? items[items.length - 1] : items[0])?.focus();
    document.addEventListener("pointerdown", outsideClose, true);
    window.addEventListener("scroll", followScroll, true);
  }

  // The list is fixed: it follows its button while the page scrolls.
  function followScroll() {
    if (fs && !fs.list.hidden) positionList(fs);
  }

  function closeList(c, refocus) {
    if (c.list.hidden) return;
    c.list.hidden = true;
    c.btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outsideClose, true);
    window.removeEventListener("scroll", followScroll, true);
    if (refocus) c.btn.focus();
  }

  // Brings a failed step's title below GitHub's sticky bars. The target is the
  // element (found again by its number), never a stored position, because the
  // layout moves while a long log renders; a few frames correct the drift.
  function covered(summary) {
    const cs = getComputedStyle(summary);
    const top = parseFloat(cs.top);
    if (cs.position === "sticky" && Number.isFinite(top)) return top;
    const h = findHeader();
    return h ? h.getBoundingClientRect().height + (parseFloat(getComputedStyle(h).marginBottom) || 0) : 0;
  }

  function land(c, st) {
    const first = stepByNumber(st.number);
    const summary = first && titleOf(first);
    if (!summary) return;
    let frames = 0;
    const adjust = () => {
      const now = stepByNumber(st.number);
      const sum = now && titleOf(now);
      if (!sum) return;
      const d = M.landingDelta(sum.getBoundingClientRect().top, covered(sum));
      if (M.needsScroll(d)) window.scrollBy({ top: d, left: 0, behavior: "instant" });
      if (++frames < 4) requestAnimationFrame(adjust);
    };
    adjust();
    try {
      summary.focus({ preventScroll: true });
    } catch {
      // handled below
    }
    if (document.activeElement !== summary) {
      c.status.textContent = "";
      setTimeout(() => (c.status.textContent = `Moved to failed step: ${st.name}`), 0);
    }
  }

  function detach(c) {
    closeList(c, false);
    c.root.remove();
  }

  // Put the control in a place and report whether GitHub's header survived it.
  function tryPlace(c, parts, base, p) {
    setLabel(c, p.short);
    c.root.className = `ghals-fs ghals-fs-${p.id}`;
    c.root.style.cssText = "";
    if (p.id === "name") {
      parts.h.insertBefore(c.root, parts.search);
    } else if (p.id === "subtitle") {
      parts.h.appendChild(c.root);
      const hr = parts.h.getBoundingClientRect();
      const cs = getComputedStyle(parts.h);
      const subRects = textRects(parts.sub, parts.title.getBoundingClientRect());
      const line = subRects[subRects.length - 1];
      if (!line) return false;
      const edge = parts.search ? parts.search.getBoundingClientRect().left : hr.right - (parseFloat(cs.paddingRight) || 0);
      const right = parts.search ? edge - 8 : edge;
      const w = c.root.getBoundingClientRect().width;
      const h = c.root.getBoundingClientRect().height;
      c.root.style.left = `${right - w - hr.left - (parseFloat(cs.borderLeftWidth) || 0)}px`;
      c.root.style.top = `${(line.top + line.bottom) / 2 - h / 2 - hr.top - (parseFloat(cs.borderTopWidth) || 0)}px`;
    } else {
      document.body.appendChild(c.root);
    }
    return M.fits(base, measure(parts, c.root), p.id).ok;
  }

  function placeIn(c, parts) {
    // Moving the control detaches it, which would drop keyboard focus to <body>.
    const a = document.activeElement;
    const focused = a && c.root.contains(a) ? (a === c.btn ? "btn" : a.dataset && a.dataset.number) : null;
    placeNow(c, parts);
    if (focused && c.root.isConnected && !c.root.contains(document.activeElement)) {
      const target = focused === "btn" ? c.btn : c.list.querySelector(`[data-number="${focused}"]`) || c.list.querySelector('[role="menuitem"]') || c.btn;
      try {
        target.focus({ preventScroll: true });
      } catch {
        // focus is a convenience here
      }
    }
  }

  function placeNow(c, parts) {
    c.root.remove();
    const base = measure(parts, null);
    for (const p of M.PLACES) {
      if (tryPlace(c, parts, base, p)) {
        c.place = p.id === "edge" ? "edge" : p.short ? `${p.id}-short` : p.id;
        c.root.dataset.place = c.place;
        return;
      }
      c.root.remove();
    }
  }

  function removeFs() {
    for (const n of document.querySelectorAll(".ghals-fs")) n.remove();
    document.removeEventListener("pointerdown", outsideClose, true);
    window.removeEventListener("scroll", followScroll, true);
    if (resizeWatch && watched) resizeWatch.disconnect();
    watched = null;
    fs = null;
  }

  function signature(c, parts, route) {
    const hr = parts.h.getBoundingClientRect();
    return [route.path, document.documentElement.clientWidth, Math.round(hr.width), squash(parts.name.textContent), squash(parts.sub.textContent), textWidth(parts.name), textWidth(parts.sub), parts.search ? Math.round(parts.search.getBoundingClientRect().width) : "x", c.key].join("|");
  }

  // The width GitHub's text takes. A <relative-time> draws its words in a shadow
  // root: its textContent and no observer change, but its width does.
  function textWidth(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of r.getClientRects()) {
      if (!q.width) continue;
      lo = Math.min(lo, q.left);
      hi = Math.max(hi, q.right);
    }
    return hi > lo ? Math.round(hi - lo) : 0;
  }

  const squash = (t) => String(t || "").replace(/\s+/g, " ").trim();

  function scanFailed(route, row) {
    if (route.kind !== "job") return removeFs();
    const steps = readFailed();
    if (!steps.length) return removeFs();
    for (const n of document.querySelectorAll(".ghals-fs")) if (!fs || n !== fs.root || !live.has(n)) n.remove();
    if (fs && (fs.path !== route.path || !live.has(fs.root))) removeFs();
    if (!fs) fs = buildFs(route);
    const c = fs;
    const key = M.stepKey(steps);
    const changed = key !== c.key;
    if (changed) {
      c.key = key;
      c.steps = steps;
      fillList(c);
      if (steps.length < 2) closeList(c, false);
    }
    const header = findHeader();
    const parts = header && headerParts(header);
    if (!header) {
      // The sticky header is not there: the start of the shortcut row, in flow.
      if (!row) return removeFs();
      if (c.place !== "row" || c.root.parentElement !== row) {
        closeList(c, false);
        setLabel(c, false);
        c.root.className = "ghals-fs ghals-fs-row";
        c.root.style.cssText = "";
        row.insertBefore(c.root, row.firstChild);
        c.place = "row";
        c.root.dataset.place = "row";
        c.sig = "";
      } else if (changed) setLabel(c, false);
      observer && observer.takeRecords();
      return;
    }
    if (!parts) {
      // Header found but unreadable: the bottom edge never depends on it.
      if (c.place !== "edge" || !c.root.isConnected || changed) {
        setLabel(c, false);
        c.root.className = "ghals-fs ghals-fs-edge";
        c.root.style.cssText = "";
        document.body.appendChild(c.root);
        c.place = "edge";
        c.root.dataset.place = "edge";
      }
      observer && observer.takeRecords();
      return;
    }
    watch(header);
    const sig = signature(c, parts, route);
    if (c.sig === sig && c.root.isConnected && !changed) return;
    const was = c.place;
    placeIn(c, parts);
    c.sig = signature(c, parts, route);
    if (was !== c.place) closeList(c, false);
    positionList(c);
    observer && observer.takeRecords();
  }

  function watch(header) {
    if (watched === header || typeof ResizeObserver === "undefined") return;
    if (!resizeWatch) resizeWatch = new ResizeObserver(queue);
    resizeWatch.disconnect();
    resizeWatch.observe(header);
    watched = header;
  }

  // --- scanning ---------------------------------------------------------

  function scan() {
    if (!extensionAlive()) return;
    const path = location.pathname;
    const route = enabled ? M.parseRoute(path) : null;
    if (route) route.path = path;
    if (!route) {
      removeRow();
      removeFs();
      return;
    }
    const anchor = anchorFor(route);
    if (!anchor) {
      removeRow();
      scanFailed(route, null);
      return;
    }

    let row = currentRow();
    if (row && (row.dataset.path !== path || row.parentElement !== anchor.parent || !live.has(row))) {
      removeRow();
      row = null;
    }
    if (!row) row = newRow(route, path, anchor);
    fitRun(row);
    scanFailed(route, row);

    const status = route.kind === "job" ? jobStatus() : runStatus();
    if (!M.showCopy(status)) {
      if (row.dataset.painted === "yes") clearButtons(row);
      return;
    }
    if (row.dataset.painted === "yes") return;

    if (route.kind !== "job") return paint(row, route, false);

    const key = `${route.owner}/${route.repo}`.toLowerCase();
    const link = rawLink(route);
    const askKey = `${path}|${key}`;
    const cached = known.get(key);
    const fresh = cached && Date.now() - cached.at < STATE_TTL_MS;
    if (!fresh) asked.delete(askKey); // a stale answer must be asked again
    const ask = () => {
      asked.add(askKey);
      return send("GHALS_DETECT", { path }).then((res) => {
        if (res && res.state) known.set(key, { state: res.state, at: Date.now() });
        return res;
      });
    };
    if (fresh) {
      if (!asked.has(askKey)) asked.add(askKey);
      return paint(row, route, !!link && cached.state === "ok");
    }
    if (!link) {
      if (!asked.has(askKey)) ask();
      return paint(row, route, false);
    }
    if (row.dataset.pending === "yes") return;
    row.dataset.pending = "yes";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!row.isConnected || row.dataset.path !== path) return;
      const k = known.get(key);
      paint(row, route, !!rawLink(route) && !!k && k.state === "ok" && Date.now() - k.at < STATE_TTL_MS);
    };
    setTimeout(finish, FIRST_PAINT_MS);
    (asked.has(askKey) ? Promise.resolve() : ask()).then(finish);
  }

  function queue() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_MS);
  }

  function start() {
    try {
      chrome.storage.local.get({ [KEY_ENABLED]: true }, (o) => {
        enabled = o[KEY_ENABLED] !== false;
        scan();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY_ENABLED]) {
          enabled = changes[KEY_ENABLED].newValue !== false;
          scan();
        }
        if (changes.githubTokens || changes.defaultTokenId) {
          known.clear();
          asked.clear();
        }
      });
    } catch {
      return;
    }
    for (const ev of ["turbo:render", "turbo:load", "pjax:end", "popstate"]) document.addEventListener(ev, queue);
    window.addEventListener("popstate", queue);
    window.addEventListener("resize", queue);
    observer = new MutationObserver(queue);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-conclusion"] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queue);
    // GitHub's own text can change without any DOM event (a relative time ticks in its shadow root): measure again now and then.
    setInterval(() => {
      if (fs && fs.place && fs.place !== "row" && !document.hidden) queue();
    }, 1000);
    // A route change that swaps no DOM (history.pushState alone) fires no mutation: watch the path too.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        queue();
      }
    }, 400);
  }

  start();
})();
