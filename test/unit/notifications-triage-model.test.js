// The Triage view's pure model: counts over the loaded rows, the category
// filter, the copy about coverage, and a 32-notification synthetic inbox run
// through the real classifier (no false "Needs attention").
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/classify.js", "features/notifications/collect.js", "features/notifications/triage-model.js"]);
const M = g.GHNT_TRIAGE_MODEL;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86_400_000;
const plain = (v) => JSON.parse(JSON.stringify(v));
const ctx = { me: "mira", windowDays: 7, rateLimited: false };

const pull = (over = {}) => ({ ok: true, kind: "pull", viewer: "mira", state: "OPEN", headOid: "h2", author: "lee", users: ["mira"], teams: [], requestsTotal: 1, reviews: [], reviewsTotal: 0, events: [], eventsTotal: 0, ...over });
const mention = (daysAgo, over = {}) => ({ ok: true, kind: "pull", viewer: "mira", state: "OPEN", texts: [{ author: "lee", text: "@mira can you look?", at: new Date(NOW - daysAgo * DAY).toISOString() }], commentsTotal: 1, mentionReviewsTotal: 0, threadsTotal: 0, ...over });
const row = (n, reason, kind = "pull") => ({ key: `acme/web#${n}`, kind, owner: "acme", repo: "web", number: n, reason, rawLabel: reason });

// [row, facts, expected section, is it one of the "needs attention" the issue expects]
const INBOX = [
  // direct review requests
  ...[1, 2, 3, 4, 5].map((n) => [row(n, "review_requested"), pull(), "attention"]),
  // team request, nobody else satisfied it
  [row(6, "review_requested"), pull({ users: [], teams: ["acme/web-team"], events: [{ type: "added", target: "Team", name: "acme/web-team", at: "2026-10-20T00:00:00Z" }] }), "attention"],
  // a review by someone else must not turn a direct request into done
  [row(7, "review_requested"), pull({ reviews: [{ author: "kim", state: "APPROVED", oid: "h2", at: "2026-10-26T00:00:00Z" }], reviewsTotal: 1 }), "attention"],
  // my review on the latest commit
  ...[8, 9, 10].map((n) => [row(n, "review_requested"), pull({ users: [], reviews: [{ author: "mira", state: "APPROVED", oid: "h2", at: "2026-10-26T00:00:00Z" }], reviewsTotal: 1 }), "waiting"]),
  // direct mention inside the window / older / unread data missing
  [row(11, "mention"), mention(1), "attention"],
  [row(12, "mention"), mention(30), "informational"],
  [row(13, "mention"), { ok: false, why: "no token" }, "unverifiable"],
  [row(14, "mention"), mention(1, { texts: [{ author: "lee", text: "```\n@mira\n```", at: new Date(NOW - DAY).toISOString() }] }), "unverifiable"],
  // review request on a closed PR, on an issue, with incomplete data
  [row(15, "review_requested"), pull({ state: "MERGED" }), "informational"],
  [row(16, "review_requested", "issue"), pull({ kind: "issue" }), "unverifiable"],
  [row(17, "review_requested"), pull({ requestsTotal: 500 }), "unverifiable"],
  [row(18, "review_requested"), pull({ viewer: "someone-else" }), "unverifiable"],
  // quiet reasons
  ...["subscribed", "comment", "ci_activity", "state_change", "author", "assign"].map((r, i) => [row(20 + i, r), null, "informational"]),
  // an unrecognised label
  [row(30, "unknown"), null, "unverifiable"],
  [row(31, "review_requested"), { ok: false, why: "denied" }, "unverifiable"],
  [row(32, "manual"), null, "informational"],
  // more direct requests, and team mentions (informational on their own)
  ...[40, 41, 42].map((n) => [row(n, "review_requested"), pull(), "attention"]),
  ...[43, 44].map((n) => [row(n, "team_mention"), null, "informational"]),
];

function classified() {
  return INBOX.map(([r, facts]) => ({ key: r.key, inPage: true, pending: false, ...g.GHNT_CLASSIFY.classify({ row: r, facts, ctx, now: NOW }) }));
}

