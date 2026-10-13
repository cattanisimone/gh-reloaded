// GitHub's Projects app dropped the file prefix from its CSS-module class
// names (`Board-module__boardContainer__x` became `boardContainer__x`).
// Full-width board and Standup mode must match the local name plus `__`,
// which is present in both generations, never the `<file>-module__` prefix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = ["full-width-board/content.js", "full-width-board/content.css", "standup-mode/content.js", "standup-mode/content.css"];

for (const f of files) {
  test(`${f} has no -module__ class selector`, () => {
    const src = fs.readFileSync(path.join(root, "features", f), "utf8");
    // A `-module__` selector is only allowed as the previous-naming fallback
    // next to the current `Name__` form on the same line or the line before.
    const lines = src.split("\n");
    const bad = lines.filter((l, i) => {
      const m = l.match(/\[class\*=["'][^"']*-module__(\w+)["']\]/);
      if (!m) return false;
      return !(l.includes(`${m[1]}__"]`) || (lines[i - 1] || "").includes(`${m[1]}__"]`) || (lines[i + 1] || "").includes(`${m[1]}__"]`));
    });
    assert.deepEqual(bad, []);
  });
}
