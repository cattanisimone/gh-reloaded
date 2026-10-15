// The renderer as it was: degree ordering, edges that skip 2+ columns arc over the top.
import { loadGlobals, bytes, keyOf, flattenPath } from "./util.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
context.window = context;
vm.runInNewContext(readFileSync(new URL("./baseline-layout.cjs", import.meta.url), "utf8"), context);
const L = context.GHDG_LAYOUT;

export default {
  name: "current",
  shippedBytes: 0,
  async layout(graph, dims) {
    const { positions, width, height } = L.layout(graph.nodes, graph.edges, "right", { ...dims, ARC_CLEAR_Y: 10 });
    const routes = new Map();
    for (const e of graph.edges) {
      const a = positions.get(e.from), b = positions.get(e.to);
      const apart = Math.round((b.x - a.x) / (dims.NODE_W + dims.COL_GAP));
      const d = apart >= 2
        ? `M ${a.x + dims.NODE_W / 2} ${a.y} C ${a.x + dims.NODE_W / 2} 10, ${b.x + dims.NODE_W / 2} 10, ${b.x + dims.NODE_W / 2} ${b.y}`
        : (() => {
            const x1 = a.x + dims.NODE_W, y1 = a.y + dims.NODE_H / 2, x2 = b.x, y2 = b.y + dims.NODE_H / 2;
            const dx = Math.max(40, (x2 - x1) / 2);
            return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
          })();
      routes.set(keyOf(e), { points: flattenPath(d) });
    }
    return { positions, routes, width, height };
  },
};
