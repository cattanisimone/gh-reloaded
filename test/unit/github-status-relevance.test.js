// Unit tests for features/github-status/relevance.js: the dot state, the
// route -> component matrix, wide incidents, notices and dismissals. A
// content-script global (no ES module), so it is evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(readFileSync("features/github-status/relevance.js", "utf8"), context);
const R = context.GHGS_RELEVANCE;

const NOW = 10_000_000;
const snap = (over = {}) => ({ indicator: "none", description: "", updatedAt: "", components: [], incidents: [], maintenances: [], ...over });
const inc = (over = {}) => ({ id: "i1", name: "Incident", status: "investigating", impact: "minor", updatedAt: "t1", url: "", components: ["Actions"], latest: null, ...over });
const comps = (p) => [...R.componentsForPath(p)].sort();

test("dot state per indicator", () => {
  const v = (s) => ({ snapshot: s, fetchedAt: NOW - 1000 });
  assert.equal(R.dotState(v(snap()), NOW), "ok");
  assert.equal(R.dotState(v(snap({ indicator: "minor" })), NOW), "minor");
  assert.equal(R.dotState(v(snap({ indicator: "major" })), NOW), "major");
  assert.equal(R.dotState(v(snap({ indicator: "critical" })), NOW), "critical");
  assert.equal(R.dotState(v(snap({ maintenances: [inc()] })), NOW), "maintenance");
});

test("dot state takes the worst of the indicator, the open incidents and the components", () => {
  const v = (s) => ({ snapshot: s, fetchedAt: NOW - 1000 });
  const comp = (status) => [{ name: "Actions", status }];
  assert.equal(R.dotState(v(snap({ incidents: [inc({ impact: "critical" })] })), NOW), "critical");
  assert.equal(R.dotState(v(snap({ incidents: [inc({ impact: "minor" })] })), NOW), "minor");
  assert.equal(R.dotState(v(snap({ incidents: [inc({ impact: "major" }), inc({ id: "i2", impact: "minor" })] })), NOW), "major");
  assert.equal(R.dotState(v(snap({ incidents: [inc({ impact: "none" })] })), NOW), "ok");
  assert.equal(R.dotState(v(snap({ components: comp("partial_outage") })), NOW), "minor");
  assert.equal(R.dotState(v(snap({ components: comp("degraded_performance") })), NOW), "minor");
  assert.equal(R.dotState(v(snap({ components: comp("major_outage") })), NOW), "major");
  assert.equal(R.dotState(v(snap({ components: comp("operational") })), NOW), "ok");
  assert.equal(R.dotState(v(snap({ indicator: "major", incidents: [inc({ impact: "minor" })] })), NOW), "major");
  assert.equal(R.dotState(v(snap({ indicator: "minor", incidents: [inc({ impact: "critical" })] })), NOW), "critical");
  assert.equal(R.dotState(v(snap({ maintenances: [inc()], incidents: [inc({ impact: "major" })] })), NOW), "major");
  assert.equal(R.dotState(v(snap({ maintenances: [inc()], incidents: [inc({ impact: "minor" })] })), NOW), "minor");
  assert.equal(R.dotState(v(snap({ maintenances: [inc()] })), NOW), "maintenance");
  assert.equal(R.dotState({ snapshot: snap({ incidents: [inc({ impact: "critical" })] }), fetchedAt: NOW - 16 * 60_000 }, NOW), "unknown");
});

test("unknown when never fetched, and older than 15 min", () => {
  assert.equal(R.dotState({ snapshot: null, fetchedAt: 0 }, NOW), "unknown");
  assert.equal(R.dotState(null, NOW), "unknown");
  assert.equal(R.dotState({ snapshot: snap(), fetchedAt: NOW - (14 * 60 + 59) * 1000 }, NOW), "ok");
  assert.equal(R.dotState({ snapshot: snap(), fetchedAt: NOW - (15 * 60 + 1) * 1000 }, NOW), "unknown");
  assert.equal(R.dotState({ snapshot: snap(), fetchedAt: NOW - 1000, error: true }, NOW), "unknown");
  assert.equal(R.dotState({ snapshot: snap({ indicator: "major" }), fetchedAt: NOW - 1000, error: true }, NOW), "unknown");
});

