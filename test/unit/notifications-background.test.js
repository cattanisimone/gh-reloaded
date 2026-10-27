// Unit tests for background/notifications.js and the rate-limit/scope detail
// lib/github-api.js now carries on errors: query shape, normalisation of PR
// and mention facts, capability detection from real responses (denial vs
// incomplete vs rate limit vs missing scope), request volume, read-only.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { rateInfo } from "../../lib/github-api.js";
import { apiFailure, buildQuery, chunk, handleMessage, normalizeMention, normalizeReview } from "../../background/notifications.js";

let realFetch;
let calls;
let n = 0;
// A fresh token id per test: lib/github-api.js caches responses per token id.
const tokens = (extra = []) => {
  const id = `t${++n}`;
  return { githubTokens: [{ id, name: "d", token: "x", owner: "" }, ...extra], defaultTokenId: id };
};
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  resetStorage(tokens());
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (status, body, headers = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { ok: status < 400, status, headers: { get: (k) => h[k.toLowerCase()] ?? null }, json: async () => body, clone() { return this; } };
};
const mockFetch = (fn) => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { path: u.pathname + u.search, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return fn(call);
  };
};

const row = (n, reason = "review_requested", kind = "pull", repo = "web", owner = "acme") => ({ key: `${owner}/${repo}#${n}`, kind, owner, repo, number: n, reason });
const prNode = (over = {}) => ({
  state: "OPEN",
  headRefOid: "h2",
  author: { login: "lee" },
  reviewRequests: { totalCount: 2, nodes: [{ requestedReviewer: { __typename: "User", login: "mira" } }, { requestedReviewer: { __typename: "Team", slug: "web", organization: { login: "acme" } } }, { requestedReviewer: null }] },
  reviews: { totalCount: 2, nodes: [{ state: "APPROVED", submittedAt: "2026-10-26T10:00:00Z", author: { login: "sam", __typename: "User" }, commit: { oid: "h2" } }, { state: "COMMENTED", submittedAt: "2026-10-26T11:00:00Z", author: { login: "ci", __typename: "Bot" }, commit: { oid: "h2" } }, { state: "COMMENTED", author: null }] },
  timelineItems: { totalCount: 2, nodes: [{ __typename: "ReviewRequestedEvent", createdAt: "2026-10-25T10:00:00Z", requestedReviewer: { __typename: "Team", slug: "web", organization: { login: "acme" } } }, { __typename: "ReviewRequestRemovedEvent", createdAt: "2026-10-25T11:00:00Z", requestedReviewer: { __typename: "User", login: "bob" } }] },
  ...over,
});

test("buildQuery: aliases per kind, review fields for review requests, read-only query", () => {
  const q = buildQuery([row(1), row(2, "mention"), row(3, "mention", "issue")]);
  assert.match(q, /viewer \{ login \}/);
  assert.match(q, /p1: pullRequest\(number: 1\)[\s\S]*reviewRequests\(first: 100\)[\s\S]*reviews\(last: 50\)[\s\S]*timelineItems\(last: 100, itemTypes: \[REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT\]\)/);
  assert.match(q, /p2: pullRequest\(number: 2\)[\s\S]*comments\(last: 50\)[\s\S]*reviewThreads\(first: 1\)/);
  assert.match(q, /i3: issue\(number: 3\)/);
  assert.doesNotMatch(q, /mutation/i);
});

test("chunk splits into batches", () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));

test("normalizeReview: users, teams, counted fields, bots, events and totals", () => {
  const f = normalizeReview(prNode(), "mira");
  assert.equal(f.ok, true);
  assert.deepEqual(f.users, ["mira"]);
  assert.deepEqual(f.teams, ["acme/web"]);
  assert.equal(f.viewer, "mira");
  assert.deepEqual(f.reviews.map((r) => [r.author, r.bot, r.oid]), [["sam", false, "h2"], ["ci", true, "h2"]]);
  assert.deepEqual(f.events.map((e) => [e.type, e.target, e.name]), [["added", "Team", "acme/web"], ["removed", "User", "bob"]]);
  assert.deepEqual([f.requestsTotal, f.reviewsTotal, f.eventsTotal], [2, 2, 2]);
  assert.equal(normalizeReview(null).ok, false);
});

