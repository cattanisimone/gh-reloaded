// The Triage model's copy and counts for the check beyond the current page:
// one case per state-table row, the N+ / N / 99+ rules, the Grouped coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/classify.js", "features/notifications/collect.js", "features/notifications/triage-model.js"]);
const M = g.GHNT_TRIAGE_MODEL;
const j = (v) => JSON.parse(JSON.stringify(v));
const NOW = Date.parse("2026-11-01T12:00:00Z");

const base = { supported: true, unsupported: null, apiState: "ok", active: true, running: false, runCategory: null, stopped: false, ended: null, pages: 2, next: true, ceiling: false, retryAt: null, error: null, filledKeys: [] };
const sum = (o = {}) => ({ outside: [], k: 0, u: 0, pending: 0, pageRows: 6, m: 6, byCat: { attention: 0, waiting: 0, informational: 0, unverifiable: 0 }, denied: false, ...o });
const snap = (o = {}, s = {}) => ({ ...base, ...o, summary: sum(s) });
const counts = (o = {}) => ({ attention: 0, waiting: 0, informational: 0, unverifiable: 0, pending: 0, loaded: 6, ...o });
const entry = (n, category, over = {}) => ({ key: `acme/web#${n}`, kind: "pull", owner: "acme", repo: "web", number: n, href: `https://github.com/acme/web/pull/${n}`, title: `Title ${n}`, reason: "subscribed", updatedAt: "2026-11-01T11:00:00Z", category, ...over });
const narrow = { review: "/notifications?query=reason%3Areview-requested", mention: "/notifications?query=reason%3Amention" };
const text = (lines) => lines.map((l) => l.segs.map((s) => s.v || s.label || `[${s.t}]`).join("")).join(" | ");
const V = (c, o, s, extra = {}) => M.view(c, { layout: "integrated", selected: o, now: NOW, nextHref: "/notifications?page=2", narrow, fmtTime: () => "14:05", fill: s, ...extra });

test("model without a fill keeps the 1.7.0 copy", () => {
  const v = M.view(counts({ attention: 2 }), { layout: "integrated", selected: "attention", nextHref: "/n" });
  assert.equal(v.status, "Needs attention · 2 of 6 loaded");
  assert.equal(v.coverage, "Counts cover the 6 loaded notifications; more pages not loaded.");
});

test("triage-model: N+ while a next page exists, aria-label says the scope", () => {
  const v = V(counts({ informational: 3 }), null, snap({}, { byCat: { informational: 7, attention: 0, waiting: 0, unverifiable: 0 }, m: 20 }));
  const c = v.cats.find((x) => x.id === "informational");
  assert.equal(c.count, "10+");
  assert.equal(c.aria, "Informational, 10 found so far, 20 notifications checked, more not checked");
});

test("triage-model: bare N only when complete (no next page, nothing unverified)", () => {
  const v = V(counts({ informational: 3 }), null, snap({ next: false }, { outside: [], m: 6 }));
  assert.equal(v.cats.find((x) => x.id === "informational").count, "3");
  assert.equal(v.cats.find((x) => x.id === "informational").aria, "Informational, 3 in all 6 notifications checked");
});

test("triage-model: 99+ cap with N+ and N", () => {
  const big = counts({ informational: 120 });
  assert.equal(V(big, null, snap()).cats[2].count, "99+");
  assert.equal(V(big, null, snap({ next: false })).cats[2].count, "99+");
  assert.equal(V(counts({ informational: 99 }), null, snap()).cats[2].count, "99+");
  assert.equal(V(counts({ informational: 98 }), null, snap()).cats[2].count, "98+");
});

test("triage-model: no '+' and the 1.7.0 aria-label when nothing can be checked outside", () => {
  const v = V(counts({ attention: 1 }), null, snap({ active: false, apiState: "unavailable" }));
  assert.equal(v.cats[0].count, "1");
  assert.equal(v.cats[0].aria, "Needs attention, 1 of 6 loaded notifications");
});

test("triage-model: status line with outside entries", () => {
  const entries = Array.from({ length: 7 }, (_, i) => entry(i + 10, "unverifiable", { reason: "weird" }));
  const v = V(counts({ unverifiable: 15 }), "unverifiable", snap({}, { outside: entries, byCat: { attention: 0, waiting: 0, informational: 0, unverifiable: 7 }, m: 35 }));
  assert.equal(v.status, "Unverifiable · 15 on this page + 7 outside · 35 notifications checked");
  assert.equal(V(counts({ unverifiable: 15 }), "unverifiable", snap({}, { m: 25 })).status, "Unverifiable · 15 on this page · 25 notifications checked");
});

