// Unit tests for features/quick-jump/model.js: page context, visits and the recent list,
// sections (limits, scope, once-per-panel), typing, trailing rows, copy and shortcut wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHQJ_MODEL: M } = loadGlobals(["features/quick-jump/model.js"]);
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const DAY = 1440;

const work = (repo, number, kind, reason, mins, title = `Item ${number}`) => ({ kind, repo, number, title, url: `https://github.com/${repo}/${kind === "pull" ? "pull" : "issues"}/${number}`, reason, updatedAt: iso(mins) });
const repoItem = (repo, mins) => ({ kind: "repo", repo, url: `https://github.com/${repo}`, pushedAt: iso(mins) });
const ok = (items = [], truncated = false) => ({ status: "ok", items, truncated });
const ctxRepo = M.pageContext("/acme/web/pull/3");
const base = (over = {}) => ({ scope: "everywhere", ctx: M.pageContext("/notifications"), lists: { assigned: ok(), review: ok(), repos: ok() }, recent: [], now: NOW, tokenName: "Work", mappedOwners: [], serving: "default", ...over });
const group = (v, id) => v.groups.find((g) => g.id === id);

test("context: scopes by page kind", () => {
  eq({ ...M.pageContext("/acme/web/issues/7") }, { kind: "repo", owner: "acme", repo: "web", scopes: ["repo", "everywhere"] });
  eq(M.pageContext("/acme").scopes, ["owner", "everywhere"]);
  assert.equal(M.pageContext("/orgs/acme/projects/1").owner, "acme");
  assert.equal(M.pageContext("/users/octo/projects/2").owner, "octo");
  for (const p of ["/notifications", "/pulls", "/issues", "/search", "/settings/profile", "/", "/dashboard"]) eq(M.pageContext(p).scopes, ["everywhere"], p);
  eq(M.pageContext("/acme/web", { notFound: true }).scopes, ["everywhere"]);
  assert.equal(M.scopeLabel("repo", true), "This repo");
  assert.equal(M.scopeLabel("repo"), "This repository");
});

test("visits: kinds, sub-paths, title must name the item, pages not recorded", () => {
  const v = (p, t, nwo = "acme/web") => M.parseVisit(p, t, nwo);
  const issue = v("/acme/web/issues/7/foo", "Retry upload · Issue #7 · acme/web");
  eq({ ...issue }, { kind: "issue", owner: "acme", repo: "acme/web", number: 7, title: "Retry upload", url: "https://github.com/acme/web/issues/7", key: "acme/web#7" });
  assert.equal(v("/acme/web/pull/7/files?w=1", "Fix it by octo · Pull Request #7 · acme/web").title, "Fix it");
  assert.equal(v("/acme/web/pull/7/checks", "Fix it by octo · Pull Request #7 · acme/web").url, "https://github.com/acme/web/pull/7");
  assert.equal(v("/acme/web", "GitHub - acme/web: A thing").kind, "repo");
  assert.equal(v("/acme/web/actions", "Actions · acme/web").url, "https://github.com/acme/web");
  assert.equal(v("/acme/web/issues", "Issues · acme/web").kind, "repo");
  // redirect not yet reflected in the title: nothing recorded
  assert.equal(v("/acme/web/pull/7", "Retry upload · Issue #7 · acme/web"), null);
  assert.equal(v("/acme/web/issues/7", "Page not found · GitHub"), null);
  assert.equal(v("/acme/web/issues/7", "Retry upload · Issue #7 · acme/web", ""), null, "no repository declared");
  assert.equal(v("/acme/web/issues/7", "Retry upload · Issue #7 · acme/web", "other/repo"), null);
  for (const p of ["/notifications", "/pulls", "/search", "/settings/profile", "/acme", "/orgs/acme/people", "/users/octo/projects/1"]) assert.equal(M.parseVisit(p, "Whatever · acme/web", "acme/web"), null, p);
  assert.equal(v("/Acme/Web/issues/7", "T · Issue #7 · Acme/Web", "acme/web").key, "acme/web#7", "case-insensitive key");
});

