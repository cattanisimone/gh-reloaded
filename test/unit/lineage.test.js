// Unit tests for features/dependency-graph/lineage.js: which cards stay
// highlighted when a card is selected. It's a content-script global (no ES
// module), so it's evaluated in a fresh context and read off the global.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(
  readFileSync(new URL("../../features/dependency-graph/lineage.js", import.meta.url), "utf8"),
  context
);
const { lineage } = context.GHDG_LINEAGE;

const edge = (from, to) => ({ from, to });
const sorted = (set) => [...set].sort();

// A -> B -> C -> D, plus an unrelated X -> Y.
const CHAIN = [edge("A", "B"), edge("B", "C"), edge("C", "D"), edge("X", "Y")];

test("includes the card, everything upstream and everything downstream, at any depth", () => {
  assert.deepEqual(sorted(lineage("B", CHAIN)), ["A", "B", "C", "D"]);
  assert.deepEqual(sorted(lineage("D", CHAIN)), ["A", "B", "C", "D"]);
  assert.deepEqual(sorted(lineage("A", CHAIN)), ["A", "B", "C", "D"]);
});

test("leaves unrelated cards out", () => {
  assert.ok(!lineage("B", CHAIN).has("X"));
  assert.deepEqual(sorted(lineage("X", CHAIN)), ["X", "Y"]);
});

test("does not cross over to siblings on the other side of a shared card", () => {
  // A -> C and B -> C: selecting A reaches C but not B (B is not upstream or downstream of A).
  const edges = [edge("A", "C"), edge("B", "C")];
  assert.deepEqual(sorted(lineage("A", edges)), ["A", "C"]);
  assert.deepEqual(sorted(lineage("C", edges)), ["A", "B", "C"]);
});

test("a card with no edges is highlighted alone", () => {
  assert.deepEqual(sorted(lineage("Z", CHAIN)), ["Z"]);
});

test("terminates on a cycle", () => {
  const edges = [edge("A", "B"), edge("B", "C"), edge("C", "A")];
  assert.deepEqual(sorted(lineage("A", edges)), ["A", "B", "C"]);
});

test("returns an empty set when nothing is selected", () => {
  assert.equal(lineage(null, CHAIN).size, 0);
});

test("only follows the edges it is given, so a hidden edge does not extend the reach", () => {
  assert.deepEqual(sorted(lineage("A", [edge("A", "B"), edge("C", "D")])), ["A", "B"]);
});
