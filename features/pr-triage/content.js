// features/pr-triage/content.js — on a repository's own Pull requests page
// (github.com/<owner>/<repo>/pulls), adds PR triage next to GitHub's native
// list: one small label on each open row saying whose move it is ("Your
// turn · Review requested", "Waiting on author", ...) and a one-line "On
// this page" bar whose buttons jump to the matching rows.
//
// Nothing native is hidden, moved or duplicated, and the list never waits
// for the extension: rows are read from the page, the review facts come
// from the background (one batched GraphQL query per page of visible
// numbers) and the labels appear when they arrive. Rows are found through
// data-testid hooks and ARIA labels, never CSS-module classes; if an anchor
// is missing the script does nothing and tries again on the next scan.
// The decisions live in classify.js (loaded first).

(function () {
  const BAR_ID = "ghprt-bar";
  const STORAGE_ENABLED = "ghprtEnabled";
  const MESSAGE_TYPE = "GHPRT_FETCH"; // matches background/pr-triage.js
  const TTL_MS = 60_000;
  const C = globalThis.GHPRT_CLASSIFY;

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function repoOfPage() {
    const m = /^\/([^/]+)\/([^/]+)\/pulls\/?$/.exec(location.pathname);
    return m ? { owner: m[1], repo: m[2], key: `${m[1]}/${m[2]}`.toLowerCase() } : null;
  }

  function currentUser() {
    return document.querySelector('meta[name="user-login"]')?.getAttribute("content") || "";
  }

  // --- reading the native list -------------------------------------------

  // Rows: the <li> around each title link. Only rows whose state icon says
  // open or draft are triaged; anything else (closed, merged) is left alone.
  function findRows() {
    const rows = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[data-testid="listitem-title-link"]')) {
      const li = a.closest("li");
      const number = Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute("href") || "")?.[1]);
      if (!li || !number || seen.has(li)) continue;
      seen.add(li);
      const icon = [...li.querySelectorAll("svg[aria-label]")].map((s) => s.getAttribute("aria-label")).find((l) => /pull request$/i.test(l));
      const triaged = /^(open|draft) pull request$/i.test(icon || "");
      const meta = li.querySelector('[data-testid="timestamp-container"]')?.parentElement || null;
      rows.push({ li, link: a, number, triaged, meta });
    }
    return rows;
  }

  // --- data ---------------------------------------------------------------

  // One entry per repository seen: facts by number with their fetch time,
  // plus a request status. Statuses other than "ready" back off for TTL_MS.
  const store = new Map();
  function entryFor(key) {
    if (!store.has(key)) store.set(key, { facts: new Map(), inflight: new Set(), status: "ready", until: 0 });
    return store.get(key);
  }

  function statusFromError(res) {
    const msg = String(res?.error || "");
    if (res?.status === 429 || /rate limit/i.test(msg)) return "rate";
    if (res && (res.hasToken === false || /No GitHub token/.test(msg))) return "notoken";
    if (res?.status === 401 || res?.status === 403) return "denied";
    return "error";
  }

  async function fetchFacts(page, numbers) {
    const entry = entryFor(page.key);
    numbers.forEach((n) => entry.inflight.add(n));
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload: { owner: page.owner, repo: page.repo, numbers } });
    } catch {
      res = null;
    }
    numbers.forEach((n) => entry.inflight.delete(n));
    if (res && res.ok && res.facts) {
      entry.status = "ready";
      entry.until = 0;
      for (const n of numbers) entry.facts.set(n, { at: Date.now(), value: res.facts[n] || { ok: false } });
    } else {
      entry.status = statusFromError(res);
      entry.until = Date.now() + TTL_MS;
    }
    schedule();
    // Nothing else wakes a static page when the back-off ends or the cached
    // facts expire, so a rescan is scheduled for that moment.
    setTimeout(schedule, TTL_MS + 50);
  }

  function wanted(entry, rows) {
    if (entry.status !== "ready" && Date.now() < entry.until) return [];
    return rows
      .filter((r) => r.triaged && !entry.inflight.has(r.number))
      .filter((r) => {
        const f = entry.facts.get(r.number);
        return !f || Date.now() - f.at > TTL_MS;
      })
      .map((r) => r.number);
  }

  // --- rendering ----------------------------------------------------------

  const BAR_NOTES = {
    notoken: "Triage needs a GitHub token for this repository owner, with Pull requests: Read (Settings → GitHub tokens).",
    denied: "Triage could not read this repository with your token. It needs Pull requests: Read.",
    rate: "GitHub rate limit, retrying later.",
  };

  function labelFor(me, entry, row) {
    if (!row.triaged) return null;
    const cached = entry.facts.get(row.number);
    if (!cached) {
      // Without any answer yet: nothing, unless the whole request failed in a
      // way the bar does not already explain.
      return entry.status === "error" ? C.classify(me, null) : null;
    }
    const r = C.classify(me, cached.value);
    return r.placement ? r : null;
  }

  function ensureBar(list) {
    let bar = document.getElementById(BAR_ID);
    if (bar && bar.nextElementSibling === list) return bar;
    bar?.remove();
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.className = "ghprt-bar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "PR triage");
    bar.innerHTML =
      '<span class="ghprt-title">On this page</span>' +
      '<span class="ghprt-summary" aria-live="polite"></span>' +
      '<button type="button" class="ghprt-hide">Hide triage</button>';
    bar.querySelector(".ghprt-hide").addEventListener("click", () => {
      try {
        chrome.storage.local.set({ [STORAGE_ENABLED]: false });
      } catch {}
      teardown();
    });
    list.before(bar);
    return bar;
  }

  function jumpButton(placement, count, text) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghprt-count";
    b.dataset.jump = placement;
    b.textContent = `${count} ${text}`;
    b.setAttribute("aria-label", `${count} ${text}: go to the next one`);
    return b;
  }

  function renderBar(bar, entry, counts, loading) {
    const sum = bar.querySelector(".ghprt-summary");
    const failed = entry.status !== "ready" && BAR_NOTES[entry.status];
    const empty = !counts.yours && !counts.waiting && !counts.unavailable;
    const note = failed || (loading && "Loading review data…") || (empty && "Nothing waiting on you.") || "";
    const key = JSON.stringify([note, counts]);
    if (sum.dataset.key === key) return;
    sum.dataset.key = key;
    const text = (s) => Object.assign(document.createElement("span"), { className: "ghprt-note", textContent: s });
    const parts = [];
    if (note) parts.push(text(note));
    else {
      if (counts.yours) parts.push(jumpButton("yours", counts.yours, "your turn"));
      if (counts.waiting) parts.push(jumpButton("waiting", counts.waiting, "waiting on others"));
      if (counts.unavailable) parts.push(text(`${counts.unavailable} unavailable`));
    }
    sum.replaceChildren(...parts);
  }

  function applyLabel(row, result) {
    let el = row.meta.querySelector(":scope > [data-ghprt]");
    if (!result) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("span");
      row.meta.append(el);
    }
    const shownText = result.placement === "yours" ? `Your turn · ${result.label}` : result.label;
    if (el.dataset.ghprt !== result.placement || el.textContent !== shownText || el.title !== result.title) {
      el.className = `ghprt-label ghprt-${result.placement}`;
      el.dataset.ghprt = result.placement;
      el.textContent = shownText;
      el.title = result.title;
    }
    row.li.dataset.ghprtPlacement = result.placement;
  }

  function render(page, rows, list) {
    const me = currentUser();
    const entry = entryFor(page.key);
    const bar = ensureBar(list);
    const placements = [];
    for (const row of rows) {
      const result = row.meta ? labelFor(me, entry, row) : null;
      // Rows only get a label with an answer for them; the bar's note covers
      // a failure of the whole request.
      const shown = BAR_NOTES[entry.status] && entry.status !== "ready" ? null : result;
      if (row.meta) applyLabel(row, shown);
      if (!shown) row.li.removeAttribute("data-ghprt-placement");
      placements.push(shown ? shown.placement : null);
    }
    const loading = rows.some((r) => r.triaged && !entry.facts.has(r.number)) && entry.status === "ready";
    renderBar(bar, entry, C.summarize(placements), loading);
  }

  // Count buttons move focus to the next matching row's title link, cycling.
  // Focus sits on the button while clicking, so the last target is remembered.
  let lastJump = null;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(`#${BAR_ID} [data-jump]`);
    if (!btn) return;
    const matches = [...document.querySelectorAll(`li[data-ghprt-placement="${btn.dataset.jump}"]`)];
    if (!matches.length) return;
    const from = lastJump?.isConnected && matches.includes(lastJump) ? lastJump : document.activeElement?.closest?.("li");
    lastJump = matches[(matches.indexOf(from) + 1) % matches.length];
    const link = lastJump.querySelector('a[data-testid="listitem-title-link"]');
    link?.focus();
    link?.scrollIntoView({ block: "center" });
  });

  function teardown() {
    document.getElementById(BAR_ID)?.remove();
    document.querySelectorAll("[data-ghprt]").forEach((el) => el.remove());
    document.querySelectorAll("[data-ghprt-placement]").forEach((el) => el.removeAttribute("data-ghprt-placement"));
  }

  async function sync() {
    if (!extensionAlive()) return;
    const page = repoOfPage();
    if (!page) return teardown();
    let enabled;
    try {
      enabled = (await chrome.storage.local.get(STORAGE_ENABLED))[STORAGE_ENABLED];
    } catch {
      return;
    }
    if (enabled === false || !currentUser()) return teardown();

    const rows = findRows();
    const list = rows.find((r) => r.triaged)?.li.parentElement;
    if (!list) return teardown(); // nothing to triage here, or no anchor: do nothing, retry on the next scan
    const entry = entryFor(page.key);
    const need = wanted(entry, rows);
    if (need.length) fetchFacts(page, need);
    render(page, rows, list);
  }

  let timer;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, 150);
  }

  document.addEventListener("turbo:load", schedule);
  document.addEventListener("turbo:render", schedule);
  document.addEventListener("pjax:end", schedule);
  window.addEventListener("popstate", schedule);

  chrome.storage.onChanged.addListener((changes) => {
    if (extensionAlive() && changes[STORAGE_ENABLED]) schedule();
  });

  // React re-renders the list on filter, sort and page changes, and may drop
  // our nodes: watch the document, re-asserting from cached facts. sync() is
  // idempotent, so our own mutations settle after one more pass.
  const observer = new MutationObserver(() => {
    if (!extensionAlive()) return observer.disconnect();
    if (repoOfPage() || document.getElementById(BAR_ID)) schedule();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid", "href", "aria-label"], // an anchor coming back
  });

  let lastUrl = location.href;
  const pollId = setInterval(() => {
    if (!extensionAlive()) return clearInterval(pollId);
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule();
    }
  }, 800);

  schedule();
})();
