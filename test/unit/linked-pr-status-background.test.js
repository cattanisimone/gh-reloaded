// Unit tests for background/linked-pr-status.js: the batched GraphQL query for
// the issues on visible board cards, the normalisation of their explicitly
// linked pull requests, batching, per-owner tokens and partial failures.
import "../support/chrome-stub.js"; // must come first: installs globalThis.chrome
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "../support/chrome-stub.js";
import { buildQuery, normalizePr, normalizeIssue, chunk, handleMessage, handleDetail, failingChecks } from "../../background/linked-pr-status.js";

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  resetStorage({
    githubTokens: [
      { id: "d", name: "default", token: "dflt", owner: "" },
      { id: "o", name: "acme", token: "acme-token", owner: "acme" },
    ],
    defaultTokenId: "d",
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const prNode = (over = {}) => ({
  number: 317,
  title: "Add preview",
  url: "https://github.com/acme/web/pull/317",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "acme/web" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
  ...over,
});
const issueNode = (...prs) => ({ issue: { closedByPullRequestsReferences: { nodes: prs } } });
const issue = (number, owner = "acme", repo = "web") => ({ owner, repo, number });

function mockFetch(handler) {
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ auth: init.headers.Authorization, query: body.query });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    const out = handler(body, calls.length);
    return { ok: out.status ? out.status < 400 : true, status: out.status || 200, json: async () => out.json };
  };
  return { calls, max: () => maxInflight };
}

