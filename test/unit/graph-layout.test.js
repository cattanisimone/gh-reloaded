// Unit tests for the dependency-graph layout pipeline: order.js (cycles,
// dummy lanes, crossing reduction), route.js (ports and paths) and layout.js
// (ranks, coordinates, stability). Content-script globals, loaded in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeGraph, KINDS } from "../../bench/dependency-graph/fixtures.js";

const context = {};
context.globalThis = context;
for (const f of ["order", "route", "layout"]) {
  vm.runInNewContext(
    readFileSync(new URL(`../../features/dependency-graph/${f}.js`, import.meta.url), "utf8"),
    context
  );
}
const { layout, EMBEDDED_DIMS, FULLSCREEN_DIMS } = context.GHDG_LAYOUT;
const { analyze } = context.GHDG_ORDER;

const nodes = (...ids) => ids.map((id) => ({ id }));
const edge = (from, to, extra = {}) => ({ from, to, ...extra });
const rowsOf = (res, dims, ids) => ids.map((id) => res.positions.get(id).y);
const key = (e) => `${e.from}->${e.to}`;

function columnsOf(res, dims, ids) {
  const out = new Map();
  for (const id of ids) {
    const c = Math.round((res.positions.get(id).x - dims.PADDING) / (dims.NODE_W + dims.COL_GAP));
    if (!out.has(c)) out.set(c, []);
    out.get(c).push(id);
  }
  for (const [, v] of out) v.sort((a, b) => res.positions.get(a).y - res.positions.get(b).y);
  return out;
}

test("layout: every edge goes strictly right, both align modes", () => {
  for (const align of ["left", "right"]) {
    for (const kind of KINDS.filter((k) => k !== "cycle")) {
      const g = makeGraph(kind, 40, 2);
      const res = layout(g.nodes, g.edges, align, EMBEDDED_DIMS);
      for (const e of g.edges) {
        assert.ok(res.positions.get(e.from).x < res.positions.get(e.to).x, `${kind}/${align} ${key(e)}`);
      }
    }
  }
});

test("layout: no two cards overlap on any bench fixture", () => {
  for (const dims of [EMBEDDED_DIMS, FULLSCREEN_DIMS]) {
    for (const kind of KINDS) {
      for (const size of [8, 40, 150]) {
        const g = makeGraph(kind, size, 3);
        const res = layout(g.nodes, g.edges, "right", dims);
        const boxes = g.nodes.map((n) => ({ id: n.id, ...res.positions.get(n.id) }));
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const apart = a.x + dims.NODE_W <= b.x || b.x + dims.NODE_W <= a.x || a.y + dims.NODE_H <= b.y || b.y + dims.NODE_H <= a.y;
            assert.ok(apart, `${kind}/${size}: ${a.id} overlaps ${b.id}`);
          }
        }
        assert.ok(boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + dims.NODE_W <= res.width && b.y + dims.NODE_H <= res.height));
      }
    }
  }
});

test("layout: a critical chain sits on one row when nothing forces it off", () => {
  const g = {
    nodes: nodes(1, 2, 3, 4, 5, 6),
    edges: [edge(1, 2, { critical: true }), edge(2, 3, { critical: true }), edge(3, 4, { critical: true }), edge(1, 5), edge(5, 4), edge(6, 4)],
  };
  const res = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
  const ys = rowsOf(res, EMBEDDED_DIMS, [1, 2, 3, 4]);
  assert.equal(new Set(ys).size, 1, `critical ys ${ys}`);
});

test("layout: same input twice gives identical output", () => {
  const g = makeGraph("dense", 80, 4);
  const a = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
  const b = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
  assert.deepEqual([...a.positions], [...b.positions]);
  assert.deepEqual([...a.routes], [...b.routes]);
});

test("layout: same order for EMBEDDED_DIMS and FULLSCREEN_DIMS", () => {
  for (const kind of KINDS) {
    const g = makeGraph(kind, 40, 5);
    const ids = g.nodes.map((n) => n.id);
    const a = columnsOf(layout(g.nodes, g.edges, "right", EMBEDDED_DIMS), EMBEDDED_DIMS, ids);
    const b = columnsOf(layout(g.nodes, g.edges, "right", FULLSCREEN_DIMS), FULLSCREEN_DIMS, ids);
    assert.deepEqual([...a], [...b], kind);
  }
});

test("layout: adding one card keeps the order of the others", () => {
  for (const kind of ["dense", "diamond", "longspan"]) {
    const g = makeGraph(kind, 40, 6);
    const first = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
    const ids = g.nodes.map((n) => n.id);
    const added = { nodes: [...g.nodes, { id: 999 }], edges: [...g.edges, edge(ids[0], 999)] };
    const second = layout(added.nodes, added.edges, "right", EMBEDDED_DIMS, first.order);
    const a = columnsOf(first, EMBEDDED_DIMS, ids);
    const b = columnsOf(second, EMBEDDED_DIMS, ids);
    assert.deepEqual([...a], [...b], kind);
  }
});

