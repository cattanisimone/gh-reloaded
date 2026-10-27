// Unit tests for features/notifications/classify.js over the synthetic set in
// fixtures/notifications-synthetic.json: every case names the section (and
// rule) it must land in. The principle under test is "never Needs attention
// without evidence": no case may come out as "attention" unless it expects it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_CLASSIFY: C } = loadGlobals(["features/notifications/classify.js"]);
const set = JSON.parse(readFileSync("test/unit/fixtures/notifications-synthetic.json", "utf8"));
const NOW = Date.parse(set.now);

const BASES = {
  pull: { ok: true, kind: "pull", viewer: "mira", state: "OPEN", headOid: "h2", author: "lee", users: [], teams: [], requestsTotal: 0, reviews: [], reviewsTotal: 0, events: [], eventsTotal: 0 },
  "mention-pull": { ok: true, kind: "pull", viewer: "mira", state: "OPEN", texts: [], commentsTotal: 0, mentionReviewsTotal: 0, threadsTotal: 0 },
  "mention-issue": { ok: true, kind: "issue", viewer: "mira", state: "OPEN", texts: [], commentsTotal: 0, mentionReviewsTotal: 0, threadsTotal: 0 },
  bad: { ok: false, why: "pull request not readable" },
};

function run(c) {
  const facts = c.facts === null ? null : { ...BASES[c.facts], ...c.over };
  const ctx = { me: "mira", windowDays: 7, rateLimited: false, ...c.ctx };
  return C.classify({ row: c.row, facts, ctx, now: NOW });
}

test("the synthetic set has at least 40 cases", () => {
  assert.ok(set.cases.length >= 40);
});

for (const c of set.cases) {
  test(`synthetic: ${c.name}`, () => {
    const r = run(c);
    assert.equal(r.section, c.expect.section, JSON.stringify(r));
    if (c.expect.rule) assert.equal(r.rule, c.expect.rule);
    if (c.expect.scope) assert.equal(r.scope, c.expect.scope);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length > 0, "every result carries evidence");
  });
}

test("zero false Needs attention across the synthetic set", () => {
  const false_ = set.cases.filter((c) => run(c).section === "attention" && c.expect.section !== "attention");
  assert.deepEqual(false_.map((c) => c.name), []);
});

test("team request is scope team, never direct", () => {
  const team = set.cases.filter((c) => c.expect.rule === 6).map(run);
  assert.ok(team.length >= 3);
  for (const r of team) assert.equal(r.scope, "team");
  assert.ok(team.every((r) => r.teams.length > 0), "names the pending team(s)");
});

test("identity check: a case-insensitive match passes, a mismatch or empty login does not", () => {
  const row = { reason: "review_requested", kind: "pull" };
  const facts = (viewer) => ({ ...BASES.pull, viewer, users: ["mira"], requestsTotal: 1 });
  const go = (me, viewer) => C.classify({ row, facts: facts(viewer), ctx: { me, windowDays: 7 }, now: NOW });
  assert.equal(go("Mira", "mira").section, "attention");
  assert.match(go("mira", "bob").evidence[0], /another account/);
  assert.match(go("", "mira").evidence[0], /signed-in login unknown/);
  assert.match(go("mira", "").evidence[0], /token login unknown/);
});

test("rule 1 scope: only review_requested and mention rows on a PR or issue need facts", () => {
  const quiet = [
    { reason: "subscribed", kind: "pull" },
    { reason: "ci_activity", kind: "run" },
    { reason: "mention", kind: "discussion" },
    { reason: "unknown", kind: "pull", rawLabel: "x" },
  ];
  const sections = quiet.map((row) => C.classify({ row, facts: null, ctx: { me: "mira", windowDays: 7, rateLimited: true }, now: NOW }));
  assert.deepEqual(sections.map((r) => r.rule), [13, 13, 12, 12]);
  assert.deepEqual(quiet.map((r) => C.needsFacts(r)), [false, false, false, false]);
  assert.equal(C.needsFacts({ reason: "mention", kind: "issue" }), true);
});

test("mention window: stored days apply and 7 is the default boundary", () => {
  const row = { reason: "mention", kind: "pull" };
  const at = (days) => new Date(NOW - days * 86_400_000).toISOString();
  const go = (days, windowDays) => C.classify({ row, facts: { ...BASES["mention-pull"], texts: [{ text: "@mira hi", at: at(days), author: "lee", editedAt: "" }], commentsTotal: 1 }, ctx: { me: "mira", windowDays }, now: NOW }).section;
  assert.equal(go(6.9, 7), "attention");
  assert.equal(go(7.1, 7), "informational");
  assert.equal(go(7.1, 30), "attention");
  assert.equal(go(0.5, 1), "attention");
});

test("mention matching helpers", () => {
  assert.equal(C.hasMention("hello @Mira!", "mira"), true);
  assert.equal(C.hasMention("(@mira)", "mira"), true);
  assert.equal(C.hasMention("@mira-bot", "mira"), false);
  assert.equal(C.hasMention("a/@mira", "mira"), false);
  assert.equal(C.hasMention("    @mira in indented code", "mira"), false);
  assert.equal(C.hasMention("~~~\n@mira\n~~~\nafter", "mira"), false);
  assert.equal(C.hasMention("~~~\n@mira\n~~~\n@mira after", "mira"), true);
});
