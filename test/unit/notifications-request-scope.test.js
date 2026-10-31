// requestScope: whether a review request is provably for me ("direct"), only
// for a team ("team"), a new request after one of my reviews ("rerequest") or
// not provable (null). Independent of the section the classifier picks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_CLASSIFY: C } = loadGlobals(["features/notifications/classify.js"]);

const base = { ok: true, kind: "pull", viewer: "mira", state: "OPEN", headOid: "h2", author: "lee", users: [], teams: [], requestsTotal: 0, reviews: [], reviewsTotal: 0, events: [], eventsTotal: 0 };
const ev = (type, target, name, at) => ({ type, target, name, at });
const rv = (author, state, at, oid = "h1") => ({ author, state, at, oid });

test("pending request for me and no review of mine: direct", () => {
  assert.equal(C.requestScope({ ...base, users: ["mira"] }, "mira"), "direct");
});

test("pending for me, request event after a review of mine: rerequest", () => {
  const f = { ...base, users: ["mira"], reviews: [rv("mira", "CHANGES_REQUESTED", "2026-01-02T00:00:00Z")], events: [ev("added", "User", "mira", "2026-01-01T00:00:00Z"), ev("added", "User", "mira", "2026-01-03T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "rerequest");
});

test("pending for me, my review is older than the only request: still direct", () => {
  const f = { ...base, users: ["mira"], reviews: [rv("mira", "COMMENTED", "2026-01-01T00:00:00Z")], events: [ev("added", "User", "mira", "2026-01-03T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "rerequest");
  const g = { ...f, reviews: [rv("mira", "COMMENTED", "2026-01-05T00:00:00Z")] };
  assert.equal(C.requestScope(g, "mira"), "direct");
});

test("a bot or the author does not make a re-review", () => {
  const f = { ...base, users: ["mira"], reviews: [{ ...rv("lee", "COMMENTED", "2026-01-01T00:00:00Z") }], events: [ev("added", "User", "mira", "2026-01-03T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "direct");
});

test("a request event names me, not removed, no longer pending: direct", () => {
  const f = { ...base, events: [ev("added", "User", "mira", "2026-01-01T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "direct");
});

test("added and removed: not provable", () => {
  const f = { ...base, events: [ev("added", "User", "mira", "2026-01-01T00:00:00Z"), ev("removed", "User", "mira", "2026-01-02T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), null);
});

test("only a team was requested: team", () => {
  const f = { ...base, teams: ["acme/platform"], events: [ev("added", "Team", "acme/platform", "2026-01-01T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "team");
  assert.equal(C.requestScope({ ...base, teams: ["acme/platform"] }, "mira"), "team");
});

test("a team and a request for me: direct, never team", () => {
  assert.equal(C.requestScope({ ...base, users: ["mira"], teams: ["acme/platform"] }, "mira"), "direct");
});

test("nothing pending and nothing named: null", () => {
  assert.equal(C.requestScope(base, "mira"), null);
});

test("incomplete data: null", () => {
  assert.equal(C.requestScope({ ...base, users: ["mira"], requestsTotal: 101 }, "mira"), null);
  assert.equal(C.requestScope({ ...base, users: ["mira"], eventsTotal: 101 }, "mira"), null);
  assert.equal(C.requestScope({ ...base, users: ["mira"], reviewsTotal: 51 }, "mira"), null);
  assert.equal(C.requestScope({ ...base, users: ["mira"], eventsTotal: Infinity }, "mira"), null);
});

test("not a readable pull request: null", () => {
  assert.equal(C.requestScope({ ok: false }, "mira"), null);
  assert.equal(C.requestScope({ ...base, kind: "issue" }, "mira"), null);
  assert.equal(C.requestScope(null, "mira"), null);
});

test("works on a merged pull request (independent of the section)", () => {
  const f = { ...base, state: "MERGED", users: ["mira"] };
  assert.equal(C.requestScope(f, "mira"), "direct");
  const r = C.classify({ row: { reason: "review_requested", kind: "pull" }, facts: f, ctx: { me: "mira", windowDays: 7 }, now: Date.now() });
  assert.equal(r.section, "informational");
  assert.equal(r.requestedAs, "direct");
});

test("classify carries requestedAs on review requests and the mention author", () => {
  const f = { ...base, users: ["mira"] };
  const r = C.classify({ row: { reason: "review_requested", kind: "pull" }, facts: f, ctx: { me: "mira", windowDays: 7 }, now: Date.now() });
  assert.equal(r.requestedAs, "direct");
  const t = { ok: true, kind: "pull", viewer: "mira", state: "OPEN", texts: [{ source: "comment", text: "hi @mira", at: new Date().toISOString(), author: "lee", url: "https://x/c1" }], commentsTotal: 1, mentionReviewsTotal: 0, threadsTotal: 0 };
  const m = C.classify({ row: { reason: "mention", kind: "pull" }, facts: t, ctx: { me: "mira", windowDays: 7 }, now: Date.now() });
  assert.deepEqual([m.by, m.source, m.href], ["lee", "comment", "https://x/c1"]);
});

test("an answered team request (no longer pending, none removed) is still team", () => {
  const f = { ...base, events: [ev("added", "Team", "acme/platform", "2026-01-01T00:00:00Z")], reviews: [rv("dana", "APPROVED", "2026-01-02T00:00:00Z")] };
  assert.equal(C.requestScope(f, "mira"), "team");
  assert.equal(C.requestScope({ ...f, events: [...f.events, ev("removed", "Team", "acme/platform", "2026-01-03T00:00:00Z")] }, "mira"), null);
});
