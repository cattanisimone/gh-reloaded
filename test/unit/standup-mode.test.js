// Unit tests for the attention rules in background/standup-mode.js: stale
// in a review-like column, orphan block, critical path at risk, column
// bottlenecks, and priority ranking. The GitHub-facing half is not
// exercised here — only the pure functions over plain data.
import "../support/chrome-stub.js"; // first: the module transitively imports lib/github-api.js
import { resetStorage } from "../support/chrome-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSignals,
  computeBottlenecks,
  handleMessage,
  isReviewLike,
  ageInDays,
  priorityRank,
  normalizeOptions,
  shapeItemData,
  columnSince,
  localDateString,
  DEFAULT_REVIEW_KEYWORDS,
} from "../../background/standup-mode.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const options = normalizeOptions({});
const item = (n, column, columnIndex) => ({ key: `a/b#${n}`, column, columnIndex });
const open = (extra = {}) => ({ state: "OPEN", labels: [], comments: [], ...extra });

test("normalizeOptions falls back to defaults and parses a keyword string", () => {
  assert.deepEqual(normalizeOptions({}), { staleDays: 3, reviewKeywords: DEFAULT_REVIEW_KEYWORDS });
  assert.deepEqual(normalizeOptions({ staleDays: "0", reviewKeywords: " , " }), {
    staleDays: 3,
    reviewKeywords: DEFAULT_REVIEW_KEYWORDS,
  });
  assert.deepEqual(normalizeOptions({ staleDays: 5, reviewKeywords: "Review, UAT" }), {
    staleDays: 5,
    reviewKeywords: ["review", "uat"],
  });
});

test("isReviewLike matches the start of a word in the column name", () => {
  const k = DEFAULT_REVIEW_KEYWORDS;
  assert.equal(isReviewLike("In review", k), true);
  assert.equal(isReviewLike("Code Reviewing", k), true);
  assert.equal(isReviewLike("QA", k), true);
  assert.equal(isReviewLike("Ready to deploy", k), true);
  assert.equal(isReviewLike("Latest", k), false);
  assert.equal(isReviewLike("In progress", k), false);
  assert.equal(isReviewLike(null, k), false);
});

test("ageInDays floors whole days and rejects bad dates", () => {
  assert.equal(ageInDays(daysAgo(5), NOW), 5);
  assert.equal(ageInDays(new Date(NOW - 1000).toISOString(), NOW), 0);
  assert.equal(ageInDays("nonsense", NOW), null);
});

test("priorityRank understands common vocabularies and leaves others unranked", () => {
  assert.equal(priorityRank("P0"), 3);
  assert.equal(priorityRank("Critical"), 3);
  assert.equal(priorityRank("High"), 2);
  assert.equal(priorityRank("p1 - soon"), 2);
  assert.equal(priorityRank("Medium"), 1);
  assert.equal(priorityRank("Low"), 0);
  assert.equal(priorityRank("Whenever"), null);
  assert.equal(priorityRank(null), null);
});

test("stale: a review-like column past the threshold is flagged, a fresh one is not", () => {
  const items = [item(1, "In review", 2), item(2, "In review", 2), item(3, "In progress", 1)];
  const data = {
    "a/b#1": open({ statusSince: daysAgo(5) }),
    "a/b#2": open({ statusSince: daysAgo(1) }),
    "a/b#3": open({ statusSince: daysAgo(9) }), // old, but not a review-like column
  };
  const { cards, summary } = computeSignals({ items, data, options, now: NOW });
  assert.deepEqual(summary.stale, ["a/b#1"]);
  assert.match(cards["a/b#1"].reasons.stale, /In review.*5 days/);
  assert.deepEqual(cards["a/b#2"].flags, []);
  assert.deepEqual(cards["a/b#3"].flags, []);
});

test("stale: closed items and unknown status times are never flagged", () => {
  const items = [item(1, "In review", 2), item(2, "In review", 2)];
  const data = {
    "a/b#1": { ...open({ statusSince: daysAgo(30) }), state: "CLOSED" },
    "a/b#2": open({ statusSince: null }),
  };
  const { summary } = computeSignals({ items, data, options, now: NOW });
  assert.deepEqual(summary.stale, []);
});

test("the stale threshold and keywords come from the options", () => {
  const items = [item(1, "UAT", 2)];
  const data = { "a/b#1": open({ statusSince: daysAgo(2) }) };
  const strict = normalizeOptions({ staleDays: 1, reviewKeywords: "uat" });
  assert.deepEqual(computeSignals({ items, data, options: strict, now: NOW }).summary.stale, ["a/b#1"]);
  assert.deepEqual(computeSignals({ items, data, options, now: NOW }).summary.stale, []);
});

