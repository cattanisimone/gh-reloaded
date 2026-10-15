// content/layout.js — a tiny left-to-right layered DAG layout.
//
// No external graph library: Chrome Web Store disallows remotely hosted
// code for MV3 extensions, and this graph is small (a parent's direct
// sub-issues plus a handful of external blockers/blocked issues), so a
// hand-rolled Sugiyama-lite layout is plenty and keeps the extension
// dependency-free. order.js decides the order of the cards in each column,
// route.js draws the edges; this file ranks, places and ties them together.
//
// Nodes are identified by `id`, which is either a plain issue number
// (internal sub-issues, unique within the current repo) or a string key
// like "owner/repo#123" (external issues, possibly from another repo).

(function (global) {
  // The layout is driven by a `dims` object so the same graph can be laid
  // out at two sizes: the compact inline card (EMBEDDED_DIMS) and the
  // roomier full-screen view (FULLSCREEN_DIMS). Everything below reads its
  // measurements from `dims` rather than from module constants.
  const EMBEDDED_DIMS = {
    NODE_W: 150, // ~2/3 of the original 220, per request
    NODE_H: 84, // room for dot+number, a 2-line title, and a business-value/team chip
    COL_GAP: 64,
    ROW_GAP: 18,
    PADDING: 24,
    TOP_EXTRA: 24,
  };
  // Full-screen cards are larger than the inline ones and carry more
  // metadata (status name and team as well as the color fill), but only as
  // large as the content needs: oversized cards with wide column gaps left
  // the cards looking empty and pushed even a short chain past the viewport
  // width. These dimensions keep cards proportioned to their content and
  // let more columns fit on screen before horizontal scrolling kicks in,
  // while still giving chains more room than the compact inline view.
  const FULLSCREEN_DIMS = {
    NODE_W: 210,
    NODE_H: 116,
    COL_GAP: 72,
    ROW_GAP: 22,
    PADDING: 28,
    TOP_EXTRA: 28,
  };

  // Column assignment. `align` picks between two schemes:
  //
  // 'left' (ASAP) — every node gets the minimum rank a predecessor
  // allows: as early as possible. This is also the correctness floor for
  // 'right' below (a blocker always renders strictly left of what it
  // blocks, regardless of which scheme is picked).
  //
  // 'right' (ALAP-ish, the default) — starts from the same ASAP floor,
  // then pulls any node that HAS an outgoing edge as far right as
  // possible — "put a card right before its nearest downstream" —
  // without ever going earlier than that floor. A node with no outgoing
  // edge (nothing depends on it, including fully isolated nodes) simply
  // keeps its ASAP rank, which for an isolated node is column 0.
  function computeRanks(nodes, edges, align) {
    const outgoing = new Map(nodes.map((n) => [n.id, []]));
    const incoming = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (outgoing.has(e.from)) outgoing.get(e.from).push(e.to);
      if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    }

    const asap = new Map();
    const visitingAsap = new Set();
    function asapOf(id) {
      if (asap.has(id)) return asap.get(id);
      if (visitingAsap.has(id) || !incoming.has(id)) return 0; // cycle guard
      visitingAsap.add(id);
      const preds = incoming.get(id) || [];
      const r = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(asapOf));
      visitingAsap.delete(id);
      asap.set(id, r);
      return r;
    }
    for (const n of nodes) asapOf(n.id);

    if (align === "left") return asap;

    const finalRank = new Map();
    const visitingFinal = new Set();
    function finalOf(id) {
      if (finalRank.has(id)) return finalRank.get(id);
      if (visitingFinal.has(id) || !outgoing.has(id)) return asap.get(id) ?? 0; // cycle guard
      visitingFinal.add(id);
      const succs = outgoing.get(id) || [];
      let r = asap.get(id) ?? 0;
      if (succs.length > 0) {
        const desired = Math.min(...succs.map(finalOf)) - 1;
        r = Math.max(r, desired); // never earlier than the ASAP floor
      }
      visitingFinal.delete(id);
      finalRank.set(id, r);
      return r;
    }
    for (const n of nodes) finalOf(n.id);

    return finalRank;
  }

  // Height of a dummy lane slot and the gap kept around it, in px. A lane is
  // just wide enough for a 1.5px line plus its arrowhead-free neighbours.
  const LANE_H = 6;
  const LANE_GAP = 8;

  // Moves each item as close to its desired top as the order and the minimum
  // separations allow (weighted isotonic regression, pool adjacent violators).
  function placeColumn(col, desired, weight, height, gapOf) {
    const n = col.length;
    const off = [0];
    for (let i = 1; i < n; i++) off.push(off[i - 1] + height(col[i - 1]) + gapOf(col[i - 1], col[i]));
    const blocks = [];
    for (let i = 0; i < n; i++) {
      blocks.push({ sum: (desired.get(col[i]) - off[i]) * weight.get(col[i]), w: weight.get(col[i]), from: i, to: i });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1];
        const a = blocks[blocks.length - 2];
        if (a.sum / a.w <= b.sum / b.w) break;
        blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, from: a.from, to: b.to });
      }
    }
    const y = new Map();
    for (const b of blocks) for (let i = b.from; i <= b.to; i++) y.set(col[i], b.sum / b.w + off[i]);
    return y;
  }

  // `prevOrder` (optional): the `order` a previous call returned. It keeps the
  // cards that were already there in place when the graph changes a little.
  function layout(nodes, edges, align = "right", dims = EMBEDDED_DIMS, prevOrder = null) {
    const { NODE_W, NODE_H, COL_GAP, ROW_GAP, PADDING, TOP_EXTRA } = dims;
    const O = global.GHDG_ORDER;
    const R = global.GHDG_ROUTE;

    // 1. normalize + cycles, 2. ranks on the acyclic part.
    const graph = O.analyze(nodes, edges);
    const rank = computeRanks(
      graph.ids.map((id) => ({ id })),
      graph.forwardEdges,
      align
    );
    // 3. dummy lanes, 4. order (no card sizes involved).
    const layers = O.buildLayers(graph.ids, rank, graph.forwardEdges);
    const degree = new Map(graph.ids.map((id) => [id, 0]));
    for (const e of graph.edges) {
      degree.set(e.from, degree.get(e.from) + 1);
      degree.set(e.to, degree.get(e.to) + 1);
    }
    const columns = O.orderItems(layers, degree, prevOrder);

    // 5. coordinates.
    const colX = (c) => PADDING + c * (NODE_W + COL_GAP);
    const height = (id) => (O.isDummy(id) ? LANE_H : NODE_H);
    const gapOf = (a, b) => (O.isDummy(a) || O.isDummy(b) ? LANE_GAP : ROW_GAP);
    const left = new Map();
    const right = new Map();
    const link = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
    for (const hop of layers.hops) {
      for (const h of hop) {
        const w = h.edge.critical ? 100 : 1;
        link(right, h.from, { id: h.to, w });
        link(left, h.to, { id: h.from, w });
      }
    }
    const top = new Map();
    for (const col of columns) {
      let y = 0;
      col.forEach((id, i) => {
        if (i) y += gapOf(col[i - 1], id);
        top.set(id, y);
        y += height(id);
      });
    }
    const centreOf = (id) => top.get(id) + height(id) / 2;
    const pull = (col, sources) => {
      const desired = new Map();
      const weight = new Map();
      for (const id of col) {
        const ns = sources.flatMap((m) => m.get(id) || []);
        const w = ns.reduce((s, n) => s + n.w, 0);
        const wanted = w ? ns.reduce((s, n) => s + centreOf(n.id) * n.w, 0) / w : centreOf(id);
        desired.set(id, wanted - height(id) / 2);
        weight.set(id, w || 0.1);
      }
      for (const [id, y] of placeColumn(col, desired, weight, height, gapOf)) top.set(id, y);
    };
    for (let iter = 0; iter < 10; iter++) {
      for (let c = 1; c < columns.length; c++) pull(columns[c], [left]);
      for (let c = columns.length - 2; c >= 0; c--) pull(columns[c], [right]);
    }
    for (let c = 0; c < columns.length; c++) pull(columns[c], [left, right]);

    // Straighten: items joined by critical hops form chains that sit on one
    // line (the average of where the pulls left them) unless a neighbour in
    // the column forces them off it.
    const parent = new Map();
    const find = (a) => {
      while (parent.get(a) !== a) a = parent.get(a);
      return a;
    };
    for (const id of top.keys()) parent.set(id, id);
    for (const hop of layers.hops) for (const h of hop) if (h.edge.critical) parent.set(find(h.from), find(h.to));
    const groups = new Map();
    for (const hop of layers.hops) {
      for (const h of hop) {
        if (!h.edge.critical) continue;
        const g = find(h.from);
        if (!groups.has(g)) groups.set(g, new Set());
        groups.get(g).add(h.from).add(h.to);
      }
    }
    const target = new Map();
    for (const members of groups.values()) {
      const avg = [...members].reduce((s, id) => s + centreOf(id), 0) / members.size;
      for (const id of members) target.set(id, avg);
    }
    for (const col of columns) {
      const desired = new Map();
      const weight = new Map();
      for (const id of col) {
        desired.set(id, (target.has(id) ? target.get(id) : centreOf(id)) - height(id) / 2);
        weight.set(id, target.has(id) ? 1e6 : 1);
      }
      for (const [id, y] of placeColumn(col, desired, weight, height, gapOf)) top.set(id, y);
    }

    let minTop = Infinity;
    let maxBottom = 0;
    for (const [id, y] of top) {
      minTop = Math.min(minTop, y);
      maxBottom = Math.max(maxBottom, y + height(id));
    }
    if (!isFinite(minTop)) minTop = 0;
    const base = PADDING + TOP_EXTRA;
    const shift = base - minTop;
    const items = new Map();
    columns.forEach((col, c) => col.forEach((id) => items.set(id, { col: c, y: Math.round((top.get(id) + shift) * 100) / 100, h: height(id) })));
    const bottom = maxBottom + shift;

    const original = new Map(nodes.map((n) => [String(n.id), n.id]));
    const positions = new Map();
    for (const id of graph.ids) positions.set(original.get(id), { x: colX(items.get(id).col), y: items.get(id).y });

    // 6. routes.
    const routes = R.buildRoutes({
      items,
      colX,
      nodeW: NODE_W,
      nodeH: NODE_H,
      chains: layers.chains,
      edges: graph.edges,
      back: graph.backEdges,
      bottom,
    });
    const maxCol = Math.max(0, columns.length - 1);
    const width = PADDING * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
    const backBand = graph.backEdges.size ? 8 + graph.backEdges.size * R.BACK_LANE : 0;
    const heightPx = Math.max(PADDING * 2 + TOP_EXTRA + NODE_H, bottom + backBand + PADDING);

    // `routes` is keyed by "from\0to" with the card ids as strings.
    return { positions, width, height: heightPx, routes, order: columns, backEdges: graph.backEdges };
  }

  global.GHDG_LAYOUT = { layout, EMBEDDED_DIMS, FULLSCREEN_DIMS };
})(typeof window !== "undefined" ? window : globalThis);
