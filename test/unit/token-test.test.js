import { test } from "node:test";
import assert from "node:assert/strict";
import { runTokenTest, tokenState, countOk, lastTestLabel, tokenKind, listingUrl, projectsQuery, MAX_TEST_REQUESTS, readTests, writeTest } from "../../options/token-test.js";

const FINE = "github_pat_AAAA1111";
const CLASSIC = "ghp_BBBB2222";

// routes: [[regex on "METHOD url", response|fn]], first match wins, else 404.
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = `${init.method || "GET"} ${url}`;
    calls.push({ key, url, method: init.method || "GET", auth: init.headers.Authorization, body: init.body });
    for (const [re, res] of routes) {
      if (!re.test(key)) continue;
      const r = typeof res === "function" ? res(url, init) : res;
      const headers = new Headers(r.headers || {});
      return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, headers, body: { cancel: async () => {} }, json: async () => r.body };
    }
    return { status: 404, ok: false, headers: new Headers(), json: async () => ({ message: "Not Found" }) };
  };
}

const user = (headers = {}) => [/GET .*\/user$/, { body: { login: "sam" }, headers }];
const priv = (full = "acme/app") => ({ body: [{ full_name: full, private: true }] });
const pub = { body: [{ full_name: "acme/open", private: false }] };
const happy = (listing = priv()) => [
  user({ "x-oauth-scopes": "repo" }),
  [/GET .*repos\?/, listing],
  [/GET .*\/orgs\/.*\/repos\?/, listing],
  [/contents\/$/, { body: [] }],
  [/pulls\?/, { body: [] }],
  [/issues\?/, { body: [] }],
  [/actions\/runs/, { body: { workflow_runs: [] } }],
  [/POST .*graphql/, { body: { data: { viewer: { projectsV2: { totalCount: 1 } } } } }],
];
const denied403 = { status: 403, body: { message: "Resource not accessible by personal access token" } };

test("request plan: at most 7 requests, GET plus one read-only GraphQL, the row's own token", async () => {
  const calls = [];
  const res = await runTokenTest({ token: CLASSIC, owner: "" }, { fetch: fakeFetch(happy(), calls) });
  assert.equal(res.outcome, "done");
  assert.ok(calls.length <= MAX_TEST_REQUESTS);
  assert.equal(calls.length, 7);
  assert.ok(calls.every((c) => c.auth === `Bearer ${CLASSIC}`));
  assert.ok(calls.every((c) => c.method === "GET" || (c.method === "POST" && c.url.endsWith("/graphql") && !/mutation/.test(c.body))));
  assert.ok(calls.every((c) => c.url.startsWith("https://api.github.com/")));
  assert.deepEqual(res.record.codes, { identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "available" });
  assert.deepEqual(countOk(res.record), { ok: 5, total: 5 });
});

test("a public repository proves nothing: repository types are Not verified, requests stop", async () => {
  const calls = [];
  const res = await runTokenTest({ token: FINE, owner: "" }, { fetch: fakeFetch(happy(pub), calls) });
  assert.equal(res.outcome, "done");
  for (const id of ["contents", "pulls", "issues", "actions"]) assert.equal(res.record.codes[id], "unverified", id);
  assert.ok(!calls.some((c) => /contents|pulls|issues|actions/.test(c.url.replace(/user\/repos.*/, ""))));
  assert.equal(res.lines.contents.hint, "We can't tell why.");
});

test("no repository listed (empty or 404): repository types unverified, never available", async () => {
  for (const listing of [{ body: [] }, { status: 404, body: { message: "Not Found" } }]) {
    const res = await runTokenTest({ token: FINE, owner: "acme" }, { fetch: fakeFetch(happy(listing)) });
    assert.equal(res.record.codes.issues, "unverified");
    assert.equal(res.record.codes.contents, "unverified");
  }
});

test("a proven denial on one type, others available", async () => {
  const routes = [[/pulls\?/, denied403], ...happy()];
  const res = await runTokenTest({ token: CLASSIC, owner: "" }, { fetch: fakeFetch(routes) });
  assert.equal(res.record.codes.pulls, "denied");
  assert.equal(res.record.codes.issues, "available");
  assert.deepEqual(countOk(res.record), { ok: 4, total: 5 });
});

