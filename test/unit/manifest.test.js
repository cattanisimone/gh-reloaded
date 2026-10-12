// Chrome Web Store limits on manifest.json, checked before a release job can fail on them.
// Every file the manifest references must also ship in the release zip, whose path list
// and exclusions are read from the `zip -r` step of release.yml (no second copy kept here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const DESCRIPTION_MAX = 132;
const NAME_MAX = 75;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

export function isValidVersion(v) {
  if (typeof v !== "string") return false;
  const parts = v.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  if (!parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535)) return false;
  return parts.some((p) => p !== "0");
}

// Every file path the manifest points at, wherever it appears.
export function referencedPaths(m) {
  const out = new Set();
  const add = (p) => typeof p === "string" && p && out.add(p);
  add(m.background?.service_worker);
  for (const p of Object.values(m.icons || {})) add(p);
  const icon = m.action?.default_icon;
  if (typeof icon === "string") add(icon);
  else for (const p of Object.values(icon || {})) add(p);
  add(m.action?.default_popup);
  add(m.options_page);
  add(m.options_ui?.page);
  add(m.side_panel?.default_path);
  add(m.devtools_page);
  for (const p of Object.values(m.chrome_url_overrides || {})) add(p);
  for (const cs of m.content_scripts || []) {
    for (const p of cs.js || []) add(p);
    for (const p of cs.css || []) add(p);
  }
  for (const p of m.sandbox?.pages || []) add(p);
  for (const w of m.web_accessible_resources || []) {
    for (const p of w.resources || []) add(p);
  }
  return [...out];
}

// Parses the `zip -r "<out>" <paths...> -x <patterns...>` command out of release.yml.
export function zipPaths(workflowText) {
  const m = workflowText.match(/zip -r\s+"[^"]*"((?:\s*\\\n|[^\n])*)/);
  if (!m) throw new Error("zip -r step not found in release.yml");
  const tokens = m[1].replace(/\\\n/g, " ").trim().split(/\s+/);
  const xi = tokens.indexOf("-x");
  const paths = (xi < 0 ? tokens : tokens.slice(0, xi)).filter(Boolean);
  const excludes = xi < 0 ? [] : tokens.slice(xi + 1).map((t) => t.replace(/^"|"$/g, ""));
  return { paths, excludes };
}

export function isZipped(file, { paths, excludes }) {
  const inList = paths.some((p) => file === p || file.startsWith(p.replace(/\/$/, "") + "/"));
  if (!inList) return false;
  const base = file.split("/").pop();
  return !excludes.some((pat) => {
    const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(file) || re.test(base);
  });
}

test("description fits the store's 132-character limit", () => {
  assert.ok(
    [...manifest.description].length <= DESCRIPTION_MAX,
    `description is ${[...manifest.description].length} characters`,
  );
  assert.ok([...("x".repeat(139))].length > DESCRIPTION_MAX);
});

test("name fits the store's 75-character limit", () => {
  assert.ok([...manifest.name].length <= NAME_MAX);
});

test("version is one to four dot-separated integers", () => {
  assert.ok(isValidVersion(manifest.version), manifest.version);
  for (const bad of ["1.2.3-beta", "01.0", "1.2.3.4.5", "0.0", "1.70000", "", "1..2"]) {
    assert.equal(isValidVersion(bad), false, bad);
  }
  for (const good of ["0.10.0", "1", "1.2.3.4", "0.0.1"]) assert.equal(isValidVersion(good), true, good);
});

test("every file the manifest references ships in the release zip", () => {
  const zip = zipPaths(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.ok(zip.paths.includes("manifest.json"));
  const files = referencedPaths(manifest);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(existsSync(f), `${f} does not exist`);
    assert.ok(isZipped(f, zip), `${f} is not in the release zip`);
  }
  // negative samples
  assert.equal(isZipped("tools/x.js", zip), false);
  assert.equal(isZipped("icons/.DS_Store", zip), false);
  assert.deepEqual(referencedPaths({ action: { default_popup: "p.html" }, options_page: "o.html" }).sort(), ["o.html", "p.html"]);
});
