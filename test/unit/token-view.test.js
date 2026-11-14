import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenView, rowHtml, resultHtml, resultView, warningDetailsHtml, stepsFor, warningStepsHtml, whichLines, testHint, displayName } from "../../options/token-view.js";
import { enabledFeatures, requiredTypes } from "../../options/token-requirements.js";
import { runTokenTest } from "../../options/token-test.js";

const at = new Date(2026, 0, 5, 9, 12).getTime();
const codes = (over) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked", ...over });
const entries = [
  { id: "d", isDefault: true, name: "Personal", owner: "", token: "github_pat_AAAA" },
  { id: "w", isDefault: false, name: "Work – acme-demo", owner: "acme-demo", token: "ghp_BBBB" },
  { id: "t", isDefault: false, name: "", owner: "example-lab", token: "" },
];
const tests = { d: { at, codes: codes() }, w: { at, codes: codes({ pulls: "denied", issues: "unverified" }) } };
const features = enabledFeatures({});
const base = { entries, tests, results: new Map(), runs: new Set(), required: requiredTypes(features), features, version: "9.9.9", ui: { laterHidden: false, stepsKey: null, editingId: null, diags: new Set() } };

test("rows: names, tag, use, state, note and last test come from the view and are all rendered", () => {
  const v = tokenView(base);
  assert.equal(v.rows.length, 3);
  const [d, w, t] = v.rows;
  assert.equal(d.defaultTag, true);
  assert.equal(d.use, "Used for: all repositories");
  assert.equal(w.label, "Missing permissions");
  assert.equal(w.note, "1 check couldn't be verified");
  assert.equal(t.label, "Not set");
  assert.equal(t.canTest, false);
  for (const r of v.rows) {
    const html = rowHtml(r);
    for (const field of [r.name, r.use, r.label, r.last, r.note]) assert.ok(!field || html.includes(field.replace(/'/g, "'")), `${r.id}: ${field} not rendered`);
  }
  assert.ok(rowHtml(d).includes('class="tag"'));
  assert.ok(!rowHtml(w).includes('class="tag"'));
  assert.ok(rowHtml(w).includes("has-note"));
  assert.ok(!rowHtml(t).includes('data-act="test"'));
});

test("a running test shows Testing… and disables Test", () => {
  const v = tokenView({ ...base, runs: new Set(["w"]) });
  assert.equal(v.rows[1].label, "Testing…");
  assert.match(rowHtml(v.rows[1]), /data-act="test"[^>]*disabled/);
  assert.notEqual(v.rows[1].last, "Testing…", "Testing… appears once (the pill), not in the last-test line too");
});

test("warning: per-permission rows, the version sentence and the read-only note are all rendered", () => {
  const w = tokenView(base).warning;
  assert.ok(w);
  assert.deepEqual(w.perms.map((p) => p.name), ["Pull requests"]);
  assert.ok(w.uses.length >= 1 && w.uses.every((u) => u.startsWith("GH Reloaded 9.9.9 uses")));
  const html = warningDetailsHtml(w);
  for (const p of w.perms) assert.ok(html.includes(p.name) && html.includes("Read-only") && p.reasons.every((r) => html.includes(r.slice(0, 20))));
  for (const u of w.uses) assert.ok(html.includes(u));
  assert.ok(html.includes("GH Reloaded never writes to GitHub."));
  assert.match(w.body, /«Work – acme-demo»/);
});

test("steps are shown only while their key is the current one; Later or a changed set drops them", () => {
  const w = tokenView(base).warning;
  assert.equal(w.steps.shown, false);
  const shown = tokenView({ ...base, ui: { ...base.ui, stepsKey: w.steps.key } }).warning;
  assert.equal(shown.steps.shown, true);
  // a different permission set → a different key → hidden again
  const other = tokenView({ ...base, tests: { ...tests, w: { at, codes: codes({ contents: "denied", pulls: "denied" }) } }, ui: { ...base.ui, stepsKey: w.steps.key } }).warning;
  assert.notEqual(other.steps.key, w.steps.key);
  assert.equal(other.steps.shown, false);
  assert.equal(tokenView({ ...base, ui: { ...base.ui, laterHidden: true } }).warning, null);
  const html = warningStepsHtml(w.steps);
  assert.equal((html.match(/<li>/g) || []).length, 4);
  assert.match(html, /href="https:\/\/github\.com\/settings\/tokens"/); // the Work token is classic
  assert.match(html, /target="_blank" rel="noopener"/);
  assert.match(warningStepsHtml(tokenView({ ...base, entries: [entries[0], { ...entries[1], token: "github_pat_X" }, entries[2]] }).warning.steps), /personal-access-tokens/);
});

test("result: header with time and count, intro, checks with reason lines, summary and advice are rendered", async () => {
  const fetch = async (url) => {
    const ok = (body, headers = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (url.endsWith("/user")) return ok({ login: "sam" }, { "x-oauth-scopes": "repo" });
    if (url.includes("/orgs/acme-demo/repos")) return ok([{ full_name: "acme-demo/app", private: true }]);
    if (url.includes("/pulls?")) return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 });
    if (url.endsWith("/graphql")) return ok({ data: { organization: { projectsV2: { totalCount: 1 } } } });
    return ok([]);
  };
  const res = await runTokenTest({ token: "ghp_BBBB", owner: "acme-demo" }, { fetch });
  const view = resultView(entries[1], res, { required: base.required });
  assert.equal(view.title, "Test result · Work – acme-demo");
  assert.match(view.when, / · \d of \d OK$/);
  assert.equal(view.lines.length, 5);
  assert.ok(view.advice.length >= 1);
  const html = resultHtml(view);
  for (const s of [view.title, view.when, view.intro, view.summary, ...view.lines.flatMap((l) => [l.label, l.pill, l.reason]), ...view.advice.flatMap((a) => [a.lead])]) assert.ok(html.includes(s.replace(/'/g, "'")), `not rendered: ${s}`);
  assert.ok(html.indexOf("tr-intro") < html.indexOf("tr-lines"));
  assert.ok(view.intro.startsWith("One read-only check per permission type"));
  const failed = resultHtml(resultView(entries[1], { outcome: "temporary", message: "offline" }, { required: base.required }));
  assert.ok(failed.includes("Not checked: offline"));
});

test("panel texts: the default token is named, the hint merges the reason with what Test does", () => {
  assert.deepEqual(whichLines({ isDefault: false, owner: "acme-demo", defaultName: displayName(entries[0]) }), [
    "Repositories owned by acme-demo use this token.",
    "Every other owner uses the default token «Personal».",
    "If this token fails, GH Reloaded doesn't try another one.",
  ]);
  assert.equal(whichLines({ isDefault: true }).length, 2);
  assert.equal(testHint("Enter a token to test it"), "Enter a token to test it. Test checks permissions without saving or changing anything.");
  assert.equal(testHint(""), "Test checks permissions without saving or changing anything.");
});

test("the token CSS block declares every selector once", () => {
  const css = readFileSync(new URL("../../options/options.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("/* --- Token section:"));
  const flat = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const seen = new Map();
  // Top-level rules only (not inside @media / @container): "selector { … }".
  let depth = 0;
  let buf = "";
  for (const ch of flat) {
    if (ch === "{") { if (depth === 0) { const sel = buf.trim(); if (!sel.startsWith("@")) seen.set(sel, (seen.get(sel) || 0) + 1); buf = ""; } depth++; }
    else if (ch === "}") { depth--; if (depth === 0) buf = ""; }
    else if (depth === 0) buf += ch;
  }
  const dups = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
  assert.deepEqual(dups, []);
});

test("steps: the opened steps never say scope(s) or scopes", () => {
  for (const classic of [true, false]) {
    const s = stepsFor({ classic, names: "Projects", ids: ["a"] });
    assert.doesNotMatch([s.url, ...s.rest].join(" ").replace(/https?:\/\/\S+/g, ""), /scope/i);
  }
});