test("recent list: one entry per item, revisit moves to the top, 50 items, 30 days", () => {
  let list = [];
  const visit = (n) => ({ key: `acme/web#${n}`, url: `u${n}`, kind: "issue", repo: "acme/web", number: n, title: `t${n}` });
  for (let i = 1; i <= 55; i++) list = M.recordVisit(list, visit(i), NOW + i * 1000);
  assert.equal(list.length, 50);
  assert.equal(list[0].number, 55);
  assert.equal(list.at(-1).number, 6);
  list = M.recordVisit(list, { ...visit(10), title: "renamed" }, NOW + 99_000);
  assert.equal(list.length, 50);
  eq([list[0].number, list[0].title], [10, "renamed"]);
  assert.equal(list.filter((i) => i.key === "acme/web#10").length, 1);
  const old = [{ ...list[0], at: NOW - 31 * DAY * 60_000 }, { ...list[1], at: NOW - 29 * DAY * 60_000 }];
  assert.equal(M.pruneRecent(old, NOW).length, 1);
  eq(Object.keys(list[0]).sort(), ["at", "key", "kind", "number", "repo", "title", "url"]);
});

test("sections: Your work merges, limits to 10, orders by update, ends with the two fixed rows", () => {
  const assigned = Array.from({ length: 8 }, (_, i) => work("acme/web", i + 1, "issue", "assigned", 10 + i));
  const review = Array.from({ length: 5 }, (_, i) => work("acme/web", 100 + i, "pull", "review", 5 + i * 3));
  const v = M.buildSections(base({ lists: { assigned: ok(assigned), review: ok(review), repos: ok() } }));
  const w = group(v, "work");
  const real = w.rows.filter((r) => !r.fixed);
  assert.equal(real.length, 10);
  const times = real.map((r) => r.ctx.at(-1));
  assert.equal(w.rows.slice(-2).map((r) => r.title).join("|"), "All assigned issues on GitHub|All review requests on GitHub");
  assert.equal(real[0].number, 100, "most recently updated first");
  assert.equal(times.length, 10);
  eq(real[0].ctx.slice(0, 3), ["acme/web #100", "Open", "Review requested"]);
});

test("sections: scope limits Your work and Recent; Active repositories never in This repository", () => {
  const lists = { assigned: ok([work("acme/web", 1, "issue", "assigned", 5), work("other/x", 2, "issue", "assigned", 6)]), review: ok(), repos: ok([repoItem("acme/web", 1), repoItem("acme/api", 2), repoItem("other/x", 3)]) };
  const recent = [{ key: "acme/web#9", url: "u", kind: "issue", repo: "acme/web", number: 9, title: "R", at: NOW - 60000 }, { key: "other/x#9", url: "u", kind: "issue", repo: "other/x", number: 9, title: "O", at: NOW - 60000 }];
  const repo = M.buildSections(base({ scope: "repo", ctx: ctxRepo, lists, recent }));
  eq(group(repo, "work").rows.filter((r) => !r.fixed).map((r) => r.number), [1]);
  eq(group(repo, "recent").rows.map((r) => r.number), [9]);
  assert.equal(group(repo, "repos"), undefined);
  const owner = M.buildSections(base({ scope: "owner", ctx: M.pageContext("/acme"), lists, recent }));
  eq(group(owner, "repos").rows.filter((r) => !r.fixed).map((r) => r.title), ["acme/web", "acme/api"]);
  const every = M.buildSections(base({ lists, recent }));
  assert.equal(group(every, "repos").rows.length, 3);
});

test("sections: each item once per panel, in the first section that shows it", () => {
  const lists = { assigned: ok([work("acme/web", 1, "issue", "assigned", 5)]), review: ok(), repos: ok(["a", "b", "c", "d", "e", "f"].map((n, i) => repoItem(`acme/${n}`, i + 1))) };
  const recent = [
    { key: "acme/web#1", url: "u", kind: "issue", repo: "acme/web", number: 1, title: "dup", at: NOW - 1000 },
    { key: "acme/a#2", url: "u", kind: "issue", repo: "acme/a", number: 2, title: "kept", at: NOW - 2000 },
    { key: "acme/a", url: "u", kind: "repo", repo: "acme/a", number: 0, title: "acme/a", at: NOW - 3000 },
  ];
  const v = M.buildSections(base({ lists, recent }));
  eq(group(v, "recent").rows.map((r) => r.key), ["acme/a#2", "acme/a"]);
  const repos = group(v, "repos").rows.filter((r) => !r.fixed).map((r) => r.title);
  eq(repos, ["acme/b", "acme/c", "acme/d", "acme/e", "acme/f"], "acme/a is shown in Recent so it is skipped, up to 5 shown");
});

test("sections: Recent shows up to 10 after skipping what Your work shows", () => {
  const recent = Array.from({ length: 14 }, (_, i) => ({ key: `acme/web#${i + 1}`, url: "u", kind: "issue", repo: "acme/web", number: i + 1, title: `t${i}`, at: NOW - (i + 1) * 1000 }));
  const lists = { assigned: ok([work("acme/web", 1, "issue", "assigned", 5)]), review: ok(), repos: ok() };
  const rows = group(M.buildSections(base({ lists, recent })), "recent").rows;
  assert.equal(rows.length, 10);
  assert.equal(rows[0].number, 2);
});

