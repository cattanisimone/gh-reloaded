// Unit tests for background/actions-log-shortcuts.js: the answer mapping, the
// per-token-and-repository cache, the stored outcome, the Open raw log URL
// validation against the sender's frame URL, and ghProbe in lib/github-api.js.
import "../support/chrome-stub.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage, chromeStub } from "../support/chrome-stub.js";
import * as bg from "../../background/actions-log-shortcuts.js";
import { ghProbe } from "../../lib/github-api.js";

let realFetch;
let calls;
let created;
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  created = [];
  bg.resetState();
  chromeStub.tabs = { create: async (o) => (created.push(o), { id: 9 }) };
  resetStorage({ githubTokens: [{ id: "t1", name: "d", token: "SECRET", owner: "" }], defaultTokenId: "t1" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (status, { type, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  type: type || "basic",
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  body: { cancel: async () => {} },
  json: async () => {
    throw new Error("body must not be read");
  },
  text: async () => {
    throw new Error("body must not be read");
  },
  clone() {
    return this;
  },
});
const mock = (fn) => {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fn(url, opts);
  };
};
const JOB_URL = (o = "acme", r = "web", run = 11, job = 22) => `https://github.com/${o}/${r}/actions/runs/${run}/job/${job}`;
const sender = (url = JOB_URL()) => ({ url, tab: { id: 5, index: 2 } });
let n = 0;
const fresh = () => ({ owner: "acme", repo: `r${++n}`, job: "22" });
const senderFor = (p) => sender(JOB_URL(p.owner, p.repo, 11, p.job));

test("message types are unique and distinct", () => {
  assert.notEqual(bg.MESSAGE_TYPE, bg.open.MESSAGE_TYPE);
});

test("mapAnswer maps every GitHub answer fail-closed", () => {
  const m = bg.mapAnswer;
  assert.equal(m({ redirected: true, status: 0 }), "ok");
  assert.equal(m({ status: 302, redirected: true }), "ok");
  assert.equal(m({ status: 200 }), "ok");
  assert.equal(m({ status: 403 }), "not-permitted");
  assert.equal(m({ status: 404 }), "not-permitted");
  assert.equal(m({ status: 403, rateLimited: true }), "rate-limited");
  assert.equal(m({ status: 429, rateLimited: true }), "rate-limited");
  assert.equal(m({ status: 403, sso: true }), "unknown");
  for (const s of [401, 410, 500, 502]) assert.equal(m({ status: s }), "unknown", String(s));
  assert.equal(m({ status: 0 }), "unknown");
  assert.equal(m(null), "unknown");
});

test("ghProbe does not follow redirects, reads no body and sends the owner's token", async () => {
  mock(() => answer(0, { type: "opaqueredirect" }));
  const r = await ghProbe("/repos/acme/web/actions/jobs/1/logs", { owner: "acme" });
  assert.equal(r.redirected, true);
  assert.equal(calls[0].opts.redirect, "manual");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer SECRET");
  assert.equal(calls[0].opts.method, undefined);
});

test("ghProbe with no token sends nothing", async () => {
  resetStorage({});
  mock(() => answer(200));
  const r = await ghProbe("/x", { owner: "acme" });
  assert.equal(r.noToken, true);
  assert.equal(calls.length, 0);
});

test("detect: ok, one probe per repo and token within the window, stored outcome", async () => {
  mock(() => answer(0, { type: "opaqueredirect" }));
  const p = fresh();
  const a = await bg.handleMessage({}, senderFor(p));
  const b = await bg.handleMessage({}, senderFor(p));
  assert.equal(a.state, "ok");
  assert.equal(b.state, "ok");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/repos/acme/${p.repo}/actions/jobs/22/logs$`));
  const { ghalsOutcomes } = await chromeStub.storage.local.get("ghalsOutcomes");
  assert.deepEqual(Object.keys(ghalsOutcomes), ["acme"]);
  assert.deepEqual(Object.keys(ghalsOutcomes.acme).sort(), ["at", "state"]);
  assert.equal(ghalsOutcomes.acme.state, "ok");
});

test("detect: another repository probes again", async () => {
  mock(() => answer(0, { type: "opaqueredirect" }));
  await bg.handleMessage({}, senderFor(fresh()));
  await bg.handleMessage({}, senderFor(fresh()));
  assert.equal(calls.length, 2);
});

test("detect: not-permitted is stored; unknown and rate-limited leave it unchanged", async () => {
  mock(() => answer(404));
  assert.equal((await bg.handleMessage({}, senderFor(fresh()))).state, "not-permitted");
  let { ghalsOutcomes } = await chromeStub.storage.local.get("ghalsOutcomes");
  assert.equal(ghalsOutcomes.acme.state, "not-permitted");
  const at = ghalsOutcomes.acme.at;
  mock(() => answer(500));
  assert.equal((await bg.handleMessage({}, senderFor(fresh()))).state, "unknown");
  mock(() => answer(429, { headers: { "retry-after": "30" } }));
  assert.equal((await bg.handleMessage({}, senderFor(fresh()))).state, "rate-limited");
  ({ ghalsOutcomes } = await chromeStub.storage.local.get("ghalsOutcomes"));
  assert.deepEqual(ghalsOutcomes.acme, { state: "not-permitted", at });
});

test("detect: ok clears an earlier warning for that owner", async () => {
  mock(() => answer(404));
  await bg.handleMessage({}, senderFor(fresh()));
  mock(() => answer(0, { type: "opaqueredirect" }));
  await bg.handleMessage({}, senderFor(fresh()));
  const { ghalsOutcomes } = await chromeStub.storage.local.get("ghalsOutcomes");
  assert.equal(ghalsOutcomes.acme.state, "ok");
});

test("detect: rate-limited sends nothing again before the reset", async () => {
  mock(() => answer(429, { headers: { "retry-after": "120" } }));
  const p = fresh();
  assert.equal((await bg.handleMessage({}, senderFor(p))).state, "rate-limited");
  assert.equal((await bg.handleMessage({}, senderFor(p))).state, "rate-limited");
  assert.equal(calls.length, 1);
});

test("detect: no token, no request; switch off, no request", async () => {
  mock(() => answer(200));
  resetStorage({});
  assert.equal((await bg.handleMessage({}, senderFor(fresh()))).state, "no-token");
  resetStorage({ githubTokens: [{ id: "t1", name: "d", token: "S", owner: "" }], defaultTokenId: "t1", ghalsEnabled: false });
  assert.equal((await bg.handleMessage({}, senderFor(fresh()))).state, "off");
  assert.equal(calls.length, 0);
});

test("detect: a sender that is not an Actions job route is refused", async () => {
  mock(() => answer(200));
  for (const s of [{}, { url: "https://evil.example/acme/web/actions/runs/1/job/2" }, { url: "https://github.com/acme/web/actions/runs/1" }]) {
    assert.equal((await bg.handleMessage({}, s)).state, "unknown");
  }
  assert.equal(calls.length, 0);
});

test("detect: the owner token is used, never another", async () => {
  resetStorage({
    githubTokens: [{ id: "t1", name: "d", token: "DEF", owner: "" }, { id: "t2", name: "o", token: "OWN", owner: "acme" }],
    defaultTokenId: "t1",
  });
  mock(() => answer(200));
  await bg.handleMessage({}, senderFor(fresh()));
  assert.equal(calls[0].opts.headers.Authorization, "Bearer OWN");
});

test("a token change clears stored outcomes and the cache; switching off clears too", async () => {
  mock(() => answer(404));
  const p = fresh();
  await bg.handleMessage({}, senderFor(p));
  await chromeStub.storage.local.set({ githubTokens: [{ id: "t1", name: "d", token: "NEW", owner: "" }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await chromeStub.storage.local.get("ghalsOutcomes")).ghalsOutcomes, undefined);
  await bg.handleMessage({}, senderFor(p));
  assert.equal(calls.length, 2, "cache was cleared");
  await chromeStub.storage.local.set({ ghalsEnabled: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await chromeStub.storage.local.get("ghalsOutcomes")).ghalsOutcomes, undefined);
});

test("rawLogUrl accepts the matching link and rebuilds it without query or hash", () => {
  const sha = "a".repeat(40);
  const s = sender();
  assert.equal(bg.rawLogUrl(`https://github.com/acme/web/commit/${sha}/checks/22/logs?x=1#y`, s.url), `https://github.com/acme/web/commit/${sha}/checks/22/logs`);
  assert.equal(bg.rawLogUrl(`/acme/web/commit/abcdef1/checks/22/logs`, s.url), "https://github.com/acme/web/commit/abcdef1/checks/22/logs");
  assert.equal(bg.rawLogUrl(`https://github.com/Acme/WEB/commit/abcdef1/checks/22/logs`, s.url), "https://github.com/acme/web/commit/abcdef1/checks/22/logs");
});

test("rawLogUrl refuses anything else", () => {
  const sha = "a".repeat(40);
  const u = JOB_URL();
  const bad = [
    `http://github.com/acme/web/commit/${sha}/checks/22/logs`,
    `https://evil.example/acme/web/commit/${sha}/checks/22/logs`,
    `https://github.com/other/web/commit/${sha}/checks/22/logs`,
    `https://github.com/acme/other/commit/${sha}/checks/22/logs`,
    `https://github.com/acme/web/commit/${sha}/checks/23/logs`,
    `https://github.com/acme/web/commit/${sha}/checks/22/logs/extra`,
    `https://github.com/acme/web/commit/zzzzzzz/checks/22/logs`,
    `https://github.com/acme/web/commit/abc/checks/22/logs`,
    `https://github.com/acme/web/commit/${sha}/checks/22/%2e%2e/logs`,
    `https://github.com/acme/web/commit/${sha}/../checks/22/logs`,
    "javascript:alert(1)",
    "",
    null,
  ];
  for (const h of bad) assert.equal(bg.rawLogUrl(h, u), null, String(h));
  assert.equal(bg.rawLogUrl(`https://github.com/acme/web/commit/${sha}/checks/22/logs`, undefined), null);
  assert.equal(bg.rawLogUrl(`https://github.com/acme/web/commit/${sha}/checks/22/logs`, "https://evil.example/acme/web/actions/runs/1/job/22"), null);
  assert.equal(bg.rawLogUrl(`https://github.com/acme/web/commit/${sha}/checks/22/logs`, "https://github.com/acme/web/actions/runs/1"), null);
});

test("open: validates, re-probes fresh, opens next to the page; failure opens nothing", async () => {
  const sha = "b".repeat(40);
  const hint = `https://github.com/acme/web/commit/${sha}/checks/22/logs?token=zzz`;
  mock(() => answer(0, { type: "opaqueredirect" }));
  const ok = await bg.open.handleMessage({ href: hint }, sender());
  assert.equal(ok.opened, true);
  assert.deepEqual(created, [{ url: `https://github.com/acme/web/commit/${sha}/checks/22/logs`, openerTabId: 5, index: 3 }]);
  mock(() => answer(404));
  const no = await bg.open.handleMessage({ href: hint }, sender());
  assert.equal(no.opened, false);
  assert.equal(created.length, 1);
  const bad = await bg.open.handleMessage({ href: "https://evil.example/x" }, sender());
  assert.equal(bad.opened, false);
  assert.equal(calls.length, 2, "an invalid link sends no probe");
});
