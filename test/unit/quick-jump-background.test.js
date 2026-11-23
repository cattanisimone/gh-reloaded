// Unit tests for background/quick-jump.js: token per scope, the three GETs, the session cache,
// waits, list classification, visits and the recent list, clean-up, the command and lib's requireToken.
import "../support/chrome-stub.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage, chromeStub } from "../support/chrome-stub.js";
import * as bg from "../../background/quick-jump.js";
import { ghFetchRaw } from "../../lib/github-api.js";

let realFetch, realNow;
let calls;
let session;
let sent;
let clock;

const TOKENS = {
  githubTokens: [
    { id: "d", name: "Personal", token: "SECRET_D", owner: "" },
    { id: "o", name: "Acme org", token: "SECRET_O", owner: "acme" },
  ],
  defaultTokenId: "d",
  ghqjEnabled: true,
};

const issue = (n, repo, mins, extra = {}) => ({ number: n, title: `Issue ${n}`, updated_at: new Date(Date.parse("2026-11-20T12:00:00Z") - mins * 60000).toISOString(), repository_url: `https://api.github.com/repos/${repo}`, ...extra });
let plan;
function res(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body, clone() { return this; } };
}
beforeEach(() => {
  realFetch = globalThis.fetch;
  realNow = Date.now;
  clock = Date.parse("2026-11-20T12:00:00Z");
  Date.now = () => clock;
  calls = [];
  sent = [];
  session = {};
  plan = {};
  chromeStub.storage.session = { get: async (k) => (k in session ? { [k]: structuredClone(session[k]) } : {}), set: async (o) => Object.assign(session, structuredClone(o)) };
  chromeStub.tabs = { sendMessage: async (id, m) => { sent.push([id, m]); }, create: async (o) => { sent.push(["create", o]); } };
  chromeStub.runtime = { getPlatformInfo: async () => ({ os: "linux" }), getURL: (p) => `chrome-extension://x/${p}` };
  chromeStub.commands = { getAll: async () => [{ name: "open-quick-jump", shortcut: "Alt+Shift+K" }] };
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, host: u.host, auth: opts.headers.Authorization, method: opts.method || "GET" });
    const which = u.pathname === "/issues" ? "assigned" : u.pathname === "/search/issues" ? "review" : "repos";
    const p = plan[which];
    if (p) return typeof p === "function" ? p() : p;
    if (which === "assigned") return res(200, [issue(1, "acme/web", 5), issue(2, "other/x", 9), issue(3, "acme/web", 7, { pull_request: {} })]);
    if (which === "review") return res(200, { total_count: 1, items: [issue(4, "acme/web", 3)] });
    return res(200, [{ full_name: "acme/web", pushed_at: "2026-11-20T10:00:00Z" }]);
  };
  resetStorage({ ...TOKENS });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

const refresh = (scope, owner) => bg.handleMessage({ phase: "refresh", scope, owner });
const cached = (scope, owner) => bg.handleMessage({ phase: "cached", scope, owner });

test("a repository scope uses the owner's mapped token, else the default; Everywhere the default only", async () => {
  let r = await refresh("repo", "acme");
  assert.deepEqual([r.serving, r.tokenName], ["mapped", "Acme org"]);
  assert.deepEqual([...new Set(calls.map((c) => c.auth))], ["Bearer SECRET_O"]);
  calls.length = 0;
  r = await refresh("repo", "someone");
  assert.deepEqual([r.serving, r.tokenName], ["default", "Personal"]);
  assert.deepEqual([...new Set(calls.map((c) => c.auth))], ["Bearer SECRET_D"]);
  calls.length = 0;
  session = {};
  r = await refresh("everywhere", "acme");
  assert.deepEqual([r.serving, r.tokenName, r.mappedOwners], ["default", "Personal", ["acme"]]);
  assert.deepEqual([...new Set(calls.map((c) => c.auth))], ["Bearer SECRET_D"]);
});

test("one open sends at most the three GETs, only to api.github.com, never a write", async () => {
  await refresh("everywhere", "");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.path).sort(), [
    "/issues?filter=assigned&state=open&sort=updated&direction=desc&per_page=100",
    "/search/issues?q=is:pr+is:open+user-review-requested:@me&sort=updated&order=desc&per_page=100",
    "/user/repos?sort=pushed&per_page=100",
  ].sort());
  assert.ok(calls.every((c) => c.host === "api.github.com" && c.method === "GET"));
  await refresh("everywhere", "");
  assert.equal(calls.length, 3, "inside the minute nothing is sent again");
  const c = await cached("everywhere", "");
  assert.equal(calls.length, 3, "the cached phase sends nothing");
  assert.equal(c.lists.assigned.status, "ok");
});