test("trailing rows: See all / Your repositories only when more or truncated; never called See all in Everywhere", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((n, i) => repoItem(`acme/${n}`, i + 1));
  const five = six.slice(0, 5);
  const lastOf = (v) => group(v, "repos").rows.at(-1);
  const every6 = M.buildSections(base({ lists: { assigned: ok(), review: ok(), repos: ok(six) } }));
  assert.equal(lastOf(every6).title, "Your repositories on GitHub");
  assert.equal(lastOf(every6).href, "https://github.com/search?q=user:@me&type=repositories");
  const every5 = M.buildSections(base({ lists: { assigned: ok(), review: ok(), repos: ok(five) } }));
  assert.equal(lastOf(every5).type, "repo");
  const cut = M.buildSections(base({ lists: { assigned: ok(), review: ok(), repos: ok(five, true) } }));
  assert.equal(lastOf(cut).title, "Your repositories on GitHub");
  const owner6 = M.buildSections(base({ scope: "owner", ctx: M.pageContext("/acme"), lists: { assigned: ok(), review: ok(), repos: ok(six) } }));
  assert.equal(lastOf(owner6).title, "See all on GitHub");
  assert.equal(lastOf(owner6).href, "https://github.com/search?q=owner:acme&type=repositories");
  const ownerCutEmpty = M.buildSections(base({ scope: "owner", ctx: M.pageContext("/acme"), lists: { assigned: ok(), review: ok(), repos: ok([repoItem("other/x", 1)], true) } }));
  eq(group(ownerCutEmpty, "repos").rows.map((r) => r.title), ["See all on GitHub"]);
  const ownerEmpty = M.buildSections(base({ scope: "owner", ctx: M.pageContext("/acme"), lists: { assigned: ok(), review: ok(), repos: ok([repoItem("other/x", 1)]) } }));
  assert.equal(group(ownerEmpty, "repos"), undefined);
});

test("fixed rows carry the scope qualifier", () => {
  const u = M.fixedUrls("repo", ctxRepo);
  assert.equal(u.assigned, "https://github.com/search?q=is:issue+is:open+assignee:@me+repo:acme/web&type=issues");
  assert.equal(u.review, "https://github.com/search?q=is:pr+is:open+user-review-requested:@me+repo:acme/web&type=pullrequests");
  assert.equal(M.fixedUrls("everywhere", ctxRepo).assigned, "https://github.com/search?q=is:issue+is:open+assignee:@me&type=issues");
  assert.equal(M.fixedUrls("owner", M.pageContext("/acme")).review.includes("+owner:acme"), true);
});

test("empty lines: with the token name, truncated variant never says what the token sees", () => {
  const v = M.buildSections(base({ scope: "repo", ctx: ctxRepo, tokenName: "My token" }));
  assert.equal(group(v, "work").lines[0].text, "GH Reloaded's GitHub token “My token” sees nothing assigned to you or waiting for your review in this repository.");
  assert.equal(group(v, "work").rows.length, 2);
  const o = M.buildSections(base({ scope: "owner", ctx: M.pageContext("/acme"), tokenName: "T" }));
  assert.match(group(o, "work").lines[0].text, /review for this owner\.$/);
  const e = M.buildSections(base({ tokenName: "T" }));
  assert.match(group(e, "work").lines[0].text, /in the repositories it can reach\.$/);
  const t = M.buildSections(base({ scope: "repo", ctx: ctxRepo, tokenName: "T", lists: { assigned: ok([work("other/x", 1, "issue", "assigned", 1)], true), review: ok(), repos: ok() } }));
  assert.equal(group(t, "work").lines[0].text, "Nothing assigned to you or waiting for your review in this repository among the most recently updated items GH Reloaded's GitHub token “T” read.");
  assert.doesNotMatch(group(t, "work").lines[0].text, /sees nothing/);
  assert.equal(group(v, "recent").lines[0].text, "Issues, pull requests and repositories you open on GitHub will appear here.");
  const withStored = M.buildSections(base({ scope: "repo", ctx: ctxRepo, recent: [{ key: "o/x#1", url: "u", kind: "issue", repo: "o/x", number: 1, title: "t", at: NOW }] }));
  assert.equal(group(withStored, "recent").lines[0].text, "Nothing you opened recently in this repository.");
});

