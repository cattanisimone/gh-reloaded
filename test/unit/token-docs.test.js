// The README and the Settings page must describe the same two token paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const readme = read("README.md");
const html = read("options/options.html");
const js = read("options/options.js");

test("README documents a fine-grained and a classic path", () => {
  assert.match(readme, /^#### A\. Fine-grained token/m);
  assert.match(readme, /^#### B\. Classic token/m);
  for (const perm of ["Issues", "Contents", "Metadata", "Projects"]) {
    assert.ok(readme.includes(`**${perm}**`), `${perm} still listed`);
  }
});

test("classic scopes are repo and read:project in README and Settings", () => {
  assert.ok(readme.includes("`repo`") && readme.includes("`read:project`"));
  assert.ok(readme.includes("scopes=repo,read:project"));
  assert.ok(html.includes("scopes=repo,read:project"));
  assert.ok(html.includes("Create a classic token"));
});

test("no source claims classic tokens are unsupported", () => {
  for (const [name, text] of [["README", readme], ["options.html", html], ["options.js", js]]) {
    assert.doesNotMatch(text, /not classic/i, name);
    assert.doesNotMatch(text, /fine-grained only/i, name);
    assert.doesNotMatch(text, /never asks for/i, name);
  }
});

test("the token placeholder is type-neutral", () => {
  assert.ok(js.includes("github_pat_… or ghp_…"));
});
