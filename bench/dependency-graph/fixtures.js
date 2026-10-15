// Seeded, fictional dependency graphs for the layout benchmark and its tests.
// Ids are plain numbers; titles are generic. Same (kind, size, seed) always
// gives the same graph.

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const KINDS = ["chain", "diamond", "fanout", "fanin", "dense", "longspan", "islands", "external", "cycle"];

function mkNodes(n, externalFrom = Infinity) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Task ${i + 1}`,
    external: i + 1 > externalFrom,
  }));
}

// Marks the longest chain's edges as critical (the real feature computes this
// in the background; the benchmark only needs a plausible chain).
export function markCritical(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e);
  const memo = new Map();
  const visiting = new Set();
  const best = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return { len: 0, path: [] };
    visiting.add(id);
    let b = { len: 0, path: [] };
    for (const e of out.get(id)) {
      const r = best(e.to);
      if (r.len + 1 > b.len) b = { len: r.len + 1, path: [e, ...r.path] };
    }
    visiting.delete(id);
    memo.set(id, b);
    return b;
  };
  let top = { len: 0, path: [] };
  for (const n of nodes) {
    const r = best(n.id);
    if (r.len > top.len) top = r;
  }
  for (const e of top.path) e.critical = true;
  return edges;
}

export function makeGraph(kind, size, seed = 1) {
  const r = rng(seed * 7919 + size);
  const edges = [];
  // Every kind but "cycle" is a DAG: edges always point from a lower id to a higher one.
  const add = (from, to) => {
    if (kind !== "cycle" && from > to) [from, to] = [to, from];
    if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
  };
  let nodes = mkNodes(size);
  switch (kind) {
    case "chain":
      for (let i = 1; i < size; i++) add(i, i + 1);
      break;
    case "diamond": {
      const w = Math.max(2, Math.round(Math.sqrt(size)));
      for (let i = 2; i <= size; i++) add(Math.max(1, i - 1 - Math.floor(r() * w)), i);
      break;
    }
    case "fanout":
      for (let i = 2; i <= size; i++) add(i <= 1 + Math.ceil(size / 4) ? 1 : 2 + Math.floor(r() * Math.ceil(size / 4)), i);
      break;
    case "fanin":
      for (let i = 1; i < size; i++) add(i, i >= size - Math.ceil(size / 4) ? size : 1 + Math.floor(r() * size));
      break;
    case "dense":
      for (let i = 2; i <= size; i++) {
        const k = 1 + Math.floor(r() * 3);
        for (let j = 0; j < k; j++) add(1 + Math.floor(r() * (i - 1)), i);
      }
      break;
    case "longspan":
      for (let i = 1; i < size; i++) add(i, i + 1);
      for (let i = 0; i < Math.max(2, size / 6); i++) {
        const a = 1 + Math.floor(r() * (size - 3));
        add(a, Math.min(size, a + 3 + Math.floor(r() * 4)));
      }
      break;
    case "islands": {
      const per = Math.max(2, Math.floor(size / 4));
      for (let i = 1; i < size; i++) if (i % per !== 0 && r() < 0.8) add(i, i + 1);
      break;
    }
    case "external": {
      const internal = Math.ceil(size * 0.7);
      nodes = mkNodes(size, internal);
      for (let i = 2; i <= internal; i++) add(1 + Math.floor(r() * (i - 1)), i);
      for (let i = internal + 1; i <= size; i++) (r() < 0.5 ? add(i, 1 + Math.floor(r() * internal)) : add(1 + Math.floor(r() * internal), i));
      break;
    }
    case "cycle":
      for (let i = 1; i < size; i++) add(i, i + 1);
      add(size, Math.max(1, size - 2));
      if (size > 6) add(Math.ceil(size / 2), 1);
      break;
    default:
      throw new Error(`unknown kind ${kind}`);
  }
  return { nodes, edges: markCritical(nodes, edges) };
}

export const SIZES = [8, 20, 40, 80, 150];
