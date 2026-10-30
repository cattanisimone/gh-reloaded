// features/quick-assign/picker.js — the decisions of Quick assignment that do
// not touch the page: which login a profile link names, which of the native
// picker's options is the one to toggle, and whether GitHub's stored
// assignees match what the action was meant to do. A content-script global
// (no ES module), loaded before content.js and unit-tested on its own.

(function (global) {
  // Enterprise Managed Users have an "_<shortcode>" suffix (jdoe_acme).
  const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

  // The login of an assignee row's link, only when the link is exactly
  // /<login> (apps and bots link elsewhere, e.g. /apps/<slug>): a row we
  // cannot target precisely gets no remove control.
  function loginFromHref(href) {
    const m = /^\/([^/?#]+)\/?$/.exec(String(href || "").replace(/^https:\/\/github\.com(?=\/)/, ""));
    return m && LOGIN.test(m[1]) ? m[1] : null;
  }

  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // options: [{ label, selected }] read from the picker's listbox. Exactly
  // one option whose label equals the login (GitHub logins are
  // case-insensitive; "alex" never matches "alex-dev"), else null.
  function findOption(options, login) {
    const hits = options.filter((o) => same(o.label.trim(), login));
    return hits.length === 1 ? hits[0] : null;
  }

  // goal: "add" | "remove". Only an option in the opposite state is clicked;
  // one already in the goal state means the page and the picker disagree, and
  // we report that rather than click something unexpected.
  function decideToggle(goal, option) {
    if (!option) return "missing";
    if (goal === "add") return option.selected ? "already" : "click";
    if (goal === "remove") return option.selected ? "click" : "already";
    return "missing";
  }

  // Compares the assignees before the action with GitHub's stored set after
  // it. "confirmed": the target is in (add) or out (remove) and nobody else
  // went missing. "unexpected": someone other than the target was removed
  // (reported even if the target is right). "unchanged": the target did not
  // change. Extra assignees added by somebody else meanwhile are ignored.
  function compareAssignees(before, after, login, goal) {
    const has = (list) => list.some((l) => same(l, login));
    const others = (list) => list.filter((l) => !same(l, login));
    const afterOthers = others(after);
    const removed = others(before).filter((l) => !afterOthers.some((a) => same(a, l)));
    if (removed.length) return { status: "unexpected", removed };
    const done = goal === "add" ? has(after) : !has(after);
    return { status: done ? "confirmed" : "unchanged", removed: [] };
  }

  global.GHQA_PICKER = { loginFromHref, findOption, decideToggle, compareAssignees };
})(typeof window !== "undefined" ? window : globalThis);
