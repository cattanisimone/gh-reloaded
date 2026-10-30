// Unit tests for background/quick-assign.js: the read-only read-back of an
// issue's assignees, and how a failed read is classified for the page.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { handleMessage, errorKind, MESSAGE_TYPE } from "../../background/quick-assign.js";

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetStorage({ githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (status, body = {}, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
  clone() {
    return this;
  },
});

test("message type is unique and namespaced", () => {
  assert.equal(MESSAGE_TYPE, "QUICK_ASSIGN_READ_ASSIGNEES");
});

test("returns the assignee logins with a GET that bypasses the HTTP cache", async () => {
  let call;
  globalThis.fetch = async (url, opts) => {
    call = { url, opts };
    return reply(200, { assignees: [{ login: "alex-dev" }, { login: "mira" }, null] });
  };
  assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: 123 }), { assignees: ["alex-dev", "mira"] });
  assert.equal(call.url, "https://api.github.com/repos/acme/web/issues/123");
  assert.equal(call.opts.cache, "no-store");
  assert.equal(call.opts.method, undefined, "read-only: no write method");
});

test("two reads in a row both reach the network", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply(200, { assignees: calls === 1 ? [{ login: "a" }] : [] });
  };
  const arg = { owner: "acme", repo: "web", number: 1 };
  assert.deepEqual((await handleMessage(arg)).assignees, ["a"]);
  assert.deepEqual((await handleMessage(arg)).assignees, []);
});

test("rejects malformed coordinates without calling GitHub", async () => {
  globalThis.fetch = async () => assert.fail("must not fetch");
  for (const arg of [{}, { owner: "a/b", repo: "web", number: 1 }, { owner: "acme", repo: "web", number: 0 }, { owner: "acme", repo: "web", number: "1" }]) {
    assert.deepEqual(await handleMessage(arg), { error: { kind: "error" } });
  }
});

test("a refusal with a token is 'denied', 404 and 403 alike", async () => {
  for (const status of [401, 403, 404]) {
    globalThis.fetch = async () => reply(status, { message: "nope" });
    assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: 1 }), { error: { kind: "denied", status } });
  }
});

test("a refusal without any token is 'notoken'", async () => {
  resetStorage({ githubTokens: [] });
  globalThis.fetch = async () => reply(404, { message: "Not Found" });
  assert.deepEqual(await handleMessage({ owner: "acme", repo: "web", number: 1 }), { error: { kind: "notoken", status: 404 } });
});

test("a rate limit carries the reset time", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  globalThis.fetch = async () => reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
  const r = await handleMessage({ owner: "acme", repo: "web", number: 1 });
  assert.equal(r.error.kind, "rate");
  assert.equal(r.error.retryAt, reset * 1000);
});

test("errorKind: server errors and network failures are plain errors", () => {
  assert.equal(errorKind({ status: 500 }, true), "error");
  assert.equal(errorKind(new TypeError("fetch failed"), true), "error");
  assert.equal(errorKind({ status: 429 }, false), "rate");
});
