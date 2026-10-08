// content/lineage.js — upstream/downstream reach of a card in the displayed graph.
//
// Pure logic, kept out of content.js so the unit tests can load it on its own.

(function (global) {
  // Returns the set of card ids to keep highlighted when `selectedId` is
  // clicked: the card itself, every card reachable by following edges forward
  // (downstream: what it blocks, directly or not) and every card reachable by
  // following them backward (upstream: what blocks it, directly or not). Works
  // on the edges as displayed, so a hidden edge never extends the reach. Safe
  // on cycles. Returns an empty set when nothing is selected.
  function lineage(selectedId, edges) {
    const reached = new Set();
    if (selectedId == null) return reached;
    reached.add(selectedId);

    for (const [near, far] of [["from", "to"], ["to", "from"]]) {
      const next = new Map();
      for (const e of edges) {
        if (!next.has(e[near])) next.set(e[near], []);
        next.get(e[near]).push(e[far]);
      }
      const seen = new Set([selectedId]);
      const stack = [selectedId];
      while (stack.length) {
        for (const n of next.get(stack.pop()) || []) {
          if (seen.has(n)) continue;
          seen.add(n);
          reached.add(n);
          stack.push(n);
        }
      }
    }
    return reached;
  }

  global.GHDG_LINEAGE = { lineage };
})(typeof window !== "undefined" ? window : globalThis);
