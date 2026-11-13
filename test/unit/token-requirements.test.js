import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURES, TYPES, requiredTypes, enabledFeatures, isFeatureOn, warningFor } from "../../options/token-requirements.js";

test("feature table is pinned", () => {
  const table = Object.fromEntries(FEATURES.map((f) => [f.id, f.types.join("+")]));
  assert.deepEqual(table, {
    ghdg: "issues+projects", ghbd: "issues", ghsm: "issues+projects", ghhp: "contents", ghig: "contents",
    ghmi: "issues+projects", ghprt: "pulls", ghqa: "issues", ghlps: "pulls+issues", "ghnt-reason-tags": "pulls+issues",
  });
  assert.deepEqual(TYPES.map((t) => t.id), ["contents", "pulls", "issues", "projects", "actions"]);
});

test("switch defaults: Board arrows and Quick assignment are opt-in, reason tags default on", () => {
  const ids = (s) => enabledFeatures(s).map((f) => f.id);
  assert.ok(!ids({}).includes("ghbd") && !ids({}).includes("ghqa"));
  assert.ok(ids({}).includes("ghnt-reason-tags"));
  assert.ok(ids({ ghbdEnabled: true }).includes("ghbd"));
  assert.ok(!ids({ ghntModules: { reasonTags: false } }).includes("ghnt-reason-tags"));
  assert.equal(isFeatureOn(FEATURES[0], { ghdgEnabled: false }), false);
});

test("required types come from the features that are on; actions is never required", () => {
  assert.deepEqual([...requiredTypes(enabledFeatures({}))].sort(), ["contents", "issues", "projects", "pulls"]);
  assert.deepEqual([...requiredTypes([])], []);
});

test("warning names the feature, the tokens and the installed version", () => {
  const features = enabledFeatures({ ghdgEnabled: false, ghsmEnabled: false, ghmiEnabled: false, ghhpEnabled: false, ghigEnabled: false, ghprtEnabled: false, ghntModules: { reasonTags: false } });
  assert.deepEqual(features.map((f) => f.id), ["ghlps"]);
  const w = warningFor({ features, version: "1.7.0", tokens: [{ id: "a", name: "Work", codes: { pulls: "denied", issues: "available" } }, { id: "b", name: "Personal", codes: { pulls: "available", issues: "available" } }] });
  assert.equal(w.title, "Linked PR status needs a permission your token doesn't have");
  assert.deepEqual(w.tokens, ["Work"]);
  assert.equal(w.maybe, false);
  assert.deepEqual(w.details, ["GH Reloaded 1.7.0 uses Pull requests (Read-only) for Linked PR status: to show the status of linked pull requests."]);
});

test("no denial: no warning; a type with no code in a tested record is 'may need'; untested tokens say nothing", () => {
  const features = enabledFeatures({});
  const full = { identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked" };
  assert.equal(warningFor({ features, version: "1", tokens: [{ id: "a", name: "A", codes: full }] }), null);
  assert.equal(warningFor({ features, version: "1", tokens: [{ id: "a", name: "A", codes: null }] }), null);
  const { projects, ...older } = full;
  const w = warningFor({ features, version: "1", tokens: [{ id: "a", name: "A", codes: older }] });
  assert.equal(w.maybe, true);
  assert.match(w.title, /may need a permission/);
});

test("no hand-written release number in the registry", () => {
  const src = readFileSync(new URL("../../options/token-requirements.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\b\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(src, /since|introduced in/i);
});
