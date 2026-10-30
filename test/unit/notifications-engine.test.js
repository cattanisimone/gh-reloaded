// The headless engine driven with a fake clock, a fake page and a fake
// background: progressive loading, caching, coverage, rate-limit retry,
// stability of classified rows and the "no rows, no request" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/classify.js", "features/notifications/collect.js", "features/notifications/engine.js"]);

const T0 = Date.parse("2026-10-27T12:00:00Z");
const pullFacts = (over = {}) => ({ ok: true, kind: "pull", viewer: "mira", state: "OPEN", headOid: "h2", author: "lee", users: ["mira"], teams: [], requestsTotal: 1, reviews: [], reviewsTotal: 0, events: [], eventsTotal: 0, ...over });
const row = (n, reason = "review_requested", kind = "pull") => ({ key: `acme/web#${n}`, kind, owner: "acme", repo: "web", number: n, reason, rawLabel: reason, inPage: true });

function setup({ rows = [row(1)], respond } = {}) {
  const env = { now: T0, rows, sent: [], timers: [], me: "mira", days: 7 };
  const engine = g.GHNT_ENGINE.createEngine({
    collect: () => ({ me: env.me, rows: env.rows }),
    mergeApi: g.GHNT_COLLECT.mergeApi,
    fromApiItem: g.GHNT_COLLECT.fromApiItem,
    classify: g.GHNT_CLASSIFY.classify,
    needsFacts: g.GHNT_CLASSIFY.needsFacts,
    getWindowDays: () => env.days,
    now: () => env.now,
    setTimer: (fn, ms) => env.timers.push({ fn, ms }) && env.timers.length,
    clearTimer: () => {},
    send: async (payload) => {
      env.sent.push(payload);
      return respond ? respond(payload, env) : { ok: true, facts: Object.fromEntries(payload.rows.map((r) => [r.key, pullFacts()])), capabilities: { "pr:acme": "ok" }, api: { state: "not-tried", items: [] }, rateLimited: false, retryAt: null };
    },
  });
  env.engine = engine;
  return env;
}
const section = (env, n) => env.engine.getState().items.find((i) => i.key === `acme/web#${n}`);

test("0 rows: no request at all", async () => {
  const env = setup({ rows: [] });
  await env.engine.start();
  assert.equal(env.sent.length, 0);
  assert.equal(env.engine.getState().items.length, 0);
});

test("rows are pending while loading, then classified; quiet rows classify at once", async () => {
  const env = setup({ rows: [row(1), row(2, "subscribed")] });
  const phases = [];
  env.engine.subscribe((s) => phases.push([s.phase, s.items.map((i) => i.pending)]));
  await env.engine.start();
  assert.deepEqual(JSON.parse(JSON.stringify(phases[0])), ["loading", [true, false]]);
  assert.equal(section(env, 1).section, "attention");
  assert.equal(section(env, 1).scope, "direct");
  assert.equal(section(env, 2).section, "informational");
  assert.equal(env.engine.getState().phase, "ready");
});

test("facts are cached for 60 s; a rescan inside the minute sends nothing", async () => {
  const env = setup();
  await env.engine.start();
  const first = env.sent.length;
  env.now += 30_000;
  await env.engine.scan();
  assert.equal(env.sent.length, first);
  env.now += 31_000;
  await env.engine.scan();
  assert.equal(env.sent.length, first + 1);
});

test("coverage never claims a total, in every API state", async () => {
  for (const state of ["not-tried", "unavailable", "missing-scope", "rate-limited", "ok"]) {
    const env = setup({
      respond: (p) => ({ ok: true, facts: { "acme/web#1": pullFacts() }, capabilities: {}, api: { state, items: state === "ok" ? [{ id: "9", reason: "mention", subject: { type: "Issue", url: "https://api.github.com/repos/acme/web/issues/9" }, repository: { full_name: "acme/web" } }] : [] }, rateLimited: false, retryAt: null }),
    });
    await env.engine.start();
    const s = env.engine.getState();
    assert.equal(s.coverage.total, null, state);
    assert.equal(s.coverage.partial, true, state);
    assert.equal(s.coverage.loaded, state === "ok" ? 2 : 1, state);
    assert.equal(s.capabilities["api:notifications"], state);
  }
});

