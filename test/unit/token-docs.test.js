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

test("classic link preselects read:project and public_repo; repo is documented as optional in README and Settings", () => {
  assert.ok(readme.includes("`repo`") && readme.includes("`read:project`"));
  assert.ok(readme.includes("scopes=read:project,public_repo"));
  assert.ok(readme.includes("`public_repo`"));
  assert.ok(html.includes("scopes=read:project,public_repo"));
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
  assert.ok(html.includes("github_pat_… or ghp_…"));
});

test("Settings lists the Pull requests permission that PR triage needs", () => {
  assert.match(html, /<span>Pull requests\b/);
});

const privacy = read("PRIVACY.md");

test("README and PRIVACY document Test, the session-only codes and Check a specific repository", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy]]) {
    assert.ok(text.includes("**Test**"), `${name} names Test`);
    assert.ok(text.includes("chrome.storage.session"), `${name} says where the outcome is kept`);
    assert.ok(text.includes("Check a specific repository"), `${name} names the repository check`);
    assert.doesNotMatch(text, /\*\*Verify access\*\*/, `${name} no longer documents the old Verify access button`);
  }
  assert.match(readme, /at most 7 read-only requests/);
  assert.ok(readme.includes("screenshots/token-settings/light.svg") && readme.includes("screenshots/token-settings/dark.svg"));
});

test("Settings has the list, the panel, the Full guide and no Verify access button", () => {
  for (const id of ['id="token-list"', 'id="token-panel"', 'id="full-guide"', 'id="token-warning"', 'id="notifications-permission-slot"']) assert.ok(html.includes(id), id);
  assert.doesNotMatch(html + js, /Verify access/);
});
