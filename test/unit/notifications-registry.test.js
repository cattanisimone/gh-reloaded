// The module registry: independent switches, availability, and the Native
// inbox override that stops every module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHNT_REGISTRY: R } = loadGlobals(["features/notifications/registry.js"]);

function setup(ids = ["a", "b", "c"]) {
  const reg = R.createRegistry();
  const log = [];
  for (const id of ids) reg.register({ id, start: () => log.push(`+${id}`), stop: () => log.push(`-${id}`) });
  return { reg, log };
}

test("nothing starts until the engine runs and a module is enabled", () => {
  const { reg, log } = setup();
  assert.equal(reg.hasActive(), false);
  reg.setConfig({ modules: { a: true } });
  assert.equal(reg.hasActive(), true);
  assert.deepEqual(log, []);
  reg.setRunning(true);
  assert.deepEqual(log, ["+a"]);
});

test("all 2^3 combinations of enabled modules, with and without Native inbox", () => {
  for (let mask = 0; mask < 8; mask++) {
    for (const nativeInbox of [false, true]) {
      const { reg, log } = setup();
      const modules = { a: !!(mask & 1), b: !!(mask & 2), c: !!(mask & 4) };
      reg.setRunning(true);
      reg.setConfig({ modules, nativeInbox });
      const expected = nativeInbox ? [] : ["a", "b", "c"].filter((id) => modules[id]);
      assert.deepEqual([...reg.list().filter((m) => m.started).map((m) => m.id)], expected, `mask ${mask} native ${nativeInbox}`);
      assert.equal(reg.hasActive(), expected.length > 0);
    }
  }
});

test("Native inbox stops every started module, switching it off restarts them", () => {
  const { reg, log } = setup();
  reg.setRunning(true);
  reg.setConfig({ modules: { a: true, b: true } });
  log.length = 0;
  reg.setConfig({ modules: { a: true, b: true }, nativeInbox: true });
  assert.deepEqual(log.sort(), ["-a", "-b"]);
  log.length = 0;
  reg.setConfig({ modules: { a: true, b: true }, nativeInbox: false });
  assert.deepEqual(log.sort(), ["+a", "+b"]);
});

test("an unavailable module is not started, and availability changes are honoured", () => {
  const reg = R.createRegistry();
  const log = [];
  reg.register({ id: "x", availability: "unavailable", start: () => log.push("+x"), stop: () => log.push("-x") });
  reg.setRunning(true);
  reg.setConfig({ modules: { x: true } });
  assert.deepEqual(log, []);
  assert.equal(reg.hasActive(), false);
  reg.setAvailability("x", "available");
  assert.deepEqual(log, ["+x"]);
});

test("stopping the engine stops modules; a throwing module does not break the others", () => {
  const reg = R.createRegistry();
  const log = [];
  reg.register({ id: "bad", start() { throw new Error("boom"); } });
  reg.register({ id: "ok", start: () => log.push("+ok"), stop: () => log.push("-ok") });
  reg.setConfig({ modules: { bad: true, ok: true } });
  reg.setRunning(true);
  assert.deepEqual(log, ["+ok"]);
  reg.setRunning(false);
  assert.deepEqual(log, ["+ok", "-ok"]);
});

test("a module without an id is refused", () => {
  assert.throws(() => R.createRegistry().register({}), /id/);
});

test("unregistering a started module stops it, an unstarted one is not stopped", () => {
  const { reg, log } = setup();
  const off = reg.register({ id: "d", start: () => log.push("+d"), stop: () => log.push("-d") });
  reg.setRunning(true);
  reg.setConfig({ modules: { d: true } });
  assert.deepEqual(log, ["+d"]);
  off();
  assert.deepEqual(log, ["+d", "-d"]);
  assert.equal(reg.list().some((m) => m.id === "d"), false);
  const off2 = reg.register({ id: "e", stop: () => log.push("-e") });
  off2();
  assert.deepEqual(log, ["+d", "-d"]);
});