test("normalizeReview: a missing totalCount counts as incomplete", () => {
  const f = normalizeReview(prNode({ reviews: { nodes: [] } }), "mira");
  assert.equal(f.reviewsTotal, Infinity);
});

test("normalizeMention: body, comments and reviews become texts; totals kept", () => {
  const f = normalizeMention({ state: "OPEN", url: "u", body: "hi @mira", createdAt: "2026-10-01T00:00:00Z", author: { login: "lee" }, comments: { totalCount: 1, nodes: [{ url: "c", body: "x", createdAt: "2026-10-02T00:00:00Z", lastEditedAt: "2026-10-03T00:00:00Z", author: { login: "sam" } }] }, reviews: { totalCount: 1, nodes: [{ body: "r", createdAt: "2026-10-04T00:00:00Z", author: null }] }, reviewThreads: { totalCount: 3 } }, "pull", "mira");
  assert.deepEqual(f.texts.map((t) => [t.source, t.author]), [["body", "lee"], ["comment", "sam"], ["review", ""]]);
  assert.equal(f.texts[1].editedAt, "2026-10-03T00:00:00Z");
  assert.deepEqual([f.commentsTotal, f.mentionReviewsTotal, f.threadsTotal], [1, 1, 3]);
  assert.equal(normalizeMention({ comments: { totalCount: 0, nodes: [] } }, "issue", "m").threadsTotal, 0);
  assert.equal(normalizeMention(null, "issue", "m").ok, false);
});

test("handleMessage: facts per row, viewer login, only GET / graphql queries", async () => {
  mockFetch((c) => reply(200, { data: { viewer: { login: "mira" }, repository: { p1: prNode(), i2: { state: "OPEN", body: "@mira", createdAt: "2026-10-26T00:00:00Z", comments: { totalCount: 0, nodes: [] } } } } }));
  const res = await handleMessage({ rows: [row(1), row(2, "mention", "issue")], api: false });
  assert.equal(res.facts["acme/web#1"].viewer, "mira");
  assert.equal(res.facts["acme/web#2"].kind, "issue");
  assert.equal(res.capabilities["pr:acme"], "ok");
  assert.equal(res.rateLimited, false);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.method === "GET" || (c.method === "POST" && c.path === "/graphql" && !/mutation/i.test(c.body.query))));
});

test("handleMessage: rows that need no facts make no request", async () => {
  mockFetch(() => reply(500, {}));
  const res = await handleMessage({ rows: [row(1, "subscribed"), row(2, "ci_activity", "run")], api: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(res.facts, {});
});

test("handleMessage: 25 per batch, grouped by repository", async () => {
  mockFetch((c) => reply(200, { data: { viewer: { login: "mira" }, repository: {} } }));
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1));
  await handleMessage({ rows: [...rows, row(99, "review_requested", "pull", "api")], api: false });
  assert.equal(calls.length, 3);
});

test("handleMessage: names that are not repositories are ignored", async () => {
  mockFetch(() => reply(200, { data: {} }));
  await handleMessage({ rows: [{ ...row(1), owner: "a/b" }, { ...row(2), repo: "x y" }], api: false });
  assert.equal(calls.length, 0);
});

test("capability: no token for the owner -> no-token, no request", async () => {
  resetStorage({});
  mockFetch(() => reply(200, {}));
  const res = await handleMessage({ rows: [row(1)], api: true });
  assert.equal(calls.length, 0);
  assert.equal(res.capabilities["pr:acme"], "no-token");
  assert.equal(res.facts["acme/web#1"].ok, false);
  assert.equal(res.api.state, "not-tried");
});

test("capability: 403 resource not accessible -> denied (not a rate limit)", async () => {
  mockFetch(() => reply(403, { message: "Resource not accessible by personal access token" }));
  const res = await handleMessage({ rows: [row(1)], api: false });
  assert.equal(res.capabilities["pr:acme"], "denied");
  assert.equal(res.rateLimited, false);
  assert.equal(res.facts["acme/web#1"].ok, false);
});