test("cannot-read list is replaced by its fixed row and line; the other list stays", () => {
  const v = M.buildSections(base({ tokenName: "T", lists: { assigned: { status: "cannot", items: [] }, review: ok([work("acme/web", 4, "pull", "review", 1)]), repos: { status: "cannot", items: [] } } }));
  const w = group(v, "work");
  assert.equal(w.rows.at(-2).href, "https://github.com/issues/assigned");
  assert.equal(w.rows.at(-1).title, "All review requests on GitHub");
  assert.equal(w.rows[0].number, 4);
  assert.equal(w.lines[0].text, "GH Reloaded's GitHub token “T” can't read your assigned issues here. This opens GitHub's page instead; check the token in GH Reloaded settings.");
  assert.equal(w.lines[0].link, "GH Reloaded settings");
  assert.equal(group(v, "repos"), undefined);
  assert.doesNotMatch(JSON.stringify(v), /token is missing|no token/i);
});

test("no serving token: three fixed rows and the line, owner or Everywhere wording", () => {
  const v = M.buildSections(base({ serving: "none", scope: "repo", ctx: ctxRepo, lists: { assigned: { status: "none", items: [] }, review: { status: "none", items: [] }, repos: { status: "none", items: [] } } }));
  const w = group(v, "work");
  eq(w.rows.map((r) => r.href), ["https://github.com/issues/assigned", "https://github.com/pulls/review-requested", "https://github.com/pulls"]);
  assert.equal(w.lines[0].text, "None of the GitHub tokens saved in GH Reloaded applies here: none is mapped to acme and none is the default. These open GitHub's own pages; map a token or choose a default in GH Reloaded settings.");
  const e = M.buildSections(base({ serving: "none", lists: { assigned: { status: "none", items: [] }, review: { status: "none", items: [] }, repos: { status: "none", items: [] } } }));
  assert.match(group(e, "work").lines[0].text, /applies to Everywhere: none is the default\./);
  assert.equal(group(v, "repos"), undefined);
});

test("owner line in Everywhere: at most three logins then and n more", () => {
  const l = (o) => M.buildSections(base({ mappedOwners: o })).groups[0].lines.find((x) => x.id === "owner-line");
  assert.equal(l(["acme-labs", "octo"]).text, "Listed with your default GitHub token. Work in acme-labs, octo shows when you open this view on their pages.");
  assert.match(l(["a", "b", "c", "d", "e"]).text, /Work in a, b, c, and 2 more shows/);
  assert.equal(l([]), undefined);
  const inRepo = M.buildSections(base({ scope: "repo", ctx: ctxRepo, mappedOwners: ["acme"] })).groups[0].lines.find((x) => x.id === "owner-line");
  assert.equal(inRepo, undefined);
});

test("status lines: grouped in the stated order, names, cached wording, minutes", () => {
  const L = (status, items = [], waitMs = 60_000) => ({ status, items, waitMs });
  const lines = M.statusLines({ assigned: L("ok"), review: L("limited"), repos: L("ok") });
  eq(lines.map((x) => x.text), ["GitHub is limiting requests right now, so your review requests are not shown. Recent items stay available; they refresh in about a minute."]);
  const two = M.statusLines({ assigned: L("limited"), review: L("limited"), repos: L("error") });
  assert.equal(two[0].text, "GitHub is limiting requests right now, so your assigned issues and your review requests are not shown. Recent items stay available; they refresh in about a minute.");
  assert.equal(two[1].text, "GitHub can't be reached right now, so active repositories are not shown. Recent items stay available; they refresh in about a minute.");
  const three = M.statusLines({ assigned: L("limited", [1]), review: L("limited", [1]), repos: L("limited", [1], 240_000) });
  assert.equal(three[0].text, "GitHub is limiting requests right now, so your assigned issues, your review requests and active repositories may be out of date. Recent items stay available; they refresh in about 4 minutes.");
  const order = M.statusLines({ assigned: L("error", [1]), review: L("limited"), repos: L("error") });
  eq(order.map((x) => x.id), ["limited", "error", "error-cached"]);
  assert.equal(M.statusLines({ assigned: L("ok"), review: L("cannot"), repos: L("loading") }).length, 0);
  assert.equal(M.waitFor(NOW + 5_000, NOW), 60_000);
  assert.equal(M.waitFor(NOW + 200_000, NOW), 200_000);
  assert.equal(M.waitFor(null, NOW), 60_000);
});

