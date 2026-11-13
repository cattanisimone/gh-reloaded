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
  function sectionNote(id, n, pending, checked) {
    const lines = [];
    if (n === 0 && !pending) lines.push(checked ? `None on this page or in the ${checked} checked.` : "None among the loaded notifications.");
    if (id === "unverifiable") lines.push("This group holds notifications whose data or token permissions are not enough to tell.");
    return lines;
  }

  // A category with 0 while rows are still classifying is not known yet.
  const isPending = (c, id) => c.pending > 0 && c[id] === 0;

  const pendingText = (n) => (n > 0 ? `Classifying ${n} ${plural(n, "notification", "notifications")}…` : "");

  // ---- beyond the current page ---------------------------------------------
  //
  // The check outside the page (fill.js) hands the view a snapshot; everything
  // it says is decided here, so no renderer words a state itself. Nothing says
  // "all clear": an empty result always names what it covered.

  const LABEL_IDS = ["informational", "unverifiable"];
  const OUTSIDE_FIRST = 25;
  const GROUPED_FIRST = 5;

  const REASON_LABELS = { review_requested: "review requested", mention: "mention", team_mention: "team mention", subscribed: "subscribed", comment: "commented", ci_activity: "CI activity", assign: "assigned", author: "author", state_change: "state change", approval_requested: "approval requested", security_alert: "security alert", invitation: "invitation", manual: "manual" };
  const reasonLabel = (r) => REASON_LABELS[r] || "unrecognised reason";

  // "5 minutes ago", "3 hours ago", "2 days ago", then the date; "" when unknown.
  function ago(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || !Number.isFinite(now)) return "";
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} ${plural(Math.floor(s / 60), "minute", "minutes")} ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)} ${plural(Math.floor(s / 3600), "hour", "hours")} ago`;
    if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} ${plural(Math.floor(s / 86_400), "day", "days")} ago`;
    return new Date(t).toISOString().slice(0, 10);
  }

  const localTime = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // One outside entry as the view shows it.
  function entryView(e, now) {
    const title = e.title || `${e.owner}/${e.repo} #${e.number}`;
    return { key: e.key, title, href: e.href, aria: `${title}, opens on GitHub`, repo: `${e.owner}/${e.repo} #${e.number}`, reason: reasonLabel(e.reason), time: ago(e.updatedAt, now), category: e.category, categoryLabel: labelOf(e.category), unread: e.unread !== false };
  }

  // The list of one category: at most `first` entries, then "Show {n} more outside this page".
  function listView(entries, cat, first, now) {
    const own = entries.filter((e) => e.category === cat);
    return { cat, k: own.length, heading: `Outside this page (${own.length})`, sub: "From your notifications on GitHub · read-only", entries: own.slice(0, first).map((e) => entryView(e, now)), more: Math.max(0, own.length - first), moreLabel: `Show ${Math.max(0, own.length - first)} more outside this page`, rest: own.slice(first).map((e) => entryView(e, now)) };
  }

  const T = (v) => ({ t: "text", v });
  const NEXT = (href) => (href ? [T(" "), { t: "next", href, label: NEXT_LABEL }] : []);
  const NARROW_LABELS = { review: "Review requests ›", mention: "Mentions ›" };

  // " Narrow with GitHub filters:" + the links that exist (none: no sentence).
  function narrowSegs(narrow) {
    const links = [];
    for (const [id, label] of Object.entries(NARROW_LABELS)) if (narrow?.[id]) links.push(T(" "), { t: "link", href: narrow[id], label });
    return links.length ? [T(" Narrow with GitHub filters:"), ...links] : [];
  }

  const NO_SCOPE = "Notifications outside this page can't be checked: the default GitHub token must be a classic token with the notifications scope.";
  const NO_TOKEN = "Without a GitHub token, review requests and mentions can't be verified, so none is counted as Needs attention.";
  const SSO = "Notifications from organizations your token can't read may be missing.";

  // The lines under the status: [{ id, segs }], plus the empty-state text.
  // o: { selected, grouped, snap, nextHref, narrow, now, fmtTime, pageCount }.
  function stateLines(o) {
    const { snap, selected, grouped, nextHref, narrow } = o;
    const fmt = o.fmtTime || localTime;
    const lines = [];
    const add = (id, ...segs) => lines.push({ id, segs: segs.flat() });
    const isLabel = LABEL_IDS.includes(selected);
    const isEvidence = !isLabel; // Needs attention, Waiting and Grouped
    const s = snap.summary;
    const m = s.m;
    const k = s.k;
    const u = s.u;
    const p = s.pending;
    const complete = snap.active && !snap.next && k === 0;
    const filled = snap.filledKeys.includes(grouped ? "*" : selected || "") || snap.running;

    // Not capable: say why, offer GitHub's own way on. With no category in play the
    // 1.7.0 coverage line says it all.
    if (!snap.active && !selected && !grouped) return { lines: [], empty: "" };
    if (!snap.supported) return { lines: [{ id: "state", segs: [T(`The filter ${snap.unsupported} can't be applied outside this page, so only this page is counted.`), ...NEXT(nextHref)] }], empty: "" };
    const none = ["not-tried"].includes(snap.apiState);
    const noCap = ["missing-scope", "unavailable"].includes(snap.apiState);
    const err = ["refused", "no-answer"].includes(snap.apiState);
    if (none) {
      if (isEvidence && (selected || grouped)) add("state", T(NO_TOKEN), T(" "), { t: "settings", label: "Settings → GitHub tokens" }, NEXT(nextHref));
      else add("state", T("Only this page is counted."), NEXT(nextHref));
      return { lines, empty: "" };
    }
    if (noCap) {
      if (isLabel) add("state", T(`${NO_SCOPE} Only this page is counted.`), NEXT(nextHref));
      else add("state", T(NO_SCOPE), narrowSegs(narrow), NEXT(nextHref));
      return { lines, empty: "" };
    }
    if (err) {
      add("state", T(`Couldn't check notifications outside this page: ${snap.apiState === "refused" ? "GitHub refused the token." : "GitHub did not answer."} Results on this page are unaffected.`), isLabel ? [] : narrowSegs(narrow), NEXT(nextHref));
      return { lines, empty: "" };
    }
    if (snap.apiState === "rate-limited" && !snap.active) {
      add("state", T("GitHub rate limit reached. Results so far are kept; you can load more after the limit resets."), NEXT(nextHref));
      return { lines, empty: "" };
    }
    if (!snap.active) return { lines: [], empty: "" };

    // Capable: from here the numbers are checked ones.
    const selCount = selected ? (o.pageCount || 0) + (s.byCat[selected] || 0) : null;
    const limited = snap.retryAt != null && o.now < snap.retryAt;
    // Only a category (or the Grouped action) can ask for more; with nothing selected the text says where things stand.
    const canMore = (selected || grouped) && (snap.next || (!isLabel && p > 0)) && !snap.ceiling;
    const nv = () => {
      if (!k) return [];
      const segs = [T(`${k} not verified yet.`)];
      if (isLabel && !snap.next && p > 0) segs.push(T(" Pick "), { t: "select", cat: "attention", label: "Needs attention" }, T(" or "), { t: "select", cat: "waiting", label: "Waiting" }, T(" to look them up."));
      if (u > 0) segs.push(T(` ${u} of them can only be opened from GitHub's list:`), ...NEXT(nextHref));
      return segs;
    };
    const more = [T("More notifications not checked yet.")];
    let empty = "";

    if (snap.running) {
      add("progress", T(`Checking more notifications… ${m} checked`), T(" "), { t: "stop" });
      if (nv().length) add("unverified", ...nv());
      add("partial", ...more);
    } else if (!filled && grouped) {
      if (complete) add("complete", T(`All ${m} notifications available to your token checked.`));
      else add("grouped-start", T(`Counts cover the ${s.pageRows} loaded ${plural(s.pageRows, "notification", "notifications")}; more pages not loaded.`), T(" "), { t: "check" });
    } else {
      if (limited) {
        add("rate", T(`GitHub rate limit reached. Results so far are kept; you can load more after ${fmt(snap.retryAt)}.`), T(" "), { t: "load-more", disabled: true, desc: `Available after ${fmt(snap.retryAt)}` });
      } else if (snap.error) {
        add("error", T(`Couldn't check notifications outside this page: ${snap.error === "refused" ? "GitHub refused the token." : "GitHub did not answer."} Results on this page are unaffected.`), isLabel ? [] : narrowSegs(narrow), NEXT(nextHref), [T(" "), { t: "load-more" }]);
      } else if (snap.ceiling) {
        add("ceiling", T(`Stopped after ${m} notifications. Narrow with GitHub filters to check further.`), isLabel ? NEXT(nextHref) : [...narrowSegs(narrow), ...NEXT(nextHref)]);
      } else if (snap.stopped) {
        add("stopped", T(`Stopped. ${m} notifications checked.`), canMore ? [T(" "), { t: "load-more" }] : []);
      } else if (complete) {
        add("complete", T(`All ${m} notifications available to your token checked.`));
      }
      if (!limited && !snap.error && !snap.ceiling && !snap.stopped && !complete) {
        // No further API page but lookups left (Needs attention, Waiting, Grouped): Load more continues them.
        if (nv().length) add("unverified", ...nv(), canMore && !snap.next ? [T(" "), { t: "load-more" }] : []);
        if (snap.next && canMore) add("partial", ...more, T(" "), { t: "load-more" });
        else if (snap.next || !k) add("partial", ...more);
        if (!selected && !grouped) lines.unshift({ id: "checked", segs: [T(`${m} notifications checked.`)] });
      } else if (!complete && nv().length) add("unverified", ...nv());
      if (grouped && lines.length && !lines.some((l) => l.id === "complete") && !lines.some((l) => l.id === "checked")) lines.unshift({ id: "checked", segs: [T(`${m} notifications checked.`)] });
    }
    if (snap.summary.denied) add("sso", T(SSO));
    if (selected && selCount === 0 && !snap.running) empty = complete ? `No match in the ${m} notifications checked.` : `No match on this page or in the ${m} notifications checked.`;
    return { lines, empty };
  }

  // The "+" of a count: more may be reachable or unverified.
  const partialOf = (snap) => !!snap && snap.active && (snap.next || snap.summary.k > 0);

  // "Needs attention, 7 found so far, 300 notifications checked, more not checked" while partial,
  // "…, 7 in all 40 notifications checked" when complete; the unverified ones are named too.
  function checkedAria(id, n, plus, snap) {
    const s = snap.summary;
    const nv = s.k ? `, ${s.k} not verified yet` : "";
    return plus ? `${labelOf(id)}, ${n} found so far, ${s.m} notifications checked${snap.next ? ", more not checked" : ""}${nv}` : `${labelOf(id)}, ${n} in all ${s.m} notifications checked`;
  }

  // Everything any layout shows, computed once: no renderer formats a count,
  // a label or a sentence itself, so a rule cannot be missed by one layout.
  // o = { layout, selected, collapsed, nextHref }.
  function view(c, o = {}) {
    const selected = o.layout === "grouped" ? null : IDS.includes(o.selected) ? o.selected : null;
    const collapsed = o.collapsed || {};
    const next = o.nextHref ? { href: o.nextHref, label: NEXT_LABEL } : null;
    const snap = o.fill || null;
    const grouped = o.layout === "grouped";
    // Grouped shows what is checked outside only once the user asked for it.
    const showOutside = !!snap && snap.active && (!grouped || snap.filledKeys.includes("*") || snap.running);
    const out = showOutside ? snap.summary.byCat : { attention: 0, waiting: 0, informational: 0, unverifiable: 0 };
    const plus = showOutside && partialOf(snap);
    const cats = CATEGORIES.map(({ id, label }) => {
      const pending = isPending(c, id);
      const expanded = collapsed[id] !== true;
      const n = c[id] + out[id];
      const capable = showOutside && !pending;
      return {
        id,
        label,
        n,
        pending,
        count: pending ? "…" : n > 99 ? "99+" : `${n}${plus ? "+" : ""}`,
        aria: capable ? checkedAria(id, n, plus, snap) : ariaLabel(id, c, pending),
        pressed: selected === id,
        expanded,
        note: expanded ? sectionNote(id, n, pending, showOutside ? snap.summary.m : 0) : [],
        outside: showOutside && grouped && expanded ? listView(snap.summary.outside, id, GROUPED_FIRST, o.now) : null,
      };
    });
    const pendingLine = pendingText(c.pending);
    const pageCount = selected ? c[selected] : 0;
    const base = {
      layout: o.layout,
      selected,
      cats,
      pending: pendingLine,
      next,
    };
    if (!snap) {
      return { ...base, status: selected ? statusLine(selected, c, isPending(c, selected)) : "", empty: selected && !isPending(c, selected) ? emptyText(selected, c) : "", coverage: coverageText(c, !!next), lines: [], outside: null };
    }
    const st = stateLines({ snap, selected, grouped, nextHref: o.nextHref, narrow: o.narrow, now: o.now, fmtTime: o.fmtTime, pageCount });
    const outsideSel = showOutside && selected ? snap.summary.byCat[selected] : 0;
    const status = !selected ? "" : showOutside ? `${labelOf(selected)} · ${isPending(c, selected) ? "…" : pageCount} on this page${outsideSel ? ` + ${outsideSel} outside` : ""} · ${snap.summary.m} notifications checked` : statusLine(selected, c, isPending(c, selected));
    // A state that is only "can't check" keeps 1.7.0's coverage line for the
    // empty state; every other state is told by its own lines.
    return {
      ...base,
      status,
      empty: selected && !isPending(c, selected) ? (showOutside ? st.empty : emptyText(selected, c)) : "",
      statusOutside: outsideSel > 0 ? `${outsideSel} outside` : "",
      coverage: st.lines.length || (snap && snap.active) ? "" : coverageText(c, !!next),
      lines: st.lines,
      outside: showOutside && selected ? listView(snap.summary.outside, selected, OUTSIDE_FIRST, o.now) : null,
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

  global.GHNT_TRIAGE_MODEL = { OUTSIDE_FIRST, GROUPED_FIRST, reasonLabel, ago, listView, stateLines, partialOf, CATEGORIES, IDS, counts, categoryOf, keeps, labelOf, countText, ariaLabel, statusLine, coverageText, emptyText, NEXT_LABEL, sectionNote, pendingText, isPending, view, moveFocus };
})(typeof window !== "undefined" ? window : globalThis);
