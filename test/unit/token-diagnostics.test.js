import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTargets, buildChecks, classify, runDiagnostics, scrub, summarize, tokenType, STATUS, MAX_REQUESTS } from "../../options/token-diagnostics.js";

const FINE = "github_pat_AAAA1111";
const CLASSIC = "ghp_BBBB2222";
const org = { kind: "orgs", owner: "acme", number: 3 };
const usr = { kind: "users", owner: "sam", number: 2 };
const c = (result, kind = "repo", extra = {}) => classify(result, { kind, token: FINE, now: 0, ...extra });

test("tokenType reads the prefix only", () => {
  assert.equal(tokenType(FINE), "fine-grained");
  assert.equal(tokenType(CLASSIC), "classic");
  for (const p of ["gho_", "ghu_", "ghs_", "ghr_"]) assert.equal(tokenType(`${p}abc123`), "unknown");
  assert.equal(tokenType("xyz"), "unknown");
});

test("parseTargets: repo is required, optional fields validated", () => {
  assert.equal(parseTargets({ repo: "" }).errors.repo.length > 0, true);
  assert.equal(parseTargets({ repo: "a/b/c" }).ok, false);
  const ok = parseTargets({ repo: "https://github.com/acme/app", issue: "#12", project: "https://github.com/orgs/acme/projects/3", file: "/docs/a.html" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.targets, { repo: { owner: "acme", name: "app" }, issue: 12, project: org, file: "docs/a.html" });
  assert.ok(parseTargets({ repo: "a/b", issue: "x" }).errors.issue);
  assert.ok(parseTargets({ repo: "a/b", project: "https://github.com/acme/app" }).errors.project);
  assert.ok(parseTargets({ repo: "a/b", file: "../x" }).errors.file);
});

test("buildChecks only requests the targets that were given", () => {
  const { targets } = parseTargets({ repo: "acme/app" });
  const checks = buildChecks(targets);
  assert.deepEqual(checks.filter((k) => k.request).map((k) => k.request.url), ["https://api.github.com/user", "https://api.github.com/repos/acme/app/issues?per_page=1", "https://api.github.com/repos/acme/app/pulls?per_page=1"]);
  assert.equal(checks.find((k) => k.id === "project").skip.length > 0, true);
  assert.equal(checks.find((k) => k.id === "file").skip.length > 0, true);
});

test("buildChecks with every target stays within the request bound and is read-only", () => {
  const { targets } = parseTargets({ repo: "acme/app", issue: "5", project: "github.com/users/sam/projects/2", file: "a b/c.html" });
  const reqs = buildChecks(targets).filter((k) => k.request);
  assert.ok(reqs.length <= MAX_REQUESTS);
  for (const k of reqs) {
    const method = k.request.method || "GET";
    assert.ok(method === "GET" || (method === "POST" && k.request.url.endsWith("/graphql") && !/mutation/i.test(k.request.body)));
  }
  assert.ok(reqs.some((k) => k.request.url.endsWith("/issues/5")));
  assert.ok(reqs.some((k) => k.request.url.endsWith("/contents/a%20b/c.html")));
  assert.match(reqs.find((k) => k.id === "project").request.body, /user\(login/);
});

test("classify: success", () => {
  assert.equal(c({ status: 200 }).status, STATUS.AVAILABLE);
  assert.equal(c({ status: 200, projectNull: false, errors: [] }, "project", { project: org }).status, STATUS.AVAILABLE);
});

test("classify: 401 is denied", () => {
  const r = c({ status: 401 }, "auth");
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.reason, /invalid, expired or revoked/);
});

test("classify: 403 with SSO header, link only when it is a github.com URL", () => {
  const good = c({ status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=1" } });
  assert.equal(good.status, STATUS.DENIED);
  assert.match(good.remedy.href, /^https:\/\/github\.com\/orgs\/acme\/sso/);
  const evil = c({ status: 403, headers: { "x-github-sso": "required; url=https://evil.example/x" } });
  assert.match(evil.remedy.href, /^https:\/\/docs\.github\.com\//);
});

test("classify: 403 and 429 rate limits are temporary", () => {
  assert.equal(c({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999999999" } }).status, STATUS.TEMPORARY);
  assert.equal(c({ status: 403, headers: { "retry-after": "60" } }).status, STATUS.TEMPORARY);
  assert.equal(c({ status: 429 }).status, STATUS.TEMPORARY);
  assert.equal(c({ status: 200, errors: ["RATE_LIMITED"], projectNull: true }, "project", { project: org }).status, STATUS.TEMPORARY);
  // the last allowed request succeeding is not a rate-limit error
  assert.equal(c({ status: 200, headers: { "x-ratelimit-remaining": "0" } }).status, STATUS.AVAILABLE);
});

test("classify: fine-grained 403 names the permission", () => {
  const r = c({ status: 403, message: "Resource not accessible by personal access token" });
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /Issues: read/);
  assert.match(c({ status: 403, message: "Resource not accessible by personal access token" }, "file").remedy.text, /Contents: read/);
});

test("classify: classic 403 lists accepted and granted scopes", () => {
  const r = classify({ status: 403, message: "Resource not accessible by personal access token", headers: { "x-oauth-scopes": "gist", "x-accepted-oauth-scopes": "repo" } }, { kind: "repo", token: CLASSIC });
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /repo/);
  assert.match(r.remedy.text, /gist/);
});

test("classify: organization policy 403 is denied with policy remedy", () => {
  const r = c({ status: 403, message: "The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days." });
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.reason, /token policy/);
});

test("classify: bare 403, 404, null project and partial data are not verified", () => {
  assert.equal(c({ status: 403 }).status, STATUS.NOT_VERIFIED);
  assert.equal(c({ status: 404, message: "Not Found" }).status, STATUS.NOT_VERIFIED);
  assert.equal(c({ status: 200, projectNull: true, errors: [] }, "project", { project: org }).status, STATUS.NOT_VERIFIED);
  assert.equal(c({ status: 200, projectNull: false, partial: true, errors: ["NOT_FOUND"] }, "project", { project: org }).status, STATUS.NOT_VERIFIED);
  assert.equal(c({ status: 200, projectNull: true, errors: ["NOT_FOUND"] }, "project", { project: org }).status, STATUS.NOT_VERIFIED);
});

test("classify: INSUFFICIENT_SCOPES on an organization project names Organization → Projects", () => {
  const r = c({ status: 200, errors: ["INSUFFICIENT_SCOPES"], projectNull: true }, "project", { project: org });
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /Organization → Projects/);
});

test("classify: user-owned project with a fine-grained token gets the classic read:project remedy", () => {
  const denied = c({ status: 403, message: "Resource not accessible by personal access token" }, "project", { project: usr });
  assert.equal(denied.status, STATUS.DENIED);
  assert.match(denied.remedy.text, /classic token/);
  assert.match(denied.remedy.text, /read:project/);
  assert.doesNotMatch(denied.remedy.text, /Organization/);
  const nullProject = c({ status: 200, projectNull: true, errors: [] }, "project", { project: usr });
  assert.equal(nullProject.status, STATUS.NOT_VERIFIED);
  assert.match(nullProject.remedy.text, /read:project/);
  assert.doesNotMatch(nullProject.remedy.text, /Organization/);
  const scopes = c({ status: 200, errors: ["INSUFFICIENT_SCOPES"], projectNull: true }, "project", { project: usr });
  assert.match(scopes.remedy.text, /read:project/);
  assert.doesNotMatch(scopes.remedy.text, /Organization/);
});

test("classify: user-owned project with a classic token names the scope to add", () => {
  const r = classify({ status: 200, projectNull: true, errors: [] }, { kind: "project", token: CLASSIC, project: usr });
  assert.match(r.remedy.text, /Add it to this token/);
  assert.match(r.remedy.text, /read:project/);
});

test("classify: user-owned remedy is not attached to success or temporary results", () => {
  assert.equal(c({ status: 200, projectNull: false, errors: [] }, "project", { project: usr }).remedy, null);
  assert.equal(c({ status: 503 }, "project", { project: usr }).remedy, null);
});

test("classify: 5xx, network, timeout and unparseable body are temporary", () => {
  for (const r of [{ status: 502 }, { failure: "network" }, { failure: "timeout" }, { failure: "parse", status: 200 }]) {
    assert.equal(c(r).status, STATUS.TEMPORARY);
  }
  assert.match(c({ status: 502 }).reason, /502/);
});

test("scrub removes every occurrence of the token", () => {
  assert.equal(scrub(`a ${FINE} b ${FINE}`, FINE), "a … b …");
});

function fakeFetch(handler, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    const { status = 200, headers = {}, body = {} } = await handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
}

test("runDiagnostics: skips the rest after a 401 and never echoes the token", async () => {
  const log = [];
  const fetch = fakeFetch(() => ({ status: 401, body: { message: `Bad credentials ${FINE}` } }), log);
  const res = await runDiagnostics(FINE, { repo: "acme/app", project: "github.com/orgs/acme/projects/3" }, { fetch });
  assert.equal(log.length, 1);
  assert.equal(res[0].status, STATUS.DENIED);
  assert.deepEqual(res.slice(1).map((r) => r.status), Array(4).fill(STATUS.NOT_CHECKED));
  assert.equal(JSON.stringify(res).includes(FINE), false);
});

test("runDiagnostics: sends the given token, at most 2 at a time, 5 requests", async () => {
  let active = 0, peak = 0;
  const log = [];
  const fetch = fakeFetch(async (url) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    if (url.endsWith("/graphql")) return { body: { data: { organization: { projectV2: { id: "x" } } } } };
    if (url.endsWith("/user")) return { body: { login: "sam" } };
    return { body: [] };
  }, log);
  const res = await runDiagnostics(FINE, { repo: "acme/app", project: "github.com/orgs/acme/projects/3", file: "a.html" }, { fetch });
  assert.equal(log.length, 5);
  assert.ok(peak <= 2);
  assert.ok(log.every((l) => l.init.headers.Authorization === `Bearer ${FINE}`));
  assert.deepEqual(res.map((r) => r.status), Array(5).fill(STATUS.AVAILABLE));
  assert.match(res[0].reason, /sam, fine-grained token/);
  assert.equal(summarize(res), "5 checked: 5 available.");
});

test("runDiagnostics: timeout and abort", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))));
  const res = await runDiagnostics(FINE, { repo: "a/b" }, { fetch: hang, timeoutMs: 20 });
  assert.equal(res[0].status, STATUS.TEMPORARY);
  assert.match(res[0].reason, /10 seconds/);
  const ctl = new AbortController();
  const p = runDiagnostics(FINE, { repo: "a/b" }, { fetch: hang, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, { name: "AbortError" });
});