test("orphan: blocked label, no open blocker, no explaining comment", () => {
  const items = [item(1, "In progress", 1)];
  const data = { "a/b#1": open({ labels: ["Blocked"], comments: ["lgtm", "thanks!"] }) };
  const { summary, cards } = computeSignals({ items, data, openBlockers: { "a/b#1": 0 }, options, now: NOW });
  assert.deepEqual(summary.orphan, ["a/b#1"]);
  assert.match(cards["a/b#1"].reasons.orphan, /no open blocker/);
});

test("orphan: an open blocker, an explaining comment, or an unchecked card clears it", () => {
  const items = [item(1, "In progress", 1), item(2, "In progress", 1), item(3, "In progress", 1)];
  const data = {
    "a/b#1": open({ labels: ["blocked"] }),
    "a/b#2": open({ labels: ["blocked"], comments: ["Waiting on the vendor's API key"] }),
    "a/b#3": open({ labels: ["blocked"] }),
  };
  const { summary } = computeSignals({
    items,
    data,
    openBlockers: { "a/b#1": 1, "a/b#2": 0 }, // #3 was never checked (dependency lookup failed)
    options,
    now: NOW,
  });
  assert.deepEqual(summary.orphan, []);
});

test("orphan: a column named Blocked counts as marked blocked", () => {
  const items = [item(1, "Blocked", 3)];
  const data = { "a/b#1": open() };
  const { summary } = computeSignals({ items, data, openBlockers: { "a/b#1": 0 }, options, now: NOW });
  assert.deepEqual(summary.orphan, ["a/b#1"]);
});

