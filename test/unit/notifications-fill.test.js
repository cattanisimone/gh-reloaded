// features/notifications/fill.js: the controller that reads more notifications
// on intent, with a fake clock, fake sends and a fake visibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/query.js", "features/notifications/collect.js", "features/notifications/classify.js", "features/notifications/fill.js"]);
const { GHNT_FILL: F, GHNT_COLLECT: C, GHNT_CLASSIFY: K, GHNT_QUERY: Q } = g;
const j = (v) => JSON.parse(JSON.stringify(v));

const pr = (n, reason = "subscribed", over = {}) => ({ id: `T${n}`, reason, unread: true, updated_at: "2026-11-01T10:00:00Z", subject: { url: `https://api.github.com/repos/acme/web/pulls/${n}`, type: "PullRequest", title: `Change ${n}` }, repository: { full_name: "acme/web" }, ...over });
const other = (id, type, title, over = {}) => ({ id, reason: "ci_activity", unread: true, subject: { url: null, type, title }, repository: { full_name: "acme/web" }, ...over });

// pages: array of item arrays (the REST pages after the baseline)
function rig({ pages = [], baseline = 1, apiPages, pageRows = [], me = "mira", counts = {}, facts = () => null, search = "/notifications", visible = { v: true }, limits } = {}) {
  const log = [];
  const clock = { t: 1_000_000 };
  const all = pages;
  const fill = F.createFill({
    now: () => clock.t,
    sleep: async (ms) => {
      log.push({ sleep: ms });
      clock.t += ms;
    },
    isVisible: () => visible.v,
    collect: C,
    query: Q,
    classify: K.classify,
    needsFacts: K.needsFacts,
    getPage: () => ({ rows: pageRows, me, counts }),
    limits,
    sendPage: async (p) => {
      log.push({ rest: p.page, at: clock.t, ims: p.ifModifiedSince });
      clock.t += 20;
      if (rig.nextPage) {
        const r = rig.nextPage(p);
        if (r) return r;
      }
      const items = all[p.page - 1] || [];
      return { ok: true, items, next: p.page < all.length, lastModified: "LM", pollInterval: 0 };
    },
    sendLookup: async ({ rows }) => {
      log.push({ lookup: rows.length, at: clock.t });
      clock.t += 20;
      return facts(rows) || { ok: true, facts: Object.fromEntries(rows.map((r) => [r.key, { ok: false, why: "pull request not readable" }])), capabilities: {}, rateLimited: false };
    },
  });
  fill.setQuery(Q.analyse(search));
  const baseItems = all.slice(0, baseline).flat();
  fill.seed({ state: "ok", key: Q.paramsKey(Q.analyse(search)), items: baseItems, pages: baseline, next: all.length > baseline, at: clock.t, lastModified: "LM" });
  return { fill, log, clock, restPages: () => log.filter((l) => l.rest).map((l) => l.rest) };
}
rig.nextPage = null;

const range = (a, b, reason) => Array.from({ length: b - a + 1 }, (_, i) => pr(a + i, reason));

test("fill: seeded items cost nothing: the baseline is already summarised", () => {
  const r = rig({ pages: [range(1, 50, "subscribed")] });
  const s = r.fill.summarize();
  assert.equal(s.outside.length, 50);
  assert.equal(r.log.length, 0);
});

test("fill: stops at the target of 10 matches for the selected category", async () => {
  const r = rig({ pages: [range(1, 5, "ci_activity"), range(6, 20, "subscribed"), range(21, 70, "subscribed")], baseline: 1, counts: { informational: 5 } });
  const reason = await r.fill.start({ category: "informational" });
  assert.equal(reason, "target");
  assert.deepEqual(j(r.restPages()), []);
});

