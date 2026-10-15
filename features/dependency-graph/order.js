// content/order.js — the graph-shaped half of the layout: cycle handling,
// dummy lanes for edges that skip columns, and crossing reduction.
//
// Pure logic with no card sizes in it, so the embedded and the full-screen
// view share one order. Kept out of content.js so the unit tests (and the
// benchmark) can load it on its own.
//
// Items are the strings of the card ids, plus one "dummy" item per column an
// edge skips. A dummy is a lane slot: it keeps the edge in its own row between
// the cards of that column instead of letting it cross them.

(function (global) {
  const SEP = "\u0000";
  const edgeKey = (from, to) => `${from}${SEP}${to}`;
  const cmpId = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  // Normalizes the edges (drops self loops, duplicates and edges whose ends
  // are not cards) and finds the back edges that close a cycle. The DFS visits
  // cards and neighbours in id order, so the same graph always yields the same
  // back edges whatever order the input came in. Back edges stay in `all`:
  // none is hidden, they are only drawn differently.
  function analyze(nodes, edges) {
    const ids = nodes.map((n) => String(n.id)).sort(cmpId);
    const known = new Set(ids);
    const seen = new Set();
    const all = [];
    for (const e of edges) {
      const from = String(e.from);
      const to = String(e.to);
      const key = edgeKey(from, to);
      if (from === to || !known.has(from) || !known.has(to) || seen.has(key)) continue;
      seen.add(key);
      all.push({ from, to, key, critical: !!e.critical });
    }
    all.sort((a, b) => cmpId(a.from, b.from) || cmpId(a.to, b.to));

    const out = new Map(ids.map((id) => [id, []]));
    for (const e of all) out.get(e.from).push(e);

    // Strongly connected components (Tarjan, iterative). A back edge is chosen
    // inside one component by a DFS from its smallest id, so adding a card
    // outside a cycle never changes which of its edges is the back edge.
    const index = new Map();
    const low = new Map();
    const comp = new Map();
    const onStack = new Set();
    const tstack = [];
    let counter = 0;
    let comps = 0;
    for (const root of ids) {
      if (index.has(root)) continue;
      const work = [{ id: root, i: 0 }];
      index.set(root, counter);
      low.set(root, counter++);
      tstack.push(root);
      onStack.add(root);
      while (work.length) {
        const top = work[work.length - 1];
        const list = out.get(top.id);
        if (top.i < list.length) {
          const to = list[top.i++].to;
          if (!index.has(to)) {
            index.set(to, counter);
            low.set(to, counter++);
            tstack.push(to);
            onStack.add(to);
            work.push({ id: to, i: 0 });
          } else if (onStack.has(to)) low.set(top.id, Math.min(low.get(top.id), index.get(to)));
        } else {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1].id;
            low.set(parent, Math.min(low.get(parent), low.get(top.id)));
          }
          if (low.get(top.id) === index.get(top.id)) {
            let w;
            do {
              w = tstack.pop();
              onStack.delete(w);
              comp.set(w, comps);
            } while (w !== top.id);
            comps++;
          }
        }
      }
    }

    const state = new Map(); // 1 = on the stack, 2 = done
    const backEdges = new Set();
    for (const root of ids) {
      if (state.has(root)) continue;
      const stack = [{ id: root, i: 0 }];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = out.get(top.id).filter((e) => comp.get(e.to) === comp.get(top.id));
        if (top.i >= list.length) {
          state.set(top.id, 2);
          stack.pop();
          continue;
        }
        const e = list[top.i++];
        const st = state.get(e.to);
        if (st === 1) backEdges.add(e.key);
        else if (!st) {
          state.set(e.to, 1);
          stack.push({ id: e.to, i: 0 });
        }
      }
    }
    return { ids, edges: all, backEdges, forwardEdges: all.filter((e) => !backEdges.has(e.key)) };
  }

  const dummyId = (key, col) => `\u0001${key}${SEP}${col}`;
  const isDummy = (id) => id.charCodeAt(0) === 1;

  // Splits every forward edge that skips columns into one hop per column.
  // Returns the columns (arrays of items), the hops between adjacent columns
  // and, per edge key, the dummy items it passes through.
  function buildLayers(ids, rank, forwardEdges) {
    const maxCol = Math.max(0, ...ids.map((id) => rank.get(id) ?? 0));
    const cols = Array.from({ length: maxCol + 1 }, () => []);
    for (const id of ids) cols[rank.get(id) ?? 0].push(id);
    const hops = Array.from({ length: maxCol }, () => []); // hops[c]: c -> c+1
    const chains = new Map();
    for (const e of forwardEdges) {
      const a = rank.get(e.from) ?? 0;
      const b = rank.get(e.to) ?? 0;
      const chain = [];
      let prev = e.from;
      for (let c = a + 1; c < b; c++) {
        const d = dummyId(e.key, c);
        cols[c].push(d);
        chain.push(d);
        hops[c - 1].push({ from: prev, to: d, edge: e });
        prev = d;
      }
      hops[b - 1].push({ from: prev, to: e.to, edge: e });
      chains.set(e.key, chain);
    }
    return { cols, hops, chains };
  }

  function positionsOf(cols) {
    const pos = new Map();
    for (const col of cols) col.forEach((id, i) => pos.set(id, i));
    return pos;
  }

  function crossingsBetween(hop, pos) {
    let n = 0;
    for (let i = 0; i < hop.length; i++) {
      const a = pos.get(hop[i].from);
      const b = pos.get(hop[i].to);
      for (let j = i + 1; j < hop.length; j++) {
        const c = pos.get(hop[j].from);
        const d = pos.get(hop[j].to);
        if ((a - c) * (b - d) < 0) n++;
      }
    }
    return n;
  }

  function totalCrossings(cols, hops) {
    const pos = positionsOf(cols);
    let n = 0;
    for (const hop of hops) n += crossingsBetween(hop, pos);
    return n;
  }

  // Reorders one column by the median position of each item's neighbours in
  // the reference column. Items without neighbours there keep their slot.
  function sortByMedian(col, neighbours, refPos) {
    const keyed = [];
    const slots = [];
    col.forEach((id, i) => {
      const ns = (neighbours.get(id) || []).map((n) => refPos.get(n)).filter((p) => p !== undefined).sort((a, b) => a - b);
      if (!ns.length) return;
      const m = ns.length >> 1;
      keyed.push({ id, med: ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2, i });
      slots.push(i);
    });
    keyed.sort((a, b) => a.med - b.med || a.i - b.i);
    const next = col.slice();
    slots.forEach((slot, k) => (next[slot] = keyed[k].id));
    return next;
  }

  function neighbourMaps(hops) {
    const left = new Map();
    const right = new Map();
    const push = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
    for (const hop of hops) {
      for (const h of hop) {
        push(right, h.from, h.to);
        push(left, h.to, h.from);
      }
    }
    return { left, right };
  }

  // Swaps neighbours in a column while that lowers the crossings they take part
  // in. `pos` (item -> index in its column) is kept up to date as items swap.
  function transpose(cols, left, right, pos, c) {
    const col = cols[c];
    // Crossings between the edges of `u` (above) and `v` (below) on both sides.
    const cross = (u, v) => {
      let n = 0;
      for (const side of [left, right]) {
        const us = side.get(u);
        const vs = side.get(v);
        if (!us || !vs) continue;
        for (const a of us) for (const b of vs) if (pos.get(a) > pos.get(b)) n++;
      }
      return n;
    };
    let any = false;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i + 1 < col.length; i++) {
        const u = col[i];
        const v = col[i + 1];
        if (cross(v, u) < cross(u, v)) {
          col[i] = v;
          col[i + 1] = u;
          pos.set(v, i);
          pos.set(u, i + 1);
          improved = any = true;
        }
      }
    }
    return any;
  }

  // Orders the items of every column to reduce crossings.
  //
  // Fresh layout: an initial left-to-right order by median, then median sweeps
  // down and up plus a transpose pass, keeping the best order seen. Refresh
  // (`prev` knows most items): the known items keep their previous relative
  // order and only the new ones are inserted, each where it adds the fewest
  // crossings, so a refresh that adds or drops a card moves nothing else.
  function orderItems(layers, degree, prev) {
    const { cols, hops } = layers;
    const { left, right } = neighbourMaps(hops);
    const all = cols.flat();
    const prevIdx = new Map();
    if (prev) prev.forEach((col) => col.forEach((id, i) => prevIdx.set(String(id), i)));
    const known = all.filter((id) => prevIdx.has(id)).length;

    if (known && known * 2 >= all.length) {
      const placed = cols.map((col) =>
        col.filter((id) => prevIdx.has(id)).sort((a, b) => prevIdx.get(a) - prevIdx.get(b) || cmpId(a, b))
      );
      const fresh = cols.map((col) => col.filter((id) => !prevIdx.has(id)).sort(cmpId));
      const placedSet = new Set(placed.flat());
      for (let c = 0; c < cols.length; c++) {
        for (const id of fresh[c]) {
          placedSet.add(id);
          // Only the crossings the new item takes part in change with its slot:
          // its own edges against the other placed edges of the two hop sets.
          // `side` says which end of a hop sits in this column.
          const sets = [];
          if (c > 0) sets.push({ hop: hops[c - 1], mine: "to", other: "from" });
          if (c < hops.length) sets.push({ hop: hops[c], mine: "from", other: "to" });
          const usable = sets.map((x) => ({ ...x, hop: x.hop.filter((h) => placedSet.has(h.from) && placedSet.has(h.to)) }));
          const pos = positionsOf(placed);
          let best = placed[c].length;
          let bestCost = Infinity;
          for (let at = 0; at <= placed[c].length; at++) {
            let cost = 0;
            for (const { hop, mine, other } of usable) {
              for (const h of hop) {
                if (h[mine] !== id) continue;
                for (const o of hop) {
                  if (o[mine] === id) continue;
                  const here = pos.get(o[mine]) >= at ? 1 : -1; // is the other item below (+1) or above the slot
                  if (here * (pos.get(h[other]) - pos.get(o[other])) > 0) cost++;
                }
              }
            }
            if (cost < bestCost) {
              bestCost = cost;
              best = at;
            }
          }
          placed[c].splice(best, 0, id);
        }
      }
      return placed;
    }

    // Initial order: column 0 by degree then id, then each column by the
    // median of its left neighbours.
    let order = cols.map((col) => col.slice().sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || cmpId(a, b)));
    for (let c = 1; c < order.length; c++) order[c] = sortByMedian(order[c].slice().sort(cmpId), left, positionsOf(order));

    let best = order.map((c) => c.slice());
    let bestCost = totalCrossings(best, hops);
    let stale = 0;
    for (let iter = 0; iter < 24 && bestCost > 0 && stale < 4; iter++) {
      if (iter % 2 === 0) for (let c = 1; c < order.length; c++) order[c] = sortByMedian(order[c], left, positionsOf(order));
      else for (let c = order.length - 2; c >= 0; c--) order[c] = sortByMedian(order[c], right, positionsOf(order));
      const pos = positionsOf(order);
      for (let c = 0; c < order.length; c++) transpose(order, left, right, pos, c);
      const cost = totalCrossings(order, hops);
      if (cost < bestCost) {
        bestCost = cost;
        best = order.map((c) => c.slice());
        stale = 0;
      } else stale++;
    }
    return best;
  }

  global.GHDG_ORDER = { analyze, buildLayers, orderItems, totalCrossings, edgeKey, isDummy, dummyId, cmpId, SEP };
})(typeof window !== "undefined" ? window : globalThis);