test("runDiagnostics: a private file is read by status only", async () => {
  let cancelled = false;
  const fetch = async (url) => {
    if (url.includes("/contents/")) {
      return { status: 200, ok: true, headers: new Headers(), body: { cancel: async () => { cancelled = true; } }, json: async () => { throw new Error("must not read"); } };
    }
    return new Response(JSON.stringify(url.endsWith("/user") ? { login: "u" } : []), { status: 200 });
  };
  const res = await runDiagnostics(FINE, { repo: "a/b", file: "p.txt" }, { fetch });
  assert.equal(res[4].status, STATUS.AVAILABLE);
  assert.ok(cancelled);
});

test("summarize counts only what was checked", () => {
  assert.equal(summarize([{ status: STATUS.AVAILABLE }, { status: STATUS.AVAILABLE }, { status: STATUS.NOT_VERIFIED }, { status: STATUS.NOT_CHECKED }]), "3 checked: 2 available, 1 not verified.");
});

test("parseTargets rejects dot-only repository segments", () => {
  assert.equal(parseTargets({ repo: "../user" }).ok, false);
  assert.equal(parseTargets({ repo: "acme/.." }).ok, false);
});

test("classify: org project, GraphQL FORBIDDEN 'not accessible by personal access token' -> denied with the Projects remedy", () => {
  const r = classify(
    { status: 200, headers: {}, errors: ["FORBIDDEN"], projectNull: true, partial: true, message: "Resource not accessible by personal access token" },
    { kind: "project", token: FINE, project: { kind: "orgs", owner: "acme", number: 3 } },
  );
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /Organization → Projects/);
});

