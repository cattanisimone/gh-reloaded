// Unit tests for background/pr-triage.js: the batched GraphQL query for the
// pull requests visible on a /pulls page, and the normalisation of each
// alias into the facts the classifier reads.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { buildQuery, normalize, chunk, handleMessage } from "../../background/pr-triage.js";

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetStorage({ githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const node = (over = {}) => ({
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: "h2",
  author: { login: "ana" },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: "User", login: "sam" } },
      { requestedReviewer: { __typename: "Team", slug: "design", organization: { login: "acme" } } },
      { requestedReviewer: null },
    ],
  },
  latestOpinionatedReviews: {
    nodes: [{ author: { login: "lee" }, state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T10:00:00Z", commit: { oid: "h1" } }],
  },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...over,
});

test("buildQuery aliases one pullRequest per number", () => {
  const q = buildQuery([412, 409]);
  assert.match(q, /p412: pullRequest\(number: 412\)/);
  assert.match(q, /p409: pullRequest\(number: 409\)/);
});

test("buildQuery keeps only integers", () => {
  assert.doesNotMatch(buildQuery([1, "2) { x", 3.5, -1]), /x|3\.5|-1/);
});

test("chunk splits into batches of at most n", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("normalize reads users, teams, reviews, checks and head", () => {
  const f = normalize(node());
  assert.equal(f.ok, true);
  assert.equal(f.author, "ana");
  assert.deepEqual(f.users, ["sam"]);
  assert.deepEqual(f.teams, ["acme/design"]);
  assert.deepEqual(f.reviews, [{ author: "lee", state: "CHANGES_REQUESTED", oid: "h1", at: "2026-10-02T10:00:00Z" }]);
  assert.equal(f.checks, "FAILURE");
  assert.equal(f.headOid, "h2");
});

test("normalize: a missing alias or a ghost author is tolerated", () => {
  assert.equal(normalize(null).ok, false);
  assert.equal(normalize(undefined).ok, false);
  const f = normalize(node({ author: null, commits: { nodes: [] }, latestOpinionatedReviews: null }));
  assert.equal(f.ok, true);
  assert.equal(f.author, "");
  assert.equal(f.checks, null);
  assert.deepEqual(f.reviews, []);
});

const ok = (data, errors) => ({ ok: true, status: 200, json: async () => ({ data, ...(errors ? { errors } : {}) }) });

test("handleMessage returns facts per number; a failing alias becomes unavailable", async () => {
  globalThis.fetch = async () =>
    ok({ repository: { p1: node(), p2: null } }, [{ message: "Could not resolve to a PullRequest with the number of 2.", path: ["repository", "p2"] }]);
  const out = await handleMessage({ owner: "acme", repo: "web", numbers: [1, 2] });
  assert.equal(out.facts[1].ok, true);
  assert.equal(out.facts[2].ok, false);
});

test("handleMessage batches 25 numbers per request, two in flight", async () => {
  let live = 0;
  let peak = 0;
  const sizes = [];
  globalThis.fetch = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    sizes.push((q.match(/pullRequest\(/g) || []).length);
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return ok({ repository: {} });
  };
  const numbers = Array.from({ length: 60 }, (_, i) => i + 1);
  const out = await handleMessage({ owner: "acme", repo: "web", numbers });
  assert.deepEqual(sizes.sort((a, b) => b - a), [25, 25, 10]);
  assert.ok(peak <= 2);
  assert.equal(Object.keys(out.facts).length, 60);
});

test("handleMessage without a token fails with 401 and never calls the API", async () => {
  resetStorage({});
  let calls = 0;
  globalThis.fetch = async () => (calls++, ok({}));
  await assert.rejects(() => handleMessage({ owner: "acme", repo: "web", numbers: [1] }), (e) => e.status === 401);
  assert.equal(calls, 0);
});

test("handleMessage surfaces a refusal as its HTTP status", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => handleMessage({ owner: "acme", repo: "web", numbers: [1] }), (e) => e.status === 403);
});

test("handleMessage surfaces a rate-limited GraphQL error", async () => {
  globalThis.fetch = async () => ok(null, [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]);
  await assert.rejects(() => handleMessage({ owner: "acme", repo: "web", numbers: [1] }), (e) => e.rateLimited === true);
});

test("handleMessage rejects an owner or repo that is not a plain name", async () => {
  await assert.rejects(() => handleMessage({ owner: "a/b", repo: "web", numbers: [1] }), /repository/);
});

test("buildQuery asks for every opinionated review, including read-only reviewers", () => {
  assert.match(buildQuery([1]), /latestOpinionatedReviews\(first: 30\)/);
  assert.doesNotMatch(buildQuery([1]), /writersOnly/);
});

test("handleMessage treats a null repository as a refusal", async () => {
  globalThis.fetch = async () => ok({ repository: null }, [{ type: "NOT_FOUND", message: "Could not resolve" }]);
  await assert.rejects(() => handleMessage({ owner: "acme", repo: "web", numbers: [7] }), (e) => e.status === 403);
});
