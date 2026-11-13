// features/notifications/query.js: what can be rebuilt from the native inbox query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_QUERY: Q } = loadGlobals(["features/notifications/query.js"]);
const j = (v) => JSON.parse(JSON.stringify(v));
const a = (query) => Q.analyse(`/notifications?query=${encodeURIComponent(query)}`);

const TOKENS = { "review-requested": "review_requested", "team-mention": "team_mention", "ci-activity": "ci_activity", "security-alert": "security_alert", "state-change": "state_change", "approval-requested": "approval_requested", mention: "mention", author: "author", assign: "assign", comment: "comment", manual: "manual", subscribed: "subscribed", invitation: "invitation" };
for (const [native, api] of Object.entries(TOKENS)) {
  test(`query: native reason:${native} maps to the API value ${api}`, () => {
    const r = a(`reason:${native}`);
    assert.equal(r.supported, true);
    assert.deepEqual(j(r.filter.reasons), [api]);
  });
}

test("query: an unmapped reason token is an unsupported filter, named", () => {
  const r = a("reason:something-new");
  assert.equal(r.supported, false);
  assert.equal(r.unsupported, "reason:something-new");
});

test("query: no query is the whole inbox: all=true, supported, narrowable", () => {
  const r = Q.analyse("/notifications");
  assert.deepEqual(j([r.supported, r.params, r.narrowable, r.key]), [true, { all: true, participating: false }, true, ""]);
});

test("query: is:unread sends all=false; is:read stays all=true and filters in memory", () => {
  assert.equal(a("is:unread").params.all, false);
  assert.equal(a("is:read").params.all, true);
  assert.equal(a("is:read").filter.read, "read");
  assert.equal(a("is:unread is:read").supported, false);
});

test("query: reason:participating maps to the participating parameter", () => {
  assert.equal(a("reason:participating").params.participating, true);
});

for (const bad of ["is:saved", "is:done", "author:lee", "some free text", "-reason:mention", "repo:acme", "org:acme/web"]) {
  test(`query: "${bad}" is an unsupported filter and zero fill`, () => {
    const r = a(bad);
    assert.equal(r.supported, false);
    assert.equal(r.unsupported, bad.split(" ")[0]);
  });
}

test("query: the first unsupported token is the one reported", () => {
  assert.equal(a("reason:mention author:lee is:saved").unsupported, "author:lee");
});

test("query: key is normalised (case, order, whitespace) so the same filter shares one cache", () => {
  assert.equal(a("Is:Unread  repo:Acme/Web").key, a("repo:acme/web is:unread").key);
  assert.notEqual(a("is:unread").key, a("is:read").key);
});

test("query: page and after parameters do not change the key", () => {
  assert.equal(Q.analyse("/notifications?query=is%3Aunread&page=2").key, Q.analyse("/notifications?query=is%3Aunread").key);
});

test("query.matches filters in memory by reason, repo, org and read state", () => {
  const f = a("reason:mention repo:acme/web is:unread").filter;
  const item = { reason: "mention", owner: "Acme", repo: "Web", unread: true };
  assert.equal(Q.matches(f, item), true);
  assert.equal(Q.matches(f, { ...item, reason: "author" }), false);
  assert.equal(Q.matches(f, { ...item, repo: "api" }), false);
  assert.equal(Q.matches(f, { ...item, unread: false }), false);
  assert.equal(Q.matches(a("org:acme").filter, { ...item, owner: "other" }), false);
  assert.equal(Q.matches(a("is:read").filter, { ...item, unread: false }), true);
});

test("query.narrowHref appends the reason token, drops paging, and is absent when reason:/is:saved/is:done are there", () => {
  assert.equal(Q.narrowHref("/notifications?query=is%3Aunread&page=3", "review-requested"), "/notifications?query=is%3Aunread+reason%3Areview-requested");
  assert.equal(Q.narrowHref("/notifications", "mention"), "/notifications?query=reason%3Amention");
  assert.equal(Q.narrowHref("/notifications?query=reason%3Amention", "review-requested"), null);
  assert.equal(Q.narrowHref("/notifications?query=is%3Asaved", "mention"), null);
  assert.equal(Q.narrowHref("/notifications?query=is%3Adone", "mention"), null);
  assert.equal(Q.narrowHref("/notifications", "nope"), null);
});
