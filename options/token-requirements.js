// Which GitHub permission types each feature reads, and the warning built from
// them. One source for "required" versus "optional" in the token list, the
// state of a token and the missing-permission warning. A future feature adds
// one entry here and one sentence. No release number lives in this file: the
// warning names the installed version, read from the manifest by the caller.

// The five permission types the Settings page reasons about, in display order.
export const TYPES = [
  { id: "contents", name: "Contents", label: "Read repository contents", how: "Contents: Read-only" },
  { id: "pulls", name: "Pull requests", label: "Read pull requests", how: "Pull requests: Read-only" },
  { id: "issues", name: "Issues", label: "Read issues", how: "Issues: Read-only" },
  { id: "projects", name: "Projects", label: "Read Projects", how: "Projects: Read-only" },
  { id: "actions", name: "Actions", label: "Read Actions logs", how: "Actions: Read-only" },
];

export const TYPE_IDS = TYPES.map((t) => t.id);

// switch: where the on/off state is stored. {key} is a plain flag in
// chrome.storage.local; {module} is a key of the `ghntModules` map.
// defaultOn applies while the flag was never saved.
export const FEATURES = [
  { id: "ghdg", name: "Dependency graph", switch: { key: "ghdgEnabled" }, defaultOn: true, types: ["issues", "projects"], reason: "to read issue relationships and project fields for the graph" },
  { id: "ghbd", name: "Board dependency arrows", switch: { key: "ghbdEnabled" }, defaultOn: false, types: ["issues"], reason: "to read the dependencies drawn on Projects boards" },
  { id: "ghsm", name: "Standup mode", switch: { key: "ghsmEnabled" }, defaultOn: true, types: ["issues", "projects"], reason: "to find blocked and stale items on a board" },
  { id: "ghhp", name: "HTML preview", switch: { key: "ghhpEnabled" }, defaultOn: true, types: ["contents"], reason: "to read private HTML files for the preview" },
  { id: "ghig", name: "Image gallery", switch: { key: "ghigEnabled" }, defaultOn: true, types: ["contents"], reason: "to list and read private images in a folder" },
  { id: "ghmi", name: "My Issues by project", switch: { key: "ghmiEnabled" }, defaultOn: true, types: ["issues", "projects"], reason: "to group your issues by project" },
  { id: "ghprt", name: "PR triage", switch: { key: "ghprtEnabled" }, defaultOn: true, types: ["pulls"], reason: "to read review and check state of pull requests" },
  { id: "ghqa", name: "Quick assignment", switch: { key: "ghqaEnabled" }, defaultOn: false, types: ["issues"], reason: "to read an issue before assigning it" },
  { id: "ghlps", name: "Linked PR status", switch: { key: "ghlpsEnabled" }, defaultOn: true, types: ["pulls", "issues"], reason: "to show the status of linked pull requests" },
  { id: "ghnt-reason-tags", name: "Notification reason tags", switch: { module: "reasonTags" }, defaultOn: true, types: ["pulls", "issues"], reason: "to tell why a notification reached you" },
];

// The chrome.storage.local keys the feature switches live in.
export const SWITCH_KEYS = [...new Set(FEATURES.map((f) => f.switch.key || "ghntModules"))];

export function isFeatureOn(feature, stored = {}) {
  const sw = feature.switch;
  const value = sw.module ? (stored.ghntModules && typeof stored.ghntModules === "object" ? stored.ghntModules[sw.module] : undefined) : stored[sw.key];
  return value === undefined ? feature.defaultOn : !!value;
}

export function enabledFeatures(stored = {}) {
  return FEATURES.filter((f) => isFeatureOn(f, stored));
}

// Types some enabled feature reads. Everything else is optional.
export function requiredTypes(features) {
  return new Set(features.flatMap((f) => f.types));
}

const typeName = (id) => TYPES.find((t) => t.id === id)?.name || id;

// tokens: [{id, name, codes}] where codes is the stored outcome of the last
// test (codes[type] is available | denied | unverified | unchecked, or absent).
// Returns null when nothing is missing and nothing is unknown, else
// {title, tokens, details, maybe}. A denied type is a proven absence; a type
// with no code in a record that was tested is only a "may need".
export function warningFor({ features, tokens, version }) {
  const denied = [];
  const unknown = [];
  const affected = new Map(); // feature id -> feature
  const named = new Map(); // token id -> name
  for (const t of tokens) {
    if (!t.codes) continue; // never tested: nothing to say
    for (const f of features) {
      for (const type of f.types) {
        const code = t.codes[type];
        const hit = code === "denied" ? denied : code === undefined ? unknown : null;
        if (!hit) continue;
        hit.push({ feature: f, type });
        affected.set(f.id, f);
        named.set(t.id, t.name);
      }
    }
  }
  if (!affected.size) return null;
  const maybe = !denied.length;
  const list = [...affected.values()];
  const first = list[0].name;
  const subject = list.length === 1 ? first : `${first} and ${list.length - 1} more`;
  const verb = list.length === 1 ? "needs" : "need";
  const title = maybe
    ? `${subject} may need a permission your token doesn't have`
    : `${subject} ${verb} a permission your token doesn't have`;
  const seen = new Set();
  const details = [];
  for (const { feature, type } of maybe ? unknown : denied) {
    const key = `${feature.id}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    details.push(`GH Reloaded ${version} uses ${typeName(type)} (Read-only) for ${feature.name}: ${feature.reason}.`);
  }
  return { title, tokens: [...named.values()], ids: [...named.keys()], details, maybe };
}