test("buildQuery asks for explicit links only, closed PRs included", () => {
  const q = buildQuery([issue(207), issue(9, "acme", "api")]);
  assert.match(q, /i0: repository\(owner: "acme", name: "web"\) \{ issue\(number: 207\)/);
  assert.match(q, /i1: repository\(owner: "acme", name: "api"\)/);
  assert.match(q, /closedByPullRequestsReferences\(first: 10, includeClosedPrs: true\)/);
  assert.doesNotMatch(q, /timelineItems|search\(/);
});

test("buildQuery drops anything that is not a safe owner, repo and number", () => {
  const q = buildQuery([issue(1, 'a"x', "web"), issue(2, "acme", "w eb"), issue(3.5), issue(-1), issue(4)]);
  assert.equal((q.match(/repository\(/g) || []).length, 1);
  assert.match(q, /issue\(number: 4\)/);
});

test("chunk splits into batches of at most n", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("normalizePr keeps lifecycle, review and checks apart; null review decision stays null", () => {
  const p = normalizePr(prNode({ reviewDecision: null }));
  assert.deepEqual(p, {
    ok: true, number: 317, title: "Add preview", url: "https://github.com/acme/web/pull/317", repo: "acme/web",
    state: "OPEN", merged: false, isDraft: false, reviewDecision: null, checks: "FAILURE",
  });
  assert.equal(normalizePr(prNode({ state: "MERGED" })).merged, true);
  assert.equal(normalizePr(prNode({ commits: { nodes: [] } })).checks, null);
  assert.equal(normalizePr(null).ok, false);
});

test("normalizeIssue: no links is an empty list, a null node or a missing issue is unreadable", () => {
  assert.deepEqual(normalizeIssue(issueNode()), { ok: true, prs: [] });
  assert.equal(normalizeIssue(null).ok, false);
  assert.equal(normalizeIssue({ issue: null }).ok, false);
  assert.equal(normalizeIssue({ issue: { closedByPullRequestsReferences: null } }).ok, false);
});

test("normalizeIssue: a PR with an error below its node is unavailable, its sibling is kept", () => {
  const r = normalizeIssue(issueNode(prNode(), prNode({ number: 318 })), { issue: false, prs: new Set([1]) });
  assert.equal(r.prs[0].ok, true);
  assert.equal(r.prs[1].ok, false);
  assert.equal(r.prs[1].number, 318); // still a known PR: the page can name it
});

test("handleMessage: facts by key, cross-repo PR kept, no implicit links", async () => {
  mockFetch(() => ({
    json: { data: { i0: issueNode(prNode(), prNode({ number: 9, repository: { nameWithOwner: "acme/api" } })), i1: issueNode() } },
  }));
  const { facts } = await handleMessage({ issues: [issue(207), issue(208)] });
  assert.equal(facts["acme/web#207"].prs.length, 2);
  assert.equal(facts["acme/web#207"].prs[1].repo, "acme/api");
  assert.deepEqual(facts["acme/web#208"], { ok: true, prs: [] });
});

test("handleMessage: 20 issues per query, two in flight, one token per owner", async () => {
  const m = mockFetch((body) => {
    const data = {};
    for (const a of body.query.matchAll(/(i\d+): repository/g)) data[a[1]] = issueNode();
    return { json: { data } };
  });
  const issues = [
    ...Array.from({ length: 45 }, (_, n) => issue(n + 1)),
    ...Array.from({ length: 3 }, (_, n) => issue(n + 1, "solo", "r")),
  ];
  await resetStorage({
    githubTokens: [{ id: "d", name: "default", token: "dflt", owner: "" }, { id: "o", name: "acme", token: "acme-token", owner: "acme" }],
    defaultTokenId: "d",
  });
  const { facts } = await handleMessage({ issues });
  assert.equal(Object.keys(facts).length, 48);
  assert.equal(m.calls.length, 4); // 20 + 20 + 5 for acme, 3 for solo
  assert.ok(m.max() <= 2, `in flight: ${m.max()}`);
  const acme = m.calls.filter((c) => /owner: "acme"/.test(c.query));
  const solo = m.calls.filter((c) => /owner: "solo"/.test(c.query));
  assert.ok(acme.every((c) => c.auth === "Bearer acme-token"));
  assert.ok(solo.every((c) => c.auth === "Bearer dflt"));
  assert.ok(m.calls.every((c) => (c.query.match(/repository\(/g) || []).length <= 20));
});

test("handleMessage: an alias error leaves that issue unreadable and the rest intact", async () => {
  mockFetch(() => ({
    json: {
      data: { i0: issueNode(prNode()), i1: null },
      errors: [{ type: "NOT_FOUND", message: "x", path: ["i1", "issue"] }],
    },
  }));
  const { facts } = await handleMessage({ issues: [issue(1), issue(2, "acme", "gone")] });
  assert.equal(facts["acme/web#1"].ok, true);
  assert.equal(facts["acme/gone#2"].ok, false);
});

test("handleMessage: every repository null is a 403 refusal", async () => {
  mockFetch(() => ({ json: { data: { i0: null, i1: null } } }));
  await assert.rejects(handleMessage({ issues: [issue(1), issue(2)] }), (e) => e.status === 403);
});

test("handleMessage: no token for the owner is a 401, HTTP errors and rate limits carry their status", async () => {
  await resetStorage({ githubTokens: [], defaultTokenId: null });
  await assert.rejects(handleMessage({ issues: [issue(1)] }), (e) => e.status === 401);
  await resetStorage({ githubTokens: [{ id: "d", name: "d", token: "x", owner: "" }], defaultTokenId: "d" });
  mockFetch(() => ({ status: 502, json: {} }));
  await assert.rejects(handleMessage({ issues: [issue(1)] }), (e) => e.status === 502);
  mockFetch(() => ({ json: { data: { i0: issueNode() }, errors: [{ type: "RATE_LIMITED", message: "limit", path: [] }] } }));
  await assert.rejects(handleMessage({ issues: [issue(2)] }), (e) => e.rateLimited === true && e.status === 429);
});

test("handleMessage: nothing to ask, nothing sent", async () => {
  const m = mockFetch(() => ({ json: {} }));
  assert.deepEqual(await handleMessage({ issues: [] }), { facts: {} });
  assert.deepEqual(await handleMessage({}), { facts: {} });
  assert.equal(m.calls.length, 0);
});

test("detail: failing check runs and status contexts only", async () => {
  const nodes = [
    { __typename: "CheckRun", name: "build", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "e2e", conclusion: "TIMED_OUT" },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
    { __typename: "StatusContext", context: "ci/ok", state: "SUCCESS" },
  ];
  const data = { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } } } };
  assert.deepEqual(failingChecks(data), ["build", "e2e", "ci/legacy"]);
  assert.deepEqual(failingChecks(null), []);
  mockFetch(() => ({ json: { data } }));
  assert.deepEqual(await handleDetail({ owner: "acme", repo: "web", number: 317 }), { failing: ["build", "e2e", "ci/legacy"] });
  await assert.rejects(handleDetail({ owner: "a b", repo: "web", number: 1 }));
});
