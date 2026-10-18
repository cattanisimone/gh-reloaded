// Unit tests for features/pr-triage/classify.js: who acts next on a pull
// request, from the facts the background normalised. A content-script
// global (no ES module), so it is evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(readFileSync("features/pr-triage/classify.js", "utf8"), context);
const { classify, summarize, groupEntries } = context.GHPRT_CLASSIFY;

const facts = (over = {}) => ({
  ok: true,
  author: "ana",
  isDraft: false,
  mergeable: "MERGEABLE",
  headOid: "h2",
  checks: "SUCCESS",
  users: [],
  teams: [],
  reviews: [],
  ...over,
});
const review = (author, state, oid = "h1") => ({ author, state, oid, at: "2026-10-02T10:00:00Z" });

test("classify: author wins over reviewer", () => {
  const f = facts({ author: "mira", users: ["mira"], reviews: [review("sam", "CHANGES_REQUESTED")] });
  const r = classify("mira", f);
  assert.equal(r.placement, "yours");
  assert.match(r.label, /Changes requested by sam/);
});

test("classify: a requested reviewer has the turn", () => {
  const r = classify("mira", facts({ users: ["mira"] }));
  assert.deepEqual([r.placement, r.label], ["yours", "Review requested"]);
});

test("classify: logins compare case-insensitively", () => {
  assert.equal(classify("Mira", facts({ users: ["mira"] })).placement, "yours");
});

test("classify: my changes-requested waits on author", () => {
  const r = classify("mira", facts({ reviews: [review("mira", "CHANGES_REQUESTED", "h2")] }));
  assert.deepEqual([r.placement, r.label], ["waiting", "Waiting on author"]);
  assert.doesNotMatch(r.title, /new commits/);
});

test("classify: …new commits keep waiting, with a note", () => {
  const r = classify("mira", facts({ headOid: "h3", reviews: [review("mira", "CHANGES_REQUESTED", "h1")] }));
  assert.equal(r.placement, "waiting");
  assert.match(r.label, /new commits since your review/);
});

test("classify: …re-request makes it my turn", () => {
  const r = classify("mira", facts({ users: ["mira"], headOid: "h3", reviews: [review("mira", "CHANGES_REQUESTED", "h1")] }));
  assert.deepEqual([r.placement, r.label], ["yours", "Review requested"]);
});

test("classify: author with changes requested by a reviewer not asked again", () => {
  const r = classify("ana", facts({ reviews: [review("sam", "CHANGES_REQUESTED"), review("lee", "APPROVED")] }));
  assert.deepEqual([r.placement, r.label], ["yours", "Changes requested by sam"]);
});

test("classify: author, reviewer asked again is waiting on review", () => {
  const r = classify("ana", facts({ users: ["sam"], teams: ["acme/design"], reviews: [review("sam", "CHANGES_REQUESTED")] }));
  assert.equal(r.placement, "waiting");
  assert.equal(r.label, "Waiting on review · sam, @acme/design");
});

test("classify: author with failing checks or a conflict", () => {
  assert.equal(classify("ana", facts({ checks: "FAILURE" })).label, "Checks failing");
  assert.equal(classify("ana", facts({ checks: "ERROR" })).placement, "yours");
  assert.equal(classify("ana", facts({ mergeable: "CONFLICTING" })).label, "Merge conflict");
});

test("classify: author with pending checks and nothing else waits on checks", () => {
  assert.equal(classify("ana", facts({ checks: "PENDING" })).label, "Waiting on checks");
});

test("classify: approved + green is no placement, never merge-ready", () => {
  const r = classify("ana", facts({ reviews: [review("lee", "APPROVED")] }));
  assert.equal(r.placement, null);
  assert.equal(classify("mira", facts({ reviews: [review("mira", "APPROVED")] })).placement, null);
});

test("classify: a draft with no blocker has no placement; a blocker still counts", () => {
  assert.equal(classify("ana", facts({ isDraft: true })).placement, null);
  assert.equal(classify("ana", facts({ isDraft: true, checks: "FAILURE" })).placement, "yours");
});

test("classify: only a team requested is neutral", () => {
  const r = classify("mira", facts({ teams: ["acme/web-core"] }));
  assert.deepEqual([r.placement, r.label], ["team", "Team review requested · @acme/web-core"]);
});

test("classify: no role gives no label", () => {
  assert.equal(classify("mira", facts()).placement, null);
});

test("classify: missing facts or no data is unavailable", () => {
  assert.equal(classify("mira", { ok: false }).placement, "unavailable");
  assert.equal(classify("mira", null).placement, "unavailable");
  assert.equal(classify("mira", { ok: false }).label, "Triage unavailable");
});

test("classify: a closed or merged PR is not triaged", () => {
  assert.equal(classify("mira", facts({ state: "MERGED", users: ["mira"] })).placement, null);
});

test("summarize: counts yours, waiting and unavailable; teams count as neither", () => {
  const out = summarize(["yours", "yours", "waiting", "team", null, "unavailable", "waiting", "waiting"]);
  assert.deepEqual({ ...out }, { yours: 2, waiting: 3, unavailable: 1 });
});

const item = (number, placement, label = "L") => ({ number, title: `PR ${number}`, href: `/o/r/pull/${number}`, result: placement && { placement, label, title: `hint ${number}` } });

test("groupEntries: each role lands in one group, native order kept", () => {
  const out = groupEntries([item(5, "waiting"), item(4, "yours", "Review requested"), item(3, "yours"), item(2, "waiting")]);
  assert.deepEqual([...out.yours.map((e) => e.number)], [4, 3]);
  assert.deepEqual([...out.waiting.map((e) => e.number)], [5, 2]);
  assert.deepEqual({ ...out.yours[0] }, { number: 4, title: "PR 4", href: "/o/r/pull/4", label: "Review requested", hint: "hint 4" });
});

test("groupEntries: one entry per PR, even if a row repeats", () => {
  const out = groupEntries([item(4, "yours"), item(4, "yours"), item(4, "waiting")]);
  assert.equal(out.yours.length, 1);
  assert.equal(out.waiting.length, 0);
});

test("groupEntries: team requests and unavailable PRs are counted, not listed; no placement is skipped", () => {
  const out = groupEntries([item(1, "team"), item(2, "team"), item(3, "unavailable"), item(4, null), item(5, "yours")]);
  assert.equal(out.team, 2);
  assert.equal(out.unavailable, 1);
  assert.deepEqual([...out.yours.map((e) => e.number)], [5]);
  assert.deepEqual([...out.waiting], []);
});

test("groupEntries: nothing in, empty groups out", () => {
  assert.deepEqual({ ...groupEntries([]), yours: [], waiting: [] }, { yours: [], waiting: [], team: 0, unavailable: 0 });
});