test("critical path at risk: past target date, or held by an old open blocker", () => {
  // A -> B -> C is the longest chain (3 hops); D is unrelated.
  const items = [item(1, "Done", 3), item(2, "In progress", 1), item(3, "Todo", 0), item(4, "Todo", 0)];
  const edges = [
    { from: "a/b#1", to: "a/b#2" },
    { from: "a/b#2", to: "a/b#3" },
  ];
  const data = {
    "a/b#1": open({ statusSince: daysAgo(10) }),
    "a/b#2": open({ statusSince: daysAgo(1) }),
    "a/b#3": open({ statusSince: daysAgo(1), targetDate: "2026-10-01" }),
    "a/b#4": open({ statusSince: daysAgo(1), targetDate: "2026-10-01" }),
  };
  const { summary, cards } = computeSignals({ items, data, edges, options, now: NOW });
  // #2 is held by #1 (open for 10 days); #3 is past its target date; #4 is overdue but off the path.
  assert.deepEqual(summary.critical.sort(), ["a/b#2", "a/b#3"]);
  assert.match(cards["a/b#2"].reasons.critical, /blocked by #1 for 10 days/);
  assert.match(cards["a/b#3"].reasons.critical, /target date/);
  assert.deepEqual(cards["a/b#4"].flags, []);
});

test("critical path: a closed blocker does not put its dependents at risk", () => {
  const items = [item(1, "Done", 3), item(2, "In progress", 1)];
  const edges = [{ from: "a/b#1", to: "a/b#2" }];
  const data = {
    "a/b#1": { ...open({ statusSince: daysAgo(10) }), state: "CLOSED" },
    "a/b#2": open({ statusSince: daysAgo(1) }),
  };
  assert.deepEqual(computeSignals({ items, data, edges, options, now: NOW }).summary.critical, []);
});

test("bottleneck: a column holding most of the open cards is flagged, the intake column never is", () => {
  const cards = [
    ...[0, 1, 2].map(() => ({ column: "Todo", columnIndex: 0, open: true, ageDays: 1 })),
    ...[0, 1, 2].map(() => ({ column: "In review", columnIndex: 2, open: true, ageDays: 1 })),
    { column: "In progress", columnIndex: 1, open: true, ageDays: 1 },
    { column: "Done", columnIndex: 3, open: false, ageDays: 1 },
  ];
  const result = computeBottlenecks(cards, 3);
  assert.deepEqual(result.map((r) => r.column), ["In review"]);
  assert.match(result[0].reason, /3 of 7 open/);
});

test("bottleneck: an old oldest card flags a small column; a quiet board flags nothing", () => {
  const old = [
    { column: "Todo", columnIndex: 0, open: true, ageDays: 1 },
    { column: "In progress", columnIndex: 1, open: true, ageDays: 1 },
    { column: "In progress", columnIndex: 1, open: true, ageDays: 1 },
    { column: "In review", columnIndex: 2, open: true, ageDays: 14 },
  ];
  assert.deepEqual(computeBottlenecks(old, 3).map((r) => r.column), ["In review"]);
  const quiet = old.map((c) => ({ ...c, ageDays: 1 }));
  assert.deepEqual(computeBottlenecks(quiet, 3), []);
});

test("cards without API data get no entry, and priority flows through", () => {
  const items = [item(1, "Todo", 0), item(2, "Todo", 0)];
  const data = { "a/b#1": open({ priority: "High" }) };
  const { cards } = computeSignals({ items, data, options, now: NOW });
  assert.deepEqual(cards["a/b#1"].priority, { name: "High", rank: 2 });
  assert.equal(cards["a/b#2"], undefined);
});

test("shapeItemData picks this project's item among several boards", () => {
  const node = {
    state: "OPEN",
    labels: { nodes: [{ name: "bug" }] },
    comments: { nodes: [{ body: "hi" }] },
    projectItems: {
      nodes: [
        { project: { number: 1, owner: { login: "acme" } }, fieldValues: { nodes: [{ name: "Other", updatedAt: "2026-01-01T00:00:00Z" }] } },
        {
          project: { number: 7, owner: { login: "Acme" } },
          fieldValues: { nodes: [{ name: "In review", updatedAt: "2026-10-01T00:00:00Z" }] },
          priority: { name: "High" },
          target: { date: "2026-10-20" },
          effort: { number: 5 },
        },
      ],
    },
  };
  assert.deepEqual(shapeItemData(node, { owner: "acme", number: 7 }, "In review"), {
    state: "OPEN",
    labels: ["bug"],
    comments: ["hi"],
    statusSince: "2026-10-01T00:00:00Z",
    priority: "High",
    targetDate: "2026-10-20",
    effort: 5,
  });
  assert.equal(shapeItemData(null, { owner: "acme", number: 7 }), null);
  assert.equal(shapeItemData(node, { owner: "acme", number: 99 }).statusSince, null);
});

test("columnSince reads the age from the field value that matches the card's column", () => {
  const item = {
    fieldValues: {
      nodes: [
        { name: "Todo", updatedAt: "2026-09-01T00:00:00Z" },
        { title: "Sprint 4", updatedAt: "2026-10-02T00:00:00Z" },
        {},
      ],
    },
  };
  assert.equal(columnSince(item, "Sprint 4"), "2026-10-02T00:00:00Z", "an iteration-field board");
  assert.equal(columnSince(item, " todo "), "2026-09-01T00:00:00Z");
  assert.equal(columnSince(item, "Review"), null, "no field holds that column: no age, not another field's");
  assert.equal(columnSince(item, null), null);
  assert.equal(columnSince(null, "Todo"), null);
});

test("localDateString uses the local calendar day, not the UTC one", () => {
  const late = new Date(2026, 9, 8, 23, 30).getTime();
  const early = new Date(2026, 9, 8, 0, 30).getTime();
  assert.equal(localDateString(late), "2026-10-08");
  assert.equal(localDateString(early), "2026-10-08");
});

test("critical path: a target date is compared against the local day", () => {
  const items = [item(1, "In progress", 1), item(2, "In progress", 1)];
  const edges = [{ from: "a/b#1", to: "a/b#2" }];
  const at = (h) => new Date(2026, 9, 8, h, 0).getTime();
  const data = { "a/b#1": open({ effort: 1 }), "a/b#2": open({ effort: 1, targetDate: "2026-10-08" }) };
  for (const hour of [0, 12, 23]) {
    const { summary } = computeSignals({ items, data, edges, options, now: at(hour) });
    assert.deepEqual(summary.critical, [], `due today is not overdue at ${hour}:00 local`);
  }
  const next = new Date(2026, 9, 9, 0, 30).getTime();
  assert.deepEqual(computeSignals({ items, data, edges, options, now: next }).summary.critical, ["a/b#2"]);
});

test("bottleneck: draft items count toward the shares but cannot flag a column alone", () => {
  const linked = [0, 1, 2].map(() => ({ column: "In review", columnIndex: 2, open: true, ageDays: 1 }));
  const drafts = Array.from({ length: 7 }, () => ({ column: "In progress", columnIndex: 1, open: true, ageDays: null, draft: true }));
  const intake = { column: "Todo", columnIndex: 0, open: true, ageDays: 1 };
  assert.deepEqual(computeBottlenecks([intake, ...linked], 3, 3).map((r) => r.column), ["In review"]);
  assert.deepEqual(computeBottlenecks([intake, ...linked, ...drafts], 3, 3), [], "3 of 11 is no longer a majority");
  const draftsOnly = Array.from({ length: 2 }, () => ({ column: "Done", columnIndex: 3, open: true, ageDays: null, draft: true }));
  assert.deepEqual(computeBottlenecks([intake, ...linked, ...draftsOnly], 3, 4).map((r) => r.column), ["In review"]);
});

test("bottleneck: an empty column still counts toward the board's column total", () => {
  const cards = [
    { column: "Todo", columnIndex: 0, open: true, ageDays: 1 },
    ...[0, 1, 2].map(() => ({ column: "In review", columnIndex: 2, open: true, ageDays: 1 })),
  ];
  assert.deepEqual(computeBottlenecks(cards, 3), [], "derived from populated cards: only two columns, no share rule");
  assert.deepEqual(computeBottlenecks(cards, 3, 3).map((r) => r.column), ["In review"]);
});

test("orphan block: an unavailable dependency lookup is not read as zero blockers", async () => {
  const realFetch = globalThis.fetch;
  resetStorage({ githubTokens: [{ id: "t", name: "t", token: "x", owner: "" }], defaultTokenId: "t" });
  const issue = (n) => ({
    state: "OPEN",
    labels: { nodes: [{ name: "blocked" }] },
    comments: { nodes: [] },
    projectItems: { nodes: [] },
  });
  const run = async (deps) => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/graphql")) {
        return { ok: true, status: 200, json: async () => ({ data: { i0: { issueOrPullRequest: issue() }, i1: { issueOrPullRequest: issue() } } }) };
      }
      const m = String(url).match(/issues\/(\d+)\/dependencies\/(\w+)/);
      if (m[2] === "blocked_by" && deps[m[1]] === 404) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [] };
    };
    const payload = {
      project: { owner: "acme", number: 1 },
      columnCount: 3,
      items: [
        { owner: "acme", repo: "web", number: 1, column: "Blocked", columnIndex: 1 },
        { owner: "acme", repo: "web", number: 2, column: "Blocked", columnIndex: 1 },
      ],
    };
    return (await handleMessage(payload)).signals.summary.orphan;
  };
  try {
    assert.deepEqual(await run({ 1: 404 }), ["acme/web#2"], "the 404 card is unknown, the verified-zero one is orphan");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("incomplete: board-wide signals are skipped, per-card flags are kept", () => {
  const items = [item(1, "Todo", 0), ...[2, 3, 4].map((n) => item(n, "In review", 2)), item(5, "In review", 2)];
  const data = {
    "a/b#1": open({ statusSince: daysAgo(1) }),
    "a/b#2": open({ statusSince: daysAgo(5) }),
    "a/b#3": open({ statusSince: daysAgo(5) }),
    "a/b#4": open({ statusSince: daysAgo(5) }),
    // a/b#5 could not be read
  };
  const whole = computeSignals({ items, data, options, columnCount: 3, now: NOW });
  assert.deepEqual(whole.summary.bottleneck, ["In review"], "baseline: the partial data would raise a bottleneck");
  const partial = computeSignals({ items, data, options, columnCount: 3, incomplete: true, now: NOW });
  assert.deepEqual(partial.summary.bottleneck, []);
  assert.deepEqual(partial.columns, []);
  assert.equal(partial.incomplete, true);
  assert.deepEqual(partial.summary.stale, ["a/b#2", "a/b#3", "a/b#4"], "per-card flags still come from what was read");
});

test("a failed fetch for one owner marks the signals incomplete", async () => {
  const realFetch = globalThis.fetch;
  resetStorage({ githubTokens: [{ id: "t", name: "t", token: "x", owner: "" }], defaultTokenId: "t" });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/graphql")) {
      const { variables } = JSON.parse(init.body);
      if (variables.o0 === "other") return { ok: false, status: 403, json: async () => ({}) };
      const issue = { state: "OPEN", labels: { nodes: [] }, comments: { nodes: [] }, projectItems: { nodes: [] } };
      return { ok: true, status: 200, json: async () => ({ data: { i0: { issueOrPullRequest: issue } } }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const res = await handleMessage({
      project: { owner: "acme", number: 1 },
      columnCount: 3,
      items: [
        { owner: "acme", repo: "web", number: 1, column: "Todo", columnIndex: 0 },
        { owner: "other", repo: "api", number: 2, column: "Todo", columnIndex: 0 },
      ],
    });
    assert.equal(res.signals.incomplete, true);
    assert.ok(res.signals.cards["acme/web#1"], "the readable card is still reported");
  } finally {
    globalThis.fetch = realFetch;
  }
});
