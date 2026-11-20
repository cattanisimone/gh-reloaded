// #131: the notifications check of Test (default token only), its outcomes and
// count rules, the requirement and warning that follow from it, and the
// Notifications block of Settings as data. No network: fetch is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTokenTest, notificationsOutcome, tokenState, countOk, MAX_TEST_REQUESTS, MAX_TEST_REQUESTS_DEFAULT } from "../../options/token-test.js";
import { FEATURES, NOTIF_ID, TYPES, enabledFeatures, isFeatureOn, requiredTypes, warningFor, releaseSentence } from "../../options/token-requirements.js";
import { tokenView, notificationsView, notificationsHtml, escapeHtml, resultView } from "../../options/token-view.js";

const FINE = "github_pat_AAAA1111";
const CLASSIC = "ghp_BBBB2222";
const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const key = `${init.method || "GET"} ${url}`;
    calls.push({ key, url, method: init.method || "GET", auth: init.headers.Authorization });
    for (const [re, res] of routes) {
      if (!re.test(key)) continue;
      const r = typeof res === "function" ? res(url, init) : res;
      return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, headers: new Headers(r.headers || {}), body: { cancel: async () => {} }, json: async () => r.body };
    }
    return { status: 404, ok: false, headers: new Headers(), json: async () => ({ message: "Not Found" }) };
  };
}
const priv = { body: [{ full_name: "acme/app", private: true }] };
const base = (scopes = "repo") => [
  [/GET .*\/user$/, { body: { login: "sam" }, headers: scopes === null ? {} : { "x-oauth-scopes": scopes } }],
  [/GET .*repos\?/, priv],
  [/GET .*\/orgs\/.*\/repos\?/, priv],
  [/contents\/$/, { body: [] }],
  [/pulls\?/, { body: [] }],
  [/issues\?/, { body: [] }],
  [/actions\/runs/, { body: { workflow_runs: [] } }],
  [/POST .*graphql/, { body: { data: { viewer: { projectsV2: { totalCount: 1 } }, organization: { projectsV2: { totalCount: 1 } } } } }],
];
const NOTIF = /GET https:\/\/api\.github\.com\/notifications\?per_page=1$/;
const item = [{ id: "1", reason: "mention" }];
const run = (token, owner, notif, opts = {}) => {
  const calls = [];
  return runTokenTest({ token, owner }, { fetch: fakeFetch([[NOTIF, notif], ...base(opts.scopes)], calls), notifications: owner === "", ...opts.run }).then((res) => ({ res, calls }));
};

test("notifications check budget: one extra read on the default token (8), owner tokens stay at 7", async () => {
  assert.equal(MAX_TEST_REQUESTS, 7);
  assert.equal(MAX_TEST_REQUESTS_DEFAULT, 8);
  const d = await run(CLASSIC, "", { body: item, headers: { "x-oauth-scopes": "notifications" } });
  assert.equal(d.calls.length, 8);
  const n = d.calls.filter((c) => c.url.includes("/notifications"));
  assert.equal(n.length, 1);
  assert.equal(n[0].method, "GET");
  assert.equal(n[0].auth, `Bearer ${CLASSIC}`);
  const o = await run(CLASSIC, "acme", { body: item });
  assert.equal(o.calls.length, 7);
  assert.ok(!o.calls.some((c) => c.url.includes("/notifications")));
  assert.equal(o.res.record.codes.notifications, undefined, "owner tokens carry no notifications code");
  // without the option (older callers) nothing is added either
  const calls = [];
  await runTokenTest({ token: CLASSIC, owner: "" }, { fetch: fakeFetch(base(), calls) });
  assert.equal(calls.length, 7);
});

