// Unit tests for background/viewed-folders.js: pagination, the viewed mapping,
// every silent failure, no request without a token, and that the query only reads.
import "../support/chrome-stub.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { handleMessage, MESSAGE_TYPE, QUERY, viewedOf } from "../../background/viewed-folders.js";

let realFetch;
let calls;
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  resetStorage({ githubTokens: [{ id: "t1", name: "Default", token: "ghp_x", owner: "" }], defaultTokenId: "t1" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (status, body = {}) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, clone() { return this; } });
const mock = (fn) => {
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, opts, body });
    return fn(body, calls.length);
  };
};
const node = (path, viewerViewedState) => ({ path, viewerViewedState });
const page = (nodes, { total, next = null } = {}) =>
  reply(200, { data: { repository: { pullRequest: { files: { totalCount: total ?? nodes.length, pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } } } });
let n = 0;
const num = () => 1000 + ++n; // distinct pull request per test: ghGraphQL caches by variables

test("message type", () => assert.equal(MESSAGE_TYPE, "GHVF_FETCH"));

test("the query only reads: no mutation, no markFileAsViewed", () => {
  assert.doesNotMatch(QUERY, /mutation|markFileAsViewed|unmarkFileAsViewed/i);
  assert.match(QUERY, /^\s*query\b/);
  assert.match(QUERY, /viewerViewedState/);
});

test("VIEWED is viewed, UNVIEWED and DISMISSED are not, anything else is unread", () => {
  assert.equal(viewedOf("VIEWED"), true);
  assert.equal(viewedOf("UNVIEWED"), false);
  assert.equal(viewedOf("DISMISSED"), false);
  assert.equal(viewedOf("SOMETHING_NEW"), undefined);
  assert.equal(viewedOf(undefined), undefined);
});

test("reads one page with the token of the owner, as a POST to the GraphQL endpoint only", async () => {
  mock(() => page([node("a/x.js", "VIEWED"), node("a/y.js", "UNVIEWED"), node("b/z.js", "DISMISSED")]));
  const out = await handleMessage({ owner: "acme", repo: "web", number: num() });
  assert.deepEqual(out, { files: [{ path: "a/x.js", viewed: true }, { path: "a/y.js", viewed: false }, { path: "b/z.js", viewed: false }], total: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer ghp_x");
});

test("paginates until there is no next page", async () => {
  mock((body) => (body.variables.after ? page([node("c", "VIEWED")], { total: 3 }) : page([node("a", "VIEWED"), node("b", "UNVIEWED")], { total: 3, next: "Mg" })));
  const out = await handleMessage({ owner: "acme", repo: "web", number: num() });
  assert.deepEqual(out.files.map((f) => f.path), ["a", "b", "c"]);
  assert.equal(out.total, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.variables.after, "Mg");
});

test("stops at 30 pages (GitHub lists at most 3000 files)", async () => {
  mock((body) => page([node(`f${calls.length}`, "UNVIEWED")], { total: 5000, next: `c${calls.length}` }));
  const out = await handleMessage({ owner: "acme", repo: "web", number: num() });
  assert.equal(calls.length, 30);
  assert.equal(out.files.length, 30);
  assert.equal(out.total, 5000);
});

test("a file with an unknown state is left out, so it stays unknown on the page", async () => {
  mock(() => page([node("a", "VIEWED"), node("b", "FUTURE_STATE"), node("c", null)]));
  const out = await handleMessage({ owner: "acme", repo: "web", number: num() });
  assert.deepEqual(out.files, [{ path: "a", viewed: true }]);
  assert.equal(out.total, 3);
});

test("no token: no request at all", async () => {
  resetStorage({});
  mock(() => page([]));
  assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: num() }), { files: null });
  assert.equal(calls.length, 0);
});

test("401, 403, 404, 500, a network error: null, never thrown", async () => {
  for (const status of [401, 403, 404, 500]) {
    mock(() => reply(status, { message: "nope" }));
    assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: num() }), { files: null }, String(status));
  }
  mock(() => {
    throw new TypeError("network");
  });
  assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: num() }), { files: null });
});

test("empty data, no pull request, GraphQL errors and a rate limit: null", async () => {
  const bodies = [
    { data: { repository: { pullRequest: null } } },
    { data: { repository: null } },
    { data: null },
    { data: { repository: { pullRequest: { files: null } } } },
    { errors: [{ message: "Resource not accessible by personal access token", type: "FORBIDDEN" }], data: null },
    { errors: [{ message: "rate limited", type: "RATE_LIMITED" }] },
  ];
  for (const b of bodies) {
    mock(() => reply(200, b));
    assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: num() }), { files: null }, JSON.stringify(b));
  }
});

test("a page that fails half way gives null, not a partial list", async () => {
  mock((body) => (body.variables.after ? reply(502) : page([node("a", "VIEWED")], { total: 2, next: "x" })));
  assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: num() }), { files: null });
});

test("a malformed request is not sent", async () => {
  mock(() => page([]));
  for (const p of [undefined, {}, { owner: "a b", repo: "web", number: 1 }, { owner: "acme", repo: "we/b", number: 1 }, { owner: "acme", repo: "web", number: 0 }, { owner: "acme", repo: "web", number: "7" }]) {
    assert.deepEqual(await handleMessage(p), { files: null });
  }
  assert.equal(calls.length, 0);
});

test("a fresh read: a cached answer is never served", async () => {
  const number = num();
  mock(() => page([node("a", "UNVIEWED")]));
  await handleMessage({ owner: "acme", repo: "web", number });
  mock(() => page([node("a", "VIEWED")]));
  const out = await handleMessage({ owner: "acme", repo: "web", number });
  assert.equal(out.files[0].viewed, true);
});