test("SSO and policy 403s are unverified with the sso flag, never denied", async () => {
  const routes = [
    [/issues\?/, { status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=1" }, body: { message: "Resource protected by organization SAML enforcement" } }],
    [/pulls\?/, { status: 403, body: { message: "The 'acme' organization forbids access via a personal access token (classic)" } }],
    ...happy(),
  ];
  const res = await runTokenTest({ token: CLASSIC, owner: "acme" }, { fetch: fakeFetch(routes) });
  assert.equal(res.record.codes.issues, "unverified");
  assert.equal(res.record.codes.pulls, "unverified");
  assert.equal(res.record.sso, true);
});

test("401 on identity: Not working, nothing else requested", async () => {
  const calls = [];
  const res = await runTokenTest({ token: FINE, owner: "" }, { fetch: fakeFetch([[/user$/, { status: 401, body: { message: "Bad credentials" } }]], calls) });
  assert.equal(res.outcome, "not-working");
  assert.equal(res.record.codes.identity, "denied");
  assert.equal(calls.length, 1);
});

test("rate limit, 5xx and network errors are temporary and conclude nothing", async () => {
  const cases = [
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" }, body: { message: "API rate limit exceeded" } },
    { status: 502, body: {} },
  ];
  for (const bad of cases) {
    const res = await runTokenTest({ token: FINE, owner: "" }, { fetch: fakeFetch([[/pulls\?/, bad], ...happy()]) });
    assert.equal(res.outcome, "temporary");
    assert.equal(res.record, null);
  }
  const res = await runTokenTest({ token: FINE, owner: "" }, { fetch: async () => { throw new TypeError("offline"); } });
  assert.equal(res.outcome, "temporary");
});

test("abort rejects with AbortError and sends nothing more", async () => {
  const ctl = new AbortController();
  const calls = [];
  const f = fakeFetch(happy(), calls);
  const p = runTokenTest({ token: FINE, owner: "" }, { fetch: async (u, i) => { const r = await f(u, i); ctl.abort(); return r; }, signal: ctl.signal });
  await assert.rejects(p, { name: "AbortError" });
  assert.ok(calls.length < 7);
});

test("listing by token and owner", () => {
  assert.match(listingUrl("", "sam"), /\/user\/repos\?visibility=private&sort=pushed/);
  assert.match(listingUrl("acme", "sam"), /\/orgs\/acme\/repos\?type=private&sort=pushed/);
  assert.match(listingUrl("Sam", "sam"), /\/user\/repos\?visibility=private&affiliation=owner/);
});

test("token kind: prefix, else the X-OAuth-Scopes header", () => {
  assert.equal(tokenKind(FINE, { "x-oauth-scopes": "repo" }), "fine-grained");
  assert.equal(tokenKind(CLASSIC, {}), "fine-grained");
  assert.equal(tokenKind(CLASSIC, { "x-oauth-scopes": "" }), "classic");
});

test("default fine-grained projects via organizations", async () => {
  const gql = (body) => [/POST .*graphql/, { body }];
  const ok = await runTokenTest({ token: FINE, owner: "" }, { fetch: fakeFetch([gql({ data: { viewer: { organizations: { nodes: [{ login: "a", projectsV2: null }, { login: "b", projectsV2: { totalCount: 2 } }] } } } }), ...happy()]) });
  assert.equal(ok.record.codes.projects, "available");
});

test("default fine-grained projects unprovable: Not verified with the neutral hint, never denied", async () => {
  for (const body of [
    { data: { viewer: { organizations: { nodes: [] } } } },
    { data: { viewer: { organizations: { nodes: [{ login: "a", projectsV2: null }] } } }, errors: [{ type: "INSUFFICIENT_SCOPES", message: "x" }] },
  ]) {
    const res = await runTokenTest({ token: FINE, owner: "" }, { fetch: fakeFetch([[/POST .*graphql/, { body }], ...happy()]) });
    assert.equal(res.record.codes.projects, "unverified");
    assert.match(res.lines.projects.hint, /doesn't know which owner this token is for/);
    assert.doesNotMatch(res.lines.projects.hint, /classic/);
  }
});

test("personal projects with a fine-grained owner token: Not verified, classic hint, no GraphQL request", async () => {
  const calls = [];
  const res = await runTokenTest({ token: FINE, owner: "sam" }, { fetch: fakeFetch(happy(), calls) });
  assert.equal(res.record.codes.projects, "unverified");
  assert.match(res.lines.projects.hint, /classic token with read:project/);
  assert.ok(!calls.some((c) => c.url.endsWith("/graphql")));
  assert.equal(calls.length, 6);
});

test("projects scope denied: classic token and organization owner", async () => {
  const body = { data: null, errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] };
  for (const [token, owner] of [[CLASSIC, ""], [FINE, "acme"], [CLASSIC, "acme"], [CLASSIC, "sam"]]) {
    const res = await runTokenTest({ token, owner }, { fetch: fakeFetch([[/POST .*graphql/, { body }], ...happy()]) });
    assert.equal(res.record.codes.projects, "denied", `${token} ${owner}`);
  }
});

test("organization owner with fine-grained token uses the organization query", async () => {
  const calls = [];
  await runTokenTest({ token: FINE, owner: "acme" }, { fetch: fakeFetch([[/POST .*graphql/, { body: { data: { organization: { projectsV2: { totalCount: 0 } } } } }], ...happy()], calls) });
  assert.match(calls.find((c) => c.url.endsWith("/graphql")).body, /organization\(login/);
  assert.deepEqual(projectsQuery({ owner: "sam", login: "sam", kind: "fine-grained" }), null);
});

test("state rules", () => {
  const rec = (codes, extra = {}) => ({ at: 1, codes: { identity: "available", contents: "unchecked", pulls: "unchecked", issues: "unchecked", projects: "unchecked", actions: "unchecked", ...codes }, ...extra });
  const req = new Set(["pulls", "issues"]);
  const st = (r, required = req, hasToken = true) => tokenState({ hasToken, rec: r, required });
  assert.equal(st(null, req, false).state, "not-set");
  assert.equal(st(null).state, "not-tested");
  assert.equal(st(rec({ identity: "denied" })).state, "not-working");
  assert.equal(st(rec({ pulls: "denied", issues: "available" })).state, "missing");
  assert.equal(st(rec({ pulls: "available", issues: "available", actions: "denied" })).state, "works");
  assert.equal(st(rec({ pulls: "available", issues: "unverified" })).note, "1 check couldn't be verified");
  assert.equal(st(rec({ pulls: "unverified", issues: "unverified" })).state, "cant-verify");
  assert.match(st(rec({ pulls: "unverified", issues: "unverified" }, { sso: true })).note, /SSO/);
  // no required type: Works if any available, else Can't verify, never Missing
  assert.equal(st(rec({ actions: "denied" }), new Set()).state, "cant-verify");
  assert.equal(st(rec({ contents: "available", actions: "denied" }), new Set()).state, "works");
});

test("last test label and session storage of codes only", async () => {
  const at = new Date(2026, 10, 13, 9, 12).getTime();
  const rec = { at, codes: { identity: "available", contents: "available", pulls: "denied", issues: "unverified", projects: "available", actions: "available" } };
  assert.equal(lastTestLabel(rec, new Date(2026, 10, 13, 18, 0)), "Today 09:12 · 3 of 5 OK");
  assert.equal(lastTestLabel(rec, new Date(2026, 10, 14, 8, 0)), "Yesterday 09:12 · 3 of 5 OK");
  assert.match(lastTestLabel(rec, new Date(2026, 10, 16, 8, 0)), /^\w+ \d+ 09:12 · 3 of 5 OK$/);
  let stored = {};
  const area = { get: async () => ({ ...stored }), set: async (o) => { Object.assign(stored, o); } };
  await writeTest("t1", rec, area);
  assert.deepEqual((await readTests(area)).t1, rec);
  await writeTest("t1", null, area);
  assert.deepEqual(await readTests(area), {});
  assert.doesNotMatch(JSON.stringify(rec), /github_pat|ghp_|acme/);
});

test("GraphQL FORBIDDEN from SAML or a token policy is unverified, not denied", async () => {
  for (const message of ["Resource protected by organization SAML enforcement. You must grant your token access", "The 'acme' organization forbids access via a personal access tokens (classic)"]) {
    const body = { data: null, errors: [{ type: "FORBIDDEN", message }] };
    const res = await runTokenTest({ token: CLASSIC, owner: "acme" }, { fetch: fakeFetch([[/POST .*graphql/, { body }], ...happy()]) });
    assert.equal(res.record.codes.projects, "unverified");
    assert.equal(res.record.sso, true);
  }
});

test("a revoked token counts 0 of 5, and overlapping session writes all survive", async () => {
  assert.deepEqual(countOk({ at: 1, codes: { identity: "denied" } }), { ok: 0, total: 5 });
  let stored = {};
  const area = { get: async () => { await new Promise((r) => setTimeout(r, 5)); return { ...stored }; }, set: async (o) => { Object.assign(stored, o); } };
  const rec = { at: 1, codes: { identity: "available" } };
  await Promise.all([writeTest("A", rec, area), writeTest("B", rec, area)]);
  assert.deepEqual(Object.keys((await readTests(area))).sort(), ["A", "B"]);
});
