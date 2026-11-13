// features/notifications/fill.js — reads notifications beyond the current inbox
// page, on intent only, through the Notifications API the engine already uses.
// A pure controller with injected send functions, clock, sleep and visibility
// (like engine.js), so every rule is unit-tested with a fake clock. No DOM.
//
// What it keeps, in this tab's memory only: per normalised native query, the
// API items read (120 s), the lookup facts for outside review requests and
// mentions (60 s), how many REST pages were read and whether another exists.
// What it never does: read inbox HTML, write to GitHub, run on page load or in
// the background, or keep anything after a reload.
//
// Budgets per fill: 4 REST pages (one at a time, >= 250 ms apart), 12 lookup
// batches (2 in flight), 8 s; a ceiling of 20 REST pages per query per tab
// (the baseline pages included); target 10 matches for a selected category.
// Abort (query or URL change, Stop, a new fill, clear) bumps a generation: an
// answer of an older generation is dropped unread.
//
// summarize() is the invariant: page rows + outside entries + not verified = m.
// Only pull requests and issues are listed outside; anything that cannot be
// keyed like a page row (Discussion, CheckSuite, commit, release, alert…) is an
// unkeyable item that is counted as "not verified", never listed.

(function (global) {
  const ITEMS_MS = 120_000;
  const FACTS_MS = 60_000;
  const LIMITS = { target: 10, pages: 4, batches: 12, ms: 8000, spacing: 250, ceiling: 20, batchSize: 25, inFlight: 2 };
  const LABEL_CATS = ["informational", "unverifiable"];
  const LOOKUP_CATS = ["attention", "waiting"];

  function createFill({ sendPage, sendLookup, collect, query, classify, needsFacts, getPage, getWindowDays = () => 7, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isVisible = () => true, limits = {} }) {
    const L = { ...LIMITS, ...limits };
    const entries = new Map(); // query key -> entry
    const listeners = new Set();
    let q = query.analyse("/notifications");
    let entry = null;
    let apiState = "not-tried"; // the engine's last answer for the baseline read
    let apiAt = 0;
    let gen = 0;
    let run = null; // { category, grouped, gen, startedAt }
    let visibleWaiters = [];
    let pageHref = "";
    let clearedAt = -1;
    const stats = { fills: 0, rest: 0, notModified: 0, batches: 0, lastElapsedMs: 0, lastStopReason: "", nextClicks: 0 };

    const emit = () => {
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          /* a view must not break the controller */
        }
      }
    };

    function newEntry() {
      return { items: new Map(), facts: new Map(), pages: 0, next: false, at: 0, lastModified: "", pollUntil: 0, filled: {}, denied: new Set(), error: null, retryAt: null, stopped: false, ended: null };
    }

    function setQuery(next) {
      if (next.key === q.key) {
        q = next;
        return;
      }
      abort();
      q = next;
      entry = entries.get(q.key) || null;
    }

    // The engine's baseline read of this query (its raw API items): items already
    // read cost nothing, so a selection starts from them. Merged, never replaced.
    function seed(api) {
      apiState = api?.state || "not-tried";
      apiAt = api?.at || 0;
      if (!api || api.state !== "ok" || api.key !== q.key || !q.supported || api.at < clearedAt) return;
      let e = entries.get(q.key);
      if (!e || now() - e.at >= ITEMS_MS) {
        e = newEntry();
        entries.set(q.key, e);
      }
      for (const raw of api.items || []) {
        const it = collect.fromApiItem(raw);
        if (!e.items.has(it.key)) e.items.set(it.key, it);
      }
      if ((api.pages || 0) >= e.pages) {
        e.pages = api.pages || e.pages;
        e.next = !!api.next;
      }
      if (api.lastModified && !e.lastModified) e.lastModified = api.lastModified;
      e.at = Math.max(e.at, api.at || now());
      entry = e;
    }

    // ---- what the view shows -------------------------------------------------

    // The invariant over page rows, outside entries and items not verified.
    function summarize() {
      const page = getPage();
      const out = { outside: [], k: 0, u: 0, pending: 0, pageRows: page.rows.length, m: page.rows.length, byCat: { attention: 0, waiting: 0, informational: 0, unverifiable: 0 }, denied: false };
      if (!entry) return out;
      out.denied = entry.denied.size > 0;
      const onPage = new Set(page.rows.map((r) => r.key));
      const matching = [...entry.items.values()].filter((i) => query.matches(q.filter, i));
      const gone = collect.absorbed(page.rows, matching);
      const ctx = { me: page.me, windowDays: getWindowDays(), rateLimited: false };
      for (const item of matching) {
        if (gone.has(item.key) || onPage.has(item.key)) continue;
        if (item.unkeyable) {
          out.u++;
          out.k++;
          continue;
        }
        const row = { reason: item.reason, kind: item.kind, rawLabel: "" };
        const f = entry.facts.get(item.key);
        if (needsFacts(row) && !f) {
          out.pending++;
          out.k++;
          continue;
        }
        const r = classify({ row, facts: f?.value, ctx, now: now() });
        out.outside.push({ ...item, category: r.section, rule: r.rule, evidence: r.evidence, at: r.at || "" });
        out.byCat[r.section]++;
      }
      out.m = page.rows.length + out.outside.length + out.k;
      return out;
    }

    function snapshot() {
      const s = summarize();
      return {
        supported: q.supported,
        unsupported: q.unsupported,
        queryKey: q.key,
        apiState,
        active: !!entry && apiState === "ok" && q.supported,
        running: !!run,
        runCategory: run?.category || null,
        stopped: !!entry?.stopped,
        ended: entry?.ended || null,
        pages: entry?.pages || 0,
        next: !!entry?.next,
        ceiling: !!entry?.next && (entry?.pages || 0) >= L.ceiling,
        retryAt: entry?.retryAt || null,
        error: entry?.error || null,
        filledKeys: Object.keys(entry?.filled || {}),
        summary: s,
      };
    }

    // ---- reading -------------------------------------------------------------

    function waitVisible() {
      if (isVisible()) return Promise.resolve();
      return new Promise((r) => visibleWaiters.push(r));
    }
    function notifyVisible() {
      const w = visibleWaiters;
      visibleWaiters = [];
      for (const r of w) r();
    }

    function absorbPage(e, res, first) {
      if (first) e.lastModified = res.lastModified || e.lastModified;
      if (res.pollInterval) e.pollUntil = now() + res.pollInterval * 1000;
      for (const raw of res.items || []) {
        const it = collect.fromApiItem(raw);
        if (!e.items.has(it.key)) e.items.set(it.key, it);
      }
      e.at = now();
    }

    // Page 1 again when the items are older than 120 s: If-Modified-Since when a
    // Last-Modified is known (a 304 keeps the list), X-Poll-Interval honoured.
    async function refresh(e, myGen) {
      if (now() - e.at < ITEMS_MS || now() < e.pollUntil) return true;
      const res = await sendPage({ page: 1, all: q.params.all, participating: q.params.participating, ifModifiedSince: e.lastModified || undefined });
      stats.rest++;
      if (myGen !== gen) return false;
      if (res?.ok && res.notModified) {
        stats.notModified++;
        e.at = now();
        if (res.pollInterval) e.pollUntil = now() + res.pollInterval * 1000;
        return true;
      }
      if (res?.ok) {
        e.items.clear();
        absorbPage(e, res, true);
        e.pages = 1;
        e.next = !!res.next;
        return true;
      }
      return failed(e, res);
    }

    function failed(e, res) {
      if (res?.failure === "rate-limited") e.retryAt = res.retryAt ?? now() + 60_000;
      else e.error = res?.failure === "no-answer" || !res ? "no-answer" : "refused";
      return false;
    }

    const candidates = (e, looked) => {
      const page = getPage();
      const onPage = new Set(page.rows.map((r) => r.key));
      const matching = [...e.items.values()].filter((i) => !i.unkeyable && !onPage.has(i.key) && query.matches(q.filter, i) && needsFacts(i));
      const stalest = (i) => {
        const f = e.facts.get(i.key);
        return !f ? 0 : 1;
      };
      return matching.filter((i) => !looked.has(i.key) && (!e.facts.has(i.key) || now() - e.facts.get(i.key).at >= FACTS_MS)).sort((a, b) => stalest(a) - stalest(b));
    };

    function batchesOf(list) {
      const byRepo = new Map();
      for (const i of list) {
        const id = `${i.owner}/${i.repo}`.toLowerCase();
        byRepo.set(id, [...(byRepo.get(id) || []), i]);
      }
      const out = [];
      for (const rows of byRepo.values()) for (let n = 0; n < rows.length; n += L.batchSize) out.push(rows.slice(n, n + L.batchSize));
      return out;
    }

    async function lookup(e, batch, looked, myGen) {
      const rows = batch.map(({ key, kind, owner, repo, number, reason }) => ({ key, kind, owner, repo, number, reason }));
      for (const r of rows) looked.add(r.key);
      stats.batches++;
      const res = await sendLookup({ rows, api: false });
      if (myGen !== gen) return "aborted";
      if (!res?.ok) {
        e.error = "no-answer";
        return "error";
      }
      for (const [cap, state] of Object.entries(res.capabilities || {})) if (cap.startsWith("pr:") && state === "denied") e.denied.add(cap.slice(3));
      const at = now();
      for (const [key, value] of Object.entries(res.facts || {})) {
        if (!value.ok && res.rateLimited && value.why === "rate limited") continue;
        e.facts.set(key, { at, value });
      }
      if (res.rateLimited) {
        e.retryAt = res.retryAt ?? now() + 60_000;
        return "rate-limited";
      }
      return "ok";
    }

    // One fill. opts: { category | null, grouped, force }
    async function start(opts = {}) {
      if (!entry || apiState !== "ok" || !q.supported) return "unavailable";
      const e = entry;
      if (e.retryAt && now() < e.retryAt) return "rate-limited";
      const category = opts.grouped ? null : opts.category || null;
      const filledKey = opts.grouped ? "*" : category;
      if (!opts.force && e.filled[filledKey]) return "filled";
      abort(true);
      const myGen = ++gen;
      run = { category, grouped: !!opts.grouped, gen: myGen };
      e.stopped = false;
      e.ended = null;
      e.error = null;
      e.retryAt = null;
      stats.fills++;
      const t0 = now();
      let deadline = t0 + L.ms;
      let pages = 0;
      let batches = 0;
      let lastRest = 0;
      const looked = new Set();
      const wantLookups = !category || LOOKUP_CATS.includes(category);
      let reason = "complete";
      emit();
      try {
        if (!(await refresh(e, myGen))) {
          if (myGen !== gen) return "aborted";
          reason = e.retryAt ? "rate-limited" : "error";
          return reason;
        }
        for (;;) {
          if (myGen !== gen) return "aborted";
          if (!isVisible()) {
            const paused = now();
            await waitVisible();
            deadline += now() - paused;
            if (myGen !== gen) return "aborted";
          }
          const sum = summarize();
          if (category) {
            const mine = getPage().counts?.[category] || 0;
            if (mine + sum.byCat[category] >= L.target) {
              reason = "target";
              break;
            }
          }
          if (now() >= deadline) {
            reason = "budget";
            break;
          }
          if (wantLookups) {
            const todo = batchesOf(candidates(e, looked));
            if (todo.length) {
              if (batches >= L.batches) {
                reason = "budget";
                break;
              }
              const take = todo.slice(0, Math.min(L.inFlight, L.batches - batches));
              batches += take.length;
              const results = await Promise.all(take.map((b) => lookup(e, b, looked, myGen)));
              if (myGen !== gen) return "aborted";
              emit();
              if (results.includes("rate-limited")) {
                reason = "rate-limited";
                break;
              }
              if (results.includes("error")) {
                reason = "error";
                break;
              }
              continue;
            }
          }
          if (!e.next) {
            reason = "complete";
            break;
          }
          if (e.pages >= L.ceiling) {
            reason = "ceiling";
            break;
          }
          if (pages >= L.pages) {
            reason = "budget";
            break;
          }
          const wait = lastRest + L.spacing - now();
          if (wait > 0) {
            await sleep(wait);
            if (myGen !== gen) return "aborted";
          }
          lastRest = now();
          const res = await sendPage({ page: e.pages + 1, all: q.params.all, participating: q.params.participating });
          stats.rest++;
          pages++;
          if (myGen !== gen) return "aborted";
          if (!res?.ok) {
            failed(e, res);
            reason = e.retryAt ? "rate-limited" : "error";
            break;
          }
          absorbPage(e, res, false);
          e.pages++;
          e.next = !!res.next;
          emit();
        }
      } finally {
        if (myGen === gen) {
          run = null;
          e.ended = reason;
          e.filled[filledKey] = true;
          stats.lastElapsedMs = now() - t0;
          stats.lastStopReason = reason;
          emit();
        }
      }
      return reason;
    }

    // Stop, a query or URL change, a new fill, a module stop: the answer of an
    // older generation is dropped unread. `quiet` is for a fill replacing another.
    function abort(quiet) {
      if (!run && !quiet) return;
      gen++;
      run = null;
      notifyVisible();
      if (!quiet) emit();
    }

    function stop() {
      if (!run) return;
      if (entry) {
        entry.stopped = true;
        entry.filled[run.grouped ? "*" : run.category] = true;
      }
      stats.lastStopReason = "user";
      abort();
    }

    // Page navigation: no fill until the user acts again; the cache stays.
    function notePage(href) {
      if (href === pageHref) return;
      pageHref = href;
      abort();
      if (entry) entry.filled = {};
    }

    // A native Done, Save, Unsubscribe or mark action: nothing read stays.
    function clear() {
      abort();
      entries.clear();
      entry = null;
      clearedAt = now();
    }

    function reset() {
      clear();
      apiState = "not-tried";
      q = query.analyse("/notifications");
      pageHref = "";
      clearedAt = -1;
    }

    return {
      setQuery,
      seed,
      start,
      stop,
      abort: () => abort(),
      clear,
      reset,
      notePage,
      notifyVisible,
      snapshot,
      summarize,
      isRunning: () => !!run,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      stats,
      limits: L,
    };
  }

  global.GHNT_FILL = { createFill, LIMITS, LABEL_CATS, LOOKUP_CATS };
})(typeof window !== "undefined" ? window : globalThis);
