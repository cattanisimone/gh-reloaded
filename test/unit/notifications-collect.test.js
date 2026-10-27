// Pure helpers of features/notifications/collect.js: subject URL parsing, the
// reason-label table, REST item keys and the page/REST merge. (The DOM reader
// is covered by the e2e spec against a fixture.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_COLLECT: C } = loadGlobals(["features/notifications/collect.js"]);

test("parseSubject: absolute href with notification_referrer_id query and hash", () => {
  const s = C.parseSubject("https://github.com/acme/web/pull/412?notification_referrer_id=NT_kwDO&notifications_query=is%3Aunread#issuecomment-9");
  assert.deepEqual([s.kind, s.owner, s.repo, s.number, s.key], ["pull", "acme", "web", 412, "acme/web#412"]);
});

test("parseSubject: relative href and issues", () => {
  assert.equal(C.parseSubject("/Acme/Web/pull/7").key, "acme/web#7");
  assert.equal(C.parseSubject("/acme/web/issues/8?x=1").kind, "issue");
});

test("parseSubject: other subjects are keyed by path and carry no number", () => {
  const run = C.parseSubject("https://github.com/acme/web/actions/runs/99?check_suite_focus=true");
  assert.equal(run.kind, "run");
  assert.equal(run.number, null);
  assert.match(run.key, /^run:\/acme\/web\/actions\/runs\/99$/);
  assert.equal(C.parseSubject("https://github.com/acme/web/discussions/4").kind, "discussion");
  assert.equal(C.parseSubject("https://github.com/acme/web/commit/abc").kind, "commit");
  assert.equal(C.parseSubject("https://github.com/acme"), null);
  assert.equal(C.parseSubject("https://example.com/a/b/pull/1"), null);
});

const REAL = { "review requested": "review_requested", mentioned: "mention", "team mentioned": "team_mention", subscribed: "subscribed", commented: "comment", "ci activity": "ci_activity", assigned: "assign", author: "author", "state change": "state_change", "approval requested": "approval_requested", "security alert": "security_alert", invitation: "invitation", manual: "manual" };
for (const [label, reason] of Object.entries(REAL)) {
  test(`reason label "${label}" -> ${reason}`, () => {
    assert.equal(C.reasonFromLabel(label), reason);
    assert.equal(C.reasonFromLabel(`  ${label.toUpperCase().replace(" ", "   ")} \n`), reason);
  });
}

test("an unrecognised label is unknown, never review_requested or mention", () => {
  for (const l of ["review wanted", "", "mentioned you", "requested"]) assert.equal(C.reasonFromLabel(l), "unknown");
});

test("fromApiItem keys by subject.url, like the page rows", () => {
  const a = C.fromApiItem({ id: "1", reason: "review_requested", subject: { url: "https://api.github.com/repos/Acme/Web/pulls/412", type: "PullRequest" }, repository: { full_name: "Acme/Web" } });
  assert.deepEqual([a.key, a.kind, a.reason, a.inPage], ["acme/web#412", "pull", "review_requested", false]);
  const other = C.fromApiItem({ id: "2", reason: "ci_activity", subject: { url: "https://api.github.com/repos/acme/web/check-suites/5", type: "CheckSuite" }, repository: { full_name: "acme/web" } });
  assert.equal(other.kind, "checksuite");
  assert.equal(other.number, null);
});

test("mergeApi: REST reason wins in both directions, API-only items are inPage false", () => {
  const page = [
    { key: "acme/web#1", kind: "pull", reason: "comment", inPage: true },
    { key: "acme/web#2", kind: "pull", reason: "review_requested", inPage: true },
  ];
  const api = [
    { key: "acme/web#1", kind: "pull", reason: "review_requested", inPage: false },
    { key: "acme/web#2", kind: "pull", reason: "comment", inPage: false },
    { key: "acme/web#3", kind: "issue", reason: "mention", inPage: false },
  ];
  const merged = C.mergeApi(page, api);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((r) => r.key === "acme/web#1").reason, "review_requested");
  assert.equal(merged.find((r) => r.key === "acme/web#2").reason, "comment");
  assert.equal(merged.find((r) => r.key === "acme/web#1").inPage, true);
  assert.equal(merged.find((r) => r.key === "acme/web#3").inPage, false);
});
