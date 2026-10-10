// features/my-issues/layout.js — pure helpers behind the Project tiles on the
// My Issues dashboard: time since update, repo#number labels, the per-Status
// cap, distribution-bar widths and the distinct issue count.
//
// Kept out of content.js so the unit tests can load it on its own.

(function (global) {
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // "30m", "1h", "2d", "3w", "5mo", "1y". Short and ASCII, so a row stays on
  // one line; the exact date goes in the <time> tooltip. A timestamp in the
  // future (clock skew) clamps to "0m"; an unparsable one gives "".
  function relativeTime(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const ms = Math.max(0, now - t);
    if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
    if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
    const days = Math.floor(ms / DAY);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }

  // Maps each `nameWithOwner` in the set to the label shown before the issue
  // number: just the repo name, unless the same name appears under two
  // different owners, in which case the owner stays to tell them apart.
  function repoLabels(issues) {
    const ownersByName = new Map();
    for (const { nameWithOwner } of issues) {
      const [owner, name] = String(nameWithOwner || "").split("/");
      if (name === undefined) continue;
      if (!ownersByName.has(name)) ownersByName.set(name, new Set());
      ownersByName.get(name).add(owner);
    }
    const labels = new Map();
    for (const { nameWithOwner } of issues) {
      const full = String(nameWithOwner || "");
      const [, name] = full.split("/");
      labels.set(full, name === undefined ? full : ownersByName.get(name).size > 1 ? full : name);
    }
    return labels;
  }

  // First `cap` items of a Status, and how many are left behind a "Show N
  // more" button. `expanded` shows them all.
  function capStatus(items, cap = 5, expanded = false) {
    if (expanded || items.length <= cap) return { visible: items.slice(), hidden: 0 };
    return { visible: items.slice(0, cap), hidden: items.length - cap };
  }

  const KNOWN_COLORS = new Set(["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"]);

  // One segment per Status, width proportional to its count (percentages
  // summing to exactly 100). No Status (null name) is always gray, as is a
  // color the palette doesn't know.
  function barSegments(statuses) {
    const total = statuses.reduce((n, s) => n + s.count, 0);
    if (!total) return [];
    let used = 0;
    return statuses.map((s, i) => {
      const last = i === statuses.length - 1;
      const width = last ? 100 - used : (s.count / total) * 100;
      used += width;
      const upper = String(s.color || "").toUpperCase();
      return {
        name: s.name,
        count: s.count,
        color: s.name && KNOWN_COLORS.has(upper) ? upper : "GRAY",
        width,
      };
    });
  }

  // Distinct issues across every tile: one in two Projects counts once.
  function distinctCount(projects, noProject) {
    const urls = new Set();
    for (const p of projects) for (const s of p.statuses) for (const i of s.issues) urls.add(i.url);
    for (const i of noProject) urls.add(i.url);
    return urls.size;
  }

  global.GHMI_LAYOUT = { relativeTime, repoLabels, capStatus, barSegments, distinctCount };
})(typeof window !== "undefined" ? window : globalThis);
