// features/my-issues/layout.js — pure helpers behind the Project tiles on the
// My Issues dashboard: time since update, `#number` chips, the per-Status
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

  // The `#591` chip of every issue in one tile. The chip is just the number;
  // the tooltip carries `owner/repo#591`. The repo name goes inside the chip
  // (`repo#591`) only when two issues of the tile share a number from
  // different repos, and the owner too if that repo name is itself shared.
  // Returns a Map keyed by issue url: { text, title, ch }, `ch` being the
  // widest chip of the tile (in characters) so the column stays aligned.
  function refChips(issues) {
    const reposByNumber = new Map();
    for (const i of issues) {
      if (!reposByNumber.has(i.number)) reposByNumber.set(i.number, new Set());
      reposByNumber.get(i.number).add(String(i.nameWithOwner || ""));
    }
    const chips = new Map();
    let ch = 0;
    for (const i of issues) {
      const full = String(i.nameWithOwner || "");
      const clash = reposByNumber.get(i.number);
      let prefix = "";
      if (clash.size > 1) {
        const name = full.split("/")[1];
        const sameName = [...clash].filter((r) => r.split("/")[1] === name).length > 1;
        prefix = name === undefined || sameName ? full : name;
      }
      const text = `${prefix}#${i.number}`;
      ch = Math.max(ch, text.length);
      chips.set(i.url, { text, title: `${full}#${i.number}` });
    }
    for (const chip of chips.values()) chip.ch = ch;
    return chips;
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

  // The issue type as a chip: null when there is none (no placeholder), the
  // color a name the palette knows or gray.
  function typeChip(issueType) {
    const name = String(issueType?.name || "").trim();
    if (!name) return null;
    const upper = String(issueType.color || "").toUpperCase();
    return { name, color: KNOWN_COLORS.has(upper) ? upper : "GRAY" };
  }

  // Distinct issues across every tile: one in two Projects counts once.
  function distinctCount(projects, noProject) {
    const urls = new Set();
    for (const p of projects) for (const s of p.statuses) for (const i of s.issues) urls.add(i.url);
    for (const i of noProject) urls.add(i.url);
    return urls.size;
  }

  global.GHMI_LAYOUT = { relativeTime, refChips, typeChip, capStatus, barSegments, distinctCount };
})(typeof window !== "undefined" ? window : globalThis);