test("state: fill in progress", () => {
  const v = V(counts(), "informational", snap({ running: true }, { m: 25 }));
  assert.equal(text(v.lines), "Checking more notifications… 25 checked [stop] | More notifications not checked yet.");
});

test("state: cap reached, partial -> More notifications not checked yet + Load more", () => {
  const v = V(counts({ informational: 4 }), "informational", snap({ ended: "budget", filledKeys: ["informational"] }, { m: 25 }));
  assert.equal(text(v.lines), "More notifications not checked yet. [load-more]");
});

test("state: complete -> bare N and the 'All m checked' line", () => {
  const v = V(counts({ informational: 4 }), "informational", snap({ next: false, ended: "complete", filledKeys: ["informational"] }, { m: 6 }));
  assert.equal(text(v.lines), "All 6 notifications available to your token checked.");
  assert.equal(v.cats[2].count, "4");
});

test("state: ceiling -> Stopped after m, narrowing links for Needs attention, Next page for label categories", () => {
  const s = snap({ ceiling: true, pages: 20, ended: "ceiling", filledKeys: ["attention", "informational"] }, { m: 1000 });
  assert.equal(text(V(counts(), "attention", s).lines), "Stopped after 1000 notifications. Narrow with GitHub filters to check further. Narrow with GitHub filters: Review requests › Mentions ›" + " Next page ›");
  assert.equal(text(V(counts(), "informational", s).lines), "Stopped after 1000 notifications. Narrow with GitHub filters to check further. Next page ›");
});

test("state: rate limit -> Load more disabled with the reset time, enabled again after it", () => {
  const s = snap({ retryAt: NOW + 60_000, ended: "rate-limited", filledKeys: ["attention"] }, { m: 30 });
  const v = V(counts(), "attention", s);
  assert.equal(text(v.lines), "GitHub rate limit reached. Results so far are kept; you can load more after 14:05. [load-more]");
  const lm = v.lines[0].segs.find((x) => x.t === "load-more");
  assert.deepEqual(j(lm), { t: "load-more", disabled: true, desc: "Available after 14:05" });
  assert.ok(!text(M.view(counts(), { layout: "integrated", selected: "attention", now: NOW + 61_000, fill: s, narrow, fmtTime: () => "14:05" }).lines).includes("rate limit"));
  assert.equal(v.cats[0].count, "0+");
});

test("state: default token fine-grained or lacking the scope", () => {
  const s = snap({ active: false, apiState: "missing-scope" });
  assert.equal(text(V(counts(), "attention", s).lines), "Notifications outside this page can't be checked: the default GitHub token must be a classic token with the notifications scope. Narrow with GitHub filters: Review requests › Mentions › Next page ›");
  const label = text(V(counts(), "informational", s).lines);
  assert.equal(label, "Notifications outside this page can't be checked: the default GitHub token must be a classic token with the notifications scope. Only this page is counted. Next page ›");
  assert.ok(!label.includes("Review requests"));
  assert.equal(V(counts(), "attention", s).cats[0].count, "0");
});

test("state: no token at all", () => {
  const s = snap({ active: false, apiState: "not-tried" });
  assert.equal(text(V(counts(), "attention", s).lines), "Without a GitHub token, review requests and mentions can't be verified, so none is counted as Needs attention. Settings → GitHub tokens Next page ›");
  assert.equal(text(V(counts(), "unverifiable", s).lines), "Only this page is counted. Next page ›");
});

test("state: unsupported native filter, named, zero links", () => {
  const s = snap({ supported: false, unsupported: "is:saved", active: false });
  const t = text(V(counts(), "attention", s).lines);
  assert.equal(t, "The filter is:saved can't be applied outside this page, so only this page is counted. Next page ›");
  assert.ok(!t.includes("Review requests"));
});

test("state: 401 / other 403 / no answer", () => {
  assert.equal(text(V(counts(), "attention", snap({ active: false, apiState: "refused" })).lines), "Couldn't check notifications outside this page: GitHub refused the token. Results on this page are unaffected. Narrow with GitHub filters: Review requests › Mentions › Next page ›");
  assert.equal(text(V(counts(), "informational", snap({ active: false, apiState: "no-answer" })).lines), "Couldn't check notifications outside this page: GitHub did not answer. Results on this page are unaffected. Next page ›");
});

