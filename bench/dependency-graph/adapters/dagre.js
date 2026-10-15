import dagre from "dagre";
import { bytes, normalize, keyOf } from "./util.js";

export default {
  name: "dagre",
  shippedBytes: bytes("node_modules/dagre/dist/dagre.min.js"),
  async layout(graph, dims) {
    const g = new dagre.graphlib.Graph({ multigraph: false });
    g.setGraph({ rankdir: "LR", nodesep: dims.ROW_GAP, ranksep: dims.COL_GAP, edgesep: 10, ranker: "network-simplex" });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of graph.nodes) g.setNode(String(n.id), { width: dims.NODE_W, height: dims.NODE_H });
    for (const e of graph.edges) g.setEdge(String(e.from), String(e.to));
    dagre.layout(g);
    const positions = new Map();
    for (const n of graph.nodes) {
      const p = g.node(String(n.id));
      positions.set(n.id, { x: p.x - dims.NODE_W / 2, y: p.y - dims.NODE_H / 2 });
    }
    const routes = new Map();
    for (const e of graph.edges) {
      const ed = g.edge(String(e.from), String(e.to));
      routes.set(keyOf(e), { points: ed.points.map((p) => ({ x: p.x, y: p.y })) });
    }
    return normalize(positions, routes, dims);
  },
};
