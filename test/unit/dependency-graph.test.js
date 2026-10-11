// Unit tests for the pure graph logic in background/dependency-graph.js:
// the effort-weighted critical path and the median helper it leans on for
// unestimated sub-issues.
import "../support/chrome-stub.js"; // first: the module transitively imports lib/github-api.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCriticalPath,
  median,
} from "../../background/dependency-graph.js";

// Nodes carry { id, state, effort }. Edges are { from, to } where
// "from blocks to"; computeCriticalPath returns pathIds / pathEdges Sets.
const edge = (from, to, extra = {}) => ({ from, to, ...extra });

test("median of an odd- and even-length list", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test("critical path follows the heaviest-effort chain, not the longest hop count", () => {
  // A -> B -> D  (effort 1+1+1 = 3) vs  A -> C -> D where C is huge (1+10+1 = 12).
  const nodes = [
    { id: "A", state: "open", effort: 1 },
    { id: "B", state: "open", effort: 1 },
    { id: "C", state: "open", effort: 10 },
    { id: "D", state: "open", effort: 1 },
  ];
  const edges = [edge("A", "B"), edge("B", "D"), edge("A", "C"), edge("C", "D")];
  const { pathIds, totalEffort } = computeCriticalPath(nodes, edges);
  assert.ok(pathIds.has("A") && pathIds.has("C") && pathIds.has("D"));
  assert.ok(!pathIds.has("B"), "the lighter B branch is not on the critical path");
  assert.equal(totalEffort, 12);
});

test("a done (closed) sub-issue is bridged over, not routed through", () => {
  // A -> B(closed) -> C: B is finished, so the path should skip it and
  // bridge A straight to C.
  const nodes = [
    { id: "A", state: "open", effort: 2 },
    { id: "B", state: "closed", effort: 5 },
    { id: "C", state: "open", effort: 2 },
  ];
  const edges = [edge("A", "B"), edge("B", "C")];
  const { pathIds, pathEdges, totalEffort } = computeCriticalPath(nodes, edges);
  assert.ok(pathIds.has("A") && pathIds.has("C"));
  assert.ok(!pathIds.has("B"), "closed node is removed from the path");
  assert.ok(pathEdges.has("A->C"), "predecessor is bridged to successor across the closed node");
  assert.equal(totalEffort, 4, "closed node's own effort is excluded");
});

test("an unestimated sub-issue is assumed to cost the median of what IS estimated", () => {
  // Estimated efforts are 2 and 4 (median 3); X is unestimated.
  const nodes = [
    { id: "A", state: "open", effort: 2 },
    { id: "X", state: "open", effort: null },
    { id: "B", state: "open", effort: 4 },
  ];
  const edges = [edge("A", "X"), edge("X", "B")];
  const { totalEffort } = computeCriticalPath(nodes, edges);
  assert.equal(totalEffort, 2 + 3 + 4);
});

test("a single edge-less node is not a critical path", () => {
  const nodes = [{ id: "solo", state: "open", effort: 5 }];
  const { pathIds, length } = computeCriticalPath(nodes, []);
  assert.equal(pathIds.size, 0);
  assert.equal(length, 0);
});

// GitHub allows mutual "blocked by" relationships, so a cycle is reachable;
// the path reconstruction must stop instead of following prev pointers forever.
test("computeCriticalPath terminates on a cycle instead of looping forever", () => {
  const nodes = [
    { id: "A", state: "open", effort: 1 },
    { id: "B", state: "open", effort: 1 },
  ];
  const edges = [edge("A", "B"), edge("B", "A")];
  assert.doesNotThrow(() => computeCriticalPath(nodes, edges));
});