test("capability: 401 -> denied", async () => {
  mockFetch(() => reply(401, { message: "Bad credentials" }));
  assert.equal((await handleMessage({ rows: [row(1)], api: false })).capabilities["pr:acme"], "denied");
});

test("capability: 200 with a null repository -> denied, not 25 unreadable PRs", async () => {
  mockFetch(() => reply(200, { data: { viewer: { login: "mira" }, repository: null } }));
  const res = await handleMessage({ rows: [row(1)], api: false });
  assert.equal(res.capabilities["pr:acme"], "denied");
});

test("capability: a missing alias is an unreadable item, the repository stays ok", async () => {
  mockFetch(() => reply(200, { data: { viewer: { login: "mira" }, repository: { p1: null } } }));
  const res = await handleMessage({ rows: [row(1)], api: false });
  assert.equal(res.capabilities["pr:acme"], "ok");
  assert.equal(res.facts["acme/web#1"].ok, false);
});

test("capability: 5xx -> unavailable", async () => {
  mockFetch(() => reply(502, {}));
  assert.equal((await handleMessage({ rows: [row(1)], api: false })).capabilities["pr:acme"], "unavailable");
});

test("rate limit: 429 with retry-after -> rateLimited with retryAt, later batches not requested", async () => {
  const before = Date.now();
  mockFetch(() => reply(429, { message: "API rate limit exceeded" }, { "retry-after": "90" }));
  const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));
  const res = await handleMessage({ rows, api: false });
  assert.equal(res.rateLimited, true);
  assert.ok(res.retryAt >= before + 90_000 && res.retryAt <= Date.now() + 90_000);
  assert.ok(calls.length <= 2, `at most the two in-flight batches, saw ${calls.length}`);
  assert.equal(Object.values(res.facts).every((f) => f.ok === false), true);
  assert.equal(res.capabilities["pr:acme"], "rate-limited");
});