test("fill: at most 4 REST pages per fill, then 'budget'; Load more reads 4 more", async () => {
  const pages = Array.from({ length: 12 }, (_, i) => []);
  pages[0] = [pr(1, "unknown")];
  const r = rig({ pages, baseline: 1 });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "budget");
  assert.deepEqual(j(r.restPages()), [2, 3, 4, 5]);
  assert.equal(await r.fill.start({ category: "unverifiable", force: true }), "budget");
  assert.deepEqual(j(r.restPages()), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test("fill: REST pages are at least 250 ms apart, one at a time", async () => {
  const r = rig({ pages: Array.from({ length: 6 }, () => []), baseline: 1 });
  await r.fill.start({ category: "unverifiable" });
  const at = r.log.filter((l) => l.rest).map((l) => l.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 250, `gap ${at[i] - at[i - 1]}`);
});

test("fill: the ceiling is 20 REST pages per query per tab, baseline included", async () => {
  const r = rig({ pages: Array.from({ length: 40 }, () => []), baseline: 2, limits: { ms: 1e9 } });
  const out = [];
  for (let n = 0; n < 8; n++) out.push(await r.fill.start({ category: "unverifiable", force: true }));
  assert.equal(r.restPages().length, 18);
  assert.equal(r.restPages().at(-1), 20);
  assert.equal(out.at(-1), "ceiling");
  assert.equal(r.fill.snapshot().ceiling, true);
});

test("fill: 8 s budget stops the fill", async () => {
  const r = rig({ pages: Array.from({ length: 10 }, () => []), baseline: 1, limits: { ms: 300 } });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "budget");
  assert.ok(r.restPages().length < 4);
});

test("fill: the last API page ends complete, 'next' false", async () => {
  const r = rig({ pages: [range(1, 3, "subscribed"), range(4, 5, "subscribed")], baseline: 1 });
  assert.equal(await r.fill.start({ category: "informational" }), "complete");
  assert.equal(r.fill.snapshot().next, false);
});

test("fill: Stop starts nothing more and the answer in flight is dropped unread", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")], [pr(3, "unknown")]], baseline: 1 });
  let release;
  const gate = new Promise((x) => (release = x));
  const real = r.fill;
  rig.nextPage = () => null;
  const p = r.fill.start({ category: "unverifiable" });
  r.fill.stop();
  release();
  await gate;
  assert.equal(await p, "aborted");
  const calls = r.log.length;
  assert.equal(real.snapshot().stopped, true);
  await new Promise((x) => setTimeout(x, 5));
  assert.equal(r.log.length, calls);
  assert.ok(!r.fill.summarize().outside.some((o) => o.number === 3));
});

test("fill: a hidden tab pauses the fill and a visible tab resumes it", async () => {
  const visible = { v: false };
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1, visible });
  const p = r.fill.start({ category: "unverifiable" });
  await new Promise((x) => setTimeout(x, 5));
  assert.equal(r.restPages().length, 0);
  visible.v = true;
  r.fill.notifyVisible();
  assert.equal(await p, "complete");
  assert.deepEqual(j(r.restPages()), [2]);
});

test("fill: A -> B -> A on the same page makes zero REST requests", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")], [pr(3, "unknown")]], baseline: 1 });
  await r.fill.start({ category: "unverifiable" });
  const n = r.log.length;
  await r.fill.start({ category: "informational" }); // B fills once (cheap) ...
  const m = r.log.length;
  assert.equal(await r.fill.start({ category: "unverifiable" }), "filled");
  assert.equal(r.log.length, m);
  assert.ok(m >= n);
});

test("fill: a page change lets the user act again, a re-selection fills once more", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  r.fill.notePage("/notifications");
  await r.fill.start({ category: "unverifiable" });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "filled");
  r.fill.notePage("/notifications?page=2");
  assert.notEqual(await r.fill.start({ category: "unverifiable" }), "filled");
});

test("fill: an unsupported filter makes zero fill calls", async () => {
  const r = rig({ pages: [range(1, 5)], search: "/notifications?query=is%3Asaved" });
  assert.equal(await r.fill.start({ category: "informational" }), "unavailable");
  assert.equal(r.log.length, 0);
  assert.equal(r.fill.snapshot().supported, false);
});

test("fill: a query change aborts the fill and nothing late is applied", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  const p = r.fill.start({ category: "unverifiable" });
  r.fill.setQuery(Q.analyse("/notifications?query=is%3Aunread"));
  assert.equal(await p, "aborted");
  assert.equal(r.fill.snapshot().active, false);
  r.fill.setQuery(Q.analyse("/notifications"));
  assert.ok(!r.fill.summarize().outside.some((o) => o.number === 2));
});

test("fill: page row wins over the API item and page + outside + not verified = m", () => {
  const pageRows = [{ key: "acme/web#1", kind: "pull", owner: "acme", repo: "web", title: "Change 1", reason: "subscribed" }, { key: "acme/web#2", kind: "pull", owner: "acme", repo: "web", title: "", reason: "mention" }];
  const r = rig({ pages: [[pr(1), pr(2, "mention"), pr(3), pr(4, "mention"), pr(5, "review_requested"), other("D1", "CheckSuite", "CI"), pr(6, "unknown")]], pageRows });
  const s = r.fill.summarize();
  assert.deepEqual([s.outside.map((o) => o.number).join(), s.pending, s.u, s.k], ["3,6", 2, 1, 3]);
  assert.equal(s.m, pageRows.length + s.outside.length + s.k);
  assert.equal(s.outside.length, 2);
  assert.deepEqual(j(s.byCat), { attention: 0, waiting: 0, informational: 1, unverifiable: 1 });
});

