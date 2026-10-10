// Unit tests for lib/github-api.js — the shared GitHub client. Covers the
// two things that are easy to get subtly wrong and invisible when they
// do: which saved token a request resolves to (per-owner mapping vs the
// default), and the short-lived response cache that keys on both the
// request and the token that served it.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { resetStorage } from "../support/chrome-stub.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveTokenRecord, ghFetch, ghGraphQL, GQL_ERRORS, repoFromUrl, safeFields, mapWithLimit } from "../../lib/github-api.js";

const TOKENS = [
  { id: "tok_default", name: "Default", token: "secret-default", owner: "" },
  { id: "tok_acme", name: "Acme", token: "secret-acme", owner: "acme" },
];

let realFetch;
beforeEach(() => {
  resetStorage({ githubTokens: TOKENS, defaultTokenId: "tok_default" });
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("resolveTokenRecord maps an owner to its token, case-insensitively", async () => {
  assert.equal((await resolveTokenRecord("acme")).id, "tok_acme");
  assert.equal((await resolveTokenRecord("ACME")).id, "tok_acme");
  assert.equal((await resolveTokenRecord(" Acme ")).id, "tok_acme");
});

test("resolveTokenRecord falls back to the default for an unmapped owner", async () => {
  assert.equal((await resolveTokenRecord("someone-else")).id, "tok_default");
  assert.equal((await resolveTokenRecord("")).id, "tok_default");
  assert.equal((await resolveTokenRecord(undefined)).id, "tok_default");
});

test("resolveTokenRecord never silently tries another token when none match and no default exists", async () => {
  resetStorage({ githubTokens: [TOKENS[1]], defaultTokenId: null }); // only the acme mapping, no default
  assert.equal(await resolveTokenRecord("nobody"), null);
});

test("resolveTokenRecord returns null when there are no tokens at all", async () => {
  resetStorage({ githubTokens: [] });
  assert.equal(await resolveTokenRecord("acme"), null);
});

test("ghFetch sends the owner-mapped token as a Bearer credential", async () => {
  let seenAuth;
  globalThis.fetch = async (url, opts) => {
    seenAuth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  await ghFetch("/repos/acme/web/issues/1", { owner: "acme" });
  assert.equal(seenAuth, "Bearer secret-acme");
});

test("ghFetch caches a response and does not re-hit the network within the TTL", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ n: calls }) };
  };
  const first = await ghFetch("/repos/acme/web/issues/cache-a", { owner: "acme" });
  const second = await ghFetch("/repos/acme/web/issues/cache-a", { owner: "acme" });
  assert.equal(calls, 1, "second identical request should be served from cache");
  assert.deepEqual(first, second);
});

test("ghFetch with { fresh } bypasses a cached entry but refreshes it", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ n: calls }) };
  };
  const first = await ghFetch("/repos/acme/web/issues/cache-fresh", { owner: "acme" });
  const refreshed = await ghFetch("/repos/acme/web/issues/cache-fresh", { owner: "acme", fresh: true });
  assert.equal(calls, 2, "a fresh request should hit the network even with a warm cache");
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(refreshed, { n: 2 });
  // The fresh response is written back, so a plain read now sees it from cache.
  const afterRefresh = await ghFetch("/repos/acme/web/issues/cache-fresh", { owner: "acme" });
  assert.equal(calls, 2, "the fresh response should have repopulated the cache");
  assert.deepEqual(afterRefresh, { n: 2 });
});

test("ghFetch keys the cache by token, so two credentials never share an entry", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ n: calls }) };
  };
  // Same path, different resolved token (acme-mapped vs default) → two fetches.
  await ghFetch("/repos/shared/path/cache-b", { owner: "acme" });
  await ghFetch("/repos/shared/path/cache-b", { owner: "other" });
  assert.equal(calls, 2);
});

test("ghFetch throws an error carrying the HTTP status on a non-OK response", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => ghFetch("/repos/acme/web/missing", { owner: "acme" }), (e) => {
    assert.equal(e.status, 404);
    return true;
  });
});

test("repoFromUrl parses owner/repo out of an API repository_url", () => {
  assert.deepEqual(repoFromUrl("https://api.github.com/repos/acme/web", "f-owner", "f-repo"), {
    owner: "acme",
    repo: "web",
  });
});

test("repoFromUrl falls back to the given owner/repo when the url is unparseable", () => {
  assert.deepEqual(repoFromUrl("", "f-owner", "f-repo"), { owner: "f-owner", repo: "f-repo" });
  assert.deepEqual(repoFromUrl(null, "f-owner", "f-repo"), { owner: "f-owner", repo: "f-repo" });
});

test("safeFields reshapes org custom field values into a by-name map", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { issue_field_name: "Team", value: "Platform", single_select_option: null },
      {
        issue_field_name: "Effort",
        value: null,
        single_select_option: { name: "5", color: "BLUE" },
      },
    ],
  });
  const byName = await safeFields("acme", "web", 101);
  assert.deepEqual(byName.Team, { value: "Platform", color: null });
  assert.deepEqual(byName.Effort, { value: "5", color: "BLUE" });
});

test("safeFields degrades to an empty map when the endpoint 404s (field not enabled)", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.deepEqual(await safeFields("acme", "web", 102), {});
});

test("mapWithLimit never runs more than `limit` calls at once and keeps the result order", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test("mapWithLimit copes with an empty list", async () => {
  assert.deepEqual(await mapWithLimit([], 4, async (n) => n), []);
});

const gqlResponse = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("ghGraphQL throws on any GraphQL error by default, even when data is present", async () => {
  globalThis.fetch = gqlResponse({ data: { a: 1 }, errors: [{ message: "Could not resolve", type: "NOT_FOUND" }] });
  await assert.rejects(() => ghGraphQL("query { a }", { n: 1 }, { owner: "acme" }), /Could not resolve/);
});

test("ghGraphQL with allowPartial returns the data and exposes the errors", async () => {
  globalThis.fetch = gqlResponse({ data: { a: 1, b: null }, errors: [{ message: "Could not resolve b", path: ["b"] }] });
  const data = await ghGraphQL("query { partial }", { n: 2 }, { owner: "acme", allowPartial: true });
  assert.equal(data.a, 1);
  assert.equal(data.b, null);
  assert.equal(data[GQL_ERRORS][0].message, "Could not resolve b");
  assert.deepEqual(Object.keys(data), ["a", "b"], "the errors do not show up as data");
});

test("ghGraphQL with allowPartial still throws when there is no data at all", async () => {
  globalThis.fetch = gqlResponse({ data: null, errors: [{ message: "Resource not accessible by personal access token" }] });
  await assert.rejects(
    () => ghGraphQL("query { nodata }", { n: 3 }, { owner: "acme", allowPartial: true }),
    (e) => {
      assert.match(e.message, /Resource not accessible/);
      assert.equal(e.graphqlErrors.length, 1);
      return true;
    }
  );
});

test("a partial GraphQL result is not cached for callers that did not opt in", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ data: { a: 1 }, errors: [{ message: "boom" }] }) };
  };
  await ghGraphQL("query { nocache }", { n: 4 }, { owner: "acme", allowPartial: true });
  await assert.rejects(() => ghGraphQL("query { nocache }", { n: 4 }, { owner: "acme" }), /boom/);
  assert.equal(calls, 2);
});
