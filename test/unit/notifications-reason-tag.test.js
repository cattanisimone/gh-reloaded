// features/notifications/reason-tag.js: which tag an engine item gets, the
// aria-label, and the "Why is this here?" lines for every tag in every data
// state. Pure; the DOM side is covered by the e2e spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_REASON_TAG: T } = loadGlobals(["features/notifications/reason-tag.js"]);
const NOW = Date.parse("2026-10-27T12:00:00Z");
const item = (over = {}) => ({ key: "acme/web#1", kind: "pull", owner: "acme", repo: "web", reason: "review_requested", rawLabel: "review requested", pending: false, section: "attention", rule: 3, evidence: ["Direct review request"], requestedAs: "direct", readAt: NOW - 180_000, ...over });
const ctx = (over = {}) => ({ now: NOW, me: "mira", retryAt: null, rateLimited: false, ...over });
const text = (m) => m.lines.map((l) => l.text).join("\n");
const hasLink = (m) => m.lines.some((l) => l.action === "tokens");

test("tagFor maps every reason", () => {
  assert.equal(T.tagFor(item()).label, "Direct review request");
  assert.equal(T.tagFor(item({ requestedAs: "team" })).label, "Team review request");
  assert.equal(T.tagFor(item({ requestedAs: "rerequest" })).label, "Re-review requested");
  assert.equal(T.tagFor(item({ requestedAs: null, section: "unverifiable", rule: 8 })).label, "Unverifiable");
  assert.equal(T.tagFor(item({ reason: "mention", rawLabel: "mentioned", requestedAs: undefined })).label, "Mention");
  assert.equal(T.tagFor(item({ reason: "subscribed", kind: "pull" })).label, "Subscribed");
  assert.equal(T.tagFor(item({ reason: "ci_activity", kind: "run" })).label, "CI");
});

test("other native reasons get no tag (decision 2B)", () => {
  for (const reason of ["comment", "assign", "author", "state_change", "team_mention", "approval_requested", "security_alert", "invitation", "manual", "unknown"]) {
    assert.equal(T.tagFor(item({ reason })), null, reason);
  }
  assert.equal(T.tagFor(null), null);
});

test("a review row still loading has no tag; a mention row keeps its tag", () => {
  assert.equal(T.tagFor(item({ pending: true, requestedAs: undefined })), null);
  assert.equal(T.tagFor(item({ reason: "mention", pending: true })).label, "Mention");
});

test("a review request on an issue is Unverifiable", () => {
  assert.equal(T.tagFor(item({ kind: "issue", requestedAs: undefined, rule: 12 })).label, "Unverifiable");
});

test("every tag has an id, tone, icon and an aria-label that explains it", () => {
  const all = [item(), item({ requestedAs: "team" }), item({ requestedAs: "rerequest" }), item({ requestedAs: null }), item({ reason: "mention" }), item({ reason: "subscribed" }), item({ reason: "ci_activity" })];
  for (const i of all) {
    const t = T.tagFor(i);
    assert.ok(t.id && t.tone && t.icon, t.label);
    assert.ok(t.aria.startsWith(t.label) && t.aria.length > t.label.length + 10, t.aria);
  }
});

test("team aria-label and popover say the review is not owed by you", () => {
  const i = item({ requestedAs: "team", teams: ["acme/platform"], rule: 6, evidence: ["Team review request pending: acme/platform", "review by dana APPROVED (does not satisfy a pending request)"] });
  assert.match(T.tagFor(i).aria, /not necessarily owed by you|team/i);
  const m = T.popover(i, ctx());
  assert.match(text(m), /GitHub reason: review requested/);
  assert.match(text(m), /Request addressed to team acme\/platform, not to you/);
  assert.match(text(m), /Review by dana APPROVED \(does not satisfy a pending request\)/);
  assert.match(text(m), /A team request does not mean the review is owed by you/);
  assert.match(text(m), /3 minutes ago: may be stale/);
  assert.equal(hasLink(m), false);
});

test("direct and re-review popovers", () => {
  const d = T.popover(item(), ctx());
  assert.match(text(d), /A review request for you is pending/);
  assert.match(text(d), /Read from the pull request 3 minutes ago/);
  const ev = T.popover(item({ rule: 2, section: "informational", evidence: ["Pull request merged"] }), ctx());
  assert.match(text(ev), /request event names you/i);
  const r = T.popover(item({ requestedAs: "rerequest" }), ctx());
  assert.match(text(r), /requested again after you already reviewed/);
});

