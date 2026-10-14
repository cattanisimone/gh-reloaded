// Unit tests for features/board-dependencies/geometry.js: done-ness, which
// edges stay visible, ports on a card side and the orthogonal routes. A
// content-script global (no ES module), so it is evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(readFileSync(new URL("../../features/board-dependencies/geometry.js", import.meta.url), "utf8"), context);
const G = context.GHBD_GEOMETRY;
const plain = (v) => JSON.parse(JSON.stringify(v));

// Columns as live: 350px frames, 8px gap; cards 332px wide inside (9px padding).
const col = (i) => ({ left: i * 358, right: i * 358 + 350, top: 0, bottom: 800 });
const card = (i, top, bottom) => ({ left: i * 358 + 9, right: i * 358 + 341, top, bottom });

test("stateFromLabel reads Closed/Merged as closed and Open/Draft as open", () => {
  assert.equal(G.stateFromLabel("Closed issue"), "closed");
  assert.equal(G.stateFromLabel("Closed as not planned issue"), "closed");
  assert.equal(G.stateFromLabel("Merged pull request"), "closed");
  assert.equal(G.stateFromLabel("Open issue"), "open");
  assert.equal(G.stateFromLabel("Draft pull request"), "open");
  assert.equal(G.stateFromLabel("Something else"), null);
  assert.equal(G.stateFromLabel(undefined), null);
});

test("isDone: card icon wins over API state, API used when no icon", () => {
  assert.equal(G.isDone("closed", "open"), true);
  assert.equal(G.isDone("open", "closed"), false);
  assert.equal(G.isDone(null, "closed"), true);
  assert.equal(G.isDone(null, "open"), false);
  assert.equal(G.isDone(null, undefined), false);
});

test("visibleEdges drops done→done, keeps done→open and open→done", () => {
  const edges = [
    { from: "a#1", to: "a#2" },
    { from: "a#1", to: "a#3" },
    { from: "a#3", to: "a#1" },
    { from: "a#3", to: "a#4" },
  ];
  const done = new Map([["a#1", true], ["a#2", true], ["a#3", false]]);
  assert.deepEqual(plain(G.visibleEdges(edges, done)), [edges[1], edges[2], edges[3]]);
});

test("portY spreads arrows along a side and keeps them off the corners", () => {
  assert.equal(G.portY(0, 100, 0, 1), 50);
  assert.deepEqual([0, 1, 2].map((i) => G.portY(0, 100, i, 3)), [25, 50, 75]);
  assert.equal(G.portY(0, 100, 0, 20), 10);
  assert.equal(G.portY(0, 100, 19, 20), 90);
  assert.equal(G.portY(0, 16, 0, 1), 8, "a very short card centres its port");
});

test("sides: same column uses right/right, otherwise the facing sides", () => {
  assert.deepEqual(plain(G.sides(col(0), col(0))), { from: "right", to: "right", kind: "same" });
  assert.deepEqual(plain(G.sides(col(0), col(2))), { from: "right", to: "left", kind: "cross" });
  assert.deepEqual(plain(G.sides(col(2), col(0))), { from: "left", to: "right", kind: "cross" });
});

test("lanesFor stacks overlapping intervals and reuses lanes for disjoint ones", () => {
  assert.deepEqual(plain(G.lanesFor([[0, 100], [50, 150], [200, 300]])), [0, 1, 0]);
  assert.deepEqual(plain(G.lanesFor([[100, 0]])), [0]);
});

const xs = (r) => r.points.map((p) => p.x);

test("same-column route stays in the column's side padding, outside the cards", () => {
  const src = { rect: card(0, 10, 90), col: col(0), y: 50 };
  const dst = { rect: card(0, 200, 280), col: col(0), y: 240 };
  const r = G.routeEdge({ src, dst });
  assert.equal(r.points[0].x, src.rect.right);
  assert.equal(r.points[3].x, dst.rect.right);
  const lx = r.points[1].x;
  assert.ok(lx > src.rect.right && lx < col(0).right, `bracket at ${lx} sits between card and column edge`);
  assert.equal(r.points[2].x, lx);
  assert.match(r.d, /^M /);
});

test("overlapping same-column brackets get distinct lanes", () => {
  const src = { rect: card(0, 10, 90), col: col(0), y: 50 };
  const dst = { rect: card(0, 200, 280), col: col(0), y: 240 };
  const a = G.routeEdge({ src, dst, lane: 0 }).points[1].x;
  const b = G.routeEdge({ src, dst, lane: 1 }).points[1].x;
  const c = G.routeEdge({ src, dst, lane: 2 }).points[1].x;
  assert.ok(a < b && b < c);
  assert.ok(c < col(0).right, "still inside the column");
  const far = G.routeEdge({ src, dst, lane: 9 }).points[1].x;
  assert.ok(far < col(0).right, "lanes beyond the padding share the outermost position");
});

test("adjacent-column route runs in the centre of the gap and crosses no card", () => {
  const src = { rect: card(0, 10, 90), col: col(0), y: 50 };
  const dst = { rect: card(1, 300, 380), col: col(1), y: 340 };
  const r = G.routeEdge({ src, dst, lane: 1 });
  assert.equal(r.points[0].x, src.rect.right);
  assert.equal(r.points[3].x, dst.rect.left);
  assert.equal(r.points[1].x, (col(0).right + col(1).left) / 2);
  assert.deepEqual(plain(xs(r).slice(1, 3)), [r.points[1].x, r.points[1].x]);
});

test("a route to the left leaves on the left side and enters the right side", () => {
  const src = { rect: card(2, 10, 90), col: col(2), y: 50 };
  const dst = { rect: card(1, 300, 380), col: col(1), y: 340 };
  const r = G.routeEdge({ src, dst, lane: 1 });
  assert.equal(r.points[0].x, src.rect.left);
  assert.equal(r.points[3].x, dst.rect.right);
});

test("a far route runs in the gap next to the target column", () => {
  const src = { rect: card(0, 10, 90), col: col(0), y: 50 };
  const dst = { rect: card(3, 300, 380), col: col(3), y: 340 };
  const r = G.routeEdge({ src, dst, lane: 1 });
  const gx = r.points[1].x;
  assert.equal(gx, col(3).left - 4);
  assert.ok(gx > col(2).right && gx < col(3).left, "inside the gap before the target column");
  assert.equal(r.points[0].y, 50);
  assert.equal(r.points[3].y, 340);
});

test("roundedPath drops collinear points and rounds real corners", () => {
  const d = G.roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }]);
  assert.match(d, /Q 20 0/);
  assert.equal((d.match(/Q/g) || []).length, 1);
  assert.equal(G.roundedPath([{ x: 0, y: 5 }, { x: 30, y: 5 }]), "M 0 5 L 30 5");
});
