// Runs every layout engine over the seeded fixtures and writes
// results/results.json, results/report.md and a few side-by-side SVGs.
//   npm run bench:graph            full run (sizes 8..150, 5 seeds, 30 timing runs)
//   npm run bench:graph -- --quick small sizes, 2 seeds, 5 timing runs
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { makeGraph, KINDS, SIZES } from "./fixtures.js";
import { score, stability, percentile } from "./metrics.js";
import { loadGlobals } from "./adapters/util.js";

const quick = process.argv.includes("--quick");
const sizes = quick ? [8, 20, 40] : SIZES;
const seeds = quick ? [1, 2] : [1, 2, 3, 4, 5];
const runs = quick ? 5 : 30;
const outDir = new URL("./results/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const { EMBEDDED_DIMS, FULLSCREEN_DIMS } = loadGlobals([
  "features/dependency-graph/order.js",
  "features/dependency-graph/route.js",
  "features/dependency-graph/layout.js",
]).GHDG_LAYOUT;

export async function loadAdapters() {
  const names = ["current", "custom", "dagre", "d3dag", "elk", "graphviz"];
  return Promise.all(names.map(async (n) => (await import(`./adapters/${n}.js`)).default));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function svgOf(graph, res, dims) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(res.width)}" height="${Math.ceil(res.height)}" font-family="sans-serif" font-size="11">`, '<rect width="100%" height="100%" fill="#fff"/>'];
  for (const e of graph.edges) {
    const r = res.routes.get(`${e.from}\u0000${e.to}`);
    if (!r) continue;
    const d = r.points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${e.critical ? "#bc4c00" : "#8c959f"}" stroke-width="${e.critical ? 2.5 : 1.5}"${r.back ? ' stroke-dasharray="3 3"' : ""}/>`);
  }
  for (const n of graph.nodes) {
    const p = res.positions.get(n.id);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${dims.NODE_W}" height="${dims.NODE_H}" rx="6" fill="#f6f8fa" stroke="#d1d9e0"${n.external ? ' stroke-dasharray="4 3"' : ""}/>`, `<text x="${p.x + 8}" y="${p.y + 20}" fill="#1f2328">${esc(n.title)}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

async function main() {
  const adapters = await loadAdapters();
  const rows = []; // one per adapter × dims × kind × size × seed
  for (const dimsName of ["embedded", "fullscreen"]) {
    const dims = dimsName === "embedded" ? EMBEDDED_DIMS : FULLSCREEN_DIMS;
    for (const kind of KINDS) {
      for (const size of sizes) {
        for (const seed of seeds) {
          const graph = makeGraph(kind, size, seed);
          for (const a of adapters) {
            const res = await a.layout(graph, dims);
            rows.push({ engine: a.name, dims: dimsName, kind, size, seed, ...score(graph, res, dims) });
          }
        }
      }
    }
  }

  // Stability (embedded): lay out, drop the last card and its edges, lay out again.
  // The custom engine is given the previous order, as the extension does.
  const stab = [];
  const dims = EMBEDDED_DIMS;
  for (const kind of KINDS.filter((k) => k !== "cycle")) {
    for (const size of sizes.filter((s) => s >= 20)) {
      for (const seed of seeds) {
        const graph = makeGraph(kind, size, seed);
        const gone = graph.nodes[graph.nodes.length - 1].id;
        const small = { nodes: graph.nodes.filter((n) => n.id !== gone), edges: graph.edges.filter((e) => e.from !== gone && e.to !== gone) };
        for (const a of adapters) {
          const first = await a.layout(graph, dims);
          const second = await a.layout(small, dims, a.usesPrev ? first.order : undefined);
          stab.push({ engine: a.name, kind, size, seed, ...stability(first, second, dims) });
        }
      }
    }
  }

  // Latency: median and p95 over `runs` layouts.
  const timing = [];
  for (const size of sizes) {
    const graph = makeGraph("dense", size, 1);
    for (const a of adapters) {
      const n = (a.name === "elk" || a.name === "graphviz") && size >= 80 ? Math.min(runs, 10) : runs;
      const ms = [];
      for (let i = 0; i < n + 2; i++) {
        const t = performance.now();
        await a.layout(graph, dims);
        if (i >= 2) ms.push(performance.now() - t);
      }
      timing.push({ engine: a.name, size, runs: n, median: percentile(ms, 50), p95: percentile(ms, 95) });
    }
  }

  // Side-by-side SVGs of one fictional graph.
  const sample = makeGraph("longspan", 20, 1);
  for (const a of adapters) writeFileSync(new URL(`sample-${a.name}.svg`, outDir), svgOf(sample, await a.layout(sample, dims), dims));

  const summary = adapters.map((a) => {
    const mine = rows.filter((r) => r.engine === a.name && r.dims === "embedded");
    const mineFull = rows.filter((r) => r.engine === a.name);
    const nonCycle = mine.filter((r) => r.kind !== "cycle");
    const s = stab.filter((r) => r.engine === a.name);
    const t = timing.filter((r) => r.engine === a.name);
    return {
      engine: a.name,
      shippedKB: Math.round(a.shippedBytes / 1024),
      gateLeftToRight: mineFull.filter((r) => r.kind !== "cycle").every((r) => r.leftToRight),
      gateAllDrawn: mineFull.every((r) => r.allEdgesDrawn),
      gateNoCardOverlap: mineFull.every((r) => r.cardOverlaps === 0),
      edgeCardHitsTotal: nonCycle.reduce((x, r) => x + r.edgeCardHits, 0),
      backEdgeHitsTotal: mine.reduce((x, r) => x + r.backEdgeHits, 0),
      crossingsMean: mean(nonCycle.map((r) => r.crossings)),
      overlapsMean: mean(nonCycle.map((r) => r.overlaps)),
      critDeviationMean: mean(nonCycle.map((r) => r.criticalDeviation)),
      widthMean: mean(nonCycle.map((r) => r.width)),
      heightMean: mean(nonCycle.map((r) => r.height)),
      inversionsMean: mean(s.map((r) => r.inversions)),
      movedMean: mean(s.map((r) => r.moved)),
      p95At80: t.find((r) => r.size === (sizes.includes(80) ? 80 : 40))?.p95,
    };
  });

  writeFileSync(new URL("results.json", outDir), JSON.stringify({ quick, sizes, seeds, runs, summary, timing, stability: stab }, null, 1));
  writeFileSync(new URL("report.md", outDir), report({ quick, sizes, seeds, runs, summary, timing, rows }));
  console.table(summary.map((s) => ({ ...s, crossingsMean: s.crossingsMean.toFixed(1), widthMean: Math.round(s.widthMean), heightMean: Math.round(s.heightMean) })));
}

const f = (n, d = 1) => (n === undefined ? "n/a" : n.toFixed(d));

function report({ quick, sizes, seeds, runs, summary, timing, rows }) {
  const L = [];
  L.push("# Dependency graph layout benchmark", "");
  L.push(`Generated by \`npm run bench:graph\`${quick ? " --quick" : ""}: sizes ${sizes.join(", ")}, ${seeds.length} seeds per kind, ${KINDS.length} kinds (${KINDS.join(", ")}), embedded and full-screen card sizes, timing over ${runs} runs. Fictional data only.`, "");
  L.push("Every metric is computed on the rendered edge paths (each curve flattened to a polyline), so all engines are scored the same way. `current` is the renderer as it was before this change. Cycle fixtures are excluded from the readability columns (every engine handles cycles differently) and counted in the gates.", "");
  L.push("## Gates and readability (means per fixture, embedded cards)", "");
  L.push("| engine | gates (right of blocker, all drawn, no card overlap) | edge-card hits (sum) | back-edge hits | crossings | shared stretches | critical deviation px | width px | height px |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of summary) L.push(`| ${s.engine} | ${s.gateLeftToRight && s.gateAllDrawn && s.gateNoCardOverlap ? "pass" : `fail (${[!s.gateLeftToRight && "order", !s.gateAllDrawn && "drawn", !s.gateNoCardOverlap && "overlap"].filter(Boolean).join(", ")})`} | ${s.edgeCardHitsTotal} | ${s.backEdgeHitsTotal} | ${f(s.crossingsMean)} | ${f(s.overlapsMean)} | ${f(s.critDeviationMean)} | ${Math.round(s.widthMean)} | ${Math.round(s.heightMean)} |`);
  L.push("", "## Stability after removing one card, and latency", "");
  L.push("| engine | order inversions | cards that changed column | p95 ms at the largest dense fixture of the run (80, or 40 in quick mode) | shipped size KB (as a plain script) |", "|---|---:|---:|---:|---:|");
  for (const s of summary) L.push(`| ${s.engine} | ${f(s.inversionsMean, 2)} | ${f(s.movedMean, 2)} | ${f(s.p95At80)} | ${s.shippedKB || "0 (in the repo)"} |`);
  L.push("", "Stability: the custom engine is given the previous order, as the extension does; the others lay out cold, as they would on every refresh.", "");
  L.push("## Latency by size (dense fixture, ms, median / p95)", "");
  const engines = summary.map((s) => s.engine);
  L.push(`| size | ${engines.join(" | ")} |`, `|---:|${engines.map(() => "---:").join("|")}|`);
  for (const size of sizes) L.push(`| ${size} | ${engines.map((e) => { const t = timing.find((x) => x.engine === e && x.size === size); return `${f(t.median)} / ${f(t.p95)}`; }).join(" | ")} |`);
  L.push("", "## Samples", "", "One fictional 20-card graph with long edges, same card size for every engine: " + engines.map((e) => `[${e}](sample-${e}.svg)`).join(", ") + ".", "");
  return L.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