test("coverage union: dedup by key, API-only items are inPage false", async () => {
  const env = setup({
    rows: [row(1)],
    respond: () => ({ ok: true, facts: { "acme/web#1": pullFacts() }, capabilities: {}, api: { state: "ok", items: [{ id: "1", reason: "review_requested", subject: { type: "PullRequest", url: "https://api.github.com/repos/acme/web/pulls/1" } }, { id: "2", reason: "subscribed", subject: { type: "Issue", url: "https://api.github.com/repos/acme/web/issues/2" } }] }, rateLimited: false, retryAt: null }),
  });
  await env.engine.start();
  const items = env.engine.getState().items;
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.key === "acme/web#2").inPage, false);
  assert.equal(items.find((i) => i.key === "acme/web#1").inPage, true);
});

test("the Notifications API is read at most once per minute", async () => {
  const env = setup();
  await env.engine.start();
  assert.equal(env.sent[0].api, true);
  env.now += 61_000;
  await env.engine.scan();
  assert.equal(env.sent[1].api, true);
});

test("rate limit: classified rows stay, others are Unverifiable, one retry timer at retryAt", async () => {
  let limited = false;
  const env = setup({
    rows: [row(1)],
    respond: (p, e) => limited
      ? { ok: true, facts: Object.fromEntries(p.rows.map((r) => [r.key, { ok: false, why: "rate limited" }])), capabilities: { "pr:acme": "rate-limited" }, api: { state: "not-tried", items: [] }, rateLimited: true, retryAt: e.now + 120_000 }
      : { ok: true, facts: Object.fromEntries(p.rows.map((r) => [r.key, pullFacts()])), capabilities: { "pr:acme": "ok" }, api: { state: "not-tried", items: [] }, rateLimited: false, retryAt: null },
  });
  await env.engine.start();
  assert.equal(section(env, 1).section, "attention");

  limited = true;
  env.rows = [row(1), row(2)];
  env.now += 61_000;
  await env.engine.scan();
  const s = env.engine.getState();
  assert.equal(s.rateLimited, true);
  assert.equal(s.retryAt, env.now + 120_000);
  assert.equal(section(env, 1).section, "attention", "an already classified row keeps its section");
  assert.equal(section(env, 2).section, "unverifiable");
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 120_050);

  limited = false;
  env.now += 120_050;
  env.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(env.engine.getState().rateLimited, false);
  assert.equal(section(env, 2).section, "attention");
});

test("while rate limited, further scans send nothing before retryAt", async () => {
  const env = setup({ respond: (p, e) => ({ ok: true, facts: Object.fromEntries(p.rows.map((r) => [r.key, { ok: false, why: "rate limited" }])), capabilities: {}, api: { state: "not-tried", items: [] }, rateLimited: true, retryAt: e.now + 300_000 }) });
  await env.engine.start();
  const n = env.sent.length;
  env.now += 90_000;
  await env.engine.scan();
  assert.equal(env.sent.length, n);
});

test("a failed request leaves the rows Unverifiable without throwing", async () => {
  const env = setup({ respond: () => { throw new Error("worker asleep"); } });
  await env.engine.start();
  assert.equal(section(env, 1).section, "unverifiable");
  assert.equal(env.engine.getState().phase, "ready");
});

