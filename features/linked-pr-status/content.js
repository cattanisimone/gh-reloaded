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
  const SETTINGS_TYPE = "GHLPS_OPEN_SETTINGS";
  const STORAGE_HINT = "ghlpsHintDismissed"; // one-time hint for a missing token or permission
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
    let found = null;
    for (const a of card.querySelectorAll("a[href]")) {
      let path;
      try {
        path = new URL(a.getAttribute("href"), location.origin).pathname;
      } catch {
        continue;
      }
      const m = ISSUE_RE.exec(path);
      if (!m) continue;
      found = found || { owner: m[1], repo: m[2], number: Number(m[3]), key: `${m[1]}/${m[2]}#${m[3]}`, title: "" };
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        found.title = text;
        break;
      }
    }
    return found;
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
  let accessDenied = false; // a link was listed but its status was refused

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
      accessDenied = [...facts.values()].some((f) => f.value?.ok && f.value.prs.some((p) => p.denied));
      showHint();
    } else {
      status = { state: statusFromError(res), until: Date.now() + BACKOFF_MS };
      showHint();
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

  // --- hint: say why nothing shows --------------------------------------

  const HINTS = {
    notoken: "Linked PR status needs a GitHub token for this repository owner to read pull requests. Add one in Settings.",
    denied: "GitHub refused part of the request. The token needs Pull requests: Read (and Commit statuses or Checks for the checks rollup) on these repositories. Check it in Settings.",
    rate: "GitHub's rate limit was reached, so linked PR status is paused. It retries in about a minute.",
  };
  const hintKey = () => (status.state !== "ready" ? status.state : accessDenied ? "denied" : "");
  let hintDismissed = false; // this page load; "rate" is never remembered

  async function showHint() {
    document.querySelector(".ghlps-hint")?.remove();
    const key = hintKey();
    const text = HINTS[key];
    if (!text || !running || hintDismissed) return;
    if (key !== "rate") {
      try {
        if ((await chrome.storage.local.get(STORAGE_HINT))[STORAGE_HINT]) return;
      } catch {}
      if (!running || hintKey() !== key) return;
    }
    const box = el("div", "ghlps-hint");
    box.setAttribute("role", "status");
    const p = el("p", null, text + " ");
    if (key !== "rate") {
      const a = el("a", null, "Open Settings");
      a.href = "#";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          chrome.runtime.sendMessage({ type: SETTINGS_TYPE });
        } catch {}
      });
      p.append(a);
    }
    const x = el("button", null, "Dismiss");
    x.type = "button";
    x.addEventListener("click", async () => {
      hintDismissed = true;
      box.remove();
      if (key !== "rate") {
        try {
          await chrome.storage.local.set({ [STORAGE_HINT]: true });
        } catch {}
      }
    });
    box.append(p, x);
    document.body.append(box);
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
    const lead = el("span", "ghlps-label-static");
    lead.append(el("span", "ghlps-label-long", "Linked PRs:"), el("span", "ghlps-label-short", "PRs:"));
    row.append(lead);
    const opener = (cls, ...kids) => {
      const b = el("button", `ghlps-open ${cls}`);
      b.type = "button";
      b.setAttribute("aria-haspopup", "dialog");
      b.append(...kids);
      return b;
    };
    if (sum.kind === "one") {
      const p = sum.pr;
      if (!native && p.number && p.url) {
        const a = el("a", "ghlps-pr", `PR #${p.number}`);
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        row.append(a);
      }
      // An open PR with no review or checks signal: just the PR link.
      if (sum.signal.id !== "open") {
        const b = opener(native ? "ghlps-left" : "ghlps-first", signalChip(sum.signal));
        b.setAttribute("aria-label", `${p.number ? `Pull request #${p.number}: ` : ""}${sum.signal.label}. Show details`);
        row.append(b);
      }
    } else {
      const compact = S.summarize(prs, { compact: true });
      const label = el("span", "ghlps-count");
      label.append(el("span", "ghlps-long", sum.label), el("span", "ghlps-short", compact.label));
      const b = opener("ghlps-left", label);
      b.setAttribute("aria-label", `${sum.text}. Show details`);
      row.append(b);
      let first = true;
      const side = (tone, glyph, long, short) => {
        const chip = el("span", `ghlps-sig ghlps-tone-${tone}`);
        const g = el("span", "ghlps-glyph", glyph);
        g.setAttribute("aria-hidden", "true");
        chip.append(...(glyph ? [g] : []), el("span", "ghlps-long", long), el("span", "ghlps-short", short));
        const c = opener(first ? "ghlps-first" : "", chip);
        c.setAttribute("aria-label", `${long}. Show details`);
        first = false;
        row.append(c);
      };
      if (sum.needs) side("bad", "", sum.attention, compact.attention);
      if (sum.unavailable) side("neutral", "?", sum.unavailableText, compact.unavailableText);
    }
    const note = S.caption(prs);
    if (note) {
      const c = el("span", "ghlps-caption", note);
      c.title = note;
      row.append(c);
    }
    return row;
  }

  function placeRow(card, row) {
    const fields = card.querySelector(FIELDS_SELECTOR);
    if (fields) fields.after(row);
    else (card.firstElementChild || card).append(row);
    fitRow(card, row);
    fitCaption(row);
    if (typeof ResizeObserver === "function") new ResizeObserver(() => fitCaption(row)).observe(row);
  }

  // GitHub's cards end with 1px screen-reader-only spans: they take no room.
  function visuallyHidden(n) {
    if (n.classList.contains("sr-only")) return true;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.position === "absolute") return true;
    const b = n.getBoundingClientRect();
    return b.width <= 1 && b.height <= 1;
  }

  // A caption squeezed to a few letters says nothing: hide it (the chip, the
  // title attribute and the modal keep the meaning).
  const CAPTION_MIN_WIDTH = 72;
  function fitCaption(row) {
    const c = row.querySelector(".ghlps-caption");
    if (!c) return;
    c.hidden = false;
    if (row.clientWidth && c.clientWidth < CAPTION_MIN_WIDTH) c.hidden = true;
  }

  // Make the band reach the card's inner edges and, when nothing follows it,
  // the bottom corners, whatever padding the card has: measured, not assumed.
  function fitRow(card, row) {
    row.style.margin = "";
    row.style.borderRadius = "";
    const cs = getComputedStyle(card);
    const c = card.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (!r.width) return;
    const bw = (side) => parseFloat(cs[`border${side}Width`]) || 0;
    const left = r.left - c.left - bw("Left");
    const right = c.right - bw("Right") - r.right;
    let last = true;
    for (let n = row; n && n !== card; n = n.parentElement) {
      for (let k = n.nextElementSibling; k; k = k.nextElementSibling) if (!visuallyHidden(k)) last = false;
    }
    const bottom = last ? c.bottom - bw("Bottom") - r.bottom : 0;
    const px = (v) => `${Math.max(0, Math.round(v * 100) / 100)}px`;
    row.style.marginInline = `-${px(left)} -${px(right)}`;
    if (last) {
      row.style.marginBottom = `-${px(bottom)}`;
      const rad = Math.max(0, (parseFloat(cs.borderBottomLeftRadius) || 0) - bw("Bottom"));
      row.style.borderRadius = `0 0 ${rad}px ${rad}px`;
    }
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
    if (native && prs.length === 1 && S.signalOf(prs[0]).id === "open") {
      row?.remove(); // nothing left to show next to GitHub's own field
      return;
    }
    const sig = JSON.stringify([info.key, native, prs.map((p) => [p.ok, p.denied, p.number, p.state, p.isDraft, p.reviewDecision, p.checks, p.url])]);
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
    document.removeEventListener("keydown", onEscape, true);
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  // GitHub's own handler can swallow Escape (preventDefault), so the native
  // cancel event never fires: catch it first, in the capture phase.
  function onEscape(e) {
    if (e.key !== "Escape" || !dialog) return;
    e.preventDefault();
    e.stopPropagation();
    closeDialog();
  }

  function kv(label, value) {
    const dl = el("div", "ghlps-kv-row");
    const dd = el("dd", null, typeof value === "string" ? value : null);
    if (typeof value !== "string") dd.append(value);
    dl.append(el("dt", null, label), dd);
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
    const where = pr.ok
      ? `${pr.repo} · ${s.id === "merged" ? "Merged" : s.id === "closed" ? "Closed" : s.id === "draft" ? "Draft" : "Open"}`
      : pr.denied
        ? "State not shown: the token needs Pull requests: Read (and Commit statuses or Checks)"
        : "State could not be read";
    sec.append(el("p", "ghlps-meta", where));
    const list = el("dl", "ghlps-kv");
    const failing = el("span", "ghlps-failing");
    const open = pr.ok && s.id !== "merged" && s.id !== "closed";
    const pill = (text, tone) => {
      const p = el("span", `ghlps-pill ghlps-tone-${tone}`, text);
      return p;
    };
    const checksTone = !pr.ok ? "neutral" : pr.checks === "FAILURE" || pr.checks === "ERROR" ? "bad" : pr.checks === "PENDING" || pr.checks === "EXPECTED" ? "warn" : "neutral";
    const reviewTone = !pr.ok ? "neutral" : pr.reviewDecision === "CHANGES_REQUESTED" ? "bad" : pr.reviewDecision === "REVIEW_REQUIRED" ? "warn" : "neutral";
    const checksRow = kv("Checks", open || !pr.ok ? pill(S.checksText(pr), checksTone) : "Not applicable");
    if (open && (pr.checks === "FAILURE" || pr.checks === "ERROR")) {
      checksRow.querySelector("dd").append(" ", failing);
      loadFailing(pr, failing);
    }
    list.append(checksRow, kv("Review", open || !pr.ok ? pill(S.reviewText(pr), reviewTone) : "Not applicable"));
    sec.append(list, el("p", "ghlps-next", `Next: ${S.nextStep(pr)}`));
    if (pr.url && pr.number) {
      const go = el("a", "ghlps-openpr", "Open PR ↗");
      go.href = pr.url;
      go.target = "_blank";
      go.rel = "noopener noreferrer";
      const actions = el("p", "ghlps-pr-actions");
      actions.append(go);
      sec.append(actions);
    }
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
    const sub = el(
      "p",
      "ghlps-sub",
      [`${info.owner}/${info.repo} #${info.number}`, info.title, `${prs.length} linked ${prs.length === 1 ? "PR" : "PRs"}`].filter(Boolean).join(" · ")
    );
    const body = el("div", "ghlps-body");
    const needs = prs.filter((p) => S.signalOf(p).attention).length;
    if (needs) {
      const banner = el("p", "ghlps-banner");
      banner.append(el("strong", null, `${needs} ${needs === 1 ? "PR needs" : "PRs need"} attention`));
      banner.append(" — a status summary, not a merge verdict.");
      body.append(banner);
    }
    body.append(sub, ...prs.map(prSection), el("p", "ghlps-note", "Review and checks are shown as GitHub reports them. Merge rules are not evaluated here."));
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
    document.addEventListener("keydown", onEscape, true);
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
    document.querySelector(".ghlps-hint")?.remove();
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
