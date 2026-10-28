// The panel's preferences contract: defaults, one layout, per-id writes, the
// 2^3 x 3 layouts x native table, and what Restore defaults removes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_PREFS: P, GHNT_REGISTRY: R } = loadGlobals(["features/notifications/prefs.js", "features/notifications/registry.js"]);

const plain = (v) => JSON.parse(JSON.stringify(v));

test("empty storage: every module on, Integrated navigation, native inbox off", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(P.normalize({}))), { modules: { triage: true, reasonTags: true, reasonWhy: true }, nativeInbox: false, layout: "integrated" });
});

test("normalize: one layout, anything invalid reads as Integrated navigation", () => {
  for (const bad of [undefined, null, "", "Quickbar", "list", 3, {}, ["quickbar"]]) assert.equal(P.normalize({ ghntLayout: bad }).layout, "integrated");
  for (const l of ["integrated", "quickbar", "grouped"]) assert.equal(P.normalize({ ghntLayout: l }).layout, l);
});

test("normalize: non-boolean switches fall back to the default, unknown ids are kept", () => {
  const n = P.normalize({ ghntModules: { triage: "yes", reasonTags: false, other: true }, ghntNativeInbox: "true" });
  assert.equal(n.modules.triage, true);
  assert.equal(n.modules.reasonTags, false);
  assert.equal(n.modules.other, true);
  assert.equal(n.nativeInbox, false);
  assert.deepEqual(JSON.parse(JSON.stringify(P.normalize({ ghntModules: [1] }).modules)), { triage: true, reasonTags: true, reasonWhy: true });
});

test("each switch writes only its own id (read-merge-write)", () => {
  const stored = { reasonTags: false, other: true };
  assert.deepEqual(plain(P.patchModule(stored, "triage", false)), { reasonTags: false, other: true, triage: false });
  assert.deepEqual(stored, { reasonTags: false, other: true });
  assert.deepEqual(plain(P.patchModule(undefined, "reasonWhy", true)), { reasonWhy: true });
  assert.deepEqual(plain(P.patchModule(null, "reasonWhy", "x")), { reasonWhy: false });
});

test("Restore defaults removes exactly the three panel keys, never the mention window", () => {
  assert.deepEqual(plain(P.RESET_KEYS).sort(), ["ghntLayout", "ghntModules", "ghntNativeInbox"]);
});

test("all 2^3 switches x 3 layouts x native inbox: running modules and the stored layout", () => {
  const ids = ["triage", "reasonTags", "reasonWhy"];
  for (let mask = 0; mask < 8; mask++) {
    for (const layout of ["integrated", "quickbar", "grouped"]) {
      for (const nativeInbox of [false, true]) {
        const reg = R.createRegistry();
        for (const id of ids) reg.register({ id, defaultOn: true, layouts: id === "triage" ? ["integrated", "quickbar", "grouped"] : [] });
        reg.setRunning(true);
        const modules = Object.fromEntries(ids.map((id, i) => [id, !!(mask & (1 << i))]));
        reg.setConfig(P.normalize({ ghntModules: modules, ghntNativeInbox: nativeInbox, ghntLayout: layout }));
        const running = reg.list().filter((m) => m.started).map((m) => m.id);
        assert.deepEqual(plain(running), nativeInbox ? [] : ids.filter((id) => modules[id]), `mask ${mask} ${layout} native ${nativeInbox}`);
        assert.equal(reg.layout(), layout, "the stored layout is exposed even when it changes nothing");
      }
    }
  }
});

test("a module's own default applies with nothing stored, a stored switch wins", () => {
  const reg = R.createRegistry();
  reg.register({ id: "a", defaultOn: true });
  reg.register({ id: "b" });
  reg.setRunning(true);
  reg.setConfig({});
  assert.deepEqual(plain(reg.list().map((m) => [m.id, m.started])), [["a", true], ["b", false]]);
  reg.setConfig({ modules: { a: false, b: true } });
  assert.deepEqual(plain(reg.list().map((m) => [m.id, m.started])), [["a", false], ["b", true]]);
  assert.equal(reg.layout(), "integrated");
});

test("availability keeps its reason, and a module declares its layouts", () => {
  const reg = R.createRegistry();
  reg.register({ id: "t", availability: "unavailable", reason: "later", layouts: ["quickbar"] });
  assert.deepEqual(JSON.parse(JSON.stringify(reg.list()[0])), { id: "t", label: "t", availability: "unavailable", reason: "later", layouts: ["quickbar"], enabled: false, started: false });
  reg.setAvailability("t", "available");
  assert.equal(reg.list()[0].reason, "");
});

test("layout copy budget: one-line descriptions and two-word-per-line titles fit the cards", () => {
  for (const l of prefs.LAYOUTS) {
    assert.ok(l.description.length <= 18, `${l.id} description is ${l.description.length} characters`);
    assert.ok(l.label.split(" ").length <= 2, `${l.id} title has more than two words`);
  }
});
