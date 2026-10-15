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

    const state = new Map(); // 1 = on the stack, 2 = done
    const backEdges = new Set();
    for (const root of ids) {
      if (state.has(root)) continue;
      const stack = [{ id: root, i: 0 }];
      state.set(root, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = out.get(top.id);
        if (top.i >= list.length) {
          state.set(top.id, 2);
          stack.pop();
          continue;
        }
        const e = list[top.i++];
        const s = state.get(e.to);
        if (s === 1) backEdges.add(e.key);
        else if (!s) {
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

  // Swaps neighbours in a column while that lowers the crossings of its two
  // adjacent hop sets.
  function transpose(cols, hops, c) {
    let improved = true;
    let any = false;
    const local = () => {
      const pos = positionsOf([cols[c - 1] || [], cols[c], cols[c + 1] || []]);
      return (c > 0 ? crossingsBetween(hops[c - 1], pos) : 0) + (c < hops.length ? crossingsBetween(hops[c], pos) : 0);
    };
    while (improved) {
      improved = false;
      for (let i = 0; i + 1 < cols[c].length; i++) {
        const before = local();
        [cols[c][i], cols[c][i + 1]] = [cols[c][i + 1], cols[c][i]];
        if (local() < before) {
          improved = true;
          any = true;
        } else [cols[c][i], cols[c][i + 1]] = [cols[c][i + 1], cols[c][i]];
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
      const onlyPlaced = () => hops.map((hop) => hop.filter((h) => placedHas(h.from) && placedHas(h.to)));
      const placedSet = new Set(placed.flat());
      const placedHas = (id) => placedSet.has(id);
      for (let c = 0; c < cols.length; c++) {
        for (const id of fresh[c]) {
          let best = placed[c].length;
          let bestCost = Infinity;
          placedSet.add(id);
          const hs = onlyPlaced();
          for (let at = 0; at <= placed[c].length; at++) {
            const trial = placed[c].slice();
            trial.splice(at, 0, id);
            const next = placed.slice();
            next[c] = trial;
            const cost = totalCrossings(next, hs);
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
      for (let c = 0; c < order.length; c++) transpose(order, hops, c);
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
