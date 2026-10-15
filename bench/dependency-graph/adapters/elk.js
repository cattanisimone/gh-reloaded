import ELK from "elkjs/lib/elk.bundled.js";
import { bytes, normalize, keyOf } from "./util.js";

const elk = new ELK();
export default {
  name: "elk",
  shippedBytes: bytes("node_modules/elkjs/lib/elk.bundled.js"),
  async layout(graph, dims) {
    const out = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": String(dims.ROW_GAP),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(dims.COL_GAP),
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.cycleBreaking.strategy": "GREEDY",
      },
      children: graph.nodes.map((n) => ({ id: String(n.id), width: dims.NODE_W, height: dims.NODE_H })),
      edges: graph.edges.map((e, i) => ({ id: `e${i}`, sources: [String(e.from)], targets: [String(e.to)] })),
    });
    const positions = new Map(out.children.map((c) => [graph.nodes.find((n) => String(n.id) === c.id).id, { x: c.x, y: c.y }]));
    const routes = new Map();
    out.edges.forEach((ed, i) => {
      const s = ed.sections[0];
      routes.set(keyOf(graph.edges[i]), { points: [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => ({ x: p.x, y: p.y })) });
    });
    return normalize(positions, routes, dims);
  },
};
