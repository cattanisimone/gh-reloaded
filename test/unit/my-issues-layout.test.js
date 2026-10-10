// Unit tests for features/my-issues/layout.js: the pure helpers behind the
// Project tiles (time since update, repo#number labels, the per-Status cap,
// distribution-bar widths, distinct issue count). It's a content-script
// global (no ES module), so it's evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(
  readFileSync(new URL("../../features/my-issues/layout.js", import.meta.url), "utf8"),
  context
);
const { relativeTime, refChips, typeChip, capStatus, barSegments, distinctCount } = context.GHMI_LAYOUT;
// Values built inside the vm context carry its own Array prototype; a JSON
// round trip lets deepEqual compare them with plain literals.
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600e3;
const D = 24 * H;

test("relativeTime formats 1h, 2d, 3w, 5mo and clamps the future to 0m", () => {
  assert.equal(relativeTime(ago(H), NOW), "1h");
  assert.equal(relativeTime(ago(2 * D), NOW), "2d");
  assert.equal(relativeTime(ago(21 * D), NOW), "3w");
  assert.equal(relativeTime(ago(150 * D), NOW), "5mo");
  assert.equal(relativeTime(ago(30 * 60e3), NOW), "30m");
  assert.equal(relativeTime(ago(400 * D), NOW), "1y");
  assert.equal(relativeTime(new Date(NOW + 5 * H).toISOString(), NOW), "0m");
  assert.equal(relativeTime("", NOW), "");
  assert.equal(relativeTime("not a date", NOW), "");
});

const I = (number, repo, url = `${repo}#${number}`) => ({ number, nameWithOwner: repo, url });

test("refChips shows just the number, with owner/repo#number as the tooltip", () => {
  const chips = refChips([I(591, "acme/web"), I(7, "acme/api")]);
  assert.equal(chips.get("acme/web#591").text, "#591");
  assert.equal(chips.get("acme/web#591").title, "acme/web#591");
  assert.equal(chips.get("acme/api#7").text, "#7");
});

test("refChips adds the repo name only when a number is shared by two repos in the tile", () => {
  const chips = refChips([I(5, "acme/web"), I(5, "acme/api"), I(6, "acme/web")]);
  assert.equal(chips.get("acme/web#5").text, "web#5");
  assert.equal(chips.get("acme/api#5").text, "api#5");
  assert.equal(chips.get("acme/web#6").text, "#6");
});

test("refChips keeps the owner too when the repo name itself is shared", () => {
  const chips = refChips([I(4, "acme/site"), I(4, "crumb/site")]);
  assert.equal(chips.get("acme/site#4").text, "acme/site#4");
  assert.equal(chips.get("crumb/site#4").text, "crumb/site#4");
});

test("refChips gives every chip of a tile the same width, the widest text", () => {
  const chips = refChips([I(5, "acme/web"), I(5, "acme/api"), I(12345, "acme/web")]);
  assert.equal(new Set([...chips.values()].map((c) => c.ch)).size, 1);
  assert.equal(chips.get("acme/web#12345").ch, 6);
});

test("typeChip: nothing without a type, palette color or gray otherwise", () => {
  assert.equal(typeChip(null), null);
  assert.equal(typeChip(undefined), null);
  assert.equal(typeChip({ name: "  ", color: "BLUE" }), null);
  assert.deepEqual(plain(typeChip({ name: "Bug", color: "red" })), { name: "Bug", color: "RED" });
  assert.deepEqual(plain(typeChip({ name: "Task", color: "MAGENTA" })), { name: "Task", color: "GRAY" });
  assert.deepEqual(plain(typeChip({ name: "Task" })), { name: "Task", color: "GRAY" });
});

test("capStatus shows 5 and counts the rest; no button at <=5", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(plain(capStatus(items)), { visible: [0, 1, 2, 3, 4], hidden: 15 });
  assert.deepEqual(plain(capStatus(items.slice(0, 5))), { visible: [0, 1, 2, 3, 4], hidden: 0 });
  assert.deepEqual(plain(capStatus(items.slice(0, 2))), { visible: [0, 1], hidden: 0 });
  assert.equal(capStatus(items, 5, true).hidden, 0);
  assert.equal(capStatus(items, 5, true).visible.length, 20);
});

test("barSegments widths sum to 100 and map colors with gray fallback", () => {
  const segs = barSegments([
    { name: "Open", color: "green", count: 20 },
    { name: "In Progress", color: "YELLOW", count: 3 },
    { name: "Weird", color: "chartreuse", count: 1 },
    { name: null, color: null, count: 1 },
  ]);
  assert.equal(segs.length, 4);
  const sum = segs.reduce((n, s) => n + s.width, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `sum was ${sum}`);
  assert.ok(segs[0].width > segs[1].width && segs[1].width > segs[2].width);
  assert.deepEqual(segs.map((s) => s.color), ["GREEN", "YELLOW", "GRAY", "GRAY"]);
  assert.equal(segs[3].name, null);
});

test("barSegments forces No Status gray and handles a single or empty set", () => {
  assert.equal(barSegments([{ name: null, color: "RED", count: 4 }])[0].color, "GRAY");
  assert.equal(barSegments([{ name: null, color: null, count: 4 }])[0].width, 100);
  assert.deepEqual(plain(barSegments([])), []);
});

test("distinctCount counts an issue in two projects once", () => {
  const a = { url: "https://github.com/acme/web/issues/1" };
  const b = { url: "https://github.com/acme/web/issues/2" };
  const c = { url: "https://github.com/acme/api/issues/9" };
  const projects = [
    { statuses: [{ issues: [a, b] }] },
    { statuses: [{ issues: [a] }, { issues: [] }] },
  ];
  assert.equal(distinctCount(projects, [c]), 3);
  assert.equal(distinctCount([], []), 0);
});
