// content/route.js — edge geometry for the dependency graph: which point of a
// card each arrow leaves from or arrives at, and the path it follows.
//
// Pure logic, no DOM. layout.js gives it the placed items (cards and dummy
// lanes); it returns one route per edge: the SVG path `d`, the polyline of
// its vertices (what the tests and the benchmark measure) and, for an edge
// that skips columns, the lane it uses in each column it passes.

(function (global) {
  const PORT_PAD = 14; // keeps ports off the rounded corners
  const BACK_LANE = 12; // spacing of the back-edge lanes under the cards

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // Spreads `count` ports along a card side, centred when there is one.
  function portY(top, height, i, count) {
    if (count <= 1) return top + height / 2;
    const band = height - PORT_PAD * 2;
    return top + PORT_PAD + ((i + 0.5) * band) / count;
  }

  // `items`: Map id -> { col, y, h } for cards and dummies, `x(col)` the left x
  // of a column, `chains`: Map edge key -> dummy ids, `edges`: all edges
  // ({ key, from, to }), `back`: Set of back edge keys, `bottom`: y below
  // which the back-edge lanes start.
  function buildRoutes({ items, colX, nodeW, nodeH, gap, chains, edges, back, bottom }) {
    const centre = (id) => items.get(id).y + items.get(id).h / 2;
    const outs = new Map(); // card -> [{ edge, next }]
    const ins = new Map(); // card -> [{ edge, prev }]
    const add = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
    const forward = edges.filter((e) => !back.has(e.key));
    for (const e of forward) {
      const chain = chains.get(e.key) || [];
      add(outs, e.from, { edge: e, next: chain.length ? chain[0] : e.to });
      add(ins, e.to, { edge: e, prev: chain.length ? chain[chain.length - 1] : e.from });
    }
    const outPort = new Map();
    const inPort = new Map();
    for (const [id, list] of outs) {
      list.sort((a, b) => centre(a.next) - centre(b.next) || cmp(a.edge.key, b.edge.key));
      const it = items.get(id);
      list.forEach((o, i) => outPort.set(o.edge.key, portY(it.y, it.h, i, list.length)));
    }
    for (const [id, list] of ins) {
      list.sort((a, b) => centre(a.prev) - centre(b.prev) || cmp(a.edge.key, b.edge.key));
      const it = items.get(id);
      list.forEach((o, i) => inPort.set(o.edge.key, portY(it.y, it.h, i, list.length)));
    }

    const routes = new Map();
    for (const e of forward) {
      const chain = chains.get(e.key) || [];
      const a = items.get(e.from);
      const b = items.get(e.to);
      const pts = [{ x: colX(a.col) + nodeW, y: outPort.get(e.key) }];
      const lanes = [];
      for (const d of chain) {
        const it = items.get(d);
        pts.push({ x: colX(it.col), y: it.y + it.h / 2 }, { x: colX(it.col) + nodeW, y: it.y + it.h / 2 });
        lanes.push({ col: it.col, y: it.y + it.h / 2 });
      }
      pts.push({ x: colX(b.col), y: inPort.get(e.key) });
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1];
        const q = pts[i];
        if (q.x === p.x) continue;
        if (q.x - p.x === nodeW && i < pts.length - 1 && pts[i - 1].y === q.y) d += ` L ${q.x} ${q.y}`;
        else if (p.y === q.y && q.x - p.x === nodeW) d += ` L ${q.x} ${q.y}`;
        else {
          const dx = (q.x - p.x) / 2;
          d += ` C ${p.x + dx} ${p.y}, ${q.x - dx} ${q.y}, ${q.x} ${q.y}`;
        }
      }
      routes.set(e.key, { d, points: pts, lanes, back: false });
    }

    // Back edges: out of the right side of the source low on the card, down the
    // gap beside its column (no card stands there), along a lane under every
    // card, up the gap in front of the target's column and into its left side.
    // Drawn behind the cards.
    const backEdges = edges.filter((e) => back.has(e.key));
    backEdges.forEach((e, i) => {
      const a = items.get(e.from);
      const b = items.get(e.to);
      const ly = bottom + 8 + i * BACK_LANE;
      const stagger = ((i % 3) - 1) * 6;
      const gx1 = colX(a.col) + nodeW + gap / 2 + stagger;
      const gx2 = colX(b.col) - gap / 2 + stagger;
      const y1 = a.y + nodeH - PORT_PAD + ((i % 3) - 1) * 3;
      const y2 = b.y + nodeH - PORT_PAD + ((i % 3) - 1) * 3;
      const pts = [
        { x: colX(a.col) + nodeW, y: y1 },
        { x: gx1, y: y1 },
        { x: gx1, y: ly },
        { x: gx2, y: ly },
        { x: gx2, y: y2 },
        { x: colX(b.col), y: y2 },
      ];
      routes.set(e.key, { d: "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L "), points: pts, lanes: [], back: true });
    });
    return routes;
  }

  global.GHDG_ROUTE = { buildRoutes, portY, BACK_LANE };
})(typeof window !== "undefined" ? window : globalThis);