test("state: an error after the first answer keeps the entries, '+' stays, Load more retries", () => {
  const v = V(counts({ informational: 2 }), "informational", snap({ error: "no-answer", ended: "error", filledKeys: ["informational"] }, { outside: [entry(9, "informational")], byCat: { attention: 0, waiting: 0, informational: 1, unverifiable: 0 }, m: 7 }));
  assert.match(text(v.lines), /^Couldn't check notifications outside this page: GitHub did not answer\. Results on this page are unaffected\. Next page › \[load-more\]/);
  assert.equal(v.cats[2].count, "3+");
  assert.equal(v.outside.entries.length, 1);
});

test("state: empty partial / empty complete never say all clear", () => {
  const partial = V(counts(), "waiting", snap({}, { m: 25 }));
  assert.equal(partial.empty, "No match on this page or in the 25 notifications checked.");
  const done = V(counts(), "waiting", snap({ next: false }, { m: 25 }));
  assert.equal(done.empty, "No match in the 25 notifications checked.");
  for (const t of [partial.empty, done.empty, text(partial.lines), text(done.lines)]) assert.doesNotMatch(t, /all clear|no notifications|inbox empty/i);
});

test("state: stopped by the user -> Stopped. m notifications checked. + Load more", () => {
  assert.equal(text(V(counts(), "attention", snap({ stopped: true, filledKeys: ["attention"] }, { m: 25 })).lines), "Stopped. 25 notifications checked. [load-more]");
});

test("state: SSO caveat for a denied owner, in any category, the count stays N+", () => {
  const s = snap({ filledKeys: ["informational"] }, { m: 25, denied: true });
  const v = V(counts(), "informational", s);
  assert.match(text(v.lines), /Notifications from organizations your token can't read may be missing\.$/);
  assert.equal(M.view(counts(), { layout: "integrated", selected: "attention", now: NOW, fill: s }).lines.at(-1).segs[0].v, "Notifications from organizations your token can't read may be missing.");
});

test("triage-model: Informational with 3 outside mention items not looked up -> listed 0, not verified 3, N+", () => {
  const v = V(counts({ informational: 2 }), "informational", snap({ ended: "budget", filledKeys: ["informational"] }, { pending: 3, k: 3, m: 9 }));
  assert.equal(v.outside.k, 0);
  assert.equal(v.cats[2].count, "2+");
  assert.equal(text(v.lines), "3 not verified yet. | More notifications not checked yet. [load-more]");
  assert.match(v.cats[2].aria, /3 not verified yet/);
});

test("triage-model: label category, no next page, k = 2 unverified -> no Load more, no 'not checked yet', Needs attention / Waiting links", () => {
  const v = V(counts({ informational: 2 }), "informational", snap({ next: false, ended: "complete", filledKeys: ["informational"] }, { pending: 2, k: 2, m: 8 }));
  assert.equal(text(v.lines), "2 not verified yet. Pick Needs attention or Waiting to look them up.");
  assert.ok(!j(v.lines).some((l) => l.segs.some((s) => s.t === "load-more")));
  assert.deepEqual(j(v.lines[0].segs.filter((s) => s.t === "select").map((s) => s.cat)), ["attention", "waiting"]);
  assert.equal(v.cats[2].count, "2+");
  const done = V(counts({ informational: 2 }), "informational", snap({ next: false }, { m: 6 }));
  assert.equal(done.cats[2].count, "2");
});

test("triage-model: Informational, last page, 2 unkeyable CheckSuite items -> listed 0, '2 not verified yet' + Next page sentence, no Pick sentence, N+", () => {
  const v = V(counts({ informational: 2 }), "informational", snap({ next: false, ended: "complete", filledKeys: ["informational"] }, { k: 2, u: 2, m: 8 }));
  assert.equal(text(v.lines), "2 not verified yet. 2 of them can only be opened from GitHub's list: Next page ›");
  assert.doesNotMatch(text(v.lines), /Pick/);
  assert.equal(v.cats[2].count, "2+");
});

test("triage-model: Needs attention, lookups done, only unkeyable left -> not verified + Next page, never complete", () => {
  const v = V(counts({ attention: 1 }), "attention", snap({ next: false, ended: "complete", filledKeys: ["attention"] }, { k: 1, u: 1, m: 7 }));
  assert.equal(text(v.lines), "1 not verified yet. 1 of them can only be opened from GitHub's list: Next page ›");
  assert.ok(!text(v.lines).includes("All "));
});

test("triage-model: Grouped, fill finished, k = 3 with u = 2 -> '{m} checked. 3 not verified yet. 2 of them…', never 'All … checked', every header N+", () => {
  const s = snap({ next: false, ended: "complete", filledKeys: ["*"] }, { pending: 1, k: 3, u: 2, m: 40, pageRows: 6 });
  const v = M.view(counts({ attention: 1 }), { layout: "grouped", now: NOW, nextHref: "/notifications?page=2", fill: s });
  assert.equal(text(v.lines), "40 notifications checked. | 3 not verified yet. 2 of them can only be opened from GitHub's list: Next page › [load-more]");
  const settled = M.view(counts({ attention: 1 }), { layout: "grouped", now: NOW, nextHref: "/notifications?page=2", fill: snap({ next: false, ended: "complete", filledKeys: ["*"] }, { k: 2, u: 2, m: 40 }) });
  assert.equal(text(settled.lines), "40 notifications checked. | 2 not verified yet. 2 of them can only be opened from GitHub's list: Next page ›");
  assert.doesNotMatch(text(v.lines), /All 40/);
  for (const c of v.cats) assert.match(c.count, /\+$/);
});

test("Grouped: before any fill the counts cover the loaded rows and the action is offered; headers carry no outside count", () => {
  const s = snap({}, { outside: [entry(9, "informational")], byCat: { attention: 0, waiting: 0, informational: 1, unverifiable: 0 }, m: 7 });
  const v = M.view(counts({ informational: 2 }), { layout: "grouped", now: NOW, fill: s });
  assert.equal(text(v.lines), "Counts cover the 6 loaded notifications; more pages not loaded. [check]");
  assert.equal(v.cats[2].count, "2");
  assert.equal(v.cats[2].outside, null);
});

test("Grouped: after a fill each expanded section has an inert sub-list of at most 5, collapsed sections none", () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(i + 20, "attention", { reason: "review_requested" }));
  const s = snap({ filledKeys: ["*"], ended: "budget" }, { outside: entries, byCat: { attention: 8, waiting: 0, informational: 0, unverifiable: 0 }, m: 40 });
  const v = M.view(counts(), { layout: "grouped", now: NOW, fill: s, collapsed: { waiting: true } });
  assert.deepEqual([v.cats[0].outside.entries.length, v.cats[0].outside.more, v.cats[0].outside.heading], [5, 3, "Outside this page (8)"]);
  assert.equal(v.cats[0].outside.moreLabel, "Show 3 more outside this page");
  assert.equal(v.cats[1].outside, null);
  assert.equal(v.cats[0].count, "8+");
  assert.deepEqual(j(v.cats[1].note), []);
  assert.match(v.cats[2].note[0], /^None on this page or in the 40 checked\.$/);
});

