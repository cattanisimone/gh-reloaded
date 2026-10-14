// features/board-dependencies/geometry.js — pure helpers behind the board
// dependency arrows: which edges to draw (done-ness), where an arrow
// attaches to a card (ports), and the orthogonal route it takes through the
// gaps between and around cards.
//
// Kept out of content.js so the unit tests can load it on its own. Every
// rect is `{ left, right, top, bottom }`; nothing here touches the DOM.

(function (global) {
  const CORNER = 10; // ports keep this far from a card's corners
  const LANE = 3; // distance between stacked brackets / runs
  const RADIUS = 4; // rounded corners of a route

  // A card's own state icon carries GitHub's label: "Open issue", "Closed
  // issue", "Merged pull request", "Draft pull request"... Closed and
  // Merged mean done; Open and Draft mean not done; anything else is unknown.
  function stateFromLabel(label) {
    const l = String(label || "").trim().toLowerCase();
    if (l.startsWith("closed") || l.startsWith("merged")) return "closed";
    if (l.startsWith("open") || l.startsWith("draft")) return "open";
    return null;
  }

  // The card's icon (when the card shows one) wins over the issue state the
  // dependency API returned. Never a column name: every board names its
  // columns differently.
  function isDone(cardState, apiState) {
    if (cardState === "closed" || cardState === "open") return cardState === "closed";
    return apiState === "closed";
  }

  // `doneByKey`: Map or object of key -> done. An edge is dropped only when
  // both ends are done; a missing key counts as not done.
  function visibleEdges(edges, doneByKey) {
    const get = (k) => (typeof doneByKey?.get === "function" ? doneByKey.get(k) : doneByKey?.[k]) === true;
    return edges.filter((e) => !(get(e.from) && get(e.to)));
  }

  // y of the i-th (0-based) of n arrows along a card side, evenly spread and
  // kept CORNER px from the corners (centred when the card is too short).
  function portY(top, bottom, i, n) {
    const h = bottom - top;
    if (h <= CORNER * 2) return top + h / 2;
    const y = top + (h * (i + 1)) / (n + 1);
    return Math.min(bottom - CORNER, Math.max(top + CORNER, y));
  }

  // Which side of each card an arrow uses. Side midpoints only, never
  // top/bottom: same column leaves and returns on the right; otherwise the
  // sides that face each other.
  function sides(srcCol, dstCol) {
    const dx = dstCol.left - srcCol.left;
    if (Math.abs(dx) < 1) return { from: "right", to: "right", kind: "same" };
    return dx > 0
      ? { from: "right", to: "left", kind: "cross" }
      : { from: "left", to: "right", kind: "cross" };
  }

  // Greedy interval colouring: intervals [a, b] that overlap get different
  // lanes. Returns the lane (0, 1, 2...) of each, in input order.
  function lanesFor(intervals) {
    const order = intervals.map((iv, i) => ({ lo: Math.min(iv[0], iv[1]), hi: Math.max(iv[0], iv[1]), i }));
    order.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const laneEnd = [];
    const out = new Array(intervals.length).fill(0);
    for (const { lo, hi, i } of order) {
      let lane = laneEnd.findIndex((end) => end < lo);
      if (lane === -1) lane = laneEnd.length;
      laneEnd[lane] = hi;
      out[i] = lane;
    }
    return out;
  }

  function roundedPath(points, r = RADIUS) {
    const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[i - 1];
      const next = pts[i + 1];
      if (!next) {
        d += ` L ${p.x} ${p.y}`;
        continue;
      }
      const cross = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
      if (cross === 0) continue; // collinear: no corner here
      const len1 = Math.hypot(p.x - prev.x, p.y - prev.y);
      const len2 = Math.hypot(next.x - p.x, next.y - p.y);
      const k = Math.min(r, len1 / 2, len2 / 2);
      const a = { x: p.x - ((p.x - prev.x) / len1) * k, y: p.y - ((p.y - prev.y) / len1) * k };
      const b = { x: p.x + ((next.x - p.x) / len2) * k, y: p.y + ((next.y - p.y) / len2) * k };
      d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`;
    }
    return d;
  }

  // Orthogonal route from the source port to the target port.
  //  src / dst: { rect (the card), col (its column frame), y (port y) }
  //  gap: width of the gutter between two column frames (8px live)
  //  lane / lanes: stacking position among the `lanes` overlapping routes;
  //  lanes that do not fit the padding or gap are spread evenly across it
  // Same column: out of the right side into the column's side padding,
  // vertical, back into the right side. Adjacent columns: the facing sides,
  // vertical run at the centre of the gap. Further apart: horizontal at the
  // source's y into the gap next to the target column, vertical there, then
  // into the target (the cards it passes are masked by the caller).
  function routeEdge({ src, dst, gap = 8, lane = 0, lanes = 1 }) {
    const s = sides(src.col, dst.col);
    const sx = s.from === "right" ? src.rect.right : src.rect.left;
    const tx = s.to === "right" ? dst.rect.right : dst.rect.left;
    const sy = src.y;
    const ty = dst.y;
    let points;
    if (s.kind === "same") {
      const pad = Math.max(0, src.col.right - Math.max(src.rect.right, dst.rect.right));
      const base = lanes > 1 ? 2 : 3;
      const room = Math.max(0, pad - 2 - base);
      const step = lanes > 1 && (lanes - 1) * LANE > room ? room / (lanes - 1) : LANE;
      const off = Math.max(2, Math.min(pad - 2, base + lane * step));
      const lx = Math.max(sx, tx) + off;
      points = [{ x: sx, y: sy }, { x: lx, y: sy }, { x: lx, y: ty }, { x: tx, y: ty }];
    } else {
      const toRight = dst.col.left > src.col.left;
      const between = toRight ? dst.col.left - src.col.right : src.col.left - dst.col.right;
      const adjacent = between <= gap * 2;
      const half = gap / 2 - 1;
      const gapStep = lanes > 1 && (lanes - 1) * LANE > half * 2 ? (half * 2) / (lanes - 1) : LANE;
      const mid = lanes > 1 ? (lanes - 1) / 2 : 0;
      const shift = Math.min(half, Math.max(-half, (lane - mid) * gapStep));
      let gx;
      if (adjacent) gx = toRight ? (src.col.right + dst.col.left) / 2 : (src.col.left + dst.col.right) / 2;
      else gx = toRight ? dst.col.left - gap / 2 : dst.col.right + gap / 2;
      gx += shift;
      points = [{ x: sx, y: sy }, { x: gx, y: sy }, { x: gx, y: ty }, { x: tx, y: ty }];
    }
    return { d: roundedPath(points), points, sides: s };
  }

  global.GHBD_GEOMETRY = { stateFromLabel, isDone, visibleEdges, portY, sides, lanesFor, routeEdge, roundedPath };
})(globalThis);
