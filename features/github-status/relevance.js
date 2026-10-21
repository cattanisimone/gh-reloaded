// features/github-status/relevance.js — the pure rules of GitHub Status: how
// the dot looks, whether an open incident concerns the page the user is on,
// and whether a dismissal still holds. No DOM, no storage: loaded before
// content.js and unit-tested on its own.

(function (global) {
  const STALE_MS = 15 * 60_000;
  const CORE = ["git operations", "api requests", "issues", "pull requests", "actions", "webhooks"];
  const RANK = { none: 0, minor: 1, major: 2, critical: 3 };
  const HTML_BLOB = /\.html?$/i;

  // Global (non-repository) first path segments and what they concern.
  const GLOBAL = {
    issues: ["issues", "api requests"],
    pulls: ["pull requests", "api requests"],
    codespaces: ["codespaces"],
    packages: ["packages"],
    orgs: [],
    users: [],
  };
  for (const g of ["settings", "notifications", "marketplace", "explore", "search", "features", "sponsors", "topics", "login", "new", "dashboard", "enterprises", "organizations", "enterprise", "copilot", "apps", "trending", "stars", "account", "collections", "github-copilot", "watching", "readme", "about", "pricing", "customer-stories", "security", "premium-support", "resources", "events", "solutions", "orgs-new", "mobile", "login", "join", "signup"]) GLOBAL[g] = [];

  const lower = (s) => String(s || "").toLowerCase();

  const COMPONENT_RANK = { degraded_performance: 1, partial_outage: 1, major_outage: 2 };
  const DOT_BY_RANK = ["ok", "minor", "major", "critical"];

  // "ok" | "minor" | "major" | "critical" | "maintenance" | "unknown". The worst
  // of the page indicator, the open incidents' impact and the components'
  // status, so the dot is never calmer than the pill (the summary's indicator
  // can say "none" while a critical incident is open). Maintenance only wins
  // when nothing is worse.
  function dotState(view, now) {
    const s = view && view.snapshot;
    if (!s || view.error || !view.fetchedAt || now - view.fetchedAt > STALE_MS) return "unknown";
    let worst = RANK[s.indicator] || 0;
    for (const i of s.incidents || []) worst = Math.max(worst, RANK[i.impact] || 0);
    for (const c of s.components || []) worst = Math.max(worst, COMPONENT_RANK[c.status] || 0);
    if (worst > 0) return DOT_BY_RANK[worst];
    if (s.indicator === "maintenance" || (s.maintenances && s.maintenances.length)) return "maintenance";
    return "ok";
  }

  // Lower-cased component names a path depends on, including API Requests
  // where a GH Reloaded feature calls the GitHub API from that page.
  function componentsForPath(pathname) {
    const parts = String(pathname || "/").split("/").filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
    const out = new Set();
    const add = (...names) => names.forEach((n) => out.add(n));
    if (!parts.length) return out;
    const first = lower(parts[0]);
    if (parts.length === 1 || Object.hasOwn(GLOBAL, first)) {
      if (Object.hasOwn(GLOBAL, first)) {
        if (first === "orgs" || first === "users") {
          if (parts[2] === "projects") add("issues", "api requests");
        } else add(...GLOBAL[first]);
      }
      return out;
    }
    const sub = lower(parts[2]);
    const rest = parts.slice(3);
    if (parts.length === 2) add("git operations");
    else if (sub === "actions") add("actions");
    else if (sub === "runs" || sub === "attestations") add("actions");
    else if (sub === "pull") {
      add("pull requests", "api requests");
      if (lower(rest[1]) === "checks") add("actions");
    } else if (sub === "pulls") add("pull requests", "api requests");
    else if (sub === "issues") add("issues", "api requests");
    else if (sub === "projects") add("issues", "api requests");
    else if (sub === "packages") add("packages");
    else if (sub === "settings") {
      if (lower(rest[0]) === "hooks") add("webhooks");
      else if (lower(rest[0]) === "pages") add("pages");
    } else if (["tree", "commits", "commit", "compare", "branches", "tags", "blame", "raw"].includes(sub)) add("git operations");
    else if (sub === "blob") {
      add("git operations");
      if (HTML_BLOB.test(parts[parts.length - 1])) add("api requests");
    }
    return out;
  }

  function isWide(incident) {
    if (incident.impact === "critical") return true;
    return (incident.components || []).filter((c) => CORE.includes(lower(c))).length >= 3;
  }

  function isRelevant(incident, pathname) {
    if (!incident || incident.impact === "none") return false;
    if (isWide(incident)) return true;
    const here = componentsForPath(pathname);
    return (incident.components || []).some((c) => here.has(lower(c)));
  }

  function isDismissed(dismissed, incident) {
    return !!dismissed && dismissed[incident.id] === incident.updatedAt;
  }

  // The incident that gets the pill on this page, or null: relevant,
  // not dismissed at its current update, worst impact first.
  function noticeFor(snapshot, pathname, dismissed) {
    if (!snapshot) return null;
    const list = snapshot.incidents.filter((i) => isRelevant(i, pathname) && !isDismissed(dismissed, i));
    list.sort((a, b) => RANK[b.impact] - RANK[a.impact]);
    return list[0] || null;
  }

  // Resolved incidents no longer need their dismissal remembered.
  function pruneDismissed(dismissed, snapshot) {
    const live = new Set((snapshot ? snapshot.incidents : []).map((i) => i.id));
    const out = {};
    for (const [id, at] of Object.entries(dismissed || {})) if (live.has(id)) out[id] = at;
    return out;
  }

  const STATUS_WORDS = { degraded_performance: "degraded performance", partial_outage: "partial outage", major_outage: "major outage", under_maintenance: "maintenance" };
  const IMPACT_WORDS = { minor: "minor incident", major: "major incident", critical: "critical incident", none: "incident" };

  // The pill's words: the relevant component and what is wrong with it, or
  // the incident's own name when it is wide (concerns no single component).
  function pillText(incident, snapshot, pathname) {
    const here = componentsForPath(pathname);
    const name = (incident.components || []).find((c) => here.has(lower(c)));
    if (!name || isWide(incident)) return { name: incident.components.length === 1 ? incident.components[0] : "GitHub", detail: IMPACT_WORDS[incident.impact] || "incident" };
    const comp = (snapshot.components || []).find((c) => lower(c.name) === lower(name));
    return { name, detail: (comp && STATUS_WORDS[comp.status]) || IMPACT_WORDS[incident.impact] || "incident" };
  }

  global.GHGS_RELEVANCE = { pillText, STALE_MS, dotState, componentsForPath, isWide, isRelevant, isDismissed, noticeFor, pruneDismissed };
})(typeof window !== "undefined" ? window : globalThis);
