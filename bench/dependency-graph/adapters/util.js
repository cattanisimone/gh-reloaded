import { readFileSync, statSync } from "node:fs";
import vm from "node:vm";
import { flattenPath } from "../metrics.js";

export const root = new URL("../../../", import.meta.url);

export function loadGlobals(files) {
  const context = {};
  context.globalThis = context;
  for (const f of files) vm.runInNewContext(readFileSync(new URL(f, root), "utf8"), context);
  return context;
}
export const bytes = (...files) => files.reduce((n, f) => n + statSync(new URL(f, root)).size, 0);
export const keyOf = (e) => `${e.from}\u0000${e.to}`;
export { flattenPath };

// Cards of every engine are the same size; engines give the card's top-left.
export function normalize(positions, routes, dims, pad = 24) {
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + dims.NODE_W); maxY = Math.max(maxY, p.y + dims.NODE_H);
  }
  for (const r of routes.values()) for (const p of r.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return { positions, routes, width: pad * 2, height: pad * 2 };
  const dx = pad - minX, dy = pad - minY;
  for (const p of positions.values()) { p.x += dx; p.y += dy; }
  for (const r of routes.values()) for (const p of r.points) { p.x += dx; p.y += dy; }
  return { positions, routes, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}