test("tones follow the mockup: team attention, mention done, unverifiable severe, subscribed and CI neutral", () => {
  const tone = (over) => T.tagFor(item(over)).tone;
  assert.equal(tone({}), "accent");
  assert.equal(tone({ requestedAs: "rerequest" }), "accent");
  assert.equal(tone({ requestedAs: "team" }), "attention");
  assert.equal(tone({ reason: "mention" }), "done");
  assert.equal(tone({ requestedAs: null }), "severe");
  assert.equal(tone({ reason: "subscribed" }), "neutral");
  assert.equal(tone({ reason: "ci_activity" }), "neutral");
});

test("freshness mark: ok when read just now, warn only when it may be stale", () => {
  const fresh = (readAt, over = {}) => T.popover(item({ readAt, ...over }), ctx()).lines.find((l) => /^Read from/.test(l.text));
  assert.equal(fresh(NOW - 10_000).kind, "ok");
  assert.equal(fresh(NOW - 3 * 60_000).kind, "warn");
  assert.equal(fresh(NOW - 3 * 3_600_000).kind, "warn");
  const mention = { reason: "mention", rawLabel: "mention", requestedAs: undefined, rule: 9, by: "lee", source: "comment", href: "h" };
  assert.equal(fresh(NOW - 10_000, mention).kind, "ok");
  assert.equal(fresh(NOW - 5 * 60_000, mention).kind, "warn");
});

test("freshness: just now, minutes, hours", () => {
  assert.match(text(T.popover(item({ readAt: NOW - 10_000 }), ctx())), /just now/);
  assert.match(text(T.popover(item({ readAt: NOW - 59 * 60_000 }), ctx())), /59 minutes ago: may be stale/);
  assert.match(text(T.popover(item({ readAt: NOW - 3 * 3_600_000 }), ctx())), /3 hours ago: may be stale/);
});

test("Unverifiable, no token: says what is missing and links to the tokens settings", () => {
  const m = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 1, evidence: ["no token for this owner"] }), ctx());
  assert.match(text(m), /Missing: no GitHub token for acme/);
  assert.equal(hasLink(m), true);
});

test("Unverifiable, denied: names the permission needed and links", () => {
  const base = { requestedAs: null, section: "unverifiable", rule: 1, evidence: ["token denied"] };
  const pr = T.popover(item(base), ctx());
  assert.match(text(pr), /was refused or cannot see web/);
  assert.match(text(pr), /Pull requests: Read \(fine-grained\) or the repo scope \(classic\)/);
  assert.equal(hasLink(pr), true);
  const unreadable = T.popover(item({ ...base, evidence: ["repository not readable with this token"] }), ctx());
  assert.match(text(unreadable), /needs Pull requests: Read/i);
  const issue = T.popover(item({ ...base, kind: "issue", reason: "mention", rawLabel: "mentioned" }), ctx());
  assert.match(text(issue), /Issues: Read/);
  assert.equal(hasLink(issue), true);
});

test("Unverifiable, token of another account", () => {
  const m = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 1, evidence: ["token belongs to another account"], tokenLogin: "other" }), ctx());
  assert.match(text(m), /token for acme belongs to @other, but you are signed in as @mira/);
  assert.equal(hasLink(m), true);
});

test("Unverifiable, incomplete data: no link", () => {
  const more = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 8, evidence: ["review data incomplete (more than the page size read)"] }), ctx());
  assert.match(text(more), /More reviews or requests than one read returns/);
  assert.equal(hasLink(more), false);
  const gone = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 8, evidence: ["request state not provable (removed, partly satisfied or no request)"] }), ctx());
  assert.match(text(gone), /requested and then removed/);
});

test("Unverifiable, rate limited and failed", () => {
  const retryAt = Date.parse("2026-10-27T12:07:00Z");
  const rl = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 1, evidence: ["rate limited"] }), ctx({ retryAt }));
  assert.match(text(rl), /rate limit was reached; retrying at \d\d:\d\d/);
  assert.equal(hasLink(rl), false);
  const failed = T.popover(item({ requestedAs: null, section: "unverifiable", rule: 1, evidence: ["request failed"] }), ctx());
  assert.match(text(failed), /GitHub did not answer; retrying on the next scan/);
});

test("a row classified before a rate limit keeps its tag and adds the rate line", () => {
  const m = T.popover(item(), ctx({ rateLimited: true, retryAt: null }));
  assert.match(text(m), /A review request for you is pending/);
  assert.match(text(m), /rate limit was reached; retrying/);
});

