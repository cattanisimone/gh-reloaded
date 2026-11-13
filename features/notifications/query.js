// features/notifications/query.js — the pure side of "what can be rebuilt from
// the native inbox query". GitHub's inbox keeps its filter in the `query`
// parameter ("is:unread reason:mention repo:acme/web"). The extension never
// reads inbox HTML, so a check outside the current page works only when the
// whole query can be reproduced from what the Notifications API returns:
// reason:, repo:, org:, is:read / is:unread and participating. Anything else
// (is:saved, is:done, author:, free text, an unmapped reason, a negation) is an
// unsupported filter and the first such token is reported.
//
// A plain global (content scripts cannot import), loaded before fill.js. No DOM.

(function (global) {
  // Native reason token (inbox query) -> the API's `reason` value.
  const REASONS = {
    "review-requested": "review_requested",
    "team-mention": "team_mention",
    "ci-activity": "ci_activity",
    "security-alert": "security_alert",
    "state-change": "state_change",
    "approval-requested": "approval_requested",
    mention: "mention",
    author: "author",
    assign: "assign",
    comment: "comment",
    manual: "manual",
    subscribed: "subscribed",
    invitation: "invitation",
  };

  const tokens = (query) => String(query || "").split(/\s+/).filter(Boolean);

  // The native query of a URL (the `query` parameter, "" when absent).
  function queryOf(search) {
    try {
      return new URL(String(search), "https://github.com").searchParams.get("query") || "";
    } catch {
      return "";
    }
  }

  // search: a URL, a path or a "?query=..." string.
  // -> { key, supported, unsupported, params: { all, participating },
  //      filter: { reasons, repos, orgs, read }, narrowable }
  function analyse(search) {
    const filter = { reasons: [], repos: [], orgs: [], read: null };
    const params = { all: true, participating: false };
    let unsupported = null;
    let narrowable = true;
    const bad = (t) => {
      if (!unsupported) unsupported = t;
    };
    const norm = [];
    for (const raw of tokens(queryOf(search))) {
      const t = raw.toLowerCase();
      norm.push(t);
      const i = t.indexOf(":");
      const name = i < 0 ? "" : t.slice(0, i);
      const value = i < 0 ? "" : t.slice(i + 1);
      if (name === "is" && (value === "unread" || value === "read")) {
        if (filter.read && filter.read !== value) bad(raw);
        filter.read = value;
      } else if (name === "is" && (value === "saved" || value === "done")) {
        narrowable = false;
        bad(raw);
      } else if (name === "reason" && value === "participating") {
        params.participating = true;
        narrowable = false;
      } else if (name === "reason" && Object.hasOwn(REASONS, value)) {
        filter.reasons.push(REASONS[value]);
        narrowable = false;
      } else if (name === "reason") {
        narrowable = false;
        bad(raw);
      } else if (name === "repo" && /^[^/\s]+\/[^/\s]+$/.test(value)) filter.repos.push(value);
      else if (name === "org" && value && !value.includes("/")) filter.orgs.push(value);
      else bad(raw);
    }
    if (filter.read === "unread") params.all = false;
    return { key: [...norm].sort().join(" "), supported: !unsupported, unsupported, params, filter, narrowable };
  }

  // Does an API-shaped item ({ reason, owner, repo, unread }) pass the rebuilt filter?
  function matches(filter, item) {
    if (filter.reasons.length && !filter.reasons.includes(item.reason)) return false;
    const repo = `${item.owner}/${item.repo}`.toLowerCase();
    if (filter.repos.length && !filter.repos.includes(repo)) return false;
    if (filter.orgs.length && !filter.orgs.includes(String(item.owner || "").toLowerCase())) return false;
    if (filter.read === "unread" && item.unread === false) return false;
    if (filter.read === "read" && item.unread !== false) return false;
    return true;
  }

  // The current URL with one more `reason:` token in the query, for the
  // narrowing links. null when the query cannot take it (a reason:, is:saved or
  // is:done token is there already) or no URL is given.
  function narrowHref(href, nativeReason) {
    const q = analyse(href);
    if (!q.narrowable || !Object.hasOwn(REASONS, nativeReason)) return null;
    try {
      const u = new URL(String(href), "https://github.com");
      u.searchParams.set("query", `${queryOf(href)} reason:${nativeReason}`.trim());
      u.searchParams.delete("page");
      u.searchParams.delete("after");
      u.searchParams.delete("before");
      return u.pathname + u.search;
    } catch {
      return null;
    }
  }

  global.GHNT_QUERY = { REASONS, analyse, matches, narrowHref, queryOf };
})(typeof window !== "undefined" ? window : globalThis);