test("fill: outside mention / review_requested are not verified until a lookup ran", async () => {
  const r = rig({ pages: [[pr(1, "mention"), pr(2, "review_requested"), pr(3, "subscribed")]] });
  let s = r.fill.summarize();
  assert.deepEqual([s.outside.length, s.pending, s.k], [1, 2, 2]);
  await r.fill.start({ category: "attention", force: true });
  s = r.fill.summarize();
  assert.equal(s.pending, 0);
  assert.equal(s.outside.length, 3);
  assert.ok(s.outside.filter((o) => o.number !== 3).every((o) => o.category === "unverifiable"));
});

test("fill: lookups run only for Needs attention / Waiting / Grouped, never for label categories", async () => {
  const r = rig({ pages: [[pr(1, "mention")]] });
  await r.fill.start({ category: "informational", force: true });
  assert.equal(r.log.filter((l) => l.lookup).length, 0);
  await r.fill.start({ category: "waiting", force: true });
  assert.equal(r.log.filter((l) => l.lookup).length, 1);
});

test("fill: at most 12 lookup batches per fill, 25 rows each, same repository, 2 in flight", async () => {
  const items = Array.from({ length: 400 }, (_, i) => pr(i + 1, "mention"));
  const r = rig({ pages: [items], limits: { ms: 1e9 } });
  const r2 = await r.fill.start({ category: "attention", force: true });
  assert.equal(r2, "budget");
  const looks = r.log.filter((l) => l.lookup);
  assert.equal(looks.length, 12);
  assert.ok(looks.every((l) => l.lookup <= 25));
  assert.equal(r.fill.stats.batches, 12);
});

test("fill: a lookup denied for an owner raises the SSO caveat flag; the item lists as Unverifiable", async () => {
  const r = rig({ pages: [[pr(1, "mention")]], facts: (rows) => ({ ok: true, facts: { [rows[0].key]: { ok: false, why: "repository not readable with this token" } }, capabilities: { "pr:acme": "denied" }, rateLimited: false }) });
  await r.fill.start({ category: "attention", force: true });
  const s = r.fill.summarize();
  assert.equal(s.denied, true);
  assert.equal(s.outside[0].category, "unverifiable");
});

test("fill: unkeyable Discussion and CheckSuite items are counted in k, never listed; the same thread on two pages counts once", async () => {
  const d = other("D1", "Discussion", "Plan");
  const r = rig({ pages: [[d, other("C1", "CheckSuite", "CI"), pr(1)], [d, other("C2", "CheckSuite", "CI 2")]], baseline: 1 });
  await r.fill.start({ category: "informational", force: true });
  const s = r.fill.summarize();
  assert.deepEqual([s.u, s.k, s.outside.length], [3, 3, 1]);
  assert.ok(s.outside.every((o) => !o.unkeyable));
});

test("fill: a DOM discussion row + the same API item (one-to-one) -> no outside entry, not in k, m counts it once", () => {
  const pageRows = [{ key: "discussion:/acme/web/discussions/12", kind: "discussion", owner: "acme", repo: "web", title: "Plan the release", reason: "mention" }];
  const r = rig({ pages: [[other("D1", "Discussion", "Plan  the Release", { reason: "mention" })]], pageRows });
  const s = r.fill.summarize();
  assert.deepEqual([s.outside.length, s.k, s.u, s.m], [0, 0, 0, 1]);
});

test("fill: DOM title differs from API title (backticks rendered) -> no absorption, item stays in k, no listed duplicate", () => {
  const pageRows = [{ key: "discussion:/acme/web/discussions/12", kind: "discussion", owner: "acme", repo: "web", title: "Plan the release", reason: "mention" }];
  const r = rig({ pages: [[other("D1", "Discussion", "Plan the `release`")]], pageRows });
  const s = r.fill.summarize();
  assert.deepEqual([s.outside.length, s.k, s.u, s.m], [0, 1, 1, 2]);
});

test("fill: reason:, repo: and read-state filters apply in memory", () => {
  const r = rig({ pages: [[pr(1, "mention"), pr(2, "subscribed"), pr(3, "subscribed", { unread: false })]], search: "/notifications?query=reason%3Asubscribed+is%3Aunread" });
  assert.deepEqual(j(r.fill.summarize().outside.map((o) => o.number)), [2]);
});

test("fill: a rate limit keeps results, no retry loop, and no request before the reset", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  rig.nextPage = () => ({ ok: false, failure: "rate-limited", retryAt: r.clock.t + 60_000 });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "rate-limited");
  const s = r.fill.snapshot();
  assert.ok(s.retryAt > r.clock.t);
  assert.equal(s.summary.outside.length, 1);
  const calls = r.log.length;
  assert.equal(await r.fill.start({ category: "unverifiable", force: true }), "rate-limited");
  assert.equal(r.log.length, calls);
  r.clock.t += 61_000;
  rig.nextPage = null;
  assert.equal(await r.fill.start({ category: "unverifiable", force: true }), "complete");
});

