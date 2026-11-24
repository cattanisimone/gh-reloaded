import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { COMMAND_NAME, DESC_REMEMBERS, DESC_NO_TOKEN, isMac, formatShortcut, shortcutOptions, describingLine, rowView } from "../../options/quick-jump-model.js";

test("the command name matches the manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(manifest.commands).includes(COMMAND_NAME));
});

test("isMac reads the platform string", () => {
  assert.equal(isMac("MacIntel"), true);
  assert.equal(isMac("macOS"), true);
  assert.equal(isMac("Win32"), false);
  assert.equal(isMac("Linux x86_64"), false);
  assert.equal(isMac(undefined), false);
});

test("formatShortcut: Windows and Linux keep Chrome's own words", () => {
  assert.equal(formatShortcut("Alt+Shift+K", false), "Alt+Shift+K");
  assert.equal(formatShortcut("Ctrl+Shift+k", false), "Ctrl+Shift+K");
  assert.equal(formatShortcut("", false), "");
  assert.equal(formatShortcut(undefined, false), "");
});

test("formatShortcut: Mac uses symbols in the standard order", () => {
  assert.equal(formatShortcut("MacCtrl+Shift+K", true), "⌃⇧K");
  assert.equal(formatShortcut("Alt+Shift+K", true), "⌥⇧K");
  assert.equal(formatShortcut("Shift+Alt+Command+K", true), "⌥⇧⌘K");
  assert.equal(formatShortcut("Ctrl+Shift+K", true), "⇧⌘K");
  assert.equal(formatShortcut("⌃⇧K", true), "⌃⇧K");
  assert.equal(formatShortcut("", true), "");
});

test("select labels: full and short forms, Windows and Linux", () => {
  const [browser, cmdk] = shortcutOptions({ mac: false, shortcut: "Alt+Shift+K" });
  assert.deepEqual(browser, { value: "browser", full: "Alt+Shift+K", short: "Alt+Shift+K" });
  assert.deepEqual(cmdk, { value: "cmdk", full: "Ctrl+K — replaces GitHub's command palette", short: "Ctrl+K" });
});

test("select labels: Mac", () => {
  const [browser, cmdk] = shortcutOptions({ mac: true, shortcut: "MacCtrl+Shift+K" });
  assert.equal(browser.full, "⌃⇧K");
  assert.deepEqual(cmdk, { value: "cmdk", full: "⌘K — replaces GitHub's command palette", short: "⌘K" });
});

test("an unassigned shortcut reads Browser shortcut (not set), short form Not set", () => {
  for (const mac of [true, false]) {
    const [browser] = shortcutOptions({ mac, shortcut: "" });
    assert.deepEqual(browser, { value: "browser", full: "Browser shortcut (not set)", short: "Not set" });
  }
});

test("describing line per value and platform", () => {
  assert.equal(describingLine({ value: "browser", mac: false, shortcut: "Alt+Shift+K" }), "Works on every GitHub page, outside text fields. Ctrl+K stays GitHub's.");
  assert.equal(describingLine({ value: "browser", mac: true, shortcut: "Alt+Shift+K" }), "Works on every GitHub page, outside text fields. ⌘K stays GitHub's.");
  assert.equal(
    describingLine({ value: "cmdk", mac: false, shortcut: "Alt+Shift+K" }),
    "Outside text fields, Ctrl+K opens Quick jump instead of GitHub's command palette, which still opens with Ctrl+Alt+K. In comment boxes and editors Ctrl+K stays GitHub's: it inserts a link. Alt+Shift+K keeps working too.",
  );
  assert.equal(
    describingLine({ value: "cmdk", mac: true, shortcut: "Alt+Shift+K" }),
    "Outside text fields, ⌘K opens Quick jump instead of GitHub's command palette, which still opens with ⌘⌥K. In comment boxes and editors ⌘K stays GitHub's: it inserts a link. ⌥⇧K keeps working too.",
  );
});

test("with the browser shortcut unassigned the ⌘K line does not claim it keeps working", () => {
  const line = describingLine({ value: "cmdk", mac: false, shortcut: "" });
  assert.ok(!line.includes("keeps working"));
  assert.ok(line.endsWith("it inserts a link."));
});

test("rowView: no token is off, disabled, described, without controls, whatever was stored", () => {
  const v = rowView({ hasToken: false, stored: { ghqjEnabled: true, ghqjShortcut: "cmdk" }, mac: false, shortcut: "Alt+Shift+K" });
  assert.equal(v.checked, false);
  assert.equal(v.disabled, true);
  assert.equal(v.showControls, false);
  assert.equal(v.description, DESC_NO_TOKEN);
  assert.equal(DESC_NO_TOKEN, "Needs a GitHub token. Add one in GitHub tokens.");
});

test("rowView: with a token it is off until switched on, then restores the last choice", () => {
  let v = rowView({ hasToken: true, stored: {}, mac: false, shortcut: "Alt+Shift+K" });
  assert.deepEqual([v.checked, v.disabled, v.showControls, v.choice, v.unassigned], [false, false, false, "browser", false]);
  assert.equal(v.description, DESC_REMEMBERS);
  v = rowView({ hasToken: true, stored: { ghqjEnabled: true }, mac: false, shortcut: "Alt+Shift+K" });
  assert.deepEqual([v.checked, v.disabled, v.showControls], [true, false, true]);
  v = rowView({ hasToken: true, stored: { ghqjEnabled: false, ghqjShortcut: "cmdk" }, mac: false, shortcut: "" });
  assert.deepEqual([v.checked, v.showControls, v.choice, v.unassigned], [false, false, "cmdk", true]);
  v = rowView({ hasToken: true, stored: { ghqjShortcut: "nonsense" }, mac: false, shortcut: "Alt+Shift+K" });
  assert.equal(v.choice, "browser");
  assert.equal(v.line, describingLine({ value: "browser", mac: false, shortcut: "Alt+Shift+K" }));
});
