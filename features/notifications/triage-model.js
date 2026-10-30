// features/notifications/triage-model.js — the pure side of the Triage view:
// the four categories, the counts over the rows loaded on the page, which
// rows a selected category keeps, the copy that says how far the counts
// reach and what an empty or Unverifiable section means, and the arrow-key movement between section headers. No DOM and no
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

  // "Needs attention · 3 of 25 loaded"; "…" for a 0 that is not known yet.
  function statusLine(selected, c, pending) {
    return `${labelOf(selected)} · ${pending ? "…" : c[selected]} of ${c.loaded} loaded`;
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

  // The link to GitHub's next page, shown in the coverage line and the empty state.
  const NEXT_LABEL = "Next page ›";

  // The inert lines under an expanded Grouped section: an empty one says it
  // covers only the loaded rows, and Unverifiable always says why it exists.
  function sectionNote(id, n, pending) {
    const lines = [];
    if (n === 0 && !pending) lines.push("None among the loaded notifications.");
    if (id === "unverifiable") lines.push("This group holds notifications whose data or token permissions are not enough to tell.");
    return lines;
  }

  // A category with 0 while rows are still classifying is not known yet.
  const isPending = (c, id) => c.pending > 0 && c[id] === 0;

  const pendingText = (n) => (n > 0 ? `Classifying ${n} ${plural(n, "notification", "notifications")}…` : "");

  // Everything any layout shows, computed once: no renderer formats a count,
  // a label or a sentence itself, so a rule cannot be missed by one layout.
  // o = { layout, selected, collapsed, nextHref }.
  function view(c, o = {}) {
    const selected = o.layout === "grouped" ? null : IDS.includes(o.selected) ? o.selected : null;
    const collapsed = o.collapsed || {};
    const next = o.nextHref ? { href: o.nextHref, label: NEXT_LABEL } : null;
    const cats = CATEGORIES.map(({ id, label }) => {
      const pending = isPending(c, id);
      const expanded = collapsed[id] !== true;
      return {
        id,
        label,
        n: c[id],
        pending,
        count: countText(c[id], pending),
        aria: ariaLabel(id, c, pending),
        pressed: selected === id,
        expanded,
        note: expanded ? sectionNote(id, c[id], pending) : [],
      };
    });
    const pendingLine = pendingText(c.pending);
    return {
      layout: o.layout,
      selected,
      cats,
      status: selected ? statusLine(selected, c, isPending(c, selected)) : "",
      empty: selected && !isPending(c, selected) ? emptyText(selected, c) : "",
      pending: pendingLine,
      coverage: coverageText(c, !!next),
      next,
    };
  }

  // Roving movement between section headers (ArrowUp/Down/Home/End).
  function moveFocus(index, key, length) {
    if (!length) return -1;
    if (key === "Home") return 0;
    if (key === "End") return length - 1;
    if (key === "ArrowDown") return (index + 1) % length;
    if (key === "ArrowUp") return (index - 1 + length) % length;
    return index;
  }

  global.GHNT_TRIAGE_MODEL = { CATEGORIES, IDS, counts, categoryOf, keeps, labelOf, countText, ariaLabel, statusLine, coverageText, emptyText, NEXT_LABEL, sectionNote, pendingText, isPending, view, moveFocus };
})(typeof window !== "undefined" ? window : globalThis);