test("fine-grained default: no request, Not verified with the fine-grained detail, out of the count", async () => {
  const { res, calls } = await run(FINE, "", { body: item }, { scopes: null });
  assert.equal(calls.length, 7);
  assert.ok(!calls.some((c) => c.url.includes("/notifications")));
  assert.equal(res.record.codes.notifications, "unverified");
  assert.deepEqual(res.record.detail, { notifications: "fine-grained" });
  const { notifications, ...without } = res.record.codes;
  assert.deepEqual(countOk(res.record), countOk({ at: 1, codes: without }), "the check is out of {n} of {m}");
  assert.equal(tokenState({ hasToken: true, rec: res.record, required: new Set([...requiredTypes(enabledFeatures({}))]) }).state, "works");
});

test("a classic token whose /user answers without scopes is told apart as fine-grained too", async () => {
  const { res, calls } = await run(CLASSIC, "", { body: item }, { scopes: null });
  assert.ok(!calls.some((c) => c.url.includes("/notifications")));
  assert.equal(res.record.detail.notifications, "fine-grained");
});

const out = (status, headers, body, kind = "classic") => notificationsOutcome({ status, headers: Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])), body, message: body?.message }, { token: CLASSIC, kind });

test("notificationsOutcome: Available with notifications or repo, Access denied only when the headers prove it, otherwise Not verified", () => {
  assert.deepEqual(out(200, { "x-oauth-scopes": "notifications" }, item), { code: "available" });
  assert.deepEqual(out(200, { "x-oauth-scopes": "repo, read:project" }, item), { code: "available" });
  assert.deepEqual(out(200, { "x-oauth-scopes": "notifications" }, []), { code: "available" }, "the scope header proves it, an empty inbox does not matter");
  // proven missing: scopes lack notifications and repo, and GitHub says notifications is accepted
  const proof = { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" };
  assert.deepEqual(out(403, proof, { message: "x" }), { code: "denied" });
  assert.deepEqual(out(404, proof, { message: "Not Found" }), { code: "denied" });
  // ambiguous: no proof
  assert.deepEqual(out(403, {}, { message: "Forbidden" }), { code: "unverified", detail: "ambiguous" });
  assert.deepEqual(out(404, {}, { message: "Not Found" }), { code: "unverified", detail: "ambiguous" });
  assert.deepEqual(out(403, { "x-oauth-scopes": "read:user" }, { message: "x" }), { code: "unverified", detail: "ambiguous" }, "no accepted-scopes header: not proven");
  assert.deepEqual(out(403, { "x-oauth-scopes": "repo", "x-accepted-oauth-scopes": "notifications, repo" }, { message: "x" }), { code: "unverified", detail: "ambiguous" }, "repo is present: never Access denied");
  assert.deepEqual(out(200, {}, []), { code: "unverified", detail: "ambiguous" }, "an empty answer with no scope header proves nothing");
  assert.deepEqual(out(200, { "x-oauth-scopes": "read:user" }, []), { code: "unverified", detail: "ambiguous" });
  assert.deepEqual(out(401, {}, { message: "Bad credentials" }), { code: "unverified", detail: "ambiguous" });
  // SSO, policy, approval
  assert.deepEqual(out(403, { "x-github-sso": "required; url=https://github.com/orgs/acme/sso" }, { message: "x" }), { code: "unverified", detail: "sso" });
  assert.deepEqual(out(403, {}, { message: "The 'acme' organization forbids access via a personal access tokens (classic)" }), { code: "unverified", detail: "sso" });
  // temporary: rate limit, 5xx, network: nothing concluded
  assert.equal(out(403, { "x-ratelimit-remaining": "0" }, { message: "rate limit exceeded" }).temporary.status, "temporary");
  assert.equal(out(503, {}, {}).temporary.status, "temporary");
  assert.equal(notificationsOutcome({ failure: "network" }, { token: CLASSIC, kind: "classic" }).temporary.status, "temporary");
  // fine-grained never asks
  assert.deepEqual(notificationsOutcome(null, { token: FINE, kind: "fine-grained" }), { code: "unverified", detail: "fine-grained" });
});

test("a proven denial and the SSO case are recorded as codes only, with no sso flag from this check", async () => {
  const d = await run(CLASSIC, "", { status: 403, headers: { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" }, body: { message: "x" } }, { scopes: "read:user" });
  assert.equal(d.res.record.codes.notifications, "denied");
  assert.equal(d.res.record.detail, undefined);
  const s = await run(CLASSIC, "", { status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso" }, body: { message: "x" } });
  assert.equal(s.res.record.codes.notifications, "unverified");
  assert.deepEqual(s.res.record.detail, { notifications: "sso" });
  assert.equal(s.res.record.sso, undefined);
  for (const r of [d.res.record, s.res.record]) assert.doesNotMatch(JSON.stringify(r), /ghp_|github_pat_|acme|sam/);
});

test("a rate limit, a 5xx or a network error on the notifications read makes the whole test temporary: the previous record is kept", async () => {
  for (const notif of [{ status: 403, headers: { "x-ratelimit-remaining": "0" }, body: { message: "API rate limit exceeded" } }, { status: 502, body: {} }]) {
    const { res } = await run(CLASSIC, "", notif);
    assert.equal(res.outcome, "temporary");
    assert.equal(res.record, null);
  }
});

test("state: Missing permissions only from a proven denial while the notifications requirement is on", () => {
  const codes = (n) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked", notifications: n });
  const on = new Set([...requiredTypes(enabledFeatures({})), NOTIF_ID]);
  const off = requiredTypes(enabledFeatures({ ghntModules: { triage: false, reasonTags: false } }));
  assert.ok(on.has(NOTIF_ID) && !off.has(NOTIF_ID));
  const st = (n, req) => tokenState({ hasToken: true, rec: { at: 1, codes: codes(n) }, required: req });
  assert.equal(st("denied", on).state, "missing");
  assert.equal(st("denied", off).state, "works", "both modules off: Access denied is optional and changes nothing");
  assert.equal(st("unverified", on).state, "works");
  assert.equal(st("unverified", on).note, "", "Not verified here is not part of '{k} checks couldn't be verified'");
  assert.equal(st("available", on).state, "works");
  // notifications alone never makes a token Works
  const only = { at: 1, codes: { identity: "available", contents: "unverified", pulls: "unverified", issues: "unverified", projects: "unverified", actions: "unchecked", notifications: "available" } };
  assert.equal(tokenState({ hasToken: true, rec: only, required: new Set(["pulls", "issues", NOTIF_ID]) }).state, "cant-verify");
});

test("count rules: proven outcomes join {m}; Not verified and Not checked stay out", () => {
  const codes = (n, over = {}) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "available", ...over, ...(n ? { notifications: n } : {}) });
  assert.deepEqual(countOk({ at: 1, codes: codes("available") }), { ok: 6, total: 6 });
  assert.deepEqual(countOk({ at: 1, codes: codes("denied") }), { ok: 5, total: 6 });
  assert.deepEqual(countOk({ at: 1, codes: codes("unverified") }), { ok: 5, total: 5 });
  assert.deepEqual(countOk({ at: 1, codes: codes("unchecked") }), { ok: 5, total: 5 });
  assert.deepEqual(countOk({ at: 1, codes: codes(null) }), { ok: 5, total: 5 });
  assert.deepEqual(countOk({ at: 1, codes: { identity: "denied" } }), { ok: 0, total: 5 });
});

test("feature table: Beyond this page needs notifications while Triage or Tags is on", () => {
  const f = FEATURES.find((x) => x.id === "ghnt-beyond");
  assert.deepEqual(f.types, ["notifications"]);
  assert.deepEqual(TYPES.map((t) => t.id), ["contents", "pulls", "issues", "projects", "actions"], "the five permission types stay five");
  const flags = (triage, tags) => ({ ghntModules: { triage, reasonTags: tags } });
  assert.equal(isFeatureOn(f, {}), true);
  assert.equal(isFeatureOn(f, flags(true, false)), true);
  assert.equal(isFeatureOn(f, flags(false, true)), true);
  assert.equal(isFeatureOn(f, flags(false, false)), false);
});

test("warning: only a proven denial on the default token; release sentence from the version argument; steps name the notifications scope, never repo", () => {
  const features = enabledFeatures({ ghdgEnabled: false, ghsmEnabled: false, ghmiEnabled: false, ghhpEnabled: false, ghigEnabled: false, ghprtEnabled: false, ghlpsEnabled: false, ghqjEnabled: false, ghntModules: { reasonTags: false } });
  assert.deepEqual(features.map((x) => x.id), ["ghnt-beyond"]);
  const codes = (n) => ({ identity: "available", notifications: n });
  const w = warningFor({ features, version: "4.5.6", tokens: [{ id: "d", name: "Mine", isDefault: true, codes: codes("denied") }] });
  assert.equal(w.title, "Beyond this page needs a permission your token doesn't have");
  assert.equal(w.release, "Available from release 4.5.6: reading beyond the loaded page requires a classic token with the notifications permission. Everything else keeps working.");
  assert.equal(w.release, releaseSentence("4.5.6"));
  assert.deepEqual(w.perms.map((p) => p.name), ["Notifications"]);
  // never for an owner token, never "may need", never for other states
  assert.equal(warningFor({ features, version: "1", tokens: [{ id: "o", name: "Owner", isDefault: false, codes: codes("denied") }] }), null);
  assert.equal(warningFor({ features, version: "1", tokens: [{ id: "d", name: "Mine", isDefault: true, codes: { identity: "available" } }] }), null);
  for (const c of ["unverified", "available", "unchecked"]) assert.equal(warningFor({ features, version: "1", tokens: [{ id: "d", name: "Mine", isDefault: true, codes: codes(c) }] }), null);
});

test("release sentence uses the manifest version, never a literal", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(releaseSentence(manifest.version).startsWith(`Available from release ${manifest.version}:`));
  for (const f of ["token-requirements.js", "token-view.js", "token-test.js"]) {
    const src = readFileSync(new URL(`../../options/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\b\d+\.\d+\.\d+\b/, f);
  }
  const html = readFileSync(new URL("../../options/options.js", import.meta.url), "utf8");
  assert.match(html, /getManifest\(\)/);
});

// ---- the Notifications block as data ----

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const hour = 3_600_000;
const entry = (over) => ({ id: "d", isDefault: true, name: "", owner: "", token: CLASSIC, ...over });
const codes = (n, over = {}) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked", ...over, ...(n ? { notifications: n } : {}) });
const on = new Set(["contents", "pulls", "issues", "projects", NOTIF_ID]);
const off = new Set(["contents", "pulls", "issues", "projects"]);
const view = (over = {}) => notificationsView({ entries: [entry()], tests: {}, results: new Map(), runs: new Set(), required: on, version: manifest.version, now: NOW, ui: {}, ...over });
const rec = (n, extra = {}) => ({ at: NOW - 2 * hour, codes: codes(n), ...extra });

test("block: check outcomes and texts", () => {
  assert.equal(view().check.name, "Your full notifications list");
  assert.deepEqual([view().check.pill, view().check.text], ["Not checked", "Not tested yet. Nothing runs until you press Test."]);
  assert.deepEqual([view({ entries: [entry({ token: "" })] }).check.pill, view({ entries: [entry({ token: "" })] }).check.text], ["Not checked", "No default token is set. Only a default token can read this list."]);
  const t = view({ runs: new Set(["d"]) }).check;
  assert.deepEqual([t.pill, t.text], ["Testing…", "Read-only requests, started by you."]);
  const a = view({ tests: { d: rec("available") } }).check;
  assert.deepEqual([a.pill, a.text, a.age], ["Available", "This token can read your full notifications list.", "Tested 2 hours ago. GitHub may answer differently now."]);
  const d = view({ tests: { d: rec("denied") } }).check;
  assert.equal(d.pill, "Access denied");
  assert.equal(d.text, "GitHub says this token doesn't have the notifications permission. Triage and Tags keep working on the loaded notifications.");
  assert.equal(d.optional, false);
  assert.equal(d.readme, true);
  const dOff = view({ tests: { d: rec("denied") }, required: off }).check;
  assert.equal(dOff.pill, "Access denied");
  assert.equal(dOff.optional, true);
  assert.match(dOff.text, /doesn't make the token Missing permissions/);
  const fg = view({ entries: [entry({ token: FINE })], tests: { d: rec("unverified", { detail: { notifications: "fine-grained" } }) } }).check;
  assert.equal(fg.pill, "Not verified");
  assert.equal(fg.text, "Fine-grained tokens can't read this list: that's GitHub's rule. It's optional and you don't have to change anything.");
  assert.equal(fg.extra, "Only a classic default token can read this list. Replacing your default changes how every owner without its own token is read.");
  const amb = view({ tests: { d: rec("unverified", { detail: { notifications: "ambiguous" } }) } }).check;
  assert.equal(amb.text, "GitHub didn't let your default token read your full notifications list, and didn't say why. It's optional and you don't have to change anything.");
  assert.equal(amb.detailText, "Some organizations don't allow this, and some tokens can't do it. We can't tell which from here.");
  const sso = view({ tests: { d: rec("unverified", { detail: { notifications: "sso" } }) } }).check;
  assert.match(sso.text, /SSO/);
  assert.equal(sso.detailText, "");
  // a temporary error shows its text and keeps the stored record for the token row
  const temp = view({ tests: { d: rec("available") }, results: new Map([["d", { outcome: "temporary", message: "GitHub's rate limit was reached; it resets at 12:30." }]]) }).check;
  assert.deepEqual([temp.pill, temp.text], ["Not checked", "Not checked: GitHub's rate limit was reached; it resets at 12:30."]);
});

test("block: how-to is for classic or no default token, open on a proven denial, hidden for fine-grained and Available", () => {
  const steps = (v) => v.howTo && v.howTo.steps.map((s) => s.text);
  const denied = view({ tests: { d: rec("denied") } });
  assert.equal(denied.howTo.open, true);
  assert.equal(denied.howTo.summary, "How to add the notifications permission to your token");
  assert.deepEqual(steps(denied), [
    "On GitHub, open Developer settings → Tokens (classic) and choose the token you use here.",
    "Tick the notifications scope and save. Do not add repo: it gives far more than this needs. If the token already has repo, change nothing.",
    "If your organization uses SSO, follow the SSO note at the bottom of this section.",
    "Come back and press Test again.",
  ]);
  assert.equal(denied.howTo.steps[0].href, "https://github.com/settings/tokens");
  assert.equal(view().howTo.open, false);
  assert.equal(view({ entries: [entry({ token: "" })] }).howTo.open, false);
  assert.equal(view({ tests: { d: rec("available") } }).howTo, null);
  assert.equal(view({ entries: [entry({ token: FINE })], tests: { d: rec("unverified", { detail: { notifications: "fine-grained" } }) } }).howTo, null);
  assert.equal(view({ ui: { howOpen: true } }).howTo.open, true);
});

test("block: what each feature needs is readable with no token and no Test", () => {
  const v = view({ entries: [entry({ token: "" })], tests: {} });
  assert.deepEqual(v.needs.map((n) => n.title), ["Triage", "Tags", "“Why is this here?”", "Beyond this page"]);
  assert.equal(v.needs[0].text, "Sorts what GitHub shows on the page with no token. Review requests and mentions need a token that can read the owner's pull requests and issues. Data: the inbox page, then the pull request or issue.");
  assert.equal(v.needs[3].text, "Optional. Needs a classic default token with the notifications permission. Data: GitHub's notifications list, read with the default token, 50 per page.");
  assert.match(v.needs[2].text, /Opens from a tag and follows it/);
});

test("block: by owner lists owner tokens and the owner passed in the URL; Add token appears only for an owner with no token", () => {
  const ent = [entry(), { id: "w", isDefault: false, name: "Northwind bot", owner: "northwind", token: CLASSIC }];
  const v = view({ entries: ent, tests: { w: { at: NOW, codes: codes(null) } }, urlOwner: { owner: "acme", state: "denied" } });
  assert.equal(v.owners.length, 2);
  const [acme, nw] = v.owners;
  assert.equal(acme.owner, "acme");
  assert.equal(acme.addFor, "acme");
  assert.equal(acme.pill, "Access denied");
  assert.match(acme.line, /^acme — can't be read/);
  assert.equal(nw.addFor, null);
  assert.equal(nw.line, "northwind — Northwind bot (classic): reads its pull requests and issues. Not used for your notifications list");
  assert.equal(nw.pill, "Available");
  // an owner token that cannot read pull requests or issues
  const bad = view({ entries: ent, tests: { w: { at: NOW, codes: codes(null, { pulls: "denied" }) } } }).owners[0];
  assert.equal(bad.line, "northwind — Northwind bot (classic): can't read its pull requests or issues. Not used for your notifications list");
  assert.equal(bad.pill, "Access denied");
  // an owner who already has a token is not offered Add token
  assert.equal(view({ entries: ent, urlOwner: { owner: "Northwind", state: "denied" } }).owners.filter((o) => o.addFor).length, 0);
  // nothing in the URL and no owner token: no by-owner entries
  assert.deepEqual(view().owners, []);
});

test("block html: every field of the view is rendered, buttons and links are native", () => {
  const ent = [entry(), { id: "w", isDefault: false, name: "Northwind bot", owner: "northwind", token: CLASSIC }];
  const v = view({ entries: ent, tests: { d: rec("denied") }, urlOwner: { owner: "acme", state: "no-token" } });
  const html = notificationsHtml(v);
  for (const s of [v.check.name, v.check.pill, v.check.text, v.check.age, v.howTo.summary, ...v.howTo.steps.map((x) => (x.linkText ? x.text.slice(x.text.indexOf(x.linkText) + x.linkText.length) : x.text)), ...v.howTo.steps.map((x) => x.linkText).filter(Boolean), ...v.needs.map((n) => n.title), ...v.owners.map((o) => o.line.replace(" — can't be read", ""))]) {
    assert.ok(html.includes(escapeHtml(s)), `not rendered: ${s}`);
  }
  assert.match(html, /<button[^>]*data-act="add-owner"[^>]*data-owner="acme"[^>]*>Add token for acme<\/button>/);
  assert.match(html, /<details[^>]*class="nb-details/);
  assert.match(html, /href="https:\/\/github\.com\/cattanisimone\/gh-reloaded#optional-the-notifications-permission-classic-token"/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.doesNotMatch(html, /ghp_|github_pat_/);
});

test("copy rules: no text of the block recommends replacing a fine-grained default; restricted words stay in their places", () => {
  const states = [
    view(), view({ entries: [entry({ token: "" })] }), view({ runs: new Set(["d"]) }),
    ...["available", "denied", "unverified"].map((n) => view({ tests: { d: rec(n) } })),
    ...["fine-grained", "sso", "ambiguous"].map((d) => view({ entries: [entry({ token: d === "fine-grained" ? FINE : CLASSIC })], tests: { d: rec("unverified", { detail: { notifications: d } }) } })),
  ];
  const strings = (v) => [v.check.text, v.check.extra, v.check.age, v.check.detailText, ...v.needs.map((n) => n.text), ...v.owners.map((o) => o.line)].filter(Boolean);
  const fine = view({ entries: [entry({ token: FINE })], tests: { d: rec("unverified", { detail: { notifications: "fine-grained" } }) } });
  for (const s of states.flatMap(strings)) {
    assert.doesNotMatch(s, /switch to|replace your|should replace|use a classic token instead/i, s);
    assert.doesNotMatch(s, /\bcapabilit/i, s);
    assert.doesNotMatch(s, /organi[sz]ation (forbids|policy)/i, s);
  }
  // 'scope' and 'fine-grained' only where allowed: the fine-grained text, the how-to, the detail
  const allowed = new Set([fine.check.text, fine.check.extra]);
  for (const s of states.flatMap(strings).filter((x) => !allowed.has(x))) assert.doesNotMatch(s, /\bscope\b|fine-grained/i, s);
  // the three situations read differently
  const texts = [view({ entries: [entry({ token: "" })] }).check.text, view({ tests: { d: rec("denied") } }).check.text, view({ tests: { d: rec("unverified", { detail: { notifications: "ambiguous" } }) } }).check.text];
  assert.equal(new Set(texts).size, 3);
  // the fine-grained view offers no how-to and no Missing permissions
  assert.equal(fine.howTo, null);
});

test("tokenView: the default row reads Missing permissions with 5 of 6 OK; the warning carries the release sentence and no steps toward repo", () => {
  const features = enabledFeatures({});
  const required = requiredTypes(features);
  const entries = [entry({ name: "Personal" })];
  const tests = { d: { at: NOW, codes: codes("denied", { actions: "available" }) } };
  const v = tokenView({ entries, tests, results: new Map(), runs: new Set(), required, features, version: "7.7.7", ui: { laterHidden: false, stepsKey: null, editingId: null, diags: new Set() } });
  assert.equal(v.rows[0].label, "Missing permissions");
  assert.match(v.rows[0].last, /5 of 6 OK$/);
  assert.equal(v.warning.title, "Beyond this page needs a permission your token doesn't have");
  assert.ok(v.warning.body.startsWith("Available from release 7.7.7: reading beyond the loaded page requires a classic token with the notifications permission. Everything else keeps working."));
  assert.deepEqual(v.warning.perms.map((p) => p.name), ["Notifications"]);
  assert.ok(v.warning.steps.rest[0].includes("notifications"));
  assert.ok(!/\brepo\b/.test(v.warning.steps.rest[0]));
  // with Triage and Tags off the same record is optional: no Missing, no warning
  const quiet = enabledFeatures({ ghntModules: { triage: false, reasonTags: false } });
  const q = tokenView({ entries, tests, results: new Map(), runs: new Set(), required: requiredTypes(quiet), features: quiet, version: "7.7.7", ui: { laterHidden: false, stepsKey: null, editingId: null, diags: new Set() } });
  assert.equal(q.rows[0].label, "Works");
  assert.equal(q.warning, null);
});

test("a Test result names a proven notifications denial in its summary and advice, so the row's Missing permissions is explained", () => {
  const codes = { identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "available", notifications: "denied" };
  const line = (status) => ({ status, reason: "", hint: "" });
  const lines = Object.fromEntries(Object.keys(codes).map((k) => [k, line(k === "notifications" ? "denied" : "available")]));
  const r = { outcome: "done", record: { at: Date.now(), codes }, lines, message: "" };
  const on = resultView({ name: "d", isDefault: true }, r, { required: new Set(["pulls", "issues", NOTIF_ID]) });
  assert.match(on.summary, /Missing permissions: Notifications\./);
  assert.ok(on.advice.some((a) => a.lead === "Notifications:"));
  const off = resultView({ name: "d", isDefault: true }, r, { required: new Set(["pulls", "issues"]) });
  assert.doesNotMatch(off.summary, /Missing permissions/);
  assert.equal(off.advice.length, 0);
});
