// features/linked-pr-status/content.js — on a Projects Board view, an issue
// card whose issue has explicitly linked pull requests (its Development
// links) gets a thin row under its fields: `PR #N` plus one text signal, or a
// neutral aggregate for several. The row opens a modal with one section per
// PR, checks and review shown separately.
//
// Nothing native is hidden, moved or duplicated and the board never waits
// for the extension: cards are read from the page, only cards near the
// viewport are asked about (one aliased GraphQL query per batch, in the
// background) and rows appear when the data arrives. Cards are found through
// the un-hashed `.board-view-column-card` and the `Fields` list's ARIA label,
// never CSS-module classes; if the issue link is missing nothing is added and
// the next scan retries. The decisions live in signal.js (loaded first).

(function () {
  const ROW_CLASS = "ghlps-row";
  const STORAGE_ENABLED = "ghlpsEnabled"; // unset = on
  const FETCH_TYPE = "GHLPS_FETCH"; // matches background/linked-pr-status.js
  const DETAIL_TYPE = "GHLPS_DETAIL";
  const TTL_MS = 120_000;
  const BACKOFF_MS = 60_000;
  const CARD_SELECTOR = ".board-view-column-card";
  const FIELDS_SELECTOR = 'ul[aria-label="Fields"]';
  const SELECTED_TAB_SELECTOR =
    'nav[aria-label="Select view"] [role="tab"][aria-selected="true"], nav[aria-label="Select view"] [role="tab"].selected';
  const ISSUE_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#]|$)/;
  const MOVE_PX = 4;
  const S = globalThis.GHLPS_SIGNAL;

  function isBoardPage() {
    if (!/^\/(orgs|users)\/[^/]+\/projects\/\d+/.test(location.pathname)) return false;
    const icon = document.querySelector(SELECTED_TAB_SELECTOR)?.querySelector('svg[class*="octicon-project"]');
    return !!icon && icon.classList.contains("octicon-project");
  }

  function issueOfCard(card) {
    if (card.parentElement?.closest(CARD_SELECTOR)) return null;
    for (const a of card.querySelectorAll("a[href]")) {
      let path;
      try {
        path = new URL(a.getAttribute("href"), location.origin).pathname;
      } catch {
        continue;
      }
      const m = ISSUE_RE.exec(path);
      if (m) return { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}` };
    }
    return null;
  }

  // GitHub's own "Linked pull requests" field, when the card shows it: a
  // field token labelled with that text, or a pull request link in the list.
  function hasNativeField(card) {
    const fields = card.querySelector(FIELDS_SELECTOR);
    if (!fields) return false;
    if (fields.querySelector('a[href*="/pull/"]')) return true;
    return [...fields.querySelectorAll("[aria-label],[title]")].some((n) =>
      /^linked pull requests/i.test(n.getAttribute("aria-label") || n.getAttribute("title") || "")
    );
  }

  // --- data ---------------------------------------------------------------

  const facts = new Map(); // key -> { at, value, stale }
  const inflight = new Set();
  let status = { state: "ready", until: 0 };
  let generation = 0;

  function statusFromError(res) {
    const msg = String(res?.error || "");
    if (res?.status === 429 || /rate limit/i.test(msg)) return "rate";
    if (res && (res.hasToken === false || /No GitHub token/.test(msg))) return "notoken";
    if (res?.status === 401 || res?.status === 403) return "denied";
    return "error";
  }

  async function fetchFacts(infos) {
    const mine = ++generation;
    infos.forEach((i) => inflight.add(i.key));
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: FETCH_TYPE,
        payload: { issues: infos.map(({ owner, repo, number }) => ({ owner, repo, number })) },
      });
    } catch {
      res = null;
    }
    infos.forEach((i) => inflight.delete(i.key));
    if (!running) return;
    if (res && res.ok && res.facts) {
      if (mine === generation) status = { state: "ready", until: 0 };
      for (const i of infos) facts.set(i.key, { at: Date.now(), value: res.facts[i.key] || { ok: false }, stale: false });
    } else {
      status = { state: statusFromError(res), until: Date.now() + BACKOFF_MS };
      // Known pull requests stay named but turn "Status unavailable"; an issue
      // whose links were never read keeps no row.
      for (const i of infos) {
        const f = facts.get(i.key);
        if (f) facts.set(i.key, { ...f, stale: true });
      }
    }
    schedule();
    setTimeout(schedule, TTL_MS + 50);
  }

  // --- rendering ----------------------------------------------------------

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function prsOf(fact) {
    if (!fact || !fact.value?.ok) return [];
    return fact.value.prs.map((p) => (fact.stale ? { ...p, ok: false } : p));
  }

  function signalChip(s) {
    const chip = el("span", `ghlps-sig ghlps-tone-${s.tone}`);
    chip.append(el("span", "ghlps-glyph", s.glyph), el("span", "ghlps-label", s.label));
    chip.firstChild.setAttribute("aria-hidden", "true");
    return chip;
  }

  function buildRow(info, prs, native) {
    const sum = S.summarize(prs);
    const row = el("div", ROW_CLASS);
    row.dataset.ghlpsKey = info.key;
    const summary = el("button", "ghlps-open");
    summary.type = "button";
    summary.setAttribute("aria-haspopup", "dialog");
    if (sum.kind === "one") {
      const p = sum.pr;
      if (!native && p.number && p.url) {
        const a = el("a", "ghlps-pr", `PR #${p.number}`);
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        row.append(a);
      }
      summary.append(signalChip(sum.signal));
      summary.setAttribute("aria-label", `${p.number ? `Pull request #${p.number}: ` : ""}${sum.signal.label}. Show details`);
    } else {
      const long = S.summarize(prs).text;
      const short = S.summarize(prs, { compact: true }).text;
      const chip = el("span", "ghlps-sig ghlps-tone-neutral");
      chip.append(el("span", "ghlps-long", long), el("span", "ghlps-short", short));
      summary.append(chip);
      summary.setAttribute("aria-label", `${long}. Show details`);
    }
    row.append(summary);
    return row;
  }

  function placeRow(card, row) {
    const fields = card.querySelector(FIELDS_SELECTOR);
    if (fields) fields.after(row);
    else (card.firstElementChild || card).append(row);
  }

  function rowInPlace(card, row) {
    if (!row.isConnected) return false;
    const fields = card.querySelector(FIELDS_SELECTOR);
    if (fields) return row.previousElementSibling === fields;
    return row.parentElement === (card.firstElementChild || card);
  }

  function renderCard(card, info) {
    const row = card.querySelector(`.${ROW_CLASS}`);
    const prs = info ? prsOf(facts.get(info.key)) : [];
    if (!info || !prs.length) {
      row?.remove();
      return;
    }
    const native = hasNativeField(card);
    const sig = JSON.stringify([info.key, native, prs.map((p) => [p.ok, p.number, p.state, p.isDraft, p.reviewDecision, p.checks, p.url])]);
    if (row && row.dataset.ghlpsSig === sig && rowInPlace(card, row)) return;
    row?.remove();
    const next = buildRow(info, prs, native);
    next.dataset.ghlpsSig = sig;
    bindRow(next);
    placeRow(card, next);
  }

  // --- detail modal -------------------------------------------------------

  let dialog = null;
  let opener = null;

  function closeDialog() {
    if (!dialog) return;
    const d = dialog;
    dialog = null;
    if (d.open) d.close();
    d.remove();
    document.documentElement.classList.remove("ghlps-modal-open");
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  function kv(label, value) {
    const dl = el("div", "ghlps-kv-row");
    dl.append(el("dt", null, label), el("dd", null, value));
    return dl;
  }

  async function loadFailing(pr, target) {
    const [owner, repo] = (pr.repo || "").split("/");
    if (!owner || !repo) return;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: DETAIL_TYPE, payload: { owner, repo, number: pr.number } });
    } catch {
      res = null;
    }
    if (!target.isConnected) return;
    if (res?.ok) target.textContent = res.failing.length ? `Failing: ${res.failing.join(", ")}` : "";
    else target.textContent = "Could not load the check names.";
  }

  function prSection(pr) {
    const sec = el("section", "ghlps-pr-section");
    const s = S.signalOf(pr);
    const head = el("h3", "ghlps-pr-head");
    if (pr.url && pr.number) {
      const a = el("a", null, `PR #${pr.number}${pr.title ? ` · ${pr.title}` : ""} ↗`);
      a.href = pr.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      head.append(a);
    } else head.textContent = "Pull request";
    sec.append(head);
    const where = pr.ok ? `${pr.repo} · ${s.id === "merged" ? "Merged" : s.id === "closed" ? "Closed" : s.id === "draft" ? "Draft" : "Open"}` : "State could not be read";
    sec.append(el("p", "ghlps-meta", where));
    const list = el("dl", "ghlps-kv");
    const failing = el("span", "ghlps-failing");
    const open = pr.ok && s.id !== "merged" && s.id !== "closed";
    const checksRow = kv("Checks", open || !pr.ok ? S.checksText(pr) : "Not applicable");
    if (open && (pr.checks === "FAILURE" || pr.checks === "ERROR")) {
      checksRow.querySelector("dd").append(" ", failing);
      loadFailing(pr, failing);
    }
    list.append(checksRow, kv("Review", open || !pr.ok ? S.reviewText(pr) : "Not applicable"));
    sec.append(list, el("p", "ghlps-next", `Next: ${S.nextStep(pr)}`));
    return sec;
  }

  function openDialog(card, info, trigger) {
    closeDialog();
    const prs = prsOf(facts.get(info.key));
    if (!prs.length) return;
    opener = trigger;
    const d = el("dialog", "ghlps-dialog");
    d.setAttribute("aria-modal", "true");
    const title = el("h2", "ghlps-title", "Linked pull requests");
    title.id = "ghlps-title";
    title.tabIndex = -1;
    d.setAttribute("aria-labelledby", title.id);
    const x = el("button", "ghlps-x", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    const head = el("div", "ghlps-head");
    head.append(title, x);
    const sub = el("p", "ghlps-sub", `${info.owner}/${info.repo} #${info.number} · ${prs.length} ${prs.length === 1 ? "PR" : "PRs"}`);
    const body = el("div", "ghlps-body");
    body.append(sub, ...prs.map(prSection));
    const foot = el("div", "ghlps-foot");
    const close = el("button", "ghlps-close", "Close");
    close.type = "button";
    foot.append(close);
    d.append(head, body, foot);

    x.addEventListener("click", closeDialog);
    close.addEventListener("click", closeDialog);
    // A click on the backdrop lands on the dialog element itself.
    d.addEventListener("click", (e) => {
      if (e.target === d) closeDialog();
    });
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeDialog();
    });
    d.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const items = [...d.querySelectorAll("a[href],button:not([disabled])")];
      const at = items.indexOf(document.activeElement);
      const inside = at >= 0;
      if (e.shiftKey && (!inside || at === 0)) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && (!inside || at === items.length - 1)) {
        e.preventDefault();
        items[0].focus();
      }
    });
    dialog = d;
    document.body.append(d);
    document.documentElement.classList.add("ghlps-modal-open");
    d.showModal();
    title.focus();
  }

  // --- row events: click and keys stop at the row, pointer events do not,
  // so a drag started on the row still drags the card. ---

  let down = null;
  document.addEventListener(
    "pointerdown",
    (e) => {
      down = e.target.closest?.(`.${ROW_CLASS}`) ? { x: e.clientX, y: e.clientY } : null;
    },
    true
  );

  function onRowClick(e) {
    const row = e.target.closest?.(`.${ROW_CLASS}`);
    if (!row || !running) return;
    e.stopPropagation();
    const moved = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE_PX;
    down = null;
    const btn = e.target.closest("button.ghlps-open");
    if (!btn) return; // the PR link keeps its native behaviour
    if (moved) {
      e.preventDefault();
      return;
    }
    const card = row.closest(CARD_SELECTOR);
    const info = card && issueOfCard(card);
    if (info) openDialog(card, info, btn);
  }

  function onRowKey(e) {
    if (!running || !e.target.closest?.(`.${ROW_CLASS}`)) return;
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  }

  // Bound on each row, so the event stops before any ancestor handler (React's
  // root, the native side panel) and no board selector is needed.
  function bindRow(row) {
    if (row.__ghlps) return;
    row.__ghlps = true;
    row.addEventListener("click", onRowClick);
    row.addEventListener("keydown", onRowKey);
  }

  // --- scanning -----------------------------------------------------------

  let running = false;
  let observer = null;
  let observedRoot = null;
  let io = null;
  const watched = new WeakSet();
  const visible = new WeakSet();
  let timer = 0;

  function schedule() {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 120);
  }

  function scan() {
    if (!running) return;
    if (!isBoardPage()) return stop();
    const want = [];
    const seen = new Set();
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      const info = issueOfCard(card);
      if (!watched.has(card)) {
        watched.add(card);
        io.observe(card);
      }
      renderCard(card, info);
      if (!info || !visible.has(card) || seen.has(info.key) || inflight.has(info.key)) continue;
      seen.add(info.key);
      const f = facts.get(info.key);
      if (!f || Date.now() - f.at > TTL_MS) want.push(info);
    }
    if (want.length && (status.state === "ready" || Date.now() >= status.until)) fetchFacts(want);
    observer?.takeRecords();
  }

  function start() {
    if (running) return;
    running = true;
    io = new IntersectionObserver(
      (entries) => {
        let fresh = false;
        for (const e of entries) {
          if (e.isIntersecting) {
            if (!visible.has(e.target)) fresh = true;
            visible.add(e.target);
          } else visible.delete(e.target);
        }
        if (fresh) schedule();
      },
      { rootMargin: "600px 400px" }
    );
    // The scan drops the records of its own changes (takeRecords), so what
    // reaches here is GitHub re-rendering, including it dropping our row.
    observer = new MutationObserver(() => schedule());
    observedRoot = document.querySelector("main") || document.body;
    observer.observe(observedRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    schedule();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    observer?.disconnect();
    io?.disconnect();
    observer = io = null;
    inflight.clear();
    closeDialog();
    for (const r of document.querySelectorAll(`.${ROW_CLASS}`)) r.remove();
    for (const c of document.querySelectorAll(CARD_SELECTOR)) watched.delete(c);
  }

  async function sync() {
    let enabled = true;
    try {
      const stored = await chrome.storage.local.get(STORAGE_ENABLED);
      enabled = stored[STORAGE_ENABLED] !== false;
    } catch {
      return;
    }
    // GitHub swapped <main>: the observers watch a detached tree, restart.
    if (enabled && running && observedRoot && !observedRoot.isConnected) stop();
    if (enabled && isBoardPage()) start();
    else if (running || document.querySelector(`.${ROW_CLASS}`)) stop();
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_ENABLED]) sync();
  });

  // Same belt and braces as the other board features: Turbo events plus a
  // URL poll that also restarts after a view switch away and back.
  let t = 0;
  const debouncedSync = () => {
    clearTimeout(t);
    t = setTimeout(sync, 150);
  };
  document.addEventListener("turbo:load", debouncedSync);
  document.addEventListener("turbo:render", debouncedSync);
  document.addEventListener("pjax:end", debouncedSync);
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      for (const [k, f] of facts) facts.set(k, { ...f, at: 0 });
      debouncedSync();
    } else if (!running && isBoardPage()) debouncedSync();
    else if (running && !isBoardPage()) stop();
  }, 800);

  sync();
})();
