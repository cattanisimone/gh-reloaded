// features/notifications/engine.js — the headless engine: scans the inbox the
// page has loaded, asks the background for the facts the classifier needs,
// classifies every notification into exactly one section and exposes the
// result (plus loading, coverage, capability and rate-limit state) to the
// registered modules. It renders nothing and never touches the page: no row
// is hidden, moved or marked, and nothing is written to GitHub.
//
// Behaviour worth knowing:
//  - A classified row keeps its section until newer data replaces it, so
//    rows do not jump while later pages load or a request is rate limited.
//  - Facts are cached for 60 s per notification; the Notifications API is
//    read at most once per 60 s.
//  - With 0 rows on the page the engine makes no request at all.
//  - On a rate limit one timer re-scans at the time GitHub indicated.
//
// Dependencies are injected so the unit tests can drive it with a fake clock.

(function (global) {
  const TTL_MS = 60_000;

  function createEngine({ collect, mergeApi, fromApiItem, send, classify, needsFacts, getWindowDays = () => 7, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    const facts = new Map(); // key -> { at, value }
    const results = new Map(); // key -> classification, kept across scans
    const listeners = new Set();
    let api = { at: 0, state: "not-tried", items: [] };
    let capabilities = {};
    let rate = { limited: false, retryAt: null };
    let timer = null;
    let inflight = null;
    let rescan = false;
    let active = false;
    let state = emptyState();

    function emptyState() {
      return { phase: "idle", items: [], coverage: { loaded: 0, total: null, partial: true }, capabilities: {}, rateLimited: false, retryAt: null, me: "" };
    }

    function publish(next) {
      // Identical state is not news: a module that renders on publish would
      // otherwise re-trigger the page observer and loop.
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      for (const fn of [...listeners]) {
        try {
          fn(state);
        } catch {
          /* a module must not break the engine */
        }
      }
    }

    // Facts are read for one reason (a review request and a mention read
    // different things), so facts read for another reason are not reused: a
    // thread whose reason changes while the page is open is read again.
    function fresh(row) {
      const f = facts.get(row.key);
      return !!f && f.reason === row.reason && now() - f.at < TTL_MS;
    }
    const factsFor = (row) => {
      const f = facts.get(row.key);
      return f && f.reason === row.reason ? f : undefined;
    };

    function build(page, phase) {
      const apiRows = api.state === "ok" ? api.items.map(fromApiItem) : [];
      const merged = mergeApi(page.rows, apiRows);
      const ctx = { me: page.me, windowDays: getWindowDays(), rateLimited: rate.limited };
      const items = merged.map((row) => {
        const f = factsFor(row)?.value;
        const pending = needsFacts(row) && !f && phase === "loading";
        let r = pending ? null : classify({ row, facts: f, ctx, now: now() });
        // What was classified before counts only for the same reason: a row
        // whose reason just changed is pending until it is read again.
        const prevEntry = results.get(row.key);
        const prev = prevEntry && prevEntry.reason === row.reason ? prevEntry.result : null;
        // A rate limit never demotes a row that was already classified.
        if (r && rate.limited && r.rule === 1 && prev && prev.rule !== 1) r = prev;
        if (r) results.set(row.key, { reason: row.reason, result: r });
        else if (prev && !f) r = prev;
        return { key: row.key, kind: row.kind, owner: row.owner || "", repo: row.repo || "", reason: row.reason, rawLabel: row.rawLabel || "", readAt: factsFor(row)?.at ?? null, tokenLogin: f?.viewer || "", inPage: row.inPage !== false, pending: !r, ...(r || {}) };
      });
      return { phase, items, coverage: { loaded: merged.length, total: null, partial: true }, capabilities: { ...capabilities, "api:notifications": api.state }, rateLimited: rate.limited, retryAt: rate.retryAt, me: page.me };
    }

    // One pass: collect, ask the background for what is missing, classify.
    async function pass() {
      const page = collect();
      if (!page.rows.length) {
        publish({ ...emptyState(), phase: "ready", me: page.me });
        return;
      }
      const rateBlocked = rate.limited && rate.retryAt != null && now() < rate.retryAt;
      const apiStale = now() - api.at >= TTL_MS;
      // The effective reason (REST wins over the label) decides what is read.
      const known = mergeApi(page.rows, api.state === "ok" ? api.items.map(fromApiItem) : []);
      const wanted = known.filter((r) => r.inPage !== false && (r.kind === "pull" || r.kind === "issue") && !fresh(r));
      if (rateBlocked || (!wanted.length && !apiStale)) {
        publish(build(page, "ready"));
        return;
      }
      publish(build(page, "loading"));
      let res = null;
      try {
        res = await send({ rows: wanted.map(({ key, kind, owner, repo, number, reason }) => ({ key, kind, owner, repo, number, reason })), api: apiStale });
      } catch {
        res = null;
      }
      if (!active) return;
      apply(res, wanted);
      publish(build(collect(), "ready"));
    }

    // Passes never overlap: a scan asked for while one runs makes it run once
    // more when it ends, and every caller awaits the same promise.
    function scan() {
      if (!active) return Promise.resolve();
      if (inflight) {
        rescan = true;
        return inflight;
      }
      inflight = (async () => {
        try {
          do {
            rescan = false;
            await pass();
          } while (rescan && active);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    }

    function apply(res, wanted) {
      const at = now();
      if (!res || !res.ok) {
        for (const r of wanted) facts.set(r.key, { at, reason: r.reason, value: { ok: false, why: "request failed" } });
        return;
      }
      rate = { limited: !!res.rateLimited, retryAt: res.retryAt ?? null };
      capabilities = { ...capabilities, ...res.capabilities };
      if (res.api) {
        api = { at, state: res.api.state, items: res.api.items || [] };
        if (res.api.state !== "not-tried") capabilities["api:notifications"] = res.api.state;
      }
      // The background knows the effective reason (REST wins over the label).
      const reasonOf = (key) => res.reasons?.[key] ?? wanted.find((r) => r.key === key)?.reason;
      for (const [key, value] of Object.entries(res.facts || {})) {
        // A rate-limited answer is not a fact: keep what we had and retry later.
        if (!value.ok && rate.limited && value.why === "rate limited") continue;
        facts.set(key, { at, reason: reasonOf(key), value });
      }
      for (const r of wanted) if (!facts.has(r.key) || facts.get(r.key).reason !== reasonOf(r.key)) facts.set(r.key, { at, reason: reasonOf(r.key), value: { ok: false, why: "no answer" } });
      if (rate.limited) {
        clearTimer(timer);
        const wait = Math.max((rate.retryAt ?? now() + TTL_MS) - now(), 0) + 50;
        timer = setTimer(() => {
          rate = { limited: false, retryAt: null };
          for (const [k, f] of [...facts]) if (!f.value.ok) facts.delete(k);
          api = { ...api, at: 0 };
          scan();
        }, wait);
      }
    }

    return {
      start() {
        if (active) return;
        active = true;
        return scan();
      },
      stop() {
        active = false;
        clearTimer(timer);
        timer = null;
        rescan = false;
        results.clear();
        facts.clear();
        api = { at: 0, state: "not-tried", items: [] };
        capabilities = {};
        rate = { limited: false, retryAt: null };
        publish(emptyState());
      },
      scan,
      // Window setting changed: classify again from cached facts, no request.
      reclassify() {
        if (active && state.phase !== "idle") publish(build(collect(), state.phase));
      },
      getState: () => state,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      isActive: () => active,
    };
  }

  global.GHNT_ENGINE = { createEngine };
})(typeof window !== "undefined" ? window : globalThis);
