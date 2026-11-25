// features/viewed-folders/content.js — Viewed per folder: a small read-only
// indicator at the right edge of every folder row of the file tree of the new
// "Files changed" page, saying how many of the changed files below it the
// signed-in user marked "Viewed" with GitHub's own checkbox.
//
// It only reads. It never clicks a native control and writes nothing to
// GitHub: the state comes from GitHub's own "Viewed" buttons (aria-pressed)
// and, when a token is already configured, from one read-only GraphQL read
// made by the background (see background/viewed-folders.js). A file neither
// source covers is unknown, and a folder with an unknown file never claims
// "all viewed" or "none viewed". Pure rules (route, counting, the merge of the
// sources, the states and their exact copy) live in model.js (GHVF_MODEL).
//
// The indicator is the last child of the row's content element (the element
// the folder's aria-labelledby names). A missing anchor means no indicator and
// no error: there is no fallback container, the next scan retries.

(function () {
  const M = globalThis.GHVF_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghvfEnabled";
  const SCAN_MS = 40;
  const POLL_PATH_MS = 400;
  const MIN_LABEL_PX = 32; // below this much room for the folder name the count is dropped and the glyph stays
  const DESC_PREFIX = "ghvf-d-";
  const SVG_NS = "http://www.w3.org/2000/svg";

  let enabled = true;
  let scanTimer = null;
  let nextId = 0;
  let tipFor = null;
  let tipEl = null;
  let resizeObserver = null;
  let lastPath = location.pathname;
  let observedTree = null;

  // What one visit of a pull request's Files changed page remembers: the files the tree has shown
  // (collapsing a folder unmounts its rows), the state each native button showed, the answer of the read.
  function fresh(route) {
    return {
      key: route ? M.keyOf(route) : null,
      route,
      treePaths: new Set(),
      seenFiles: new WeakSet(), // file rows already read: a 3000-file tree is not walked again at every scan
      hrefToPath: new Map(),
      page: new Map(), // path -> { viewed, seq }
      api: null, // { seq, states: Map, paths: [], complete }
      requested: false,
      pending: false,
      seq: 0,
      counterTotal: null,
      counterEl: null,
      folders: [],
    };
  }
  let st = fresh(null);

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  // --- reading the page -------------------------------------------------

  function findTree() {
    for (const t of document.querySelectorAll('[role="tree"]')) {
      if (/file tree/i.test(t.getAttribute("aria-label") || "")) return t;
    }
    return null;
  }

  const rowOf = (el) => (el && el.closest ? el.closest('[role="treeitem"]') : null);

  function readTree(tree) {
    const folders = [];
    for (const li of tree.querySelectorAll('[role="treeitem"]')) {
      const id = li.id;
      if (!id) continue;
      // The classic Files changed page has a tree of the same name whose rows are ids of its own
      // ("file-tree-item-diff-…"), not paths: it is not this page and must not start a read.
      if (id.startsWith("file-tree-item-")) continue;
      if (li.hasAttribute("aria-expanded")) {
        folders.push(li);
        continue;
      }
      if (st.seenFiles.has(li)) continue;
      st.seenFiles.add(li);
      st.treePaths.add(id);
      const link = li.querySelector('a[href^="#diff-"]');
      if (link) st.hrefToPath.set(link.getAttribute("href"), id);
    }
    st.folders = folders;
  }

  const isViewedButton = (b) => /^(not )?viewed$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim());

  function pathOfRegion(region) {
    const byLink = st.hrefToPath.get(`#${region.id}`);
    if (byLink) return byLink;
    // Second choice: the heading's text (bidi marks stripped); for a rename "old → new" the new path.
    const h = region.querySelector("h3, h2");
    if (!h) return null;
    const text = M.cleanPath(h.textContent);
    const candidates = [text, ...text.split(/\s*(?:→|->)\s*/).slice(-1)];
    return candidates.find((c) => st.treePaths.has(c)) || null;
  }

  // Records what a native button shows; a state is stamped when first seen or when it changes.
  function observeButton(button) {
    const region = button.closest('[role="region"][id^="diff-"]');
    if (!region || !isViewedButton(button)) return;
    const path = pathOfRegion(region);
    if (!path) return;
    const viewed = button.getAttribute("aria-pressed") === "true";
    const prev = st.page.get(path);
    if (!prev || prev.viewed !== viewed) st.page.set(path, { viewed, seq: ++st.seq });
  }

  function readButtons() {
    for (const region of document.querySelectorAll('[role="region"][id^="diff-"]')) {
      const button = [...region.querySelectorAll("button[aria-pressed]")].find(isViewedButton);
      if (button) observeButton(button);
    }
  }

  // The toolbar's own "0 of 210 files viewed" (a screen-reader span, outside the tree pane): the total
  // of changed files, to prove the tree lists all of them.
  function readCounter() {
    if (st.counterEl && st.counterEl.isConnected) {
      const c = M.parseCounter(st.counterEl.textContent);
      if (c) return void (st.counterTotal = c.total);
    }
    st.counterEl = null;
    for (const el of document.querySelectorAll('.sr-only, [class*="sr-only"]')) {
      if (el.textContent.length > 80) continue;
      const c = M.parseCounter(el.textContent);
      if (c) {
        st.counterEl = el;
        return void (st.counterTotal = c.total);
      }
    }
    st.counterTotal = null;
  }

  // --- what is known ------------------------------------------------------

  function listing() {
    if (st.api && st.api.complete) return { paths: st.api.paths, proven: true };
    const paths = [...st.treePaths];
    return { paths, proven: st.counterTotal != null && paths.length === st.counterTotal };
  }

  function stateOf(path) {
    return M.fileState(path, st.api, st.page);
  }

  // --- the indicator ------------------------------------------------------

  const svg = (inner, w = 16) => {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("class", "ghvf-glyph");
    s.setAttribute("width", String(w));
    s.setAttribute("height", "16");
    s.setAttribute("viewBox", `0 0 ${w} 16`);
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.innerHTML = inner;
    return s;
  };

  const RING = (extra) => `<circle cx="8" cy="8" r="6" fill="none" stroke-width="2" ${extra}/>`;

  function glyphFor(d) {
    switch (d.state) {
      case "viewed":
        return svg('<path fill="currentColor" fill-rule="evenodd" d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/>');
      case "partial": {
        const off = (38 * (1 - d.fraction)).toFixed(2);
        return svg(
          RING('class="ghvf-track"') +
            `<circle class="ghvf-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="38" stroke-dashoffset="${off}" transform="rotate(-90 8 8)"/>`
        );
      }
      case "toview":
        return svg(RING('class="ghvf-track"'));
      case "loading":
        return svg('<rect class="ghvf-pill" x="0" y="4" width="28" height="8" rx="4"/>', 28);
      default:
        return svg(RING('class="ghvf-track ghvf-dashed" stroke-dasharray="3 2.2"'));
    }
  }

  function newIndicator() {
    const ind = document.createElement("span");
    ind.className = "ghvf-ind";
    ind.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "ghvf-count";
    const desc = document.createElement("span");
    desc.className = "ghvf-desc";
    desc.hidden = true;
    desc.id = DESC_PREFIX + ++nextId;
    ind.append(count, desc);
    return ind;
  }

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text; // an identical write is still a mutation
  };
  const setAttr = (node, name, value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };

  function paint(ind, d) {
    const glyphKey = d.state + ":" + Math.round(d.fraction * 100);
    if (ind.dataset.glyph !== glyphKey) {
      ind.dataset.glyph = glyphKey;
      ind.querySelector(".ghvf-glyph")?.remove();
      ind.insertBefore(glyphFor(d), ind.firstChild);
    }
    setAttr(ind, "data-state", d.state);
    setText(ind.querySelector(".ghvf-count"), d.count);
    const desc = ind.querySelector(".ghvf-desc");
    setText(desc, d.text);
    return desc;
  }

  // The count is the row's accessible description: our hidden text node is added to the row's own
  // aria-describedby (GitHub's id stays), and the row's name stays the folder name.
  function describeRow(li, descId) {
    const cur = (li.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const next = cur.filter((t) => !t.startsWith(DESC_PREFIX));
    next.push(descId);
    if (next.join(" ") !== cur.join(" ")) li.setAttribute("aria-describedby", next.join(" "));
  }

  function undescribeRow(li) {
    const cur = (li.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const next = cur.filter((t) => !t.startsWith(DESC_PREFIX));
    if (next.length === cur.length) return;
    if (next.length) li.setAttribute("aria-describedby", next.join(" "));
    else li.removeAttribute("aria-describedby");
  }

  // The row's content element: the one aria-labelledby names; the class part "TreeViewItemContent"
  // (not the "...Text" label) is the second choice, used only when that attribute gives no element.
  function anchorOf(li) {
    const id = li.getAttribute("aria-labelledby");
    const named = id ? document.getElementById(id) : null;
    if (named && rowOf(named) === li) return named;
    for (const el of li.querySelectorAll('[class*="TreeViewItemContent"], [class*="TreeView-item-content"]')) {
      if (/ContentText|item-content-text/.test(el.className)) continue;
      if (rowOf(el) === li) return el;
    }
    return null;
  }

  const labelOf = (content) => content.querySelector('[class*="TreeViewItemContentText"], [class*="item-content-text"]');

  function removeFrom(li) {
    li.querySelectorAll(".ghvf-ind").forEach((i) => {
      if (rowOf(i) === li) i.remove();
    });
    undescribeRow(li);
  }

  function renderRow(li, counts, proven) {
    const content = anchorOf(li);
    if (!content) return removeFrom(li);
    const d = M.describe(counts.get(li.id), { proven, loading: st.pending });
    let ind = [...content.children].find((c) => c.classList.contains("ghvf-ind"));
    if (!ind) {
      removeFrom(li);
      ind = newIndicator();
      content.appendChild(ind);
    } else if (content.lastElementChild !== ind) content.appendChild(ind);
    const desc = paint(ind, d);
    describeRow(li, desc.id);
    if (tipFor === ind) showTip(ind);
  }

  function render() {
    const tree = findTree();
    if (!tree) return;
    if (tipFor && !tipFor.isConnected) hideTip(); // the hovered row was unmounted under the pointer
    const { paths, proven } = listing();
    const counts = M.countFolders(paths, stateOf);
    for (const li of st.folders) if (li.isConnected) renderRow(li, counts, proven);
    layoutPass(tree);
  }

  // GitHub's label truncates first; when it would be left with less than MIN_LABEL_PX the count is
  // dropped and the glyph stays. One write pass, one read pass, one write pass.
  function layoutPass(tree) {
    if (!tree.getBoundingClientRect().width) return; // the pane is hidden: nothing to measure
    const rows = [];
    for (const li of st.folders) {
      const content = li.isConnected ? anchorOf(li) : null;
      const ind = content && [...content.children].find((c) => c.classList.contains("ghvf-ind"));
      const label = content && labelOf(content);
      if (ind && label && ind.querySelector(".ghvf-count").textContent) rows.push({ ind, label });
    }
    for (const r of rows) r.ind.classList.remove("ghvf-compact");
    const small = rows.filter((r) => r.label.getBoundingClientRect().width < MIN_LABEL_PX);
    for (const r of small) r.ind.classList.add("ghvf-compact");
  }

  // --- the tooltip --------------------------------------------------------

  function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement("div");
    tipEl.className = "ghvf-tip";
    tipEl.setAttribute("popover", "manual");
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(ind) {
    const text = ind.querySelector(".ghvf-desc")?.textContent;
    if (!text || !ind.isConnected) return hideTip();
    const tip = ensureTip();
    tipFor = ind;
    tip.textContent = text;
    try {
      if (!tip.matches(":popover-open")) tip.showPopover();
    } catch {
      /* a browser without popover: no bubble, the text stays on the row */
      return;
    }
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const r = ind.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - t.width, vw - 8 - t.width));
    let top = r.bottom + 4;
    if (top + t.height > vh - 8) top = r.top - 4 - t.height;
    top = Math.max(8, top);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTip() {
    tipFor = null;
    if (!tipEl) return;
    try {
      if (tipEl.matches(":popover-open")) tipEl.hidePopover();
    } catch {
      /* already hidden */
    }
  }

  // --- the read (background) ------------------------------------------------

  function request() {
    st.requested = true;
    st.pending = true;
    const mine = st;
    const seq = ++st.seq;
    const { owner, repo, number } = st.route;
    const done = (res) => {
      if (st !== mine) return; // another pull request, an earlier visit of this one, or left the page
      st.pending = false;
      if (res && res.ok && Array.isArray(res.files)) {
        const states = new Map(res.files.map((f) => [f.path, !!f.viewed]));
        st.api = { seq, states, paths: [...states.keys()], complete: Number.isInteger(res.total) && states.size === res.total };
      }
      readButtons();
      render();
    };
    try {
      const p = chrome.runtime.sendMessage({ type: "GHVF_FETCH", payload: { owner, repo, number } });
      Promise.resolve(p).then(done, () => done(null));
    } catch {
      done(null);
    }
  }

  // --- lifecycle --------------------------------------------------------------

  function teardown() {
    hideTip();
    if (tipEl) tipEl.remove();
    tipEl = null;
    if (resizeObserver) resizeObserver.disconnect();
    observedTree = null;
    document.querySelectorAll(".ghvf-ind").forEach((i) => {
      const li = rowOf(i);
      i.remove();
      if (li) undescribeRow(li);
    });
    st = fresh(null);
  }

  function scan() {
    if (!extensionAlive()) return;
    lastPath = location.pathname;
    const route = enabled ? M.parseRoute(location.pathname) : null;
    if (!route) {
      if (st.key !== null) teardown();
      return;
    }
    const key = M.keyOf(route);
    if (st.key !== key) {
      teardown();
      st = fresh(route);
    }
    const tree = findTree();
    if (!tree) return; // the classic page, or the tree is not here yet: nothing, retried on the next scan
    if (observedTree !== tree) {
      resizeObserver.disconnect();
      resizeObserver.observe(tree);
      observedTree = tree;
    }
    readTree(tree);
    readButtons();
    readCounter();
    if (!st.requested && st.treePaths.size && st.folders.length) request();
    render();
  }

  function queue() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_MS);
  }

  const active = () => st.key !== null || M.isRoute(location.pathname);
  const ours = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest(".ghvf-ind, .ghvf-tip"));
  };

  function onMutations(records) {
    if (!enabled || !active() || !extensionAlive()) return;
    let pressed = false;
    let structural = false;
    const described = [];
    for (const r of records) {
      if (ours(r.target)) continue;
      if (r.type === "attributes") {
        if (r.attributeName === "aria-pressed") pressed = true;
        else if (r.attributeName === "aria-describedby") described.push(r.target);
        else structural = true;
      } else structural = true;
    }
    if (pressed && st.key !== null) {
      // A tick: the folders follow in the same task, before the next frame.
      readButtons();
      render();
    }
    for (const li of described) {
      // React rewrote aria-describedby: put our id back at once.
      const content = li.nodeType === 1 && li.hasAttribute("aria-expanded") ? anchorOf(li) : null;
      const ind = content && [...content.children].find((c) => c.classList.contains("ghvf-ind"));
      if (ind) describeRow(li, ind.querySelector(".ghvf-desc").id);
    }
    if (structural) {
      // Rows mounted or replaced inside the tree get their indicator before the next paint; anything else
      // on the page (diffs rendering) is debounced.
      if (observedTree && records.some((r) => r.type === "childList" && !ours(r.target) && observedTree.contains(r.target))) {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = null;
        scan();
      } else queue();
    }
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
      });
    } catch {
      return;
    }
    for (const ev of ["turbo:render", "turbo:load", "pjax:end"]) document.addEventListener(ev, scan);
    window.addEventListener("popstate", queue);
    new MutationObserver(onMutations).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "aria-expanded", "aria-describedby", "aria-labelledby"],
    });
    // The pane is resizable (256-700px) and the window too: re-check which rows are short of room.
    resizeObserver = new ResizeObserver(() => {
      if (st.key !== null && observedTree) layoutPass(observedTree);
    });
    // The tooltip: a hover bubble in the top layer, hidden on leave, scroll and Escape.
    document.addEventListener("pointerover", (e) => {
      const ind = e.target && e.target.closest ? e.target.closest(".ghvf-ind") : null;
      if (ind && st.key !== null) showTip(ind);
    });
    document.addEventListener("pointerout", (e) => {
      const ind = e.target && e.target.closest ? e.target.closest(".ghvf-ind") : null;
      if (ind && !(e.relatedTarget && ind.contains(e.relatedTarget))) hideTip();
    });
    window.addEventListener("scroll", () => tipFor && hideTip(), true);
    document.addEventListener("keydown", (e) => e.key === "Escape" && tipFor && hideTip());
    // A route change that swaps no DOM (history.pushState alone) fires no mutation: watch the path too.
    setInterval(() => {
      if (location.pathname !== lastPath) scan();
    }, POLL_PATH_MS);
  }

  start();
})();