test("changing the mention window re-classifies without a request", async () => {
  const at = new Date(T0 - 10 * 86_400_000).toISOString();
  const env = setup({
    rows: [row(1, "mention")],
    respond: () => ({ ok: true, facts: { "acme/web#1": { ok: true, kind: "pull", viewer: "mira", state: "OPEN", texts: [{ text: "@mira", at, author: "lee", editedAt: "" }], commentsTotal: 1, mentionReviewsTotal: 0, threadsTotal: 0 } }, capabilities: {}, api: { state: "not-tried", items: [] }, rateLimited: false, retryAt: null }),
  });
  await env.engine.start();
  assert.equal(section(env, 1).section, "informational");
  env.days = 14;
  env.engine.reclassify();
  assert.equal(section(env, 1).section, "attention");
  assert.equal(env.sent.length, 1);
});

test("stop resets to idle and later scans do nothing", async () => {
  const env = setup();
  await env.engine.start();
  env.engine.stop();
  assert.equal(env.engine.getState().phase, "idle");
  assert.equal(env.engine.getState().items.length, 0);
  const n = env.sent.length;
  await env.engine.scan();
  assert.equal(env.sent.length, n);
});

test("the request carries no more than the page rows and never a write", async () => {
  const env = setup({ rows: [row(1), row(2, "subscribed"), { ...row(3), kind: "run", number: null, key: "run:/x" }] });
  await env.engine.start();
  assert.deepEqual(Object.keys(env.sent[0]).sort(), ["api", "rows"]);
  assert.ok(env.sent[0].rows.every((r) => r.kind === "pull" || r.kind === "issue"));
});

test("an unchanged scan does not publish again", async () => {
  const env = setup();
  await env.engine.start();
  let n = 0;
  env.engine.subscribe(() => n++);
  await env.engine.scan();
  await env.engine.scan();
  assert.equal(n, 0);
});

test("items carry owner, repo, the raw label and when their facts were read", async () => {
  const env = setup({ rows: [row(1)] });
  await env.engine.start();
  const item = section(env, 1);
  assert.deepEqual([item.owner, item.repo, item.rawLabel, item.readAt], ["acme", "web", "review_requested", T0]);
  assert.equal(item.requestedAs, "direct");
});

test("facts read for one reason are not reused when the reason changes", async () => {
  const env = setup({ rows: [row(1, "mention")], respond: (p) => ({ ok: true, facts: Object.fromEntries(p.rows.map((r) => [r.key, r.reason === "mention" ? { ok: true, kind: "pull", viewer: "mira", state: "OPEN", texts: [{ source: "comment", text: "@mira hi", at: new Date(T0 - 1000).toISOString(), author: "lee", url: "u" }], commentsTotal: 1, mentionReviewsTotal: 0, threadsTotal: 0 } : pullFacts()])), reasons: Object.fromEntries(p.rows.map((r) => [r.key, r.reason])), capabilities: { "pr:acme": "ok" }, api: { state: "not-tried", items: [] }, rateLimited: false, retryAt: null }) });
  await env.engine.start();
  assert.equal(section(env, 1).rule, 9);
  env.rows = [row(1, "review_requested")];
  await env.engine.scan();
  assert.equal(env.sent.length, 2, "read again for the new reason, inside the 60 s cache window");
  assert.equal(section(env, 1).rule, 3);
  assert.equal(section(env, 1).requestedAs, "direct");
});

test("a REST reason that differs from the label does not cause a read on every scan", async () => {
  const env = setup({ rows: [row(1, "mention")], respond: (p) => ({ ok: true, facts: Object.fromEntries(p.rows.map((r) => [r.key, pullFacts()])), reasons: Object.fromEntries(p.rows.map((r) => [r.key, "review_requested"])), capabilities: {}, api: { state: "ok", items: [{ id: "1", reason: "review_requested", subject: { url: "https://api.github.com/repos/acme/web/pulls/1", type: "PullRequest", title: "t" }, repository: { full_name: "acme/web" } }] }, rateLimited: false, retryAt: null }) });
  await env.engine.start();
  await env.engine.scan();
  await env.engine.scan();
  assert.equal(env.sent.length, 1, "the label said mention but REST said review_requested: one read");
});
