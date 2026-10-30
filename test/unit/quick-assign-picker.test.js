// Unit tests for features/quick-assign/picker.js: login from a profile link,
// exact option lookup, the toggle decision and the before/after comparison.
// A content-script global (no ES module), so it is evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects built in the vm context have another prototype
import { loadGlobals } from "../support/load-global.js";

const { loginFromHref, findOption, decideToggle, compareAssignees } = loadGlobals(["features/quick-assign/picker.js"]).GHQA_PICKER;

test("loginFromHref accepts only a plain /<login> link", () => {
  assert.equal(loginFromHref("/alex-dev"), "alex-dev");
  assert.equal(loginFromHref("/alex-dev/"), "alex-dev");
  assert.equal(loginFromHref("https://github.com/alex-dev"), "alex-dev");
  assert.equal(loginFromHref("/jo_acme"), "jo_acme"); // Enterprise Managed User
  for (const bad of ["/apps/build-bot", "/acme/web", "/orgs/acme/people", "", null, "/", "/-bad", "/a b", "/_bad", "/bad_", "https://example.com/alex"]) {
    assert.equal(loginFromHref(bad), null, String(bad));
  }
});

test("findOption matches the exact login, never a prefix or the full name", () => {
  const options = [{ label: "alex", selected: false }, { label: "alex-dev", selected: true }, { label: "Alexandra Dev", selected: false }];
  assert.equal(findOption(options, "alex-dev"), options[1]);
  assert.equal(findOption(options, "alex"), options[0]);
  assert.equal(findOption(options, "ALEX-DEV"), options[1]);
  assert.equal(findOption(options, "ale"), null);
  assert.equal(findOption(options, "Alexandra"), null);
});

test("findOption refuses an ambiguous match", () => {
  assert.equal(findOption([{ label: "sam", selected: false }, { label: "sam", selected: true }], "sam"), null);
});

test("decideToggle clicks only an option in the opposite state", () => {
  assert.equal(decideToggle("add", { selected: false }), "click");
  assert.equal(decideToggle("add", { selected: true }), "already");
  assert.equal(decideToggle("remove", { selected: true }), "click");
  assert.equal(decideToggle("remove", { selected: false }), "already");
  assert.equal(decideToggle("add", null), "missing");
  assert.equal(decideToggle("other", { selected: true }), "missing");
});

test("compareAssignees confirms an add and an remove that leave the others alone", () => {
  assert.deepEqual(plain(compareAssignees(["alex-dev"], ["alex-dev", "mira"], "mira", "add")), { status: "confirmed", removed: [] });
  assert.deepEqual(plain(compareAssignees(["alex-dev", "mira"], ["alex-dev"], "mira", "remove")), { status: "confirmed", removed: [] });
  assert.equal(compareAssignees([], ["mira"], "MIRA", "add").status, "confirmed");
});

test("compareAssignees: no change in the target is 'unchanged'", () => {
  assert.equal(compareAssignees(["alex-dev"], ["alex-dev"], "mira", "add").status, "unchanged");
  assert.equal(compareAssignees(["alex-dev", "mira"], ["alex-dev", "mira"], "mira", "remove").status, "unchanged");
});

test("compareAssignees flags unexpected removals, even when the target is right", () => {
  const r = compareAssignees(["alex-dev", "sam"], ["mira"], "mira", "add");
  assert.deepEqual(plain(r), { status: "unexpected", removed: ["alex-dev", "sam"] });
  assert.equal(compareAssignees(["alex-dev", "mira"], [], "mira", "remove").status, "unexpected");
});

test("compareAssignees ignores somebody else's concurrent addition", () => {
  assert.equal(compareAssignees(["alex-dev"], ["alex-dev", "mira", "zed"], "mira", "add").status, "confirmed");
});