test("layout: removing one card keeps the order of the others", () => {
  const g = makeGraph("dense", 40, 7);
  const first = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
  const gone = g.nodes[g.nodes.length - 1].id;
  const rest = g.nodes.filter((n) => n.id !== gone);
  const second = layout(rest, g.edges.filter((e) => e.from !== gone && e.to !== gone), "right", EMBEDDED_DIMS, first.order);
  const ids = rest.map((n) => n.id);
  // Rows can shift when a column loses a card, and ranks can follow the
  // removed card's edges; among the cards that stay in a column, the vertical
  // order must not change.
  const before = columnsOf(first, EMBEDDED_DIMS, ids);
  const after = columnsOf(second, EMBEDDED_DIMS, ids);
  for (const [c, col] of after) {
    const kept = col.filter((id) => (before.get(c) || []).includes(id));
    assert.deepEqual(kept, (before.get(c) || []).filter((id) => kept.includes(id)), `column ${c}`);
  }
});

test("layout: islands stack without overlap", () => {
  const res = layout(nodes(1, 2, 3, 4), [edge(1, 2)], "right", EMBEDDED_DIMS);
  assert.equal(res.positions.size, 4);
  const ys = [...res.positions.values()].filter((p) => p.x === res.positions.get(3).x).map((p) => p.y);
  assert.equal(new Set(ys).size, ys.length);
});

test("order: a cycle keeps all its edges, one marked back edge", () => {
  const edges = [edge(1, 2), edge(2, 3), edge(3, 1)];
  const a = analyze(nodes(1, 2, 3), edges);
  assert.equal(a.backEdges.size, 1);
  assert.equal(a.forwardEdges.length, 2);
  const res = layout(nodes(1, 2, 3), edges, "right", EMBEDDED_DIMS);
  assert.equal(res.routes.size, 3);
  assert.equal([...res.routes.values()].filter((r) => r.back).length, 1);
  // The chain still reads left to right.
  assert.ok(res.positions.get(1).x < res.positions.get(2).x && res.positions.get(2).x < res.positions.get(3).x);
});

test("order: the same cycle always gets the same back edge", () => {
  const edges = [edge(3, 1), edge(1, 2), edge(2, 3)];
  const a = [...analyze(nodes(1, 2, 3), edges).backEdges];
  const b = [...analyze(nodes(3, 2, 1), [...edges].reverse()).backEdges];
  assert.deepEqual(a, b);
});

test("order: self loops and unknown endpoints are ignored without throwing", () => {
  const res = layout(nodes(1, 2), [edge(1, 1), edge(1, 9), edge(1, 2)], "right", EMBEDDED_DIMS);
  assert.equal(res.positions.size, 2);
  assert.ok(res.routes.has("1\u00002"));
});

test("order: adding a card outside a cycle keeps which edge is the back edge", () => {
  const first = analyze(nodes(5, 7, 9), [edge(5, 7), edge(7, 5), edge(7, 9)]);
  const second = analyze(nodes(3, 5, 7, 9), [edge(5, 7), edge(7, 5), edge(7, 9), edge(3, 7)]);
  assert.deepEqual([...first.backEdges], [...second.backEdges]);
  const res1 = layout(nodes(5, 7, 9), [edge(5, 7), edge(7, 5), edge(7, 9)], "right", EMBEDDED_DIMS);
  const res2 = layout(nodes(3, 5, 7, 9), [edge(5, 7), edge(7, 5), edge(7, 9), edge(3, 7)], "right", EMBEDDED_DIMS, res1.order);
  assert.equal(res1.positions.get(5).x, res2.positions.get(5).x);
});

test("layout: a seeded layout of a large graph stays fast", () => {
  const g = makeGraph("dense", 150, 1);
  const first = layout(g.nodes, g.edges, "right", EMBEDDED_DIMS);
  const t = performance.now();
  layout(g.nodes, g.edges, "right", EMBEDDED_DIMS, first.order);
  const ms = performance.now() - t;
  assert.ok(ms < 400, `seeded layout took ${ms} ms`);
});

test("layout: an isolated new card does not move the existing rows of its column", () => {
  const edges = [edge(1, 4), edge(2, 4), edge(3, 4)];
  const first = layout(nodes(1, 2, 3, 4), edges, "right", EMBEDDED_DIMS);
  const second = layout(nodes(1, 2, 3, 4, 5), [...edges, edge(5, 4)], "right", EMBEDDED_DIMS, first.order);
  // the fan-in target may re-centre; the existing sources must keep their rows
  for (const id of [1, 2, 3]) assert.equal(second.positions.get(id).y, first.positions.get(id).y, `card ${id}`);
});
