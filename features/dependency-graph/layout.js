// content/layout.js — a tiny left-to-right layered DAG layout.
//
// No external graph library: Chrome Web Store disallows remotely hosted
// code for MV3 extensions, and this graph is small (a parent's direct
// sub-issues plus a handful of external blockers/blocked issues), so a
// hand-rolled Sugiyama-lite layout is plenty and keeps the extension
// dependency-free.
//
// Nodes are identified by `id`, which is either a plain issue number
// (internal sub-issues, unique within the current repo) or a string key
// like "owner/repo#123" (external issues, possibly from another repo).

(function (global) {
  const NODE_W = 150; // ~2/3 of the original 220, per request
  const NODE_H = 84; // room for dot+number, a 2-line title, and a business-value/team chip
  const COL_GAP = 64;
  const ROW_GAP = 18;
  const PADDING = 24;
  // Extra clear space above row 0, reserved for edges that skip 2+ columns
  // — those arc up and over instead of cutting across whatever card sits
  // in an intermediate column (see content.js). ARC_CLEAR_Y is where that
  // arc's apex sits; it must stay comfortably above PADDING + TOP_EXTRA.
  const TOP_EXTRA = 24;
  const ARC_CLEAR_Y = 10;

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

  function layout(nodes, edges, align = "right") {
    const rank = computeRanks(nodes, edges, align);

    // Vertical order within a column: nodes with more connections (in +
    // out edges) float to the top, per request.
    const degree = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) {
      if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
      if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1);
    }

    const columns = new Map();
    for (const n of nodes) {
      const r = rank.get(n.id) ?? 0;
      if (!columns.has(r)) columns.set(r, []);
      columns.get(r).push(n);
    }

    const maxCol = Math.max(0, ...columns.keys());
    const positions = new Map();
    let maxRows = 1;

    for (let c = 0; c <= maxCol; c++) {
      const col = (columns.get(c) || []).slice().sort((a, b) => {
        const da = degree.get(a.id) ?? 0;
        const db = degree.get(b.id) ?? 0;
        if (db !== da) return db - da; // higher degree first (towards the top)
        return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
      });
      maxRows = Math.max(maxRows, col.length);
      col.forEach((n, i) => {
        positions.set(n.id, {
          x: PADDING + c * (NODE_W + COL_GAP),
          y: PADDING + TOP_EXTRA + i * (NODE_H + ROW_GAP),
        });
      });
    }

    const width = PADDING * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
    const height = PADDING * 2 + TOP_EXTRA + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

    return { positions, width, height };
  }

  global.GHDG_LAYOUT = { layout, NODE_W, NODE_H, COL_GAP, ARC_CLEAR_Y };
})(window);
