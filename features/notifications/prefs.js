// features/notifications/prefs.js — the preferences contract of the
// notifications modules, as pure functions shared by the settings panel and
// the content script. Three local keys (chrome.storage.local), nothing is
// written to GitHub:
//   ghntModules      {moduleId: boolean}  per-module switches (other ids are kept)
//   ghntNativeInbox  boolean              pauses every module, keeps the rest
//   ghntLayout       "integrated" | "quickbar" | "grouped"
// An unset key means the default; a stored value of the wrong type is read
// as unset. Each control writes only its own value.

(function (global) {
  const KEYS = { modules: "ghntModules", nativeInbox: "ghntNativeInbox", layout: "ghntLayout" };
  // Restore defaults removes exactly these keys (never ghntMentionWindowDays).
  const RESET_KEYS = [KEYS.modules, KEYS.nativeInbox, KEYS.layout];

  const MODULES = [
    { id: "triage", label: "Triage", description: "Sorts notifications into four categories", defaultOn: true },
    { id: "reasonTags", label: "Tags", description: "Reason labels on notifications", defaultOn: true },
    { id: "reasonWhy", label: "“Why is this here?”", description: "Evidence behind a classification, opened from a tag", defaultOn: true },
  ];

  const LAYOUTS = [
    { id: "integrated", label: "Integrated navigation", description: "Categories in the inbox's own navigation" },
    { id: "quickbar", label: "Quick bar", description: "Horizontal filters" },
    { id: "grouped", label: "Grouped sections", description: "Collapsible groups" },
  ];
  const DEFAULT_LAYOUT = "integrated";

  function normalizeLayout(value) {
    return LAYOUTS.some((l) => l.id === value) ? value : DEFAULT_LAYOUT;
  }

  function isMap(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  // The effective switch of one catalogue module.
  function moduleOn(stored, id) {
    const flag = isMap(stored) ? stored[id] : undefined;
    if (typeof flag === "boolean") return flag;
    return MODULES.find((m) => m.id === id)?.defaultOn === true;
  }

  // stored: the raw storage object. Returns the effective preferences.
  function normalize(stored = {}) {
    const raw = isMap(stored[KEYS.modules]) ? stored[KEYS.modules] : {};
    const modules = { ...raw };
    for (const m of MODULES) modules[m.id] = moduleOn(raw, m.id);
    return { modules, nativeInbox: stored[KEYS.nativeInbox] === true, layout: normalizeLayout(stored[KEYS.layout]) };
  }

  // Read-merge-write of one switch: the other ids stay as stored.
  function patchModule(storedModules, id, value) {
    return { ...(isMap(storedModules) ? storedModules : {}), [id]: value === true };
  }

  global.GHNT_PREFS = { KEYS, RESET_KEYS, MODULES, LAYOUTS, DEFAULT_LAYOUT, normalize, normalizeLayout, moduleOn, patchModule };
})(typeof window !== "undefined" ? window : globalThis);
