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

const REAL = { "review requested": "review_requested", mention: "mention", mentioned: "mention", "team mention": "team_mention", "team mentioned": "team_mention", subscribed: "subscribed", commented: "comment", "ci activity": "ci_activity", assigned: "assign", author: "author", "state change": "state_change", "approval requested": "approval_requested", "security alert": "security_alert", invitation: "invitation", manual: "manual" };
for (const [label, reason] of Object.entries(REAL)) {
  test(`reason label "${label}" -> ${reason}`, () => {
    assert.equal(C.reasonFromLabel(label), reason);
    assert.equal(C.reasonFromLabel(`  ${label.toUpperCase().replace(" ", "   ")} \n`), reason);
  });
}

test("the live inbox label 'mention' is a mention, like the older 'mentioned'", () => {
  assert.equal(C.reasonFromLabel("mention"), "mention");
  assert.equal(C.reasonFromLabel("mentioned"), "mention");
  assert.equal(C.reasonFromLabel("team mention"), "team_mention");
});

test("an unrecognised label is unknown, never review_requested or mention", () => {
  for (const l of ["review wanted", "", "mentioned you", "requested"]) assert.equal(C.reasonFromLabel(l), "unknown");
});

test("fromApiItem keys by subject.url, like the page rows", () => {
  const a = C.fromApiItem({ id: "1", reason: "review_requested", subject: { url: "https://api.github.com/repos/Acme/Web/pulls/412", type: "PullRequest" }, repository: { full_name: "Acme/Web" } });
  assert.deepEqual([a.key, a.kind, a.reason, a.inPage], ["acme/web#412", "pull", "review_requested", false]);
  const other = C.fromApiItem({ id: "2", reason: "ci_activity", subject: { url: "https://api.github.com/repos/acme/web/check-suites/5", type: "CheckSuite" }, repository: { full_name: "acme/web" } });
  assert.equal(other.kind, "run");
  assert.equal(other.number, null);
  assert.equal(other.unkeyable, true);
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

test("pickLabel: a known label text wins; injected leaves are ignored", () => {
  const leaves = [{ text: "acme/web #1", className: "x" }, { text: "Subscribed", className: "ghnt-tag" }, { text: "Mentioned", className: "f6" }];
  assert.equal(C.pickLabel(leaves).text, "Mentioned");
});

test("pickLabel: a row whose native label is gone has none, even with an injected 'Subscribed' tag", () => {
  assert.equal(C.pickLabel([{ text: "Subscribed", className: "ghnt-tag ghnt-tag-x" }, { text: "Fix it", className: "" }]), null);
});

test("pickLabel: falls back to a leaf marked as a reason, never to an injected one", () => {
  assert.equal(C.pickLabel([{ text: "weird", className: "reason-label" }]).text, "weird");
  assert.equal(C.pickLabel([{ text: "weird", className: "ghnt-reason" }]), null);
});

test("keyOf: the same key readPage uses, null without a subject link", async () => {
  const { GHNT_COLLECT: C } = loadGlobals(["features/notifications/collect.js"]);
  const link = (href) => ({ href });
  const li = (hrefs) => ({ querySelectorAll: () => hrefs.map(link) });
  assert.equal(C.keyOf(li(["https://github.com/Acme/Web/pull/412?notification_referrer_id=1"])), "acme/web#412");
  assert.equal(C.keyOf(li(["https://github.com/acme/web/actions/runs/99"])), "run:/acme/web/actions/runs/99");
  assert.equal(C.keyOf(li([])), null);
});

const api = (over) => ({ id: "T1", reason: "mention", unread: true, updated_at: "2026-11-01T10:00:00Z", subject: { url: null, type: "Discussion", title: "Plan the release" }, repository: { full_name: "Acme/Web" }, ...over });

test("collect: fromApiItem keys PullRequest / Issue as o/r#N with the web href", () => {
  const p = C.fromApiItem(api({ subject: { url: "https://api.github.com/repos/Acme/Web/pulls/7", type: "PullRequest", title: "Fix it" } }));
  assert.deepEqual([p.key, p.kind, p.number, p.href, p.unkeyable], ["acme/web#7", "pull", 7, "https://github.com/Acme/Web/pull/7", undefined]);
  const i = C.fromApiItem(api({ subject: { url: "https://api.github.com/repos/acme/web/issues/8", type: "Issue", title: "Bug" } }));
  assert.deepEqual([i.key, i.href, i.unread, i.id], ["acme/web#8", "https://github.com/acme/web/issues/8", true, "T1"]);
});

for (const [type, url, kind] of [["Discussion", null, "discussion"], ["CheckSuite", null, "run"], ["Commit", "https://api.github.com/repos/acme/web/commits/abc", "commit"], ["Release", "https://api.github.com/repos/acme/web/releases/9", "release"], ["RepositoryVulnerabilityAlert", null, "repositoryvulnerabilityalert"], ["RepositoryInvitation", null, "repositoryinvitation"], [undefined, null, "other"]]) {
  test(`collect: ${type} (subject.url ${url ? "set" : "null"}) is unkeyable:<thread id>`, () => {
    const u = C.fromApiItem(api({ id: "T9", subject: { url, type, title: "x" } }));
    assert.deepEqual([u.unkeyable, u.key, u.kind, u.inPage], [true, "unkeyable:t9", kind, false]);
  });
}

test("collect: an unkeyable key never equals a page key, so mergeApi lists no page row twice", () => {
  const page = [{ key: "discussion:/acme/web/discussions/12", kind: "discussion", owner: "acme", repo: "web", title: "Other", reason: "mention" }];
  const merged = C.mergeApi(page, [C.fromApiItem(api({ subject: { url: null, type: "Discussion", title: "Different" } }))]);
  assert.equal(merged.length, 2);
});

test("collect: normTitle collapses whitespace, trims, lowercases and applies NFC", () => {
  assert.equal(C.normTitle("  Plan \n the\t RELEASE "), "plan the release");
  assert.equal(C.normTitle("Cafe\u0301"), C.normTitle("Caf\u00e9"));
});

const pageRow = (over) => ({ key: "discussion:/acme/web/discussions/12", kind: "discussion", owner: "Acme", repo: "Web", title: "Plan the  release", reason: "mention", ...over });

test("collect: absorption is one-to-one on repository (lowercase), kind and normalised title", () => {
  const item = C.fromApiItem(api({}));
  assert.deepEqual([...C.absorbed([pageRow()], [item])], [item.key]);
  assert.equal(C.mergeApi([pageRow()], [item]).length, 1);
});

test("collect: two API CheckSuite items with the same title as one page run row both stay unabsorbed", () => {
  const run = { kind: "run", key: "run:/acme/web/actions/runs/1", title: "CI" };
  const items = [C.fromApiItem(api({ id: "A", subject: { url: null, type: "CheckSuite", title: "CI" } })), C.fromApiItem(api({ id: "B", subject: { url: null, type: "CheckSuite", title: "CI" } }))];
  assert.equal(C.absorbed([pageRow(run)], items).size, 0);
  assert.equal(C.mergeApi([pageRow(run)], items).length, 3);
});

test("collect: no absorption without a title, with a different kind, repository or title (backticks rendered)", () => {
  const item = C.fromApiItem(api({}));
  assert.equal(C.absorbed([pageRow({ title: "" })], [item]).size, 0);
  assert.equal(C.absorbed([pageRow({ kind: "run" })], [item]).size, 0);
  assert.equal(C.absorbed([pageRow({ repo: "api" })], [item]).size, 0);
  assert.equal(C.absorbed([pageRow()], [C.fromApiItem(api({ subject: { url: null, type: "Discussion", title: "Plan the `release`" } }))]).size, 0);
  assert.equal(C.absorbed([pageRow({ kind: "pull", key: "acme/web#1" })], [item]).size, 0);
});

test("collect: two page rows with the same title, one API item: no absorption", () => {
  assert.equal(C.absorbed([pageRow(), pageRow({ key: "discussion:/acme/web/discussions/13" })], [C.fromApiItem(api({}))]).size, 0);
});