test("Grouped: nothing can be checked -> the Needs attention / Waiting text with Next page, headers keep page-only counts with no '+'", () => {
  const v = M.view(counts({ attention: 1 }), { layout: "grouped", now: NOW, nextHref: "/n", narrow, fill: snap({ active: false, apiState: "missing-scope" }) });
  assert.match(text(v.lines), /^Notifications outside this page can't be checked: .*Narrow with GitHub filters: Review requests › Mentions › Next page ›$/);
  assert.equal(v.cats[0].count, "1");
});

test("outside list: 25 entries, then 'Show {n} more'; entry has title link, aria suffix, repo #n, reason, time, category tag", () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(i + 1, "unverifiable", { reason: "weird" }));
  const v = V(counts(), "unverifiable", snap({}, { outside: entries, byCat: { attention: 0, waiting: 0, informational: 0, unverifiable: 30 }, m: 36 }));
  assert.equal(v.outside.entries.length, 25);
  assert.equal(v.outside.moreLabel, "Show 5 more outside this page");
  assert.deepEqual(j(v.outside.entries[0]), { key: "acme/web#1", title: "Title 1", href: "https://github.com/acme/web/pull/1", aria: "Title 1, opens on GitHub", repo: "acme/web #1", reason: "unrecognised reason", time: "1 hour ago", category: "unverifiable", categoryLabel: "Unverifiable", unread: true });
  assert.equal(v.outside.heading, "Outside this page (30)");
  assert.equal(v.outside.sub, "From your notifications on GitHub · read-only");
});

test("the model never words an empty or partial state as complete", () => {
  for (const sel of M.IDS) for (const next of [true, false]) {
    const t = text(V(counts(), sel, snap({ next }, { m: 6 })).lines);
    assert.doesNotMatch(t, /all clear|no notifications|inbox empty|nothing to do/i);
  }
});

test("ago: minutes, hours, days, then the date", () => {
  assert.equal(M.ago("2026-11-01T11:59:50Z", NOW), "just now");
  assert.equal(M.ago("2026-11-01T11:55:00Z", NOW), "5 minutes ago");
  assert.equal(M.ago("2026-10-30T12:00:00Z", NOW), "2 days ago");
  assert.equal(M.ago("2026-08-01T12:00:00Z", NOW), "2026-08-01");
  assert.equal(M.ago("", NOW), "");
});
