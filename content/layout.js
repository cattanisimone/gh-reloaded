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
  const NODE_H = 64; // tall enough for dot+number, title, and a business-value/team line
  const COL_GAP = 64;
  const ROW_GAP = 16;
  const PADDING = 24;

  // rank(node) = 0 if nothing blocks it, else 1 + max(rank(blocker)).
  // "Blockers" render to the left, the issues they block render to the
  // right — matching the requested left-to-right dependency flow. This
  // also naturally pushes external blockers further left and external
  // blocked-issues further right of the internal sub-issue columns.
  function computeRanks(nodes, edges) {
    const incoming = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    }

    const rank = new Map();
    const visiting = new Set(); // cycle guard — dependencies shouldn't cycle, but don't hang if they do

    function rankOf(id) {
      if (rank.has(id)) return rank.get(id);
      if (visiting.has(id) || !incoming.has(id)) return 0;
      visiting.add(id);
      const preds = incoming.get(id) || [];
      const r = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(rankOf));
      visiting.delete(id);
      rank.set(id, r);
      return r;
    }

    for (const n of nodes) rankOf(n.id);
    return rank;
  }

  function layout(nodes, edges) {
    const rank = computeRanks(nodes, edges);

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
      const col = (columns.get(c) || [])
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
      maxRows = Math.max(maxRows, col.length);
      col.forEach((n, i) => {
        positions.set(n.id, {
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