test("rate limit: 403 with x-ratelimit-remaining 0 -> retryAt from x-ratelimit-reset", async () => {
  const reset = Math.floor(Date.now() / 1000) + 300;
  mockFetch(() => reply(403, { message: "API rate limit exceeded for user" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
  const res = await handleMessage({ rows: [row(1)], api: false });
  assert.equal(res.rateLimited, true);
  assert.equal(res.retryAt, reset * 1000);
});

test("rate limit: GraphQL RATE_LIMITED error", async () => {
  mockFetch(() => reply(200, { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }));
  const res = await handleMessage({ rows: [row(1)], api: false });
  assert.equal(res.rateLimited, true);
  assert.ok(res.retryAt > Date.now());
});

test("rateInfo: distinguishes denial from rate limits", () => {
  const h = (o) => ({ get: (k) => o[k] ?? null });
  assert.equal(rateInfo(403, h({}), "Resource not accessible").rateLimited, false);
  assert.equal(rateInfo(403, h({}), "You have exceeded a secondary rate limit").rateLimited, true);
  assert.equal(rateInfo(429, h({})).rateLimited, true);
  assert.equal(rateInfo(404, h({ "x-ratelimit-remaining": "0" })).rateLimited, false);
  assert.equal(rateInfo(500, h({})).retryAt, null);
});

// --- Notifications API ------------------------------------------------------

const apiItem = (id, reason, url) => ({ id, reason, unread: true, subject: { url, type: "PullRequest", title: "t" }, repository: { full_name: "acme/web" } });

test("api: works with a classic token, two pages when rel=next, compact items", async () => {
  mockFetch((c) => {
    if (c.path.startsWith("/notifications")) {
      const page = new URL("https://x" + c.path).searchParams.get("page");
      return page === "1"
        ? reply(200, [apiItem("1", "review_requested", "https://api.github.com/repos/acme/web/pulls/5")], { link: '<https://api.github.com/notifications?page=2>; rel="next"', "x-oauth-scopes": "notifications" })
        : reply(200, [apiItem("2", "mention", "https://api.github.com/repos/acme/web/pulls/6")], { "x-oauth-scopes": "notifications" });
    }
    return reply(200, { data: { viewer: { login: "mira" }, repository: { p5: prNode(), p6: { state: "OPEN", comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 0 } } } } });
  });
  const res = await handleMessage({ rows: [], api: true });
  assert.equal(res.api.state, "ok");
  assert.equal(res.api.items.length, 2);
  assert.deepEqual(Object.keys(res.api.items[0]).sort(), ["id", "reason", "repository", "subject", "unread"]);
  assert.equal(calls.filter((c) => c.path.startsWith("/notifications")).length, 2);
  assert.ok(res.facts["acme/web#5"].ok, "an API-only review request gets its facts");
  assert.ok(res.facts["acme/web#6"].ok);
});

test("api: at most 2 pages even when rel=next keeps coming", async () => {
  mockFetch((c) => c.path.startsWith("/notifications") ? reply(200, [apiItem("1", "subscribed", "https://api.github.com/repos/acme/web/issues/1")], { link: '<x>; rel="next"' }) : reply(200, { data: {} }));
  await handleMessage({ rows: [], api: true });
  assert.equal(calls.filter((c) => c.path.startsWith("/notifications")).length, 2);
});

test("api: REST reason wins over the label for fetching facts", async () => {
  mockFetch((c) => c.path.startsWith("/notifications")
    ? reply(200, [apiItem("1", "review_requested", "https://api.github.com/repos/acme/web/pulls/7")], { "x-oauth-scopes": "notifications" })
    : reply(200, { data: { viewer: { login: "mira" }, repository: { p7: prNode() } } }));
  const res = await handleMessage({ rows: [row(7, "comment")], api: true });
  assert.equal(res.reasons["acme/web#7"], "review_requested");
  assert.equal(res.facts["acme/web#7"].ok, true);
});

test("api: classic token whose scope header lacks notifications -> missing-scope", async () => {
  mockFetch(() => reply(403, { message: "Resource not accessible" }, { "x-oauth-scopes": "read:user, public_repo", "x-accepted-oauth-scopes": "notifications, repo" }));
  const res = await handleMessage({ rows: [], api: true });
  assert.equal(res.api.state, "missing-scope");
  assert.equal(res.rateLimited, false);
});

test("api: classic token with repo scope is not missing-scope", () => {
  assert.equal(apiFailure({ status: 404, scopes: ["repo"], acceptedScopes: ["notifications", "repo"] }).state, "unavailable");
});

test("api: fine-grained token (no scope header), ambiguous 403/404 and empty data -> unavailable, no cause", async () => {
  for (const status of [403, 404]) {
    mockFetch(() => reply(status, { message: "Not Found" }));
    assert.equal((await handleMessage({ rows: [], api: true })).api.state, "unavailable");
  }
  mockFetch(() => reply(200, []));
  assert.equal((await handleMessage({ rows: [], api: true })).api.state, "unavailable");
});

test("api: rate limited -> rate-limited state and rateLimited flag", async () => {
  mockFetch(() => reply(429, {}, { "retry-after": "30" }));
  const res = await handleMessage({ rows: [row(1)], api: true });
  assert.equal(res.api.state, "rate-limited");
  assert.equal(res.rateLimited, true);
  assert.ok(res.retryAt > Date.now());
});

test("api: uses the default token, never an owner's", async () => {
  resetStorage({ githubTokens: [{ id: "d-own", name: "d", token: "default", owner: "" }, { id: "o-own", name: "o", token: "acme-token", owner: "acme" }], defaultTokenId: "d-own" });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([new URL(url).pathname, init.headers.Authorization]);
    return new URL(url).pathname === "/notifications" ? reply(200, [apiItem("1", "review_requested", "https://api.github.com/repos/acme/web/pulls/1")]) : reply(200, { data: { viewer: { login: "mira" }, repository: {} } });
  };
  await handleMessage({ rows: [row(1)], api: true });
  assert.deepEqual(seen.find((s) => s[0] === "/notifications"), ["/notifications", "Bearer default"]);
  assert.deepEqual(seen.find((s) => s[0] === "/graphql"), ["/graphql", "Bearer acme-token"]);
});

test("no write: the module source contains no mutation, PATCH, PUT or DELETE", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("background/notifications.js", "utf8");
  assert.doesNotMatch(src, /mutation|"PATCH"|"PUT"|"DELETE"|method:/i);
});