test("classify: a secondary rate limit is recognised from the message alone", () => {
  assert.equal(c({ status: 403, headers: {}, message: "You have exceeded a secondary rate limit. Please wait a few minutes." }).status, STATUS.TEMPORARY);
});

test("runDiagnostics: a failed private-file request has its error body parsed", async () => {
  const fetch = async (url) => {
    if (url.includes("/contents/")) return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 });
    return new Response(JSON.stringify(url.endsWith("/user") ? { login: "u" } : []), { status: 200 });
  };
  const res = await runDiagnostics(FINE, { repo: "a/b", file: "p.txt" }, { fetch });
  assert.equal(res[4].status, STATUS.DENIED);
  assert.match(res[4].remedy.text, /Contents: read/);
});

test("runDiagnostics: a rate-limited authentication stops the remaining requests", async () => {
  const log = [];
  const fetch = fakeFetch(async () => ({ status: 429, body: { message: "slow down" } }), log);
  const res = await runDiagnostics(FINE, { repo: "a/b", file: "p.txt" }, { fetch });
  assert.equal(log.length, 1);
  assert.equal(res[0].status, STATUS.TEMPORARY);
  assert.deepEqual(res.slice(1).map((r) => r.status), Array(res.length - 1).fill(STATUS.NOT_CHECKED));
});

