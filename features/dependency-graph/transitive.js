// content/transitive.js — transitive reduction of the displayed graph.
//
// Pure logic, kept out of content.js so the unit tests can load it on its own.

(function (global) {
  // Returns the edges to draw when "Hide transitive dependencies" is on: every
  // edge (u,v) already implied by a longer path u -> ... -> v of any length
  // through the given cards is dropped ("A blocks D" adds nothing when
  // A -> B -> C -> D is shown). Works on the cards actually on screen, so a
  // detour only counts while its cards are visible. An edge marked `critical`
  // is always kept: it's a segment of the highlighted chain, not noise. The
  // edge under test is removed before probing, so a cycle never makes a card
  // reach itself through that very edge.
  function hideTransitiveEdges(nodeIds, edges) {
    const idSet = new Set(nodeIds);
    const adj = new Map(nodeIds.map((id) => [id, new Set()]));
    for (const e of edges) {
      if (idSet.has(e.from) && idSet.has(e.to)) adj.get(e.from).add(e.to);
    }

    function reachable(start, target) {
      const seen = new Set();
      const stack = Array.from(adj.get(start));
      while (stack.length) {
        const n = stack.pop();
        if (n === target) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const next of adj.get(n)) stack.push(next);
      }
      return false;
    }

    const redundant = new Set();
    for (const e of edges) {
      if (e.critical || !idSet.has(e.from) || !idSet.has(e.to)) continue;
      adj.get(e.from).delete(e.to);
      if (reachable(e.from, e.to)) redundant.add(e);
      else adj.get(e.from).add(e.to); // not actually redundant — put it back
    }

    return edges.filter((e) => !redundant.has(e));
  }

  global.GHDG_TRANSITIVE = { hideTransitiveEdges };
})(typeof window !== "undefined" ? window : globalThis);
