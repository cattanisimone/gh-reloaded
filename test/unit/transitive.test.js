// Unit tests for features/dependency-graph/transitive.js: the transitive
// reduction applied to the displayed graph. It's a content-script global
// (no ES module), so it's evaluated in a fresh context and read off the global.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(
  readFileSync(new URL("../../features/dependency-graph/transitive.js", import.meta.url), "utf8"),
  context
);
const { hideTransitiveEdges } = context.GHDG_TRANSITIVE;

const edge = (from, to, extra = {}) => ({ from, to, ...extra });
const keys = (edges) => edges.map((e) => `${e.from}->${e.to}`).sort();

test("hides an edge implied by a two-hop path", () => {
  const edges = [edge("A", "B"), edge("B", "C"), edge("A", "C")];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "B", "C"], edges)), ["A->B", "B->C"]);
});

test("hides an edge implied by a path of any depth", () => {
  // A -> B, A -> D, B -> C, C -> D: A -> D is implied by A -> B -> C -> D.
  const edges = [edge("A", "B"), edge("A", "D"), edge("B", "C"), edge("C", "D")];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "B", "C", "D"], edges)), ["A->B", "B->C", "C->D"]);

  const long = [edge("A", "B"), edge("B", "C"), edge("C", "D"), edge("D", "E"), edge("A", "E"), edge("B", "E")];
  assert.deepEqual(
    keys(hideTransitiveEdges(["A", "B", "C", "D", "E"], long)),
    ["A->B", "B->C", "C->D", "D->E"]
  );
});

test("keeps an edge with no alternative path", () => {
  const edges = [edge("A", "B"), edge("A", "C")];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "B", "C"], edges)), ["A->B", "A->C"]);
});

test("counts a detour through visible external cards", () => {
  const edges = [edge("A", "X#1"), edge("X#1", "C"), edge("A", "C")];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "X#1", "C"], edges)), ["A->X#1", "X#1->C"]);
});

test("keeps an edge whose detour runs through a card that is not shown", () => {
  const edges = [edge("A", "B"), edge("B", "C"), edge("A", "C")];
  assert.ok(keys(hideTransitiveEdges(["A", "C"], edges)).includes("A->C"));
});

test("never hides an edge marked critical", () => {
  const edges = [edge("A", "B"), edge("B", "C"), edge("A", "C", { critical: true })];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "B", "C"], edges)), ["A->B", "A->C", "B->C"]);
});

test("terminates on a cycle and never hides an edge through itself", () => {
  const edges = [edge("A", "B"), edge("B", "A")];
  assert.deepEqual(keys(hideTransitiveEdges(["A", "B"], edges)), ["A->B", "B->A"]);
});