test("lists are trimmed: pull requests dropped from assigned, only shown fields kept, URLs rebuilt", async () => {
  const r = await refresh("everywhere", "");
  assert.deepEqual(r.lists.assigned.items.map((i) => [i.kind, i.repo, i.number, i.url]), [["issue", "acme/web", 1, "https://github.com/acme/web/issues/1"], ["issue", "other/x", 2, "https://github.com/other/x/issues/2"]]);
  assert.deepEqual(r.lists.review.items[0], { kind: "pull", repo: "acme/web", number: 4, title: "Issue 4", url: "https://github.com/acme/web/pull/4", reason: "review", updatedAt: r.lists.review.items[0].updatedAt });
  assert.deepEqual(r.lists.repos.items, [{ kind: "repo", repo: "acme/web", url: "https://github.com/acme/web", pushedAt: "2026-11-20T10:00:00Z" }]);
  assert.equal(JSON.stringify(r).includes("SECRET"), false, "no token value in anything returned");
});

test("truncation: Link rel=next for issues and repositories, total_count for search", async () => {
  plan.assigned = res(200, [issue(1, "a/b", 1)], { link: '<https://api.github.com/x?page=2>; rel="next"' });
  plan.review = res(200, { total_count: 150, items: [issue(2, "a/b", 1)] });
  plan.repos = res(200, [], {});
  const r = await refresh("everywhere", "");
  assert.deepEqual([r.lists.assigned.truncated, r.lists.review.truncated, r.lists.repos.truncated], [true, true, false]);
});

test("classification: cannot (401, 404, 422, plain 403), limited (429, 403 with remaining 0 or retry-after), error (5xx, network)", async () => {
  for (const [status, headers, want] of [[401, {}, "cannot"], [404, {}, "cannot"], [422, {}, "cannot"], [403, {}, "cannot"], [429, {}, "limited"], [403, { "x-ratelimit-remaining": "0" }, "limited"], [403, { "retry-after": "30" }, "limited"], [500, {}, "error"], [502, {}, "error"]]) {
    resetStorage({ ...TOKENS });
    session = {};
    plan.assigned = res(status, { message: "x" }, headers);
    const r = await refresh("everywhere", "");
    assert.equal(r.lists.assigned.status, want, `${status} ${JSON.stringify(headers)}`);
    assert.equal(r.lists.review.status, "ok", "another list's outcome never hides this one");
  }
  plan.assigned = () => { throw new TypeError("network"); };
  session = {};
  assert.equal((await refresh("everywhere", "")).lists.assigned.status, "error");
});

test("a limited or failed list keeps the last good rows, waits at least a minute and what GitHub asked", async () => {
  await refresh("everywhere", "");
  clock += 61_000;
  plan.assigned = res(429, {}, { "retry-after": "300" });
  let r = await refresh("everywhere", "");
  assert.equal(r.lists.assigned.status, "limited");
  assert.equal(r.lists.assigned.items.length, 2, "cached rows stay");
  assert.equal(r.lists.assigned.waitMs, 300_000);
  const n = calls.length;
  clock += 120_000;
  await refresh("everywhere", "");
  assert.equal(calls.filter((c) => c.path.startsWith("/issues")).length, 2, "not asked again before the wait is over (once at open, once limited)");
  clock += 200_000;
  plan.assigned = undefined;
  r = await refresh("everywhere", "");
  assert.equal(r.lists.assigned.status, "ok");
  assert.ok(calls.length > n);
  // an error waits a minute
  clock += 61_000;
  plan.review = res(503, {});
  r = await refresh("everywhere", "");
  assert.equal(r.lists.review.status, "error");
  assert.equal(r.lists.review.waitMs, 60_000);
});

test("tokens are saved but none serves the scope: no request at all, not even anonymous", async () => {
  resetStorage({ githubTokens: [{ id: "o", name: "Acme", token: "SECRET_O", owner: "acme" }], defaultTokenId: null, ghqjEnabled: true });
  let r = await refresh("everywhere", "");
  assert.equal(r.serving, "none");
  assert.equal(r.lists.assigned.status, "none");
  r = await refresh("repo", "someone");
  assert.equal(r.serving, "none");
  assert.equal(calls.length, 0);
  r = await refresh("repo", "acme");
  assert.equal(r.serving, "mapped");
  assert.equal(calls.length, 3);
});

test("a failing list is never retried with another token", async () => {
  plan.assigned = res(404, {});
  await refresh("repo", "acme");
  assert.deepEqual([...new Set(calls.map((c) => c.auth))], ["Bearer SECRET_O"]);
  assert.equal(calls.filter((c) => c.path.startsWith("/issues")).length, 1);
});

