import { loadGlobals, bytes, flattenPath } from "./util.js";

const FILES = ["features/dependency-graph/order.js", "features/dependency-graph/route.js", "features/dependency-graph/layout.js"];
const L = loadGlobals(FILES).GHDG_LAYOUT;

export default {
  name: "custom",
  shippedBytes: bytes(...FILES),
  usesPrev: true,
  async layout(graph, dims, prev) {
    const r = L.layout(graph.nodes, graph.edges, "right", dims, prev || null);
    const routes = new Map();
    for (const [k, v] of r.routes) routes.set(k, { points: flattenPath(v.d), back: v.back });
    return { positions: r.positions, routes, width: r.width, height: r.height, order: r.order };
  },
};
