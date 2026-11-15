// features/resolved-conversations/content.js — Resolved conversations: one bar
// directly above the first loaded resolved conversation on the Conversation
// tab of a pull request, with the count and a button that expands or collapses
// every loaded resolved conversation at once.
//
// The extension only clicks each conversation's own chevron button, like a
// reader would. It never activates "Load more…", sends no request and reads no
// token: GitHub's own lazy load of each opened conversation is the only
// traffic. Pure rules (copy, toggle rule, status texts) live in model.js
// (globalThis.GHRC_MODEL). A missing anchor means no bar and no error: the
// next scan retries, there is no fallback container.

(function () {
  const M = globalThis.GHRC_MODEL;
  if (!M) return;

  const KEY_ENABLED = "ghrcEnabled";
  const SCAN_MS = 150;
  const POLL_PATH_MS = 400;
  const LABEL_ID = "ghrc-count";

  let enabled = true;
  let scanTimer = null;
  const live = new WeakSet(); // bars this script built: a Turbo snapshot clone has the markup but no listeners
  const ids = new WeakMap();
  let nextId = 0;

  // What the bar remembers between scans (one bar per page).
  const st = {
    busy: false,
    frozenLabel: "", // the label while Expanding stays as it was
    result: null, // { k, sig }: the outcome of the last Expand when some conversations did not open
  };

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // --- reading the page -------------------------------------------------

  // A resolved conversation: a review-thread-collapsible whose header row (the
  // child holding the chevron button) shows the visible "Resolved" label. The
  // text is matched inside the header only, so a "Resolved" option elsewhere
  // (the minimize form) never counts.
  function headerOf(thread) {
    return [...thread.children].find((c) => c.querySelector("button[aria-expanded]")) || null;
  }

  function parts(thread) {
    const header = headerOf(thread);
    if (!header) return null;
    const button = header.querySelector("button[aria-expanded]");
    const resolved = [...header.querySelectorAll("*")].some((e) => e.childElementCount === 0 && squash(e.textContent) === "Resolved");
    if (!button || !resolved) return null;
    const body = [...thread.children].find((c) => c !== header) || null;
    return { thread, button, body };
  }

  function resolvedThreads() {
    const out = [];
    for (const t of document.querySelectorAll("review-thread-collapsible")) {
      const p = parts(t);
      if (p) out.push(p);
    }
    return out;
  }

  // Open means the button says so and GitHub's lazy content has arrived: the
  // include-fragment is a direct child of the body until it does (and stays
  // there when the load failed).
  function isOpen(p) {
    if (p.button.getAttribute("aria-expanded") !== "true") return false;
    return !(p.body && p.body.querySelector(":scope > include-fragment"));
  }

  function hasLoadMore(root) {
    for (const b of root.querySelectorAll("button")) {
      const text = b.textContent;
      if (text.length < 40 && /^Load more/i.test(squash(text))) return true;
    }
    return false;
  }

  function snapshot() {
    const list = resolvedThreads();
    const open = [];
    let sig = "";
    for (const p of list) {
      if (!ids.has(p.thread)) ids.set(p.thread, ++nextId);
      const o = isOpen(p);
      if (o) open.push(p);
      sig += `${ids.get(p.thread)}${o ? "o" : "c"}|`;
    }
    const first = list[0] ? list[0].thread : null;
    const root = (first && first.closest(".js-discussion")) || document;
    return { list, n: list.length, open: open.length, sig, loadMore: first ? hasLoadMore(root) : false };
  }

  // --- the bar ----------------------------------------------------------

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function newBar() {
    const bar = el("div", "ghrc-bar");
    const label = el("span", "ghrc-label");
    label.id = LABEL_ID;
    const button = el("button", "Button Button--secondary Button--small ghrc-btn");
    button.type = "button";
    button.setAttribute("aria-describedby", LABEL_ID);
    const content = el("span", "Button-content");
    content.appendChild(el("span", "Button-label"));
    button.appendChild(content);
    button.addEventListener("click", onClick);
    // The live region exists, empty, before any click: one created and filled in
    // the same tick is often not announced by screen readers.
    const status = el("span", "ghrc-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    bar.append(label, button, status);
    live.add(bar);
    return bar;
  }

  const bars = () => [...document.querySelectorAll(".ghrc-bar")];
  const removeBars = () => bars().forEach((b) => b.remove());

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text; // an identical write is still a mutation
  }

  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function render(bar, snap) {
    if (!st.busy && st.result && !M.keepResult(st.result, snap.sig)) st.result = null;
    const all = M.allOpen(snap.n, snap.open);
    const labelText = st.busy
      ? st.frozenLabel
      : M.label({ n: snap.n, open: snap.open, loadMore: snap.loadMore, result: st.result ? st.result.k : null });
    setText(bar.querySelector(".ghrc-label"), labelText);
    const button = bar.querySelector(".ghrc-btn");
    setText(button.querySelector(".Button-label"), M.buttonText({ allOpen: all, loadMore: snap.loadMore, busy: st.busy }));
    setAttr(button, "aria-expanded", String(all && !st.busy));
    if (st.busy) setAttr(button, "aria-disabled", "true");
    else if (button.hasAttribute("aria-disabled")) button.removeAttribute("aria-disabled");
  }

  function scan() {
    if (!extensionAlive()) return;
    if (!enabled || !M.isRoute(location.pathname)) return removeBars();
    const snap = snapshot();
    if (!snap.n) return removeBars();
    const first = snap.list[0].thread;
    const all = bars();
    let bar = all.length === 1 && live.has(all[0]) ? all[0] : null;
    if (!bar) {
      removeBars();
      bar = newBar();
    }
    if (bar.nextElementSibling !== first || bar.parentNode !== first.parentNode) first.parentNode.insertBefore(bar, first);
    render(bar, snap);
  }

  function queue() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_MS);
  }

  function announce(text) {
    const box = document.querySelector(".ghrc-bar .ghrc-status");
    if (box) setText(box, text);
  }

  // --- acting -----------------------------------------------------------

  // Resolves when the conversation is open, GitHub reported a load error on
  // it, or the bound elapsed: whichever comes first. Never waits for ever.
  function settle(p, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let mo = null;
      const finish = (why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (mo) mo.disconnect();
        p.thread.removeEventListener("error", onError, true);
        resolve(why);
      };
      const onError = () => finish("error");
      const check = () => {
        if (isOpen(p)) finish("open");
      };
      mo = new MutationObserver(check);
      mo.observe(p.thread, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-expanded", "hidden", "class"] });
      p.thread.addEventListener("error", onError, true); // include-fragment's error does not bubble
      timer = setTimeout(() => finish("timeout"), ms);
      check();
    });
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function expand(path) {
    const before = snapshot();
    st.busy = true;
    st.frozenLabel = M.label({ n: before.n, open: before.open, loadMore: before.loadMore, result: st.result ? st.result.k : null });
    st.result = null;
    announce("");
    scan();
    const ms = M.boundMs(document.documentElement.dataset.ghrcBoundMs);
    try {
      // One at a time: GitHub's lazy load of each conversation is the heavy part.
      for (const p of before.list) {
        if (location.pathname !== path || !p.thread.isConnected || isOpen(p)) continue;
        const settled = settle(p, ms);
        // A conversation whose button already says open (its content still loading or failed)
        // is only waited for: a click would close it.
        if (p.button.getAttribute("aria-expanded") !== "true") p.button.click();
        await settled;
        await tick();
      }
    } finally {
      st.busy = false;
    }
    if (location.pathname !== path) return;
    const after = snapshot();
    st.result = after.open < after.n ? { k: after.open, sig: after.sig } : null;
    scan();
    announce(M.status({ kind: "expanded", n: after.n, k: after.open, loadMore: after.loadMore }));
  }

  async function collapse() {
    const before = snapshot();
    st.result = null;
    announce("");
    for (const p of before.list) {
      if (p.button.getAttribute("aria-expanded") === "true") p.button.click();
    }
    await tick();
    const after = snapshot();
    scan();
    announce(M.status({ kind: "collapsed", n: after.n, loadMore: after.loadMore }));
  }

  function onClick() {
    if (st.busy) return; // aria-disabled: focus stays, activation is ignored
    const snap = snapshot();
    if (!snap.n) return;
    if (M.allOpen(snap.n, snap.open)) collapse();
    else expand(location.pathname);
  }

  // --- start ------------------------------------------------------------

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
    // A Turbo snapshot restore brings back a clone of the bar with no listeners: replace it at once,
    // not after the debounce, so a click cannot land on the dead copy.
    for (const ev of ["turbo:render", "turbo:load", "pjax:end"]) document.addEventListener(ev, scan);
    window.addEventListener("popstate", queue);
    new MutationObserver(queue).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "class", "hidden", "data-resolved"],
    });
    // A route change that swaps no DOM (history.pushState alone) fires no mutation: watch the path too.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        queue();
      }
    }, POLL_PATH_MS);
  }

  start();
})();
