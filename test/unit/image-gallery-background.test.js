// Unit tests for background/image-gallery.js: listing classification, PROBE
// proof rules, the memory-only suppression map, and that nothing is written.
import "../support/chrome-stub.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { list, probe, suppress, consume, clearSuppressions, classifyError, MESSAGE_TYPE, probeFile, suppression, consumption } from "../../background/image-gallery.js";

let realFetch;
let calls;
beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  clearSuppressions();
  resetStorage({});
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
const mock = (fn) => {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return fn(url, opts);
  };
};
const file = (name, dir = "shots") => ({ name, path: `${dir}/${name}`, type: "file" });
let n = 0;
const repo = () => `r${++n}`; // distinct repo per test: ghFetch caches by path

test("message types are unique", () => {
  assert.equal(MESSAGE_TYPE, "GHIG_LIST");
  assert.deepEqual([probeFile, suppression, consumption].map((m) => m.MESSAGE_TYPE), ["GHIG_PROBE", "GHIG_SUPPRESS", "GHIG_CONSUME"]);
});

test("lists the folder, keeps the API order, drops directories, reports complete", async () => {
  const r = repo();
  mock(() => reply(200, [file("B.png"), { name: "d", path: "shots/d", type: "dir" }, file("a.png")]));
  const out = await list({ owner: "acme", repo: r, segments: ["main", "shots", "a.png"] });
  assert.equal(out.state, "ok");
  assert.deepEqual(out.entries.map((e) => e.name), ["B.png", "a.png"]);
  assert.equal(out.incomplete, false);
  assert.equal(out.ref, "main");
  assert.equal(out.path, "shots/a.png");
  assert.match(calls[0].url, new RegExp(`/repos/acme/${r}/contents/shots\\?ref=main$`));
  assert.equal(calls[0].opts.method, undefined, "read only");
});

test("a folder of 1000 entries is flagged incomplete", async () => {
  const r = repo();
  mock(() => reply(200, Array.from({ length: 1000 }, (_, i) => file(`i${i}.png`))));
  const out = await list({ owner: "acme", repo: r, segments: ["main", "shots", "i1.png"] });
  assert.equal(out.incomplete, true);
});

test("widens the ref one segment at a time only on 404", async () => {
  const r = repo();
  mock((url) => (url.includes("ref=feature%2Ffoo") ? reply(200, [file("a.png")]) : reply(404, { message: "No commit found" })));
  const out = await list({ owner: "acme", repo: r, segments: ["feature", "foo", "shots", "a.png"] });
  assert.equal(out.state, "ok");
  assert.equal(out.ref, "feature/foo");
  assert.equal(out.path, "shots/a.png");
  assert.equal(calls.length, 2);
});

test("uses the page's known ref without probing other splits", async () => {
  const r = repo();
  mock(() => reply(200, [file("a.png")]));
  const out = await list({ owner: "acme", repo: r, segments: ["feature", "foo", "shots", "a.png"], ref: "feature/foo" });
  assert.equal(out.ref, "feature/foo");
  assert.equal(calls.length, 1);
});

test("classification: rate limit, 5xx and network are not permission claims; 401/403/404 are unknown", async () => {
  assert.equal(classifyError({ rateLimited: true, status: 403 }), "rate-limit");
  assert.equal(classifyError({ status: 500 }), "error");
  assert.equal(classifyError(new TypeError("Failed to fetch")), "error");
  assert.equal(classifyError({ timedOut: true }), "error");
  for (const status of [401, 403, 404]) assert.equal(classifyError({ status }), "unknown");
  const r = repo();
  mock(() => reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }));
  assert.equal((await list({ owner: "acme", repo: r, segments: ["main", "a.png"] })).state, "rate-limit");
  const r2 = repo();
  mock(() => reply(500));
  assert.equal((await list({ owner: "acme", repo: r2, segments: ["main", "a.png"] })).state, "error");
  const r3 = repo();
  mock(() => reply(404, { message: "Not Found" }));
  assert.equal((await list({ owner: "acme", repo: r3, segments: ["main", "a.png"] })).state, "unknown");
});

