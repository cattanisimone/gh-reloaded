// Unit tests for the dependency-graph edge routing (route.js through layout).
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
const { layout, EMBEDDED_DIMS: D } = context.GHDG_LAYOUT;
const nodes = (...ids) => ids.map((id) => ({ id }));
const edge = (from, to, extra = {}) => ({ from, to, ...extra });

// Samples a route's polyline (its `points`) as segments for geometry checks.
function segments(route) {
  const out = [];
  for (let i = 1; i < route.points.length; i++) out.push([route.points[i - 1], route.points[i]]);
  return out;
}
function hitsBox(seg, p) {
  const [a, b] = seg;
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const y = a.y + ((b.y - a.y) * i) / n;
    if (x > p.x + 0.5 && x < p.x + D.NODE_W - 0.5 && y > p.y + 0.5 && y < p.y + D.NODE_H - 0.5) return true;
  }
  return false;
}

test("route: a long edge passes no card", () => {
  for (const kind of KINDS.filter((k) => k !== "cycle")) {
    const g = makeGraph(kind, 40, 8);
    const res = layout(g.nodes, g.edges, "right", D);
    for (const [k, route] of res.routes) {
      if (route.back) continue;
      for (const n of g.nodes) {
        const [from, to] = k.split("\u0000");
        if (String(n.id) === from || String(n.id) === to) continue;
        const p = res.positions.get(n.id);
        for (const s of segments(route)) assert.ok(!hitsBox(s, p), `${kind}: ${k} crosses card ${n.id}`);
      }
    }
  }
});

test("route: no edge climbs into a shared corridor above the cards", () => {
  const g = makeGraph("longspan", 40, 9);
  const res = layout(g.nodes, g.edges, "right", D);
  // Lanes live between and beside the cards, inside the stage: nothing climbs
  // into a band above row 0 (the old arc apex sat at y = 10, above the padding).
  const floor = D.PADDING + D.TOP_EXTRA;
  for (const route of res.routes.values()) {
    for (const p of route.points) assert.ok(p.y >= floor - 0.5 && p.y <= res.height, `point outside the stage rows: ${p.y}`);
  }
  const laneYs = new Map();
  for (const route of res.routes.values()) for (const l of route.lanes) laneYs.set(`${l.col}:${Math.round(l.y)}`, (laneYs.get(`${l.col}:${Math.round(l.y)}`) || 0) + 1);
  assert.ok([...laneYs.values()].every((n) => n === 1), "no two edges share a lane");
});

test("route: two long edges never share a lane", () => {
  // 1 -> 4 and 2 -> 5 both skip columns; their lanes must differ in every column.
  const g = {
    nodes: nodes(1, 2, 3, 4, 5, 6, 7),
    edges: [edge(1, 3), edge(3, 4), edge(4, 5), edge(5, 6), edge(1, 6), edge(2, 6), edge(3, 7), edge(2, 5)],
  };
  const res = layout(g.nodes, g.edges, "right", D);
  const longs = [...res.routes.entries()].filter(([, r]) => r.lanes && r.lanes.length > 0);
  assert.ok(longs.length >= 2);
  for (let i = 0; i < longs.length; i++) {
    for (let j = i + 1; j < longs.length; j++) {
      for (const a of longs[i][1].lanes) {
        for (const b of longs[j][1].lanes) {
          if (a.col === b.col) assert.ok(Math.abs(a.y - b.y) >= 4, `${longs[i][0]} and ${longs[j][0]} share a lane in column ${a.col}`);
        }
      }
    }
  }
});

test("route: fan-out ports are sorted by target and distinct", () => {
  const g = { nodes: nodes(1, 2, 3, 4, 5), edges: [edge(1, 2), edge(1, 3), edge(1, 4), edge(1, 5)] };
  const res = layout(g.nodes, g.edges, "right", D);
  const ports = [2, 3, 4, 5].map((t) => ({ t, y: res.routes.get(`1\u0000${t}`).points[0].y, ty: res.positions.get(t).y }));
  ports.sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < ports.length; i++) assert.ok(ports[i].y > ports[i - 1].y, "ports are distinct and follow the target order");
  const p1 = res.positions.get(1);
  assert.ok(ports.every((p) => p.y > p1.y && p.y < p1.y + D.NODE_H), "ports stay on the card side");
});

test("route: every displayed edge has a path ending at its target card", () => {
  const g = makeGraph("dense", 40, 10);
  const res = layout(g.nodes, g.edges, "right", D);
  for (const e of g.edges) {
    const r = res.routes.get(`${e.from}\u0000${e.to}`);
    assert.ok(r && /^M /.test(r.d), `${e.from}->${e.to}`);
    const end = r.points[r.points.length - 1];
    const t = res.positions.get(e.to);
    assert.ok(Math.abs(end.x - t.x) < 0.01 || r.back, "ends on the target's left side");
  }
});

test("route: a back edge is drawn below the cards inside the stage", () => {
  const res = layout(nodes(1, 2, 3), [edge(1, 2), edge(2, 3), edge(3, 1)], "right", D);
  const back = [...res.routes.values()].find((r) => r.back);
  const bottom = Math.max(...[...res.positions.values()].map((p) => p.y + D.NODE_H));
  assert.ok(Math.max(...back.points.map((p) => p.y)) > bottom);
  assert.ok(Math.max(...back.points.map((p) => p.y)) <= res.height);
});