test("fill: a refused or silent API after the first answer keeps the entries and reports the class", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  rig.nextPage = () => ({ ok: false, failure: "refused" });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "error");
  assert.deepEqual([r.fill.snapshot().error, r.fill.snapshot().summary.outside.length], ["refused", 1]);
  rig.nextPage = () => ({ ok: false, failure: "no-answer" });
  await r.fill.start({ category: "unverifiable", force: true });
  assert.equal(r.fill.snapshot().error, "no-answer");
  rig.nextPage = null;
});

test("fill: items older than 120 s are re-read with If-Modified-Since; a 304 keeps the list and costs no state change", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  await r.fill.start({ category: "unverifiable" });
  const before = j(r.fill.summarize().outside);
  r.clock.t += 130_000;
  rig.nextPage = (p) => (p.ifModifiedSince ? { ok: true, notModified: true } : null);
  await r.fill.start({ category: "unverifiable", force: true });
  assert.equal(r.log.find((l) => l.ims).ims, "LM");
  assert.equal(r.fill.stats.notModified, 1);
  assert.deepEqual(j(r.fill.summarize().outside), before);
  rig.nextPage = null;
});

test("fill: X-Poll-Interval is honoured before a re-read", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")]], baseline: 1 });
  rig.nextPage = (p) => ({ ok: true, items: [pr(2, "unknown")], next: false, lastModified: "LM", pollInterval: 300 });
  await r.fill.start({ category: "unverifiable" });
  r.clock.t += 130_000;
  const n = r.log.length;
  rig.nextPage = null;
  await r.fill.start({ category: "unverifiable", force: true });
  assert.equal(r.log.filter((l) => l.rest === 1).length, 0);
  assert.ok(r.log.length >= n);
});

test("fill: clear drops everything (a native action)", async () => {
  const r = rig({ pages: [[pr(1, "unknown")]] });
  r.fill.clear();
  assert.equal(r.fill.snapshot().active, false);
  assert.equal(r.fill.summarize().outside.length, 0);
});

test("fill: request log carries only notifications pages and read lookups, never a write", async () => {
  const r = rig({ pages: [[pr(1, "mention")], [pr(2, "review_requested")]], baseline: 1 });
  await r.fill.start({ category: "attention" });
  assert.ok(r.log.every((l) => "rest" in l || "lookup" in l || "sleep" in l));
});

test("fill: Grouped fills all four sections at once with no per-category target", async () => {
  const r = rig({ pages: [[pr(1, "mention")], [pr(2, "subscribed")], [pr(3, "subscribed")]], baseline: 1, counts: { attention: 50 } });
  assert.equal(await r.fill.start({ grouped: true }), "complete");
  assert.deepEqual(j(r.restPages()), [2, 3]);
  assert.ok(r.log.some((l) => l.lookup));
});

test("fill: Load more aims at 10 more matches than it has, not at the first target again", async () => {
  const pages = [[pr(1, "unknown")], ...Array.from({ length: 6 }, (_, i) => range(100 + i * 20, 119 + i * 20, "unknown"))];
  const r = rig({ pages, baseline: 1 });
  assert.equal(await r.fill.start({ category: "unverifiable" }), "target");
  assert.deepEqual(j(r.restPages()), [2]);
  assert.equal(await r.fill.start({ category: "unverifiable", force: true }), "target");
  assert.deepEqual(j(r.restPages()), [2, 3]);
});

test("fill: a stale cache's refresh counts in the 4 REST pages and is spaced like the others", async () => {
  const r = rig({ pages: Array.from({ length: 8 }, () => []), baseline: 1 });
  r.clock.t += 121_000;
  await r.fill.start({ category: "unverifiable" });
  const rest = r.log.filter((l) => l.rest);
  assert.equal(rest.length, 4);
  assert.deepEqual(j(rest.map((l) => l.rest)), [1, 2, 3, 4]);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i].at - rest[i - 1].at >= 250);
});

test("fill: asking for another category ends the running fill first, even when that category was already filled", async () => {
  const r = rig({ pages: [[pr(1, "unknown")], [pr(2, "unknown")], [pr(3, "unknown")], [pr(4, "unknown")], [pr(5, "unknown")], [pr(6, "unknown")]], baseline: 1, limits: { ms: 1e9 } });
  await r.fill.start({ category: "informational" }); // filled
  const running = r.fill.start({ category: "unverifiable", force: true });
  assert.equal(r.fill.isRunning(), true);
  assert.equal(await r.fill.start({ category: "informational" }), "filled");
  assert.equal(await running, "aborted");
  assert.equal(r.fill.isRunning(), false);
});