test("a 32-notification synthetic inbox: every row lands where expected, nothing is a false 'Needs attention'", () => {
  assert.equal(INBOX.length, 32);
  const items = classified();
  items.forEach((item, i) => assert.equal(item.section, INBOX[i][2], `${item.key} -> ${item.section}`));
  const c = M.counts(items);
  assert.deepEqual({ a: c.attention, w: c.waiting, i: c.informational, u: c.unverifiable, loaded: c.loaded, pending: c.pending }, { a: 11, w: 3, i: 11, u: 7, loaded: 32, pending: 0 });
  const attention = items.filter((i) => i.section === "attention").map((i) => i.key);
  assert.deepEqual(plain(attention), [1, 2, 3, 4, 5, 6, 7, 11, 40, 41, 42].map((n) => `acme/web#${n}`));
});

test("counts: only rows the page shows, pending rows are in no category", () => {
  const items = [
    { key: "a", inPage: true, section: "attention", pending: false },
    { key: "b", inPage: true, section: "waiting", pending: false },
    { key: "c", inPage: false, section: "attention", pending: false },
    { key: "d", inPage: true, pending: true },
    { key: "e", inPage: true, section: "weird", pending: false },
  ];
  assert.deepEqual(plain(M.counts(items)), { attention: 1, waiting: 1, informational: 0, unverifiable: 0, pending: 2, loaded: 4 });
  assert.deepEqual(plain(M.counts([])), { attention: 0, waiting: 0, informational: 0, unverifiable: 0, pending: 0, loaded: 0 });
});

test("keeps: a selected category keeps its rows only; a pending row is kept only with no selection", () => {
  const a = { section: "attention", pending: false };
  const p = { pending: true };
  assert.equal(M.keeps(null, a), true);
  assert.equal(M.keeps(null, p), true);
  assert.equal(M.keeps("attention", a), true);
  assert.equal(M.keeps("waiting", a), false);
  assert.equal(M.keeps("attention", p), false);
  assert.equal(M.keeps("attention", undefined), false);
});

test("copy: coverage names the loaded rows and partial pages; an empty filter is never 'all clear'", () => {
  const c = { attention: 0, waiting: 5, informational: 17, unverifiable: 0, pending: 0, loaded: 25 };
  assert.equal(M.coverageText(c, true), "Counts cover the 25 loaded notifications; more pages not loaded.");
  assert.equal(M.coverageText({ ...c, loaded: 1 }, false), "Counts cover the 1 loaded notification.");
  assert.equal(M.statusLine("waiting", c), "Waiting · 5 of 25 loaded");
  assert.equal(M.statusLine("waiting", { ...c, waiting: 0, pending: 3 }, true), "Waiting · … of 25 loaded");
  assert.equal(M.emptyText("attention", c), "No match among the loaded notifications.");
  assert.doesNotMatch(M.emptyText("attention", c), /clear|all/i);
  assert.equal(M.emptyText("waiting", c), "");
  assert.equal(M.emptyText(null, c), "");
  assert.equal(M.NEXT_LABEL, "Next page ›");
  assert.equal(M.pendingText(4), "Classifying 4 notifications…");
  assert.equal(M.pendingText(1), "Classifying 1 notification…");
  assert.equal(M.pendingText(0), "");
});

test("count text: whole up to 99+, an ellipsis while classifying; aria labels carry the totals", () => {
  assert.equal(M.countText(3, false), "3");
  assert.equal(M.countText(100, false), "99+");
  assert.equal(M.countText(0, true), "…");
  const c = { attention: 3, waiting: 0, informational: 0, unverifiable: 0, pending: 0, loaded: 25 };
  assert.equal(M.ariaLabel("attention", c, false), "Needs attention, 3 of 25 loaded notifications");
});

