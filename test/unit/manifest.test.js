// Chrome Web Store limits on manifest.json, checked before a release job can fail on them.
// Every file the manifest references must also ship in the release zip, whose path list
// and exclusions are read from the `zip -r` step of release.yml (no second copy kept here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

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
  for (const h of m.file_handlers || []) {
    add(h.action);
    for (const i of h.icons || []) add(i?.src);
  }
  const mime = m.mime_types_handler;
  if (typeof mime === "string") add(mime);
  else if (mime && typeof mime === "object") {
    // Either `{ handler_url }` or the documented `{ "<mime/type>": { handler_url } }` dictionary.
    if (mime.handler_url) add(mime.handler_url);
    for (const h of Array.isArray(mime) ? mime : Object.values(mime)) add(h?.handler_url);
  }
  add(m.storage?.managed_schema);
  for (const c of m.input_components || []) {
    add(c.input_view);
    add(c.options_page);
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
function findMessage(value, messages) {
  const m = typeof value === "string" && value.match(/^__MSG_(.+)__$/);
  const entry = m && messages && Object.entries(messages).find(([k]) => k.toLowerCase() === m[1].toLowerCase());
  return entry && typeof entry[1].message === "string" ? entry[1].message : undefined;
}

export function resolveMessage(value, messages) {
  if (!/^__MSG_(.+)__$/.test(value ?? "")) return value;
  const message = findMessage(value, messages);
  assert.ok(message !== undefined, `${value} has no message in the default locale`);
  return message;
}

// The manifest string as the store sees it in every packaged locale (Chrome picks the user's
// preferred locale before the default one), or just the literal when it is not localized.
// Chrome allows sparse translations (a missing key falls back to the default locale), so only
// locales that define the key are measured; at least one must, or the placeholder is dangling.
// The default locale must define the key: it ends Chrome's fallback chain.
export function localizedValues(value, localeMessages, defaultLocale) {
  if (!/^__MSG_(.+)__$/.test(value ?? "")) return [value];
  if (defaultLocale !== undefined) {
    assert.ok(
      findMessage(value, localeMessages[defaultLocale]) !== undefined,
      `${value} has no message in the default locale (${defaultLocale})`
    );
  }
  const found = Object.values(localeMessages)
    .map((messages) => findMessage(value, messages))
    .filter((message) => message !== undefined);
  assert.ok(found.length > 0, `${value} has no message in any packaged locale`);
  return found;
}

function packagedLocales() {
  if (!existsSync("_locales")) return {};
  const out = {};
  for (const dir of readdirSync("_locales")) {
    const path = `_locales/${dir}/messages.json`;
    if (existsSync(path)) out[dir] = JSON.parse(readFileSync(path, "utf8"));
  }
  return out;
}

function localizedManifestStrings(key) {
  return localizedValues(manifest[key], packagedLocales(), manifest.default_locale);
}

test("description fits the store's 132-character limit", () => {
  for (const description of localizedManifestStrings("description")) {
    assert.ok([...description].length <= DESCRIPTION_MAX, `description is ${[...description].length} characters`);
  }
});

test("name fits the store's 75-character limit", () => {
  for (const name of localizedManifestStrings("name")) assert.ok([...name].length <= NAME_MAX);
});

test("localized strings are resolved before measuring", () => {
  const messages = { appDesc: { message: "x".repeat(140) } };
  assert.equal(resolveMessage("__MSG_appDesc__", messages).length, 140);
  assert.equal(resolveMessage("__MSG_APPDESC__", messages).length, 140);
  assert.equal(resolveMessage("plain", messages), "plain");
  assert.throws(() => resolveMessage("__MSG_missing__", messages));
});

test("every packaged locale's translation is measured", () => {
  const locales = { en: { d: { message: "short" } }, it: { d: { message: "y".repeat(140) } } };
  const lengths = localizedValues("__MSG_d__", locales).map((v) => v.length);
  assert.deepEqual(lengths, [5, 140]);
  assert.deepEqual(localizedValues("plain", locales), ["plain"]);
  assert.throws(() => localizedValues("__MSG_d__", { fr: {} }));
  // sparse translation: a locale without the key is skipped, not an error
  assert.deepEqual(localizedValues("__MSG_d__", { en: { d: { message: "ok" } }, fr: {} }), ["ok"]);
});

test("the default locale must define every localized key", () => {
  const locales = { en: {}, it: { d: { message: "ok" } } };
  assert.throws(() => localizedValues("__MSG_d__", locales, "en"));
  assert.deepEqual(localizedValues("__MSG_d__", { en: { d: { message: "a" } }, it: locales.it }, "en"), ["a", "ok"]);
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
      assert.ok(statSync(pattern).isFile(), `${pattern} is not a regular file`);
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
  assert.deepEqual(referencedPaths({ file_handlers: [{ action: "/h.html" }, { action: "g.html" }] }).sort(), ["g.html", "h.html"]);
  assert.deepEqual(referencedPaths({ file_handlers: [{ action: "h.html", icons: [{ src: "/csv.png" }, { src: "i/a.png" }] }] }).sort(), ["csv.png", "h.html", "i/a.png"]);
  assert.deepEqual(referencedPaths({ mime_types_handler: [{ handler_url: "/m.html" }] }), ["m.html"]);
  assert.deepEqual(referencedPaths({ mime_types_handler: { "application/pdf": { handler_url: "viewer.html" } } }), ["viewer.html"]);
  assert.deepEqual(referencedPaths({ mime_types_handler: "n.html" }), ["n.html"]);
  assert.deepEqual(
    referencedPaths({ storage: { managed_schema: "s.json" }, input_components: [{ input_view: "/v.html", options_page: "io.html" }] }).sort(),
    ["io.html", "s.json", "v.html"],
  );
  assert.equal(statSync("options").isFile(), false);
  assert.deepEqual(referencedPaths({ action: { default_popup: "p.html" }, options_page: "o.html" }).sort(), ["o.html", "p.html"]);
});