test("review request on a non-pull subject", () => {
  const m = T.popover(item({ kind: "issue", requestedAs: undefined, rule: 12, section: "unverifiable", evidence: ["review request on an issue"] }), ctx());
  assert.match(text(m), /This is not a pull request, so the request cannot be read/);
});

test("Mention popovers: found, not found, incomplete, no token, loading", () => {
  const mention = { reason: "mention", rawLabel: "mentioned", requestedAs: undefined, section: "attention", rule: 9, evidence: ["Direct mention"], by: "lee", source: "comment", href: "https://github.com/acme/web/pull/1#c1" };
  const found = T.popover(item(mention), ctx());
  assert.match(text(found), /Mentioned by @lee in a comment/);
  assert.ok(found.lines.some((l) => l.href === "https://github.com/acme/web/pull/1#c1"));
  const none = T.popover(item({ ...mention, section: "unverifiable", rule: 11, evidence: ["no mention found in what was read"], by: undefined, href: undefined }), ctx());
  assert.match(text(none), /No mention of you found in what was read/);
  const inc = T.popover(item({ ...mention, section: "unverifiable", rule: 11, evidence: ["read set incomplete"], by: undefined, href: undefined }), ctx());
  assert.match(text(inc), /may be further down/);
  const noToken = T.popover(item({ ...mention, section: "unverifiable", rule: 1, evidence: ["no token for this owner"], by: undefined, href: undefined }), ctx());
  assert.match(text(noToken), /The mention itself was not read: no GitHub token for acme/);
  assert.equal(hasLink(noToken), true);
  const loading = T.popover(item({ ...mention, pending: true, rule: undefined, evidence: undefined, by: undefined, href: undefined }), ctx());
  assert.match(text(loading), /Checking the mention/);
});

test("Mention, rate limited keeps previous evidence", () => {
  const m = T.popover(item({ reason: "mention", rawLabel: "mentioned", requestedAs: undefined, rule: 9, by: "lee", source: "comment", href: "h" }), ctx({ rateLimited: true }));
  assert.match(text(m), /Mentioned by @lee/);
  assert.match(text(m), /rate limit/);
});

test("Subscribed and CI read nothing: same popover in every state", () => {
  for (const reason of ["subscribed", "ci_activity"]) {
    const a = T.popover(item({ reason, rawLabel: reason === "ci_activity" ? "ci activity" : "subscribed", requestedAs: undefined, rule: 13 }), ctx());
    const b = T.popover(item({ reason, rawLabel: reason === "ci_activity" ? "ci activity" : "subscribed", requestedAs: undefined, rule: 1, evidence: ["no token for this owner"] }), ctx({ rateLimited: true }));
    assert.equal(text(a), text(b));
    assert.equal(hasLink(a), false);
    assert.match(text(a), /Nothing else is read for this reason/);
    assert.ok(!/ago|just now/.test(text(a)));
  }
  assert.match(text(T.popover(item({ reason: "subscribed", requestedAs: undefined }), ctx())), /You watch this repository or thread/);
  assert.match(text(T.popover(item({ reason: "ci_activity", requestedAs: undefined }), ctx())), /workflow run you are subscribed to/);
});

test("every popover starts with the GitHub reason and ends with the rule", () => {
  const all = [item(), item({ requestedAs: "team" }), item({ requestedAs: "rerequest" }), item({ requestedAs: null, rule: 1, evidence: ["token denied"] }), item({ reason: "mention", rawLabel: "mentioned" }), item({ reason: "subscribed", rawLabel: "subscribed" }), item({ reason: "ci_activity", rawLabel: "ci activity" })];
  for (const i of all) {
    const m = T.popover(i, ctx());
    assert.equal(m.title, "Why is this here?");
    assert.match(m.lines[0].text, /^GitHub reason: /);
    assert.equal(m.lines.at(-1).kind, "rule");
    assert.match(m.lines.at(-1).text, /^Rule: /);
  }
});

test("injected text never becomes the reason: only the item's own fields are read", () => {
  assert.equal(T.tagFor(item({ reason: "unknown", rawLabel: "Subscribed" })), null);
});

test("visible copy says panel, never popover", () => {
  const states = [item(), item({ reason: "mention", rawLabel: "mention" }), item({ requestedAs: null, section: "unverifiable", rule: 1, evidence: ["token denied"] })];
  for (const i of states) assert.doesNotMatch(text(T.popover(i, ctx())), /popover/i);
});
