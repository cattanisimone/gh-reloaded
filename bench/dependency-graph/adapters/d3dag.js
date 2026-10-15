import { graphStratify, sugiyama, layeringSimplex, decrossOpt, decrossTwoLayer, coordQuad, coordSimplex } from "d3-dag";
import { bytes, normalize, keyOf } from "./util.js";

export default {
  name: "d3-dag",
  shippedBytes: bytes("node_modules/d3-dag/dist/d3-dag.iife.min.js"),
  async layout(graph, dims) {
    const ids = graph.nodes.map((n) => String(n.id));
    const parents = new Map(ids.map((id) => [id, []]));
    // d3-dag needs a DAG: drop edges that close a cycle (DFS back edges), the
    // same way every engine here has to cope; they are drawn as straight lines.
    const out = new Map(ids.map((id) => [id, []]));
    for (const e of graph.edges) out.get(String(e.from)).push(String(e.to));
    const state = new Map();
    const back = new Set();
    const dfs = (u) => {
      state.set(u, 1);
      for (const v of out.get(u)) {
        if (state.get(v) === 1) back.add(`${u}\u0000${v}`);
        else if (!state.get(v)) dfs(v);
      }
      state.set(u, 2);
    };
    for (const id of ids) if (!state.get(id)) dfs(id);
    for (const e of graph.edges) if (!back.has(`${e.from}\u0000${e.to}`)) parents.get(String(e.to)).push(String(e.from));
    const dag = graphStratify()
      .id((d) => d.id)
      .parentIds((d) => d.parents)(ids.map((id) => ({ id, parents: parents.get(id) })));
    const layout = sugiyama()
      .layering(layeringSimplex())
      .decross(ids.length <= 12 ? decrossOpt() : decrossTwoLayer())
      .coord(ids.length <= 40 ? coordSimplex() : coordQuad())
      .nodeSize([dims.NODE_H + dims.ROW_GAP, dims.NODE_W + dims.COL_GAP])
      .gap([0, 0]);
    layout(dag);
    // d3-dag lays out top-down: x is the cross axis (rows), y the layer (columns).
    const positions = new Map();
    for (const node of dag.nodes()) {
      const n = graph.nodes.find((q) => String(q.id) === node.data.id);
      positions.set(n.id, { x: node.y, y: node.x - dims.NODE_H / 2 });
    }
    const routes = new Map();
    for (const link of dag.links()) {
      const e = graph.edges.find((q) => String(q.from) === link.source.data.id && String(q.to) === link.target.data.id);
      routes.set(keyOf(e), { points: link.points.map(([x, y], i, a) => ({ x: i === 0 ? y - dims.COL_GAP : i === a.length - 1 ? y : y - dims.COL_GAP / 2, y: x })) });
    }
    for (const k of back) {
      const [f, t] = k.split("\u0000");
      const e = graph.edges.find((q) => String(q.from) === f && String(q.to) === t);
      const a = positions.get(e.from), b = positions.get(e.to);
      routes.set(keyOf(e), { points: [{ x: a.x, y: a.y + dims.NODE_H / 2 }, { x: b.x + dims.NODE_W, y: b.y + dims.NODE_H / 2 }], back: true });
    }
    return normalize(positions, routes, dims);
  },
};
