// Chrome Web Store limits on manifest.json, checked before a release job can fail on them.
// Every file the manifest references must also ship in the release zip, whose path list
// and exclusions are read from the `zip -r` step of release.yml (no second copy kept here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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
  // Chrome accepts root-relative paths ("/images/*"); the repo file list has none.
  const add = (p) => typeof p === "string" && p && out.add(p.replace(/^\/+/, ""));
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
  for (const r of m.declarative_net_request?.rule_resources || []) add(r.path);
  if (m.default_locale) add(`_locales/${m.default_locale}/messages.json`);
  return [...out];
}

// Every file under dir, as repo-relative paths.
function listFiles(dir = ".") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const path = dir === "." ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

// Expands a manifest resource pattern (`*` matches any run of characters) to existing files.
export function expandResource(pattern, files) {
  if (!pattern.includes("*")) return [pattern];
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return files.filter((f) => re.test(f));
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

// Resolves Chrome's `__MSG_key__` form against the default locale's messages, so the limits
// apply to the text the store sees. `messages` is the parsed messages.json (or undefined).
export function resolveMessage(value, messages) {
  const m = typeof value === "string" && value.match(/^__MSG_(.+)__$/);
  if (!m) return value;
  const entry = messages && Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
  assert.ok(entry && typeof entry[1].message === "string", `${value} has no message in the default locale`);
  return entry[1].message;
}

function localizedManifestString(key) {
  let messages;
  if (manifest.default_locale) {
    const path = `_locales/${manifest.default_locale}/messages.json`;
    if (existsSync(path)) messages = JSON.parse(readFileSync(path, "utf8"));
  }
  return resolveMessage(manifest[key], messages);
}

test("description fits the store's 132-character limit", () => {
  const description = localizedManifestString("description");
  assert.ok([...description].length <= DESCRIPTION_MAX, `description is ${[...description].length} characters`);
  assert.ok([...("x".repeat(139))].length > DESCRIPTION_MAX);
});

test("name fits the store's 75-character limit", () => {
  assert.ok([...localizedManifestString("name")].length <= NAME_MAX);
});

test("localized strings are resolved before measuring", () => {
  const messages = { appDesc: { message: "x".repeat(140) } };
  assert.equal(resolveMessage("__MSG_appDesc__", messages).length, 140);
  assert.equal(resolveMessage("__MSG_APPDESC__", messages).length, 140);
  assert.equal(resolveMessage("plain", messages), "plain");
  assert.throws(() => resolveMessage("__MSG_missing__", messages));
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
  const all = listFiles();
  const packaged = all.filter((f) => isZipped(f, zip));
  for (const pattern of files) {
    if (!pattern.includes("*")) {
      assert.ok(existsSync(pattern), `${pattern} does not exist`);
      assert.ok(isZipped(pattern, zip), `${pattern} is not in the release zip`);
      continue;
    }
    // A glob only has to match files that ship; checkout-only matches (tests, .DS_Store) are irrelevant.
    assert.ok(expandResource(pattern, packaged).length > 0, `${pattern} matches no file in the release zip`);
  }
  // negative samples
  assert.equal(isZipped("tools/x.js", zip), false);
  assert.equal(isZipped("icons/.DS_Store", zip), false);
  assert.deepEqual(expandResource("images/*.png", ["images/a.png", "images/b.svg", "x/images/a.png"]), ["images/a.png"]);
  assert.deepEqual(expandResource("*", ["manifest.json", "test/a.js"].filter((f) => isZipped(f, { paths: ["manifest.json"], excludes: [] }))), ["manifest.json"]);
  assert.deepEqual(
    referencedPaths({ default_locale: "en", declarative_net_request: { rule_resources: [{ path: "r.json" }] } }).sort(),
    ["_locales/en/messages.json", "r.json"],
  );
  assert.deepEqual(
    referencedPaths({ web_accessible_resources: [{ resources: ["/images/*", "/a.js"] }] }).sort(),
    ["a.js", "images/*"],
  );
  assert.deepEqual(referencedPaths({ action: { default_popup: "p.html" }, options_page: "o.html" }).sort(), ["o.html", "p.html"]);
});