test("a private repo with no applicable token answers 'private' without any request", async () => {
  mock(() => reply(200, []));
  const out = await list({ owner: "acme", repo: repo(), segments: ["main", "a.png"], privateHint: true });
  assert.equal(out.state, "private");
  assert.equal(calls.length, 0);
});

test("a token for another owner does not count; the owner's token does", async () => {
  resetStorage({ githubTokens: [{ id: "t", name: "o", token: "secret", owner: "other" }] });
  mock(() => reply(200, []));
  assert.equal((await list({ owner: "acme", repo: repo(), segments: ["main", "a.png"], privateHint: true })).state, "private");
  resetStorage({ githubTokens: [{ id: "t", name: "o", token: "secret", owner: "acme" }] });
  const out = await list({ owner: "acme", repo: repo(), segments: ["main", "a.png"], privateHint: true });
  assert.equal(out.state, "ok");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer secret");
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\//, "the token goes to api.github.com only");
});

test("probe: bytes → data URL; 404 with a readable parent lacking the file → removed; ambiguous → neutral", async () => {
  const r = repo();
  mock(() => reply(200, { content: "QUJD\n", size: 3, sha: "s" }));
  assert.deepEqual(await probe({ owner: "acme", repo: r, ref: "main", path: "shots/a.png" }), { kind: "bytes", dataUrl: "data:image/png;base64,QUJD" });

  const r2 = repo();
  mock((url) => (url.includes("/contents/shots/a.png") ? reply(404) : reply(200, [file("b.png")])));
  assert.deepEqual(await probe({ owner: "acme", repo: r2, ref: "main", path: "shots/a.png" }), { kind: "removed" });

  const r3 = repo();
  mock(() => reply(404));
  assert.deepEqual(await probe({ owner: "acme", repo: r3, ref: "main", path: "shots/a.png" }), { kind: "neutral" });

  const r4 = repo();
  mock(() => reply(403, { message: "Forbidden" }));
  assert.deepEqual(await probe({ owner: "acme", repo: r4, ref: "main", path: "shots/a.png" }), { kind: "neutral" });

  const r5 = repo();
  mock(() => reply(401, { message: "Bad credentials" }));
  assert.deepEqual(await probe({ owner: "acme", repo: r5, ref: "main", path: "shots/a.png" }), { kind: "refused" });
});

test("probe falls back to the Git blob when the Contents API omits the content", async () => {
  const r = repo();
  mock((url) => (url.includes("/git/blobs/") ? reply(200, { content: "QUJD" }) : reply(200, { sha: "abc", size: 10 })));
  const out = await probe({ owner: "acme", repo: r, ref: "main", path: "shots/big.gif" });
  assert.equal(out.dataUrl, "data:image/gif;base64,QUJD");
});

test("suppression: consumed once, only for the clicked URL, per tab, with a TTL", () => {
  const tab = { tab: { id: 7 } };
  assert.equal(suppress({ url: "/a/b/blob/main/x.png" }, tab, 1000).stored, true);
  assert.equal(consume({ url: "/a/b/blob/main/x.png" }, tab, 2000).suppressed, true);
  assert.equal(consume({ url: "/a/b/blob/main/x.png" }, tab, 2001).suppressed, false, "consumed on first read");

  suppress({ url: "/a/b/blob/main/x.png" }, tab, 1000);
  assert.equal(consume({ url: "/a/b/blob/main/y.png" }, tab, 1500).suppressed, false, "another URL");
  assert.equal(consume({ url: "/a/b/blob/main/x.png" }, tab, 1600).suppressed, false, "and it discards the entry");

  suppress({ url: "/u" }, tab, 1000);
  assert.equal(consume({ url: "/u" }, tab, 20000).suppressed, false, "expired");

  suppress({ url: "/u" }, { tab: { id: 8 } }, 1000);
  assert.equal(consume({ url: "/u" }, tab, 1100).suppressed, false, "another tab");
  assert.equal(suppress({ url: "/u" }, {}, 1000).stored, false);
});

test("suppression writes nothing to storage", async () => {
  suppress({ url: "/u" }, { tab: { id: 1 } });
  consume({ url: "/u" }, { tab: { id: 1 } });
  assert.deepEqual(await chrome.storage.local.get(null), {});
});