test("the cache is per token record and purged when the secret changes or the token is removed", async () => {
  await refresh("repo", "acme");
  await refresh("everywhere", "");
  assert.deepEqual(Object.keys(session.ghqjCache).sort(), ["d", "o"]);
  await chromeStub.storage.local.set({ githubTokens: [{ id: "d", name: "Personal", token: "SECRET_D", owner: "" }, { id: "o", name: "Acme org", token: "NEW", owner: "acme" }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(Object.keys(session.ghqjCache), ["d"]);
  await chromeStub.storage.local.set({ githubTokens: [{ id: "o", name: "Acme org", token: "NEW", owner: "acme" }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(Object.keys(session.ghqjCache || {}), []);
  const cachedO = await cached("repo", "acme");
  assert.equal(cachedO.lists.assigned.status, "loading", "nothing is shown under another token");
});

test("nothing happens when switched off or with no token", async () => {
  resetStorage({ ...TOKENS, ghqjEnabled: false });
  assert.deepEqual(await refresh("everywhere", ""), { active: false });
  resetStorage({});
  assert.deepEqual(await refresh("everywhere", ""), { active: false });
  assert.equal(calls.length, 0);
});

test("requireToken: ghFetchRaw sends nothing when no token applies", async () => {
  resetStorage({ githubTokens: [{ id: "o", name: "Acme", token: "S", owner: "acme" }], defaultTokenId: null });
  await assert.rejects(() => ghFetchRaw("/user/repos", { owner: "", requireToken: true }), (e) => e.noToken === true);
  assert.equal(calls.length, 0);
  resetStorage({ ...TOKENS });
  const r = await ghFetchRaw("/user/repos", { owner: "acme", requireToken: true });
  assert.equal(r.tokenId, "o");
});

// ---- visits ------------------------------------------------------------------------

const GH = { url: "https://github.com/acme/web/issues/7" };

test("visit: validated, rebuilt URL, one entry per item, 50 items, 30 days", async () => {
  const v = (extra = {}) => ({ kind: "issue", repo: "acme/web", number: 7, title: "  Retry  upload ", ...extra });
  assert.deepEqual(await bg.visit.handleMessage(v(), GH), { recorded: true });
  let list = (await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent;
  assert.deepEqual(list.map((i) => [i.key, i.url, i.title]), [["acme/web#7", "https://github.com/acme/web/issues/7", "Retry upload"]]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["at", "key", "kind", "number", "repo", "title", "url"]);
  clock += 1000;
  await bg.visit.handleMessage(v({ repo: "ACME/Web", title: "Renamed" }), GH);
  list = (await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent;
  assert.equal(list.length, 1, "one entry per item regardless of letter case");
  assert.equal(list[0].title, "Renamed");
  for (let i = 1; i <= 55; i++) { clock += 1000; await bg.visit.handleMessage(v({ number: 100 + i }), GH); }
  list = (await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent;
  assert.equal(list.length, 50);
  assert.equal(list[0].number, 155);
  clock += 31 * 86_400_000;
  assert.equal(bg.pruneRecent(list, clock).length, 0);
  // revisit moves to the top
  const moved = bg.recordVisit(list, { key: list[5].key, url: "u", kind: "issue", repo: "acme/web", number: 1, title: "t" }, clock - 1000);
  assert.equal(moved[0].key, list[5].key);
});

test("visit: rejected for no token, off, other origin or malformed data", async () => {
  const ok = { kind: "issue", repo: "acme/web", number: 7, title: "t" };
  for (const bad of [{ ...ok, kind: "gist" }, { ...ok, repo: "acme" }, { ...ok, repo: "a/b/c" }, { ...ok, number: 0 }, { ...ok, number: "x" }, { ...ok, repo: "ac me/web" }, null]) {
    assert.deepEqual(await bg.visit.handleMessage(bad, GH), { recorded: false });
  }
  assert.deepEqual(await bg.visit.handleMessage(ok, { url: "https://evil.example/x" }), { recorded: false });
  assert.deepEqual(await bg.visit.handleMessage(ok, {}), { recorded: false });
  resetStorage({ ...TOKENS, ghqjEnabled: false });
  assert.deepEqual(await bg.visit.handleMessage(ok, GH), { recorded: false });
  resetStorage({});
  assert.deepEqual(await bg.visit.handleMessage(ok, GH), { recorded: false });
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent, undefined);
});

test("switching off or removing the last token deletes the stored recent items; another token left keeps them", async () => {
  const seed = [{ key: "a/b#1", url: "u", kind: "issue", repo: "a/b", number: 1, title: "t", at: clock }];
  await chromeStub.storage.local.set({ ghqjRecent: seed });
  await chromeStub.storage.local.set({ githubTokens: [TOKENS.githubTokens[0]] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent.length, 1);
  await chromeStub.storage.local.set({ ghqjEnabled: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent, undefined);
  await chromeStub.storage.local.set({ ghqjEnabled: true, ghqjRecent: seed });
  await chromeStub.storage.local.set({ githubTokens: [] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent, undefined);
  // re-adding a token restores the last choice and recording starts again from then
  await chromeStub.storage.local.set({ githubTokens: [TOKENS.githubTokens[0]], defaultTokenId: "d" });
  assert.equal((await bg.state.handleMessage()).enabled, true);
  assert.deepEqual(await bg.visit.handleMessage({ kind: "repo", repo: "acme/web", title: "x" }, GH), { recorded: true });
});

// ---- state, command, settings ------------------------------------------------------------

test("state: on by default with a token, choice, shortcut and platform", async () => {
  assert.deepEqual(await bg.state.handleMessage(), { active: true, enabled: true, choice: "browser", shortcut: "Alt+Shift+K", platform: "other" });
  resetStorage({ ...TOKENS, ghqjShortcut: "cmdk", ghqjEnabled: false });
  chromeStub.runtime.getPlatformInfo = async () => ({ os: "mac" });
  chromeStub.commands.getAll = async () => [{ name: "open-quick-jump", shortcut: "" }];
  assert.deepEqual(await bg.state.handleMessage(), { active: false, enabled: false, choice: "cmdk", shortcut: "", platform: "mac" });
  resetStorage({});
  assert.equal((await bg.state.handleMessage()).active, false);
});

test("command: toggles the tab only with a token and the feature on; tabs without the page script are ignored", async () => {
  await bg.handleCommand("open-quick-jump", { id: 5 });
  assert.deepEqual(sent, [[5, { type: "GHQJ_TOGGLE" }]]);
  sent.length = 0;
  await bg.handleCommand("other", { id: 5 });
  await bg.handleCommand("open-quick-jump", undefined);
  assert.deepEqual(sent, []);
  chromeStub.tabs.sendMessage = async () => { throw new Error("Could not establish connection"); };
  await bg.handleCommand("open-quick-jump", { id: 6 }); // other-origin tab: no content script, no throw
  resetStorage({});
  chromeStub.tabs.sendMessage = async (id, m) => { sent.push([id, m]); };
  await bg.handleCommand("open-quick-jump", { id: 5 });
  assert.deepEqual(sent, [], "no token: no effect on any page");
});

test("settings link: only known anchors, only from a github.com page", async () => {
  await bg.openSettings.handleMessage({ hash: "tokens-section" }, GH);
  await bg.openSettings.handleMessage({ hash: "evil" }, GH);
  await bg.openSettings.handleMessage({ hash: "quick-jump" }, { url: "https://evil.example/" });
  assert.deepEqual(sent.map((s) => s[1].url), ["chrome-extension://x/options/options.html#tokens-section", "chrome-extension://x/options/options.html#quick-jump"]);
});

// Regressions found by the adversarial review.
test("a second open or a Tab to a scope served by the same record awaits the read in flight: at most three GETs", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    await new Promise((r) => setTimeout(r, 40));
    return prev(url, opts);
  };
  await Promise.all([refresh("repo", "someone"), refresh("everywhere", ""), refresh("repo", "someone")]);
  assert.equal(calls.length, 3);
  assert.deepEqual([...new Set(calls.map((c) => c.auth))], ["Bearer SECRET_D"]);
});

test("a read that was running when the token's secret changed is not cached under the new secret", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    await new Promise((r) => setTimeout(r, 40));
    return prev(url, opts);
  };
  const running = refresh("everywhere", "");
  await new Promise((r) => setTimeout(r, 10));
  await chromeStub.storage.local.set({ githubTokens: [{ id: "d", name: "Personal", token: "ROTATED", owner: "" }, TOKENS.githubTokens[1]] });
  await running;
  assert.equal(session.ghqjCache?.d, undefined);
});

test("a visit accepted just before the feature is switched off never puts the list back", async () => {
  const pending = bg.visit.handleMessage({ kind: "repo", repo: "acme/web", title: "x" }, GH);
  await chromeStub.storage.local.set({ ghqjEnabled: false });
  await pending;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent, undefined);
});

test("off by default: with a token but no saved switch nothing is active and nothing is recorded; switching it on activates it", async () => {
  resetStorage({ githubTokens: TOKENS.githubTokens, defaultTokenId: "d" });
  const ok = { kind: "issue", repo: "acme/web", number: 1, title: "t", url: "https://github.com/acme/web/issues/1" };
  const st = await bg.state.handleMessage();
  assert.equal(st.active, false);
  assert.equal(st.enabled, false);
  assert.deepEqual(await bg.visit.handleMessage(ok, { url: "https://github.com/acme/web/issues/1" }), { recorded: false });
  assert.equal((await chromeStub.storage.local.get("ghqjRecent")).ghqjRecent, undefined);
  await chromeStub.storage.local.set({ ghqjEnabled: true });
  assert.equal((await bg.state.handleMessage()).active, true);
});
