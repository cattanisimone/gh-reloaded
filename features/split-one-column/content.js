// features/split-one-column/content.js — Split diff: one column for one-sided
// files. On a pull request's Files changed, a single commit and a compare page
// in Split, a file whose changed lines are all on one side (only added, or only
// deleted lines) reads like GitHub's Unified for that file only: the empty half
// and the duplicate context cells are hidden by CSS, nothing is moved, removed
// or re-created. A small per-file button in the file header gives GitHub's
// Split back. The extension makes no request, reads no token and stores only
// the on/off switch; the per-file choice lives in memory.
//
// The rules (model.js): 1 already one column → untouched; 2 an anchor is
// missing → untouched; 3 both sides changed → untouched; 4 content on the side to
// hide (a review thread, a form) → Split; 5 otherwise one column. Every table
// keeps one small record per row, so a later change (a thread mounted, a row
// added, a late "Load diff") updates one row and re-decides in O(1); a full pass
// over the rows runs only when the table is first seen or its structure changes.

(function () {
  const M = globalThis.GHSOC_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghsocEnabled";
  const TABLE_SEL = 'table[aria-label^="Diff for"], table.diff-table';
  const CONTAINER_SEL = '[role="region"][aria-labelledby], [data-tagsearch-path]';
  const TRACKED = "table[data-ghsoc-reason]";
  const FORM = "textarea, input, [contenteditable]";
  const SVG_NS = "http://www.w3.org/2000/svg";

  let enabled = true;
  let observer = null;
  let pending = [];
  let needScan = false;
  let flushTimer = null;
  let flushRaf = 0;
  let lastPath = location.pathname;
  const states = new Map(); // table → state (a Map so a disabled feature can revert every table)
  const byContainer = new WeakMap(); // file container → state
  let choices = new Map(); // "pathname|file" → true when the user chose Split for that file

  /* state: { table, container, rows: WeakMap<tr, contribution>, sum, info, decision, userSplit,
              control, anchorName, mode, key } */

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function measure(name, t0) {
    try {
      performance.measure(name, { start: t0, end: performance.now() });
    } catch {
      /* no timeline: nothing to report */
    }
  }

  // --- reading the page ---------------------------------------------------

  function readCell(td) {
    const cls = typeof td.className === "string" ? td.className : "";
    const kind = M.cellKind({ cls, dcell: td.getAttribute("data-diff-cell") });
    const cell = { kind, span: td.colSpan || 1, change: null, text: "", foreign: false };
    if (kind === "text") {
      const inner = td.querySelector("[data-diff-text-inner], .diff-text-inner, .blob-code-inner");
      const code = inner ? inner.closest("code") : null;
      cell.text = squash(inner ? inner.textContent : "");
      if (td.querySelector(".no-nl-marker, [aria-label^='No newline']")) cell.text += "\u0001nonl";
      const marker = td.querySelector("[data-code-marker], [data-diff-text-marker], .diff-text-marker");
      cell.change = M.changeOf({
        type: code && code.getAttribute("data-diff-type"),
        cls: cls + " " + (code && typeof code.className === "string" ? code.className : ""),
        marker: marker && (marker.getAttribute("data-code-marker") || marker.textContent),
      });
      // anything but the line's own text and its +/- marker is content (a thread nested in the code too)
      const markerText = marker && marker.textContent ? marker.textContent : "";
      const rest = inner ? td.textContent.replace(inner.textContent, "").replace(markerText, "") : td.textContent;
      cell.foreign = !!td.querySelector(FORM) || squash(rest) !== "";
    } else if (kind === "empty") {
      cell.foreign = !!td.querySelector(FORM) || squash(td.textContent) !== "";
    } else if (kind === "number") {
      cell.foreign = !!td.querySelector(FORM);
    }
    return cell;
  }

  function readRow(tr) {
    const tds = tr.children;
    if (tr.classList.contains("inline-comments")) {
      return {
        inline: true,
        cells: [...tds].map((td) => ({
          span: td.colSpan || 1,
          content: !!td.querySelector(FORM) || squash(td.textContent) !== "" || !!td.querySelector("img, svg, details, form"),
        })),
      };
    }
    const cells = [];
    for (let i = 0; i < tds.length; i++) cells.push(readCell(tds[i]));
    return { cells };
  }

  function rowsOf(table) {
    return table.querySelectorAll(":scope > tbody > tr, :scope > tr");
  }

  function declaredCols(table) {
    const n = table.querySelectorAll(":scope > colgroup > col").length;
    if (n) return n;
    let max = 0;
    let i = 0;
    for (const tr of rowsOf(table)) {
      let s = 0;
      for (const td of tr.children) s += td.colSpan || 1;
      max = Math.max(max, s);
      if (++i > 20) break;
    }
    return max;
  }

  // How many cells of the first four-cell line row are actually displayed (another extension
  // may have hidden one). One layout read, only on a full pass, and never while we hide cells.
  function renderedCols(table) {
    for (const tr of rowsOf(table)) {
      if (tr.children.length === 4) {
        let n = 0;
        for (const td of tr.children) if (getComputedStyle(td).display !== "none") n++;
        return n;
      }
    }
    return 4;
  }

  // --- the file header: container, anchor, control --------------------------

  function containerOf(table) {
    let el = table.parentElement;
    while (el) {
      if (el.matches(CONTAINER_SEL)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function nameOf(btn) {
    const label = btn.getAttribute("aria-label");
    if (label) return squash(label);
    const ids = (btn.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return squash(ids.map((id) => (document.getElementById(id) || {}).textContent || "").join(" "));
  }

  // The first anchor present in the header, in order: Viewed, More options, the … menu. By role,
  // ARIA name and visible text, never a class. The control goes right before it.
  function findAnchor(state) {
    const { container, table } = state;
    if (!container) return null;
    const heads = [...container.children].filter((c) => !c.contains(table) && c !== state.control);
    for (const h of heads) {
      for (const b of h.querySelectorAll("button[aria-label]")) {
        if (/^(not )?viewed$/i.test(squash(b.getAttribute("aria-label")))) return { el: b, name: "viewed" };
      }
    }
    for (const h of heads) {
      for (const b of h.querySelectorAll('button[aria-haspopup="true"]')) {
        if (/^more options$/i.test(nameOf(b))) return { el: b, name: "more-options" };
      }
    }
    for (const h of heads) {
      for (const d of h.querySelectorAll("details")) {
        if (!d.querySelector(':scope > summary[aria-haspopup="menu"]')) continue;
        const item = [...d.querySelectorAll('[role="menuitem"]')].find((i) => /^view file$/i.test(squash(i.textContent)));
        if (item) return { el: d, name: "file-menu" };
      }
    }
    return null;
  }

  function icon(kind) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ghsoc-ico");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      kind === "columns"
        ? "M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2ZM1.5 3.75v8.5c0 .138.112.25.25.25h5.5v-9h-5.5a.25.25 0 0 0-.25.25Zm7.25-.25v9h5.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25Z"
        : "M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2ZM1.5 3.75v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z"
    );
    svg.appendChild(path);
    return svg;
  }

  function newControl(state) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghsoc-btn";
    b.setAttribute("data-ghsoc-control", "");
    const lbl = document.createElement("span");
    lbl.className = "ghsoc-lbl";
    b.append(icon("columns"), lbl);
    b.addEventListener("click", () => onToggle(state));
    return b;
  }

  function paintControl(state) {
    const b = state.control;
    const split = state.userSplit;
    const text = split ? M.LABEL.one : M.LABEL.split;
    const lbl = b.querySelector(".ghsoc-lbl");
    if (lbl.textContent !== text) lbl.textContent = text;
    if (b.getAttribute("aria-label") !== text) b.setAttribute("aria-label", text);
    const d = split ? M.DESC.split : M.DESC.one;
    if (b.getAttribute("aria-description") !== d) b.setAttribute("aria-description", d);
    const st = split ? "split" : "one";
    if (b.getAttribute("data-ghsoc-state") !== st) {
      b.replaceChild(icon(split ? "rows" : "columns"), b.querySelector(".ghsoc-ico"));
      b.setAttribute("data-ghsoc-state", st);
    }
  }

  // Exactly one control per file, the previous element sibling of the anchor. Returns false when
  // there is no anchor (the caller then reverts: one column is never left without a way back).
  function ensureControl(state, anchor) {
    if (!state.control) state.control = newControl(state);
    const c = state.control;
    const ok = c.isConnected && c.nextElementSibling === anchor.el && c.getAttribute("data-ghsoc-anchor") === anchor.name;
    if (!ok) {
      for (const stray of state.container.querySelectorAll("[data-ghsoc-control]")) if (stray !== c) stray.remove();
      anchor.el.before(c);
      c.setAttribute("data-ghsoc-anchor", anchor.name);
    }
    paintControl(state);
  }

  function removeControl(state) {
    if (state.control) state.control.remove();
    if (state.container) for (const stray of state.container.querySelectorAll("[data-ghsoc-control]")) stray.remove();
  }

  // --- hiding: only attributes, never nodes -----------------------------------

  const HIDE = { additions: [1], deletions: [2, 3] };

  function applyRow(tr, hidden) {
    const tds = tr.children;
    if (tds.length === 4 && !tr.classList.contains("inline-comments")) return; // CSS hides these by position
    let at = 0;
    for (const td of tds) {
      const span = td.colSpan || 1;
      let overlap = 0;
      for (let c = at; c < at + span; c++) if (hidden.includes(c)) overlap++;
      at += span;
      if (!overlap) continue;
      if (overlap >= span) td.setAttribute("data-ghsoc-hidden", "");
      else if (!td.hasAttribute("data-ghsoc-colspan")) {
        td.setAttribute("data-ghsoc-colspan", String(span));
        td.colSpan = span - overlap;
      }
    }
  }

  function applyTable(state, mode) {
    const t = state.table;
    const hidden = HIDE[mode];
    t.setAttribute("data-ghsoc", mode);
    for (const tr of rowsOf(t)) applyRow(tr, hidden);
    state.mode = mode;
  }

  function revertTable(state) {
    const t = state.table;
    if (t.hasAttribute("data-ghsoc")) t.removeAttribute("data-ghsoc");
    if (state.mode || t.querySelector("[data-ghsoc-colspan], [data-ghsoc-hidden]")) {
      for (const td of t.querySelectorAll("[data-ghsoc-colspan]")) {
        td.colSpan = Number(td.getAttribute("data-ghsoc-colspan")) || 1;
        td.removeAttribute("data-ghsoc-colspan");
      }
      for (const td of t.querySelectorAll("[data-ghsoc-hidden]")) td.removeAttribute("data-ghsoc-hidden");
    }
    state.mode = null;
  }

  // --- deciding and applying -------------------------------------------------

  function fileKey(table) {
    const c = containerOf(table);
    const path = (c && c.getAttribute("data-tagsearch-path")) || table.getAttribute("aria-label") || "";
    return location.pathname + "|" + path;
  }

  function decideAndApply(state) {
    const anchor = findAnchor(state);
    state.info.hasHeader = !!anchor;
    const d = M.decide(state.info, state.sum);
    state.decision = d;
    state.table.setAttribute("data-ghsoc-reason", d.reason);
    if (d.outcome !== "one-column") {
      revertTable(state);
      removeControl(state);
      return;
    }
    ensureControl(state, anchor);
    if (state.userSplit) revertTable(state);
    else {
      const mode = d.hide === "left" ? "additions" : "deletions";
      if (state.mode !== mode) {
        revertTable(state);
        applyTable(state, mode);
      }
    }
  }

  function fullPass(table) {
    const t0 = performance.now();
    let state = states.get(table);
    if (!state) {
      state = { table, container: containerOf(table), rows: new WeakMap(), sum: M.zero(), info: {}, decision: null, userSplit: false, control: null, mode: null };
      states.set(table, state);
      if (state.container) byContainer.set(state.container, state);
    }
    if (!state.container || !state.container.contains(table)) {
      state.container = containerOf(table);
      if (state.container) byContainer.set(state.container, state);
    }
    state.userSplit = choices.has(fileKey(table));
    revertTable(state); // read the markup as GitHub rendered it, not as we hid it
    state.rows = new WeakMap();
    state.sum = M.zero();
    const declared = declaredCols(table);
    state.info = { declared, rendered: declared === 4 ? renderedCols(table) : declared, hasHeader: false };
    if (declared === 4 && state.info.rendered === 4) {
      for (const tr of rowsOf(table)) {
        const c = M.checkRow(readRow(tr), 4);
        state.rows.set(tr, c);
        M.add(state.sum, c, 1);
      }
    }
    decideAndApply(state);
    measure("ghsoc:full", t0);
  }

  function rowOf(td, table) {
    let el = td;
    while (el) {
      const tr = el.closest("tr");
      if (!tr) return null;
      if (tr.closest("table") === table) return tr;
      el = tr.closest("table").parentElement;
    }
    return null;
  }

  function updateRow(state, tr) {
    const p = tr.parentElement;
    if (!tr.isConnected || !p || (p !== state.table && p.parentElement !== state.table) || p.tagName === "THEAD") return false;
    const old = state.rows.get(tr);
    if (old) M.add(state.sum, old, -1);
    const c = M.checkRow(readRow(tr), 4);
    state.rows.set(tr, c);
    M.add(state.sum, c, 1);
    if (state.mode) applyRow(tr, HIDE[state.mode]);
    return true;
  }

  function dropRow(state, tr) {
    const old = state.rows.get(tr);
    if (old) {
      M.add(state.sum, old, -1);
      state.rows.delete(tr);
    }
  }

  // --- the mutation routing ----------------------------------------------------

  function locate(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return { where: "outside" };
    const table = el.closest(TRACKED);
    if (table) {
      const state = states.get(table);
      if (!state) return { where: "outside" };
      if (el === table) return { where: "table", state };
      const parent = el.parentElement;
      if (parent === table) {
        if (el.tagName === "TBODY") return { where: "tbody", state };
        if (el.tagName === "TR") return { where: "row", state, tr: el };
        if (el.tagName === "COLGROUP") return { where: "table", state };
        return { where: "outside" };
      }
      const cg = el.closest("colgroup");
      if (cg && cg.parentElement === table) return { where: "table", state };
      if (el.tagName === "TR" && parent.parentElement === table) {
        return parent.tagName === "THEAD" ? { where: "outside" } : { where: "row", state, tr: el };
      }
      if (el.tagName === "TBODY" || el.tagName === "THEAD") return { where: "outside" };
      const td = el.closest("td, th");
      const tr = td && rowOf(td, table);
      if (!tr || tr.parentElement.tagName === "THEAD") return { where: "outside" };
      return { where: "cell", state, tr };
    }
    const container = el.closest(CONTAINER_SEL);
    if (container) {
      const state = byContainer.get(container);
      if (state && !(state.control && state.control.contains(el))) return { where: "header", state };
    }
    return { where: "outside" };
  }

  function mayHoldTable(n) {
    return n.nodeType === 1 && (n.matches(TABLE_SEL) || !!n.querySelector(TABLE_SEL));
  }

  function process(records) {
    const groups = new Map(); // state → { full, rows:Set, added:Set, removed:Set, header }
    let scan = false;
    const group = (s) => {
      let g = groups.get(s);
      if (!g) groups.set(s, (g = { full: false, rows: new Set(), added: new Set(), removed: new Set(), header: false }));
      return g;
    };
    for (const r of records) {
      const loc = locate(r.target);
      if (loc.where === "outside") {
        if (r.type === "childList") for (const n of r.addedNodes) if (mayHoldTable(n)) scan = true;
        continue;
      }
      if (loc.where === "header" && r.type === "childList") for (const n of r.addedNodes) if (mayHoldTable(n)) scan = true;
      const g = group(loc.state);
      if (loc.state.info.declared !== 4 || loc.state.info.rendered !== 4) {
        // already one column: only a structural change matters
        if (loc.where === "table") g.full = true;
        else if (loc.where === "tbody" && r.type === "childList") g.full = true;
        continue;
      }
      const rowsOnly =
        r.type === "childList" &&
        [...r.addedNodes, ...r.removedNodes].every((n) => n.nodeType === 3 || (n.nodeType === 1 && n.tagName === "TR"));
      const kind = M.route({
        type: r.type,
        where: loc.where,
        rowsOnly: loc.where === "tbody" && rowsOnly,
        reduced: r.type === "attributes" && r.target.hasAttribute && r.target.hasAttribute("data-ghsoc-colspan"),
      });
      if (kind === "table") g.full = true;
      else if (kind === "header") g.header = true;
      else if (kind === "row") {
        if (loc.tr) g.rows.add(loc.tr);
      } else if (kind === "rows") {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.tagName === "TR") g.added.add(n);
        for (const n of r.removedNodes) if (n.nodeType === 1 && n.tagName === "TR") g.removed.add(n);
      }
    }
    for (const [state, g] of groups) {
      if (!state.table.isConnected) {
        states.delete(state.table);
        continue;
      }
      if (g.full) {
        fullPass(state.table);
        continue;
      }
      const t0 = performance.now();
      for (const tr of g.removed) if (!tr.isConnected) dropRow(state, tr);
      for (const tr of g.added) if (tr.isConnected) updateRow(state, tr);
      if (g.added.size || g.removed.size) {
        decideAndApply(state);
        measure("ghsoc:rows", t0);
      }
      let rowsDone = false;
      for (const tr of g.rows) {
        if (g.added.has(tr)) continue;
        const t2 = performance.now();
        if (updateRow(state, tr)) {
          rowsDone = true;
          measure("ghsoc:row", t2);
        }
      }
      if (rowsDone) decideAndApply(state);
      if (g.header) {
        const t3 = performance.now();
        decideAndApply(state);
        measure("ghsoc:header", t3);
      }
    }
    if (scan) scanTables();
  }

  function flush() {
    flushTimer = null;
    if (flushRaf) cancelAnimationFrame(flushRaf);
    flushRaf = 0;
    if (!extensionAlive() || !enabled || !observer) return;
    // 1) records queued before our writes are part of this batch; 2) process and write;
    // 3) what is queued now was written by us: drop it.
    const recs = pending.concat(observer.takeRecords());
    pending = [];
    if (!M.isRoute(location.pathname)) {
      resetAll();
      return;
    }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      choices = new Map();
    }
    try {
      process(recs);
      if (needScan) {
        needScan = false;
        scanTables();
      }
    } catch (e) {
      console.warn("[GH Reloaded] split one column:", e);
    }
    observer.takeRecords();
  }

  function queue(records) {
    if (records) pending.push(...records);
    else needScan = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 120);
    flushRaf = requestAnimationFrame(flush);
  }

  function scanTables() {
    if (!enabled || !M.isRoute(location.pathname)) return;
    for (const table of document.querySelectorAll(TABLE_SEL)) {
      if (table.hasAttribute("data-ghsoc-reason") && states.has(table)) continue;
      fullPass(table);
    }
    if (observer) observer.takeRecords();
  }

  function resetAll() {
    for (const state of states.values()) {
      revertTable(state);
      removeControl(state);
      state.table.removeAttribute("data-ghsoc-reason");
    }
    states.clear();
    if (observer) observer.takeRecords();
  }

  function onToggle(state) {
    const key = fileKey(state.table);
    state.userSplit = !state.userSplit;
    if (state.userSplit) choices.set(key, true);
    else choices.delete(key);
    decideAndApply(state);
    if (observer) observer.takeRecords();
  }

  function refresh() {
    if (!extensionAlive()) return;
    if (!enabled || !M.isRoute(location.pathname)) return resetAll();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      choices = new Map();
    }
    for (const [table] of states) if (!table.isConnected) states.delete(table);
    scanTables();
  }

  // --- start -----------------------------------------------------------------

  function start() {
    try {
      chrome.storage.local.get({ [KEY_ENABLED]: true }, (o) => {
        enabled = o[KEY_ENABLED] !== false;
        refresh();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY_ENABLED]) {
          enabled = changes[KEY_ENABLED].newValue !== false;
          refresh();
        }
      });
    } catch {
      return;
    }
    observer = new MutationObserver((recs) => {
      if (!enabled) return;
      queue(recs);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["colspan"],
    });
    for (const ev of ["turbo:render", "turbo:load", "pjax:end"]) document.addEventListener(ev, () => queue());
    window.addEventListener("popstate", () => queue());
    setInterval(() => {
      if (location.pathname !== lastPath) {
        refresh();
      }
    }, 400);
    refresh();
  }

  start();
})();