test("typing: all fetched and stored items, grouped, once, capped at 10, highlighted; search row last", () => {
  const assigned = [work("acme/web", 61, "pull", "review", 10, "Retry the upload when the worker times out"), work("acme/web", 54, "issue", "assigned", 12, "Sort by oldest")];
  const many = Array.from({ length: 12 }, (_, i) => work("acme/web", 200 + i, "issue", "assigned", 20 + i, `upload job ${i}`));
  const recent = [{ key: "acme/web#61", url: "u", kind: "pull", repo: "acme/web", number: 61, title: "Retry the upload when the worker times out", at: NOW }, { key: "acme/web#300", url: "u", kind: "issue", repo: "acme/web", number: 300, title: "Upload docs", at: NOW }];
  const lists = { assigned: ok([...assigned, ...many]), review: ok(), repos: ok([repoItem("acme/uploader", 5)]) };
  const v = M.buildMatches({ query: "Upload", scope: "everywhere", ctx: M.pageContext("/pulls"), lists, recent, now: NOW });
  const rows = v.groups[0].rows;
  assert.equal(rows.length, 10);
  assert.equal(rows.filter((r) => r.number === 61).length, 1);
  eq(rows[0].ranges.title, [[10, 16]]);
  assert.equal(v.groups.at(-1).rows[0].title, "Search GitHub for “Upload”");
  assert.equal(v.groups.at(-1).rows[0].href, "https://github.com/search?q=Upload");
  const all = M.buildMatches({ query: "upload", scope: "everywhere", ctx: M.pageContext("/pulls"), lists: { assigned: ok([]), review: ok(), repos: ok([repoItem("acme/uploader", 5)]) }, recent: [], now: NOW });
  assert.equal(all.groups[0].rows[0].type, "repo");
  eq(all.groups[0].rows[0].ranges.repo, [[5, 11]]);
});

test("typing: words all match, number with or without #, scope qualifier, no-match message", () => {
  const lists = { assigned: ok([work("acme/web", 61, "pull", "review", 10, "Retry the upload")]), review: ok(), repos: ok() };
  const q = (query, scope = "repo", ctx = ctxRepo) => M.buildMatches({ query, scope, ctx, lists, recent: [], now: NOW });
  assert.equal(q("retry upload").groups[0].rows.length, 1);
  assert.equal(q("retry nothing").groups[0].id, "search");
  assert.equal(q("#61").groups[0].rows.length, 1);
  assert.equal(q("61").groups[0].rows.length, 1);
  assert.equal(q("acme/web").groups[0].rows.length, 1);
  assert.equal(q("zzz").none.text, "No matches in your work or recent items.");
  assert.equal(q("zzz").none.second, "Search GitHub to look beyond them.");
  assert.equal(q("fix it").groups.at(-1).rows[0].href, "https://github.com/search?q=repo%3Aacme%2Fweb+fix+it");
  assert.equal(q("fix", "owner", M.pageContext("/acme")).groups.at(-1).rows[0].href, "https://github.com/search?q=owner%3Aacme+fix");
  assert.equal(q("fix", "everywhere").groups.at(-1).rows[0].href, "https://github.com/search?q=fix");
  assert.equal(q("retry", "repo", M.pageContext("/other/x/pull/1")).groups[0].id, "search", "outside the scope: no match");
});

test("relative time wording", () => {
  const t = (mins) => M.relativeTime(NOW - mins * 60_000, NOW);
  eq([t(0.2), t(12), t(180), t(DAY * 1.2), t(4 * DAY), t(9 * DAY), t(21 * DAY), t(40 * DAY)], ["just now", "12 minutes ago", "3 hours ago", "yesterday", "4 days ago", "last week", "3 weeks ago", "last month"]);
});

test("shortcut copy: platform wording and the cmdk keys", () => {
  assert.equal(M.shortcutText("Alt+Shift+K", false), "Alt+Shift+K");
  assert.equal(M.shortcutText("MacCtrl+Shift+K", true), "⌃⇧K");
  assert.equal(M.shortcutText("Alt+Shift+K", true), "⌥⇧K");
  assert.equal(M.footerShortcut({ choice: "cmdk", platform: "mac" }), "⌘K");
  assert.equal(M.footerShortcut({ choice: "cmdk", platform: "other" }), "Ctrl+K");
  assert.equal(M.footerShortcut({ choice: "browser", shortcut: "", platform: "other" }), "Not set");
  assert.equal(M.isCmdK({ key: "k", metaKey: true }, true), true);
  assert.equal(M.isCmdK({ key: "k", ctrlKey: true }, true), false);
  assert.equal(M.isCmdK({ key: "K", ctrlKey: true }, false), true);
  assert.equal(M.isCmdK({ key: "k", ctrlKey: true, altKey: true }, false), false, "Ctrl+Alt+K stays GitHub's");
  assert.equal(M.isCmdK({ key: "k", metaKey: true, altKey: true }, true), false);
});
