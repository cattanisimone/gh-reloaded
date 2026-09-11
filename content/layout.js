// content/layout.js — a tiny left-to-right layered DAG layout.
//
// No external graph library: Chrome Web Store disallows remotely hosted
// code for MV3 extensions, and this graph is small (a parent's direct
// sub-issues, typically well under 100 nodes), so a hand-rolled
// Sugiyama-lite layout is plenty and keeps the extension dependency-free.

(function (global) {
  const NODE_W = 220;
  const NODE_H = 56;
  const COL_GAP = 80;
  const ROW_GAP = 16;
  const PADDING = 24;

  // rank(node) = 0 if nothing blocks it, else 1 + max(rank(blocker)).
  // "Blockers" render to the left, the issues they block render to the
  // right — matching the requested left-to-right dependency flow.
  function computeRanks(nodes, edges) {
    const incoming = new Map(nodes.map((n) => [n.number, []]));
    for (const e of edges) {
      if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    }

    const rank = new Map();
    const visiting = new Set(); // cycle guard — dependencies shouldn't cycle, but don't hang if they do

    function rankOf(n) {
      if (rank.has(n)) return rank.get(n);
      if (visiting.has(n)) return 0;
      visiting.add(n);
      const preds = incoming.get(n) || [];
      const r = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(rankOf));
      visiting.delete(n);
      rank.set(n, r);
      return r;
    }

    for (const n of nodes) rankOf(n.number);
    return rank;
  }

  function layout(nodes, edges) {
    const rank = computeRanks(nodes, edges);

    const columns = new Map();
    for (const n of nodes) {
      const r = rank.get(n.number) ?? 0;
      if (!columns.has(r)) columns.set(r, []);
      columns.get(r).push(n);
    }

    const maxCol = Math.max(0, ...columns.keys());
    const positions = new Map();
    let maxRows = 1;

    for (let c = 0; c <= maxCol; c++) {
      const col = (columns.get(c) || []).slice().sort((a, b) => a.number - b.number);
      maxRows = Math.max(maxRows, col.length);
      col.forEach((n, i) => {
        positions.set(n.number, {
          x: PADDING + c * (NODE_W + COL_GAP),
          y: PADDING + i * (NODE_H + ROW_GAP),
        });
      });
    }

    const width = PADDING * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
    const height = PADDING * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

    return { positions, width, height };
  }

  global.GHDG_LAYOUT = { layout, NODE_W, NODE_H };
})(window);