test("moveFocus: arrows wrap, Home and End jump, other keys stay", () => {
  assert.equal(M.moveFocus(0, "ArrowDown", 4), 1);
  assert.equal(M.moveFocus(3, "ArrowDown", 4), 0);
  assert.equal(M.moveFocus(0, "ArrowUp", 4), 3);
  assert.equal(M.moveFocus(2, "Home", 4), 0);
  assert.equal(M.moveFocus(1, "End", 4), 3);
  assert.equal(M.moveFocus(1, "a", 4), 1);
  assert.equal(M.moveFocus(0, "ArrowDown", 0), -1);
});

test("a Grouped section note: empty sections cover only the loaded rows, Unverifiable always says why", () => {
  assert.deepEqual(plain(M.sectionNote("waiting", 0)), ["None among the loaded notifications."]);
  assert.deepEqual(plain(M.sectionNote("waiting", 3)), []);
  assert.deepEqual(plain(M.sectionNote("unverifiable", 2)), ["This group holds notifications whose data or token permissions are not enough to tell."]);
  assert.deepEqual(plain(M.sectionNote("unverifiable", 0)), ["None among the loaded notifications.", "This group holds notifications whose data or token permissions are not enough to tell."]);
  for (const id of M.IDS) for (const line of M.sectionNote(id, 0)) assert.doesNotMatch(line, /all clear|nothing to do/i);
});

// view(): one table of every state the three layouts share (S1).
test("view(): layouts x {loading, pending, partial, last page, empty, all classified} give one set of strings", () => {
  const mk = (over) => ({ attention: 0, waiting: 0, informational: 0, unverifiable: 0, pending: 0, loaded: 0, ...over });
  const states = {
    loading: mk({ pending: 5, loaded: 5 }),
    pending: mk({ attention: 2, pending: 3, loaded: 5 }),
    classified: mk({ attention: 2, waiting: 1, informational: 2, loaded: 5 }),
    empty: mk(),
  };
  for (const layout of ["integrated", "quickbar", "grouped"]) {
    for (const [name, c] of Object.entries(states)) {
      for (const nextHref of ["/notifications?after=p2", null]) {
        const v = M.view(c, { layout, selected: "waiting", collapsed: { informational: true }, nextHref });
        const pendingNow = c.pending > 0;
        // a category with 0 is "…" while rows classify, whatever the layout
        for (const cat of v.cats) {
          assert.equal(cat.pending, pendingNow && c[cat.id] === 0, `${layout}/${name}/${cat.id}`);
          assert.equal(cat.count, cat.pending ? "…" : String(c[cat.id]));
          assert.match(cat.aria, cat.pending ? /classifying of/ : new RegExp(`, ${c[cat.id]} of ${c.loaded} loaded`));
          assert.ok(!cat.pending || !cat.note.some((l) => /None among/.test(l)), "no None note while pending");
        }
        assert.equal(v.cats.find((x) => x.id === "informational").expanded, false);
        assert.deepEqual(plain(v.cats.find((x) => x.id === "informational").note), []);
        // Next page only when GitHub has one, in the coverage line
        assert.equal(v.next?.href ?? null, nextHref);
        assert.equal(v.coverage, M.coverageText(c, !!nextHref));
        assert.equal(v.pending, pendingNow ? `Classifying ${c.pending} ${c.pending === 1 ? "notification" : "notifications"}…` : "");
        if (layout === "grouped") {
          assert.equal(v.selected, null);
          assert.equal(v.status, "");
          assert.equal(v.empty, "");
        } else {
          assert.equal(v.selected, "waiting");
          // the status line never states a 0 the pill shows as "…"
          assert.equal(v.status, `Waiting · ${pendingNow && c.waiting === 0 ? "…" : c.waiting} of ${c.loaded} loaded`);
          // "No match" is never said while the rows are still being classified
          assert.equal(v.empty, pendingNow || c.waiting > 0 ? "" : "No match among the loaded notifications.");
        }
      }
    }
  }
  assert.equal(M.view(states.classified, { layout: "integrated", selected: "attention" }).empty, "");
  assert.equal(M.view(states.classified, { layout: "integrated", selected: "bogus" }).selected, null);
});