test("route matrix", () => {
  assert.deepEqual(comps("/acme/web/actions"), ["actions"]);
  assert.deepEqual(comps("/acme/web/actions/runs/12"), ["actions"]);
  assert.deepEqual(comps("/acme/web/runs/12"), ["actions"]);
  assert.deepEqual(comps("/acme/web/pull/7"), ["api requests", "pull requests"]);
  assert.deepEqual(comps("/acme/web/pull/7/checks"), ["actions", "api requests", "pull requests"]);
  assert.deepEqual(comps("/acme/web/pulls"), ["api requests", "pull requests"]);
  assert.deepEqual(comps("/pulls"), ["api requests", "pull requests"]);
  assert.deepEqual(comps("/acme/web/issues/3"), ["api requests", "issues"]);
  assert.deepEqual(comps("/issues"), ["api requests", "issues"]);
  assert.deepEqual(comps("/orgs/acme/projects/4"), ["api requests", "issues"]);
  assert.deepEqual(comps("/users/mira/projects/4/views/1"), ["api requests", "issues"]);
  assert.deepEqual(comps("/acme/web/packages"), ["packages"]);
  assert.deepEqual(comps("/acme/web/settings/hooks"), ["webhooks"]);
  assert.deepEqual(comps("/acme/web/settings/pages"), ["pages"]);
  assert.deepEqual(comps("/codespaces"), ["codespaces"]);
  assert.deepEqual(comps("/acme/web"), ["git operations"]);
  for (const p of ["tree/main", "blob/main/a.js", "commits/main", "commit/abc", "compare/a...b", "branches", "blame/main/a.js"]) {
    assert.deepEqual(comps(`/acme/web/${p}`), ["git operations"], p);
  }
  assert.deepEqual(comps("/acme/web/blob/main/index.html"), ["api requests", "git operations"]);
  assert.deepEqual(comps("/acme/web/settings/secrets"), []);
  assert.deepEqual(comps("/"), []);
  assert.deepEqual(comps("/settings/profile"), []);
});

test("wide: critical, or 3+ core components", () => {
  assert.equal(R.isWide(inc({ impact: "critical", components: ["Copilot"] })), true);
  assert.equal(R.isWide(inc({ components: ["Git Operations", "Issues", "Actions"] })), true);
  assert.equal(R.isWide(inc({ components: ["Git Operations", "Issues", "Copilot", "Pages"] })), false);
});

test("a Copilot incident on a PR page: no notice", () => {
  const s = snap({ indicator: "minor", incidents: [inc({ components: ["Copilot"] })] });
  assert.equal(R.noticeFor(s, "/acme/web/pull/7", {}), null);
});

test("an Actions incident: notice on Actions pages and PR checks, not on issues", () => {
  const s = snap({ indicator: "minor", incidents: [inc()] });
  assert.equal(R.noticeFor(s, "/acme/web/actions", {}).id, "i1");
  assert.equal(R.noticeFor(s, "/acme/web/pull/7/checks", {}).id, "i1");
  assert.equal(R.noticeFor(s, "/acme/web/issues/3", {}), null);
});

test("a wide incident shows everywhere; impact none and maintenances never", () => {
  const wide = snap({ incidents: [inc({ impact: "critical", components: ["Copilot"] })] });
  assert.equal(R.noticeFor(wide, "/settings/profile", {}).id, "i1");
  assert.equal(R.noticeFor(snap({ incidents: [inc({ impact: "none" })] }), "/acme/web/actions", {}), null);
  assert.equal(R.noticeFor(snap({ maintenances: [inc()] }), "/acme/web/actions", {}), null);
  assert.equal(R.noticeFor(null, "/", {}), null);
});

test("worst relevant incident wins", () => {
  const s = snap({ incidents: [inc({ id: "a", impact: "minor" }), inc({ id: "b", impact: "major" })] });
  assert.equal(R.noticeFor(s, "/acme/web/actions", {}).id, "b");
});

test("dismissal holds for the same update and lapses on a newer one", () => {
  const s = snap({ incidents: [inc()] });
  assert.equal(R.noticeFor(s, "/acme/web/actions", { i1: "t1" }), null);
  const updated = snap({ incidents: [inc({ updatedAt: "t2" })] });
  assert.equal(R.noticeFor(updated, "/acme/web/actions", { i1: "t1" }).id, "i1");
});

test("resolved incidents are pruned from the dismissals", () => {
  assert.deepEqual({ ...R.pruneDismissed({ i1: "t1", gone: "t0" }, snap({ incidents: [inc()] })) }, { i1: "t1" });
  assert.deepEqual({ ...R.pruneDismissed({ i1: "t1" }, null) }, {});
});

test("pill text: component and its status, or a generic label when wide", () => {
  const s = snap({ indicator: "minor", components: [{ name: "Actions", status: "degraded_performance" }], incidents: [inc()] });
  assert.deepEqual({ ...R.pillText(s.incidents[0], s, "/acme/web/actions") }, { name: "Actions", detail: "degraded performance" });
  const wide = inc({ impact: "critical", components: ["Git Operations", "Issues", "Actions"] });
  assert.deepEqual({ ...R.pillText(wide, snap({ incidents: [wide] }), "/settings/profile") }, { name: "GitHub", detail: "critical incident" });
});

test("owner names that are Object properties are ordinary owners", () => {
  for (const owner of ["constructor", "toString", "hasOwnProperty", "__proto__"]) assert.deepEqual(comps(`/${owner}/web/actions`), ["actions"], owner);
});

test("a maintenance page indicator is amber even before the list is read", () => {
  assert.equal(R.dotState({ snapshot: snap({ indicator: "maintenance" }), fetchedAt: NOW - 1000 }, NOW), "maintenance");
});

test("global two-segment pages are not repositories", () => {
  for (const p of ["/trending/python", "/stars/mira", "/account/billing", "/collections/choosing-a-license"]) assert.deepEqual(comps(p), [], p);
});
