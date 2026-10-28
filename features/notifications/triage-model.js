// features/notifications/triage-model.js — the pure side of the Triage view:
// the four categories, the counts over the rows loaded on the page, which
// rows a selected category keeps, the copy that says how far the counts
// reach, and the arrow-key movement between section headers. No DOM and no
// storage, so every rule is unit-tested in Node. The engine's items are the
// only input; nothing here classifies.
//
// A plain global (content scripts cannot import), loaded before triage.js.

(function (global) {
  const CATEGORIES = [
    { id: "attention", label: "Needs attention" },
    { id: "waiting", label: "Waiting" },
    { id: "informational", label: "Informational" },
    { id: "unverifiable", label: "Unverifiable" },
  ];
  const IDS = CATEGORIES.map((c) => c.id);

  const plural = (n, one, many) => (n === 1 ? one : many);

  // Only rows the page shows can be listed, so only they are counted; an item
  // that came from the API alone has no row to show. A pending item is in no
  // category yet.
  function counts(items) {
    const out = { attention: 0, waiting: 0, informational: 0, unverifiable: 0, pending: 0, loaded: 0 };
    for (const item of items || []) {
      if (item.inPage === false) continue;
      out.loaded++;
      if (item.pending || !IDS.includes(item.section)) out.pending++;
      else out[item.section]++;
    }
    return out;
  }

  // The category a row is in, or null while it is not classified.
  function categoryOf(item) {
    return item && !item.pending && IDS.includes(item.section) ? item.section : null;
  }

  // Does the selected category (null = all) keep this row? A pending row is
  // kept only when nothing is selected.
  function keeps(selected, item) {
    return !selected || categoryOf(item) === selected;
  }

  const labelOf = (id) => CATEGORIES.find((c) => c.id === id)?.label || "";

  // Short text of a pill, a nav item or an aria-label.
  function countText(n, pending) {
    return pending ? "…" : n > 99 ? "99+" : String(n);
  }

  function ariaLabel(id, c, pending) {
    return `${labelOf(id)}, ${pending ? "classifying" : c[id]} of ${c.loaded} loaded ${plural(c.loaded, "notification", "notifications")}`;
  }

  // "Needs attention · 3 of 25 loaded"
  function statusLine(selected, c) {
    return `${labelOf(selected)} · ${c[selected]} of ${c.loaded} loaded`;
  }

  // How far the counts reach. `more` is true when GitHub has another page.
  function coverageText(c, more) {
    const n = c.loaded;
    const base = `Counts cover the ${n} loaded ${plural(n, "notification", "notifications")}`;
    return more ? `${base}; more pages not loaded.` : `${base}.`;
  }

  // The line under a selected category, or "" when there is nothing to say. An
  // empty result is never "all clear": it only covers what is loaded.
  function emptyText(selected, c) {
    if (!selected || c[selected] > 0) return "";
    return "No match among the loaded notifications.";
  }

  const pendingText = (n) => (n > 0 ? `Classifying ${n} ${plural(n, "notification", "notifications")}…` : "");

  // Roving movement between section headers (ArrowUp/Down/Home/End).
  function moveFocus(index, key, length) {
    if (!length) return -1;
    if (key === "Home") return 0;
    if (key === "End") return length - 1;
    if (key === "ArrowDown") return (index + 1) % length;
    if (key === "ArrowUp") return (index - 1 + length) % length;
    return index;
  }

  global.GHNT_TRIAGE_MODEL = { CATEGORIES, IDS, counts, categoryOf, keeps, labelOf, countText, ariaLabel, statusLine, coverageText, emptyText, pendingText, moveFocus };
})(typeof window !== "undefined" ? window : globalThis);
