import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { bytes, normalize, keyOf } from "./util.js";

const gv = await Graphviz.load();
export default {
  name: "graphviz",
  shippedBytes: bytes("node_modules/@hpcc-js/wasm-graphviz/dist/index.js"),
  async layout(graph, dims) {
    const dot = [
      `digraph G { rankdir=LR; splines=spline; nodesep=${dims.ROW_GAP / 72}; ranksep=${dims.COL_GAP / 72}; node [shape=box, fixedsize=true, width=${dims.NODE_W / 72}, height=${dims.NODE_H / 72}];`,
      ...graph.nodes.map((n) => `"${n.id}";`),
      ...graph.edges.map((e) => `"${e.from}" -> "${e.to}";`),
      "}",
    ].join("\n");
    const plain = gv.layout(dot, "plain", "dot").split("\n");
    const [, , gw, gh] = plain[0].split(" ");
    const H = +gh * 72;
    const positions = new Map();
    const routes = new Map();
    for (const line of plain) {
      const t = line.trim().split(" ");
      if (t[0] === "node") {
        const n = graph.nodes.find((x) => String(x.id) === t[1].replace(/"/g, ""));
        positions.set(n.id, { x: +t[2] * 72 - dims.NODE_W / 2, y: H - +t[3] * 72 - dims.NODE_H / 2 });
      } else if (t[0] === "edge") {
        const n = +t[3];
        const pts = [];
        for (let i = 0; i < n; i++) pts.push({ x: +t[4 + 2 * i] * 72, y: H - +t[5 + 2 * i] * 72 });
        const e = graph.edges.find((x) => String(x.from) === t[1].replace(/"/g, "") && String(x.to) === t[2].replace(/"/g, ""));
        routes.set(keyOf(e), { points: pts });
      }
    }
    return normalize(positions, routes, dims);
  },
};
