import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const md = fs.readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

test('AGENTS.md has an "Options / settings UX" section naming the Features/Advanced split', () => {
  const m = md.match(/^## Options \/ settings UX\n([\s\S]*?)(?=^## )/m);
  assert.ok(m, "section heading missing");
  assert.match(m[1], /Features/);
  assert.match(m[1], /Advanced/);
  assert.match(m[1], /Configure/);
  assert.match(m[1], /storage key/);
});