test("runDiagnostics: a rate limit on any check stops the queued requests", async () => {
  const log = [];
  const fetch = fakeFetch(async (url) => {
    if (url.endsWith("/user")) return { body: { login: "u" } };
    if (url.includes("/repos/acme/app") && !url.includes("/contents/")) return { status: 429, body: { message: "slow down" } };
    await new Promise((r) => setTimeout(r, 20));
    return { body: {} };
  }, log);
  const res = await runDiagnostics(FINE, { repo: "acme/app", project: "github.com/orgs/acme/projects/3", file: "a.html" }, { fetch });
  assert.equal(log.length, 3);
  assert.equal(res.at(-1).status, STATUS.NOT_CHECKED);
  assert.match(res.at(-1).reason, /rate-limiting/);
});

test("classify: user-owned project with an OAuth or app token stays token-neutral", () => {
  const r = classify({ status: 200, projectNull: true, errors: [] }, { kind: "project", token: "gho_abc123", project: usr });
  assert.match(r.remedy.text, /read:project/);
  assert.doesNotMatch(r.remedy.text, /fine-grained/);
});

test("buildChecks always requests the pull requests list right after issues, within MAX_REQUESTS (5)", () => {
  const { targets } = parseTargets({ repo: "acme/app", issue: "5", project: "github.com/orgs/acme/projects/2", file: "a.html" });
  const checks = buildChecks(targets);
  assert.deepEqual(checks.map((k) => k.id), ["auth", "repo", "pulls", "project", "file"]);
  assert.equal(checks[2].request.url, "https://api.github.com/repos/acme/app/pulls?per_page=1");
  assert.equal(checks[2].label, "Pull requests");
  assert.equal(checks[2].resource, "acme/app, pull requests list");
  assert.equal(checks.filter((k) => k.request).length, MAX_REQUESTS);
  assert.equal(MAX_REQUESTS, 5);
});

test("classify pulls: 200 is Available", () => {
  assert.equal(c({ status: 200 }, "pulls").status, STATUS.AVAILABLE);
});

test("classify pulls: a fine-grained 403 'not accessible by personal access token' is Access denied naming Pull requests: read and the repository selection", () => {
  const r = c({ status: 403, headers: {}, message: "Resource not accessible by personal access token" }, "pulls");
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /repository's selection|repository in the token's selection/);
  assert.match(r.remedy.text, /Pull requests: read \(and Metadata\)/);
});

test("classify pulls: a classic 403 names the accepted and granted scopes", () => {
  const r = classify({ status: 403, headers: { "x-oauth-scopes": "gist", "x-accepted-oauth-scopes": "repo" }, message: "Resource not accessible by personal access token" }, { kind: "pulls", token: CLASSIC });
  assert.equal(r.status, STATUS.DENIED);
  assert.match(r.remedy.text, /Accepted for this request: repo\. Granted: gist/);
});

test("classify pulls: a 404 is Not verified with the ambiguous remedy", () => {
  const r = c({ status: 404 }, "pulls");
  assert.equal(r.status, STATUS.NOT_VERIFIED);
  assert.match(r.remedy.text, /Check the resource name/);
});

test("runDiagnostics: a 401 marks Pull requests Not checked; pull requests are read once, with the card's token", async () => {
  const log = [];
  const denied = await runDiagnostics(FINE, { repo: "acme/app" }, { fetch: fakeFetch(() => ({ status: 401, body: {} }), log) });
  assert.equal(denied.find((r) => r.id === "pulls").status, STATUS.NOT_CHECKED);
  const seen = [];
  const res = await runDiagnostics(FINE, { repo: "acme/app" }, { fetch: fakeFetch((url) => { seen.push(url); return { body: url.endsWith("/user") ? { login: "u" } : [] }; }) });
  assert.equal(seen.filter((u) => u.includes("/pulls")).length, 1);
  assert.equal(res.find((r) => r.id === "pulls").status, STATUS.AVAILABLE);
});
