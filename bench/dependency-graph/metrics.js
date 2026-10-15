// Scores a layout on what the user sees: the rendered edge paths, flattened
// to polylines. Every engine goes through the same functions.

// Flattens an SVG path made of M, L, V, H and C commands (absolute) into points.
export function flattenPath(d, steps = 14) {
  const t = d.trim().split(/[\s,]+/);
  const pts = [];
  let i = 0;
  let cur = { x: 0, y: 0 };
  while (i < t.length) {
    const c = t[i++];
    if (c === "M" || c === "L") {
      cur = { x: +t[i++], y: +t[i++] };
      pts.push(cur);
    } else if (c === "V") {
      cur = { x: cur.x, y: +t[i++] };
      pts.push(cur);
    } else if (c === "H") {
      cur = { x: +t[i++], y: cur.y };
      pts.push(cur);
    } else if (c === "C") {
      const p1 = { x: +t[i++], y: +t[i++] };
      const p2 = { x: +t[i++], y: +t[i++] };
      const p3 = { x: +t[i++], y: +t[i++] };
      for (let k = 1; k <= steps; k++) {
        const u = k / steps;
        const m = 1 - u;
        pts.push({
          x: m * m * m * cur.x + 3 * m * m * u * p1.x + 3 * m * u * u * p2.x + u * u * u * p3.x,
          y: m * m * m * cur.y + 3 * m * m * u * p1.y + 3 * m * u * u * p2.y + u * u * u * p3.y,
        });
      }
      cur = p3;
    } else throw new Error(`unsupported path command ${c}`);
  }
  return pts;
}

function segIntersect(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function overlapLen(a, b, c, d) {
  // Collinear-ish overlap of two segments within 1.5px, length along the shared direction.
  const vx = b.x - a.x, vy = b.y - a.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return 0;
  const ux = vx / len, uy = vy / len;
  const dist = (p) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
  if (dist(c) > 1.5 || dist(d) > 1.5) return 0;
  const proj = (p) => (p.x - a.x) * ux + (p.y - a.y) * uy;
  const lo = Math.max(0, Math.min(proj(c), proj(d)));
  const hi = Math.min(len, Math.max(proj(c), proj(d)));
  return Math.max(0, hi - lo);
}

// result: { positions: Map id -> {x,y}, routes: Map key -> {points, back?}, width, height }
// graph: { nodes, edges }, dims: card size.
export function score(graph, result, dims) {
  const { positions, routes } = result;
  const list = graph.edges
    .map((e) => ({ e, r: routes.get(`${e.from}\u0000${e.to}`) }))
    .filter((x) => x.r);
  const boxes = graph.nodes.map((n) => ({ id: n.id, ...positions.get(n.id) }));

  let crossings = 0;
  let overlap = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      if (A.e.from === B.e.from || A.e.from === B.e.to || A.e.to === B.e.from || A.e.to === B.e.to) continue;
      const pa = A.r.points, pb = B.r.points;
      let hit = false;
      for (let a = 1; a < pa.length && !hit; a++) {
        for (let b = 1; b < pb.length; b++) {
          if (segIntersect(pa[a - 1], pa[a], pb[b - 1], pb[b])) {
            crossings++;
            hit = true;
            break;
          }
        }
      }
    }
  }
  // Overlap: shared stretches between edges that do not share a card end are
  // a lane shared; edges from the same card may legitimately start together.
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      if (A.e.from === B.e.from || A.e.to === B.e.to) continue;
      const pa = A.r.points, pb = B.r.points;
      let len = 0;
      for (let a = 1; a < pa.length; a++) for (let b = 1; b < pb.length; b++) len += overlapLen(pa[a - 1], pa[a], pb[b - 1], pb[b]);
      if (len > 4) overlap++;
    }
  }

  let edgeCardHits = 0;
  let backHits = 0;
  for (const { e, r } of list) {
    const hit = boxes.some((c) => {
      if (c.id === e.from || c.id === e.to) return false;
      return r.points.some((p) => p.x > c.x + 1 && p.x < c.x + dims.NODE_W - 1 && p.y > c.y + 1 && p.y < c.y + dims.NODE_H - 1);
    });
    if (hit) (r.back ? backHits++ : edgeCardHits++);
  }

  let cardOverlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (!(a.x + dims.NODE_W <= b.x || b.x + dims.NODE_W <= a.x || a.y + dims.NODE_H <= b.y || b.y + dims.NODE_H <= a.y)) cardOverlaps++;
    }
  }

  const back = new Set(graph.edges.filter((e) => routes.get(`${e.from}\u0000${e.to}`)?.back).map((e) => `${e.from}\u0000${e.to}`));
  const leftToRight = graph.edges.every((e) => back.has(`${e.from}\u0000${e.to}`) || e.from === e.to || positions.get(e.from).x < positions.get(e.to).x);
  const drawn = list.length === new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}`)).size;

  const crit = graph.edges.filter((e) => e.critical);
  const dev = crit.length
    ? crit.reduce((s, e) => s + Math.abs(positions.get(e.from).y - positions.get(e.to).y), 0) / crit.length
    : 0;

  return {
    crossings,
    overlaps: overlap,
    edgeCardHits,
    backEdgeHits: backHits,
    cardOverlaps,
    leftToRight,
    allEdgesDrawn: drawn,
    criticalDeviation: dev,
    width: Math.round(result.width),
    height: Math.round(result.height),
  };
}

// Stability: lay out the graph, then the graph with one card and its edges
// removed, and compare the cards present in both: inversions of the vertical
// order inside each column, and the mean vertical displacement.
export function stability(a, b, dims) {
  const col = (res, id) => Math.round(res.positions.get(id).x / (dims.NODE_W + dims.COL_GAP));
  const common = [...a.positions.keys()].filter((id) => b.positions.has(id));
  let inversions = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const p = common[i], q = common[j];
      if (col(a, p) !== col(a, q) || col(b, p) !== col(b, q)) continue;
      if ((a.positions.get(p).y - a.positions.get(q).y) * (b.positions.get(p).y - b.positions.get(q).y) < 0) inversions++;
    }
  }
  const moved = common.filter((id) => col(a, id) !== col(b, id)).length;
  return { inversions, moved, common: common.length };
}

export function percentile(xs, p) {
  const s = xs.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
