// features/pr-triage/content.js — on a repository's own Pull requests page
// (github.com/<owner>/<repo>/pulls), adds PR triage next to GitHub's native
// list: a compact two-group personal panel plus contextual row labels.
// The panel lists only the currently loaded native rows, above the search box.
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
    if (!store.has(key)) store.set(key, { facts: new Map(), inflight: new Set(), status: "ready", until: 0, generation: 0 });
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
    const generation = ++entry.generation;
    numbers.forEach((n) => entry.inflight.add(n));
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE, payload: { owner: page.owner, repo: page.repo, numbers } });
    } catch {
      res = null;
    }
    numbers.forEach((n) => entry.inflight.delete(n));
    if (res && res.ok && res.facts) {
      if (generation === entry.generation) {
        entry.status = "ready";
        entry.until = 0;
      }
      for (const n of numbers) entry.facts.set(n, { at: Date.now(), value: res.facts[n] || { ok: false } });
    } else if (generation === entry.generation) {
      // A filter/page change can start a newer fetch before this one ends.
      // Older results may fill their own cache, but must not change the
      // current request's status or back-off period.
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

  // The panel sits right before the page's own "Pull requests" search
  // landmark (role + ARIA label, no class names), so search, filters, list and
  // pagination all stay below it. No landmark, no panel: never another place.
  function findSearch() {
    return [...document.querySelectorAll('[role="search"]')].find((el) => /^pull requests$/i.test(el.getAttribute("aria-label") || "")) || null;
  }

  function ensureBar(search) {
    let bar = document.getElementById(BAR_ID);
    if (bar && bar.nextElementSibling === search) return bar;
    bar?.remove();
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.className = "ghprt-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "My PR triage");
    bar.innerHTML =
      '<div class="ghprt-header"><h2>My PR triage</h2>' +
      '<span class="ghprt-title">On this page</span>' +
      '<span class="ghprt-summary" aria-live="polite"></span>' +
      '<button type="button" class="ghprt-collapse" aria-expanded="true" aria-controls="ghprt-groups">Collapse panel</button>' +
      '<button type="button" class="ghprt-hide">Hide triage</button></div>' +
      '<p class="ghprt-status" hidden></p>' +
      '<div class="ghprt-groups" id="ghprt-groups"></div>';
    const groups = bar.querySelector(".ghprt-groups");
    for (const [placement, title] of [["yours", "Needs my action"], ["waiting", "Waiting on others"]]) {
      const group = document.createElement("section");
      group.className = "ghprt-group";
      group.dataset.group = placement;
      group.setAttribute("aria-labelledby", `ghprt-heading-${placement}`);
      group.innerHTML = `<h3 id="ghprt-heading-${placement}">${title} <span class="ghprt-total"></span></h3>` +
        `<div class="ghprt-entries" role="list" aria-label="${title}"></div>` +
        '<p class="ghprt-empty"></p>' +
        '<button type="button" class="ghprt-more" hidden></button>';
      group.querySelector(".ghprt-more").addEventListener("click", () => {
        panelState.expanded[placement] = !panelState.expanded[placement];
        schedule();
      });
      groups.append(group);
    }
    bar.querySelector(".ghprt-collapse").addEventListener("click", () => {
      panelState.collapsed = !panelState.collapsed;
      schedule();
    });
    bar.querySelector(".ghprt-hide").addEventListener("click", () => {
      try {
        chrome.storage.local.set({ [STORAGE_ENABLED]: false });
      } catch {}
      teardown();
    });
    search.before(bar);
    return bar;
  }

  // Temporary view state, never stored. It follows the repository: a filter,
  // page or route change keeps it, another repository or a reload resets it.
  const panelState = { repo: "", collapsed: false, expanded: {} };
  const PREVIEW_LIMIT = 5;

  function renderGroups(bar, page, grouped, entry, loading, failed) {
    if (panelState.repo !== page.key) {
      panelState.repo = page.key;
      panelState.collapsed = false;
      panelState.expanded = {};
    }
    const status = bar.querySelector(".ghprt-status");
    const statusText = failed || "";
    if (status.textContent !== statusText) status.textContent = statusText;
    status.hidden = !failed;
    const groups = bar.querySelector(".ghprt-groups");
    groups.hidden = panelState.collapsed || !!failed;
    const toggle = bar.querySelector(".ghprt-collapse");
    toggle.hidden = !!failed; // nothing to collapse while one note replaces the groups
    const expanded = String(!panelState.collapsed);
    if (toggle.getAttribute("aria-expanded") !== expanded) {
      toggle.setAttribute("aria-expanded", expanded);
      toggle.textContent = panelState.collapsed ? "Expand panel" : "Collapse panel";
    }
    for (const placement of ["yours", "waiting"]) {
      const group = bar.querySelector(`[data-group="${placement}"]`);
      const items = grouped[placement];
      const total = group.querySelector(".ghprt-total");
      const number = loading ? "" : String(items.length);
      if (total.textContent !== number) total.textContent = number;
      const shown = panelState.expanded[placement] ? items : items.slice(0, PREVIEW_LIMIT);
      const signature = JSON.stringify(shown.map((e) => [e.number, e.href, e.title, e.label, e.hint]));
      const list = group.querySelector(".ghprt-entries");
      if (list.dataset.key !== signature) {
        list.dataset.key = signature;
        list.replaceChildren(...shown.map((e) => {
          const item = document.createElement("div");
          item.className = "ghprt-entry";
          item.setAttribute("role", "listitem");
          const link = document.createElement("a");
          link.className = "ghprt-link";
          link.href = e.href;
          link.textContent = e.title;
          const reason = document.createElement("span");
          reason.className = "ghprt-reason";
          reason.textContent = `#${e.number} · ${e.label}`;
          reason.title = e.hint;
          item.append(link, reason);
          return item;
        }));
      }
      const empty = group.querySelector(".ghprt-empty");
      const note = (loading && "Loading review data…") ||
        (grouped.unavailable && `None among the PRs that could be read (${grouped.unavailable} could not).`) ||
        (placement === "yours" ? "Nothing needs your action on this page." : "Nothing is waiting on others on this page.");
      if (empty.textContent !== note) empty.textContent = note;
      empty.hidden = items.length > 0;
      const more = group.querySelector(".ghprt-more");
      more.hidden = items.length <= PREVIEW_LIMIT;
      const moreText = panelState.expanded[placement] ? "Show fewer" : `Show ${items.length - PREVIEW_LIMIT} more`;
      if (more.textContent !== moreText) more.textContent = moreText;
      more.setAttribute("aria-expanded", String(!!panelState.expanded[placement]));
    }
  }

  // Header: plain counts (the entries below are the links), kept visible
  // while the panel is collapsed.
  function renderSummary(bar, grouped, loading, failed) {
    const sum = bar.querySelector(".ghprt-summary");
    const counts = [grouped.yours.length, grouped.waiting.length, grouped.team, grouped.unavailable];
    const key = JSON.stringify([loading, !!failed, counts]);
    if (sum.dataset.key === key) return;
    sum.dataset.key = key;
    const span = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });
    const parts = [];
    if (!loading && !failed) {
      parts.push(span(`ghprt-pill${counts[0] ? " ghprt-pill-yours" : ""}`, `${counts[0]} need my action`));
      parts.push(span("ghprt-pill", `${counts[1]} waiting on others`));
      const extra = [];
      if (counts[2]) extra.push(`${counts[2]} team request${counts[2] === 1 ? "" : "s"}`);
      if (counts[3]) extra.push(`${counts[3]} unavailable`);
      if (extra.length) parts.push(span("ghprt-note", `· ${extra.join(" · ")}`));
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

  function render(page, rows, search) {
    const me = currentUser();
    const entry = entryFor(page.key);
    const failed = entry.status !== "ready" && BAR_NOTES[entry.status] ? BAR_NOTES[entry.status] : "";
    const items = [];
    for (const row of rows) {
      const result = row.meta ? labelFor(me, entry, row) : null;
      // Rows only get a label with an answer for them; the panel's note
      // covers a failure of the whole request.
      const shown = failed ? null : result;
      if (row.meta) applyLabel(row, shown);
      if (!shown) row.li.removeAttribute("data-ghprt-placement");
      items.push({ number: row.number, title: row.link.textContent.trim(), href: row.link.href, result: shown });
    }
    if (!search) return document.getElementById(BAR_ID)?.remove(); // no anchor: no panel, retry on the next scan
    const loading = !failed && rows.some((r) => r.triaged && !entry.facts.has(r.number)) && entry.status === "ready";
    const grouped = C.groupEntries(items);
    const bar = ensureBar(search);
    renderSummary(bar, grouped, loading, failed);
    renderGroups(bar, page, grouped, entry, loading, failed);
  }

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
    if (!rows.some((r) => r.triaged)) return teardown(); // nothing to triage here: do nothing, retry on the next scan
    const entry = entryFor(page.key);
    const need = wanted(entry, rows);
    if (need.length) fetchFacts(page, need);
    render(page, rows, findSearch());
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
    attributeFilter: ["data-testid", "href", "aria-label", "role"], // an anchor coming back
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
