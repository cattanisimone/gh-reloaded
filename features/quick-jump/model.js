// features/quick-jump/model.js — the pure rules of "Quick jump": the page
// context and its scopes, what counts as a visit and how the recent list is
// kept, how the three personal lists and the recent items are merged into the
// panel's sections, local filtering, the status and empty-state copy, the
// search and fixed-row targets, and the shortcut wording. No DOM, no chrome.*,
// so the page side and the unit tests share it. Exposed as globalThis.GHQJ_MODEL.

(function () {
  const WORK_LIMIT = 10;
  const RECENT_LIMIT = 10;
  const REPO_LIMIT = 5;
  const MATCH_LIMIT = 10;
  const MIN_WAIT_MS = 60_000;
  const DAY = 86_400_000;

  // Top-level paths that are not an owner login.
  const RESERVED = new Set(
    ("about advisories apps account blog codespaces collections contact copilot customer-stories dashboard discussions enterprise enterprises events explore features gist gists git-guides home issues join login logout marketplace mobile new notifications organizations orgs premium-support pricing pulls readme repos resources search security sessions settings signup site sitemap solutions sponsors stars support team topics trending users watching ").trim().split(/\s+/)
  );

  const low = (s) => String(s || "").toLowerCase();
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // ---- page context --------------------------------------------------------

  // The scope values a page offers, in order, with the context owner and repo.
  // `notFound`: the page is GitHub's "Page not found" (no context at all).
  // `nwo`: the repository the page declares ("owner/repo" or ""), when the caller can read it. A path of two
  // segments is a repository only if the page says so (an advisory or an enterprise page is not one).
  function pageContext(pathname, { notFound = false, nwo } = {}) {
    const none = { kind: "global", owner: "", repo: "", scopes: ["everywhere"] };
    if (notFound) return none;
    const parts = String(pathname || "").split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    if (!parts.length) return none;
    const first = low(parts[0]);
    if ((first === "orgs" || first === "users") && parts[1]) {
      if (first === "users" && parts.length === 2) return { kind: "owner", owner: parts[1], repo: "", scopes: ["owner", "everywhere"] };
      return { kind: "owner", owner: parts[1], repo: "", scopes: ["owner", "everywhere"] };
    }
    if (RESERVED.has(first)) return none;
    if (parts.length === 1) return { kind: "owner", owner: parts[0], repo: "", scopes: ["owner", "everywhere"] };
    if (nwo !== undefined && low(nwo) !== low(`${parts[0]}/${parts[1]}`)) return none;
    return { kind: "repo", owner: parts[0], repo: parts[1], scopes: ["repo", "everywhere"] };
  }

  const scopeLabel = (scope, narrow = false) => ({ repo: narrow ? "This repo" : "This repository", owner: "This owner", everywhere: "Everywhere" })[scope] || "Everywhere";
  const scopePhrase = (scope) => ({ repo: "in this repository", owner: "for this owner", everywhere: "in the repositories it can reach" })[scope];

  // ---- visits and the recent list -----------------------------------------

  // The item a page is, read from the pathname, the page title and the
  // repository the page declares (`nwo`, "owner/repo" or ""). A visit exists only
  // when the title names the URL's item, so a redirect or in-page navigation that
  // has not updated the title yet records nothing until it does.
  function parseVisit(pathname, title, nwo) {
    const m = /^\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(String(pathname || ""));
    if (!m) return null;
    const [, owner, repo, rest = ""] = m;
    if (RESERVED.has(low(owner)) || owner === "orgs" || owner === "users") return null;
    const t = squash(title);
    if (!t || /^page not found/i.test(t) || /^sign in to github/i.test(t) || /^\(?404\)?/.test(t)) return null;
    if (nwo && low(nwo) !== low(`${owner}/${repo}`)) return null;
    if (!nwo) return null;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const issue = /^issues\/(\d+)(?:\/|$)/.exec(rest);
    const pull = /^pull\/(\d+)(?:\/|$)/.exec(rest);
    if (issue || pull) {
      const kind = issue ? "issue" : "pull";
      const number = Number((issue || pull)[1]);
      const label = issue ? "Issue" : "Pull Request";
      // "<title> · Issue #n · o/r" and "<title> by <login> · Pull Request #n · o/r", with " · GitHub" added when signed out
      const tail = ` · ${label} #${number} · ${escapeRe(owner)}/${escapeRe(repo)}(?: · GitHub)?$`;
      const tm = (issue ? null : new RegExp(`^(.*) by [^\\s·]+${tail}`, "i").exec(t)) || new RegExp(`^(.*)${tail}`, "i").exec(t);
      if (!tm) return null;
      return { kind, owner, repo: `${owner}/${repo}`, number, title: tm[1].trim() || `${owner}/${repo}#${number}`, url: `${repoUrl}/${issue ? "issues" : "pull"}/${number}`, key: `${low(owner)}/${low(repo)}#${number}` };
    }
    if (/^(issues|pull)(\/|$)/.test(rest) && /^(issues|pull)\/\d/.test(rest)) return null;
    return { kind: "repo", owner, repo: `${owner}/${repo}`, number: 0, title: `${owner}/${repo}`, url: repoUrl, key: `${low(owner)}/${low(repo)}` };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ---- time ----------------------------------------------------------------

  function relativeTime(at, now) {
    const t = typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, Math.round((now - t) / 1000));
    const n = (v, unit) => `${v} ${unit}${v === 1 ? "" : "s"} ago`;
    if (s < 60) return "just now";
    if (s < 3600) return n(Math.floor(s / 60), "minute");
    if (s < 86400) return n(Math.floor(s / 3600), "hour");
    const d = Math.floor(s / 86400);
    if (d < 2) return "yesterday";
    if (d < 7) return n(d, "day");
    if (d < 14) return "last week";
    if (d < 30) return n(Math.floor(d / 7), "week");
    if (d < 60) return "last month";
    if (d < 365) return n(Math.floor(d / 30), "month");
    return n(Math.floor(d / 365), "year");
  }

  // ---- scope and matching --------------------------------------------------

  function inScope(item, scope, ctx) {
    if (scope === "everywhere") return true;
    const repo = low(item.repo);
    if (scope === "repo") return repo === low(`${ctx.owner}/${ctx.repo}`);
    return repo.split("/")[0] === low(ctx.owner);
  }

  const itemKey = (i) => (i.kind === "repo" ? low(i.repo) : `${low(i.repo)}#${i.number}`);

  function words(q) {
    return squash(q).toLowerCase().split(" ").filter(Boolean);
  }

  // All words must match, case-insensitively, in the title, owner/repo or number (61 or #61).
  function matchRanges(item, q) {
    const ws = words(q);
    if (!ws.length) return null;
    const title = low(item.title);
    const repo = low(item.repo);
    const num = item.number ? String(item.number) : "";
    const out = { title: [], repo: [] };
    for (const w of ws) {
      const bare = w.replace(/^#/, "");
      const ti = title.indexOf(w);
      const ri = repo.indexOf(w);
      if (ti >= 0) out.title.push([ti, ti + w.length]);
      else if (ri >= 0) out.repo.push([ri, ri + w.length]);
      else if (num && bare && /^\d+$/.test(bare) && num.startsWith(bare)) continue;
      else return null;
    }
    return { title: mergeRanges(out.title), repo: mergeRanges(out.repo) };
  }

  function mergeRanges(r) {
    const s = [...r].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const x of s) {
      const last = out[out.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else out.push([x[0], x[1]]);
    }
    return out;
  }

  // ---- targets -------------------------------------------------------------

  function qualifier(scope, ctx) {
    if (scope === "repo") return `repo:${ctx.owner}/${ctx.repo}`;
    if (scope === "owner") return `owner:${ctx.owner}`;
    return "";
  }

  const plus = (s) => encodeURIComponent(s).replace(/%20/g, "+").replace(/%40/g, "@").replace(/%3A/gi, ":").replace(/%2F/gi, "/");

  function searchUrl(text, scope, ctx) {
    const q = [qualifier(scope, ctx), squash(text)].filter(Boolean).join(" ");
    return `https://github.com/search?q=${encodeURIComponent(q).replace(/%20/g, "+")}`;
  }

  function fixedUrls(scope, ctx) {
    const q = qualifier(scope, ctx);
    const add = q ? `+${q}` : "";
    return {
      assigned: `https://github.com/search?q=is:issue+is:open+assignee:@me${add}&type=issues`,
      review: `https://github.com/search?q=is:pr+is:open+user-review-requested:@me${add}&type=pullrequests`,
      ownerRepos: `https://github.com/search?q=owner:${plus(ctx.owner || "")}&type=repositories`,
      myRepos: "https://github.com/search?q=user:@me&type=repositories",
      pageAssigned: "https://github.com/issues/assigned",
      pageReview: "https://github.com/pulls/review-requested",
      pagePulls: "https://github.com/pulls",
    };
  }

  // ---- copy ----------------------------------------------------------------

  const NAMES = { assigned: "your assigned issues", review: "your review requests", repos: "active repositories" };

  function joinNames(names) {
    if (names.length <= 1) return names[0] || "";
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  function refreshText(waitMs) {
    return waitMs > 90_000 ? `in about ${Math.ceil(waitMs / 60_000)} minutes` : "in about a minute";
  }

  // The wait before a list is asked again: at least a minute and at least what GitHub asked.
  function waitFor(retryAt, now) {
    return Math.max(MIN_WAIT_MS, Number.isFinite(retryAt) ? retryAt - now : 0);
  }

  // Status lines of lists that are limited or failed, grouped per situation in the stated order.
  // lists: { assigned, review, repos } each { status, items, waitMs }.
  function statusLines(lists) {
    const groups = [
      { key: "limited", cached: false, head: "GitHub is limiting requests right now", tail: "are not shown" },
      { key: "limited", cached: true, head: "GitHub is limiting requests right now", tail: "may be out of date" },
      { key: "error", cached: false, head: "GitHub can't be reached right now", tail: "are not shown" },
      { key: "error", cached: true, head: "GitHub can't be reached right now", tail: "may be out of date" },
    ];
    const out = [];
    for (const g of groups) {
      const hit = ["assigned", "review", "repos"].filter((n) => {
        const l = lists[n];
        return l && l.status === g.key && !!(l.items && l.items.length) === g.cached;
      });
      if (!hit.length) continue;
      const wait = Math.max(...hit.map((n) => lists[n].waitMs || MIN_WAIT_MS));
      out.push({ id: `${g.key}${g.cached ? "-cached" : ""}`, lists: hit, text: `${g.head}, so ${joinNames(hit.map((n) => NAMES[n]))} ${g.tail}. Recent items stay available; they refresh ${refreshText(wait)}.` });
    }
    return out;
  }

  const SETTINGS_LINK = "GH Reloaded settings";

  function cannotLine(list, tokenName) {
    return { text: `GH Reloaded's GitHub token “${tokenName}” can't read ${list === "assigned" ? "your assigned issues" : "your review requests"} here. This opens GitHub's page instead; check the token in ${SETTINGS_LINK}.`, link: SETTINGS_LINK, id: `cannot-${list}` };
  }

  function noServingLine(scope, ctx) {
    const why = scope === "everywhere" ? "applies to Everywhere: none is the default" : `applies here: none is mapped to ${ctx.owner} and none is the default`;
    return { text: `None of the GitHub tokens saved in GH Reloaded ${why}. These open GitHub's own pages; map a token or choose a default in ${SETTINGS_LINK}.`, link: SETTINGS_LINK, id: "no-serving" };
  }

  function ownerLine(owners) {
    const list = (owners || []).filter(Boolean);
    if (!list.length) return null;
    const shown = list.slice(0, 3).join(", ");
    const more = list.length > 3 ? `, and ${list.length - 3} more` : "";
    return { text: `Listed with your default GitHub token. Work in ${shown}${more} shows when you open this view on their pages.`, id: "owner-line" };
  }

  function emptyWorkLine(scope, tokenName, truncated) {
    const ph = scopePhrase(scope);
    if (truncated) {
      const where = scope === "repo" ? " in this repository" : scope === "owner" ? " for this owner" : "";
      return { text: `Nothing assigned to you or waiting for your review${where} among the most recently updated items GH Reloaded's GitHub token “${tokenName}” read.`, id: "empty-work" };
    }
    return { text: `GH Reloaded's GitHub token “${tokenName}” sees nothing assigned to you or waiting for your review ${ph}.`, id: "empty-work" };
  }

  // anyStored: items are stored at all; anyInScope: some of them are in the scope (the once-per-panel
  // rule may still have moved them to Your work, which says nothing about Recent being empty).
  function emptyRecentLine(scope, anyStored, anyInScope) {
    if (!anyStored) return { text: "Issues, pull requests and repositories you open on GitHub will appear here.", id: "empty-recent" };
    if (anyInScope || scope === "everywhere") return null;
    return { text: `Nothing you opened recently ${scope === "repo" ? "in this repository" : "for this owner"}.`, id: "empty-recent" };
  }

  // ---- sections ------------------------------------------------------------

  const TYPE_LABEL = { issue: "Issue", pull: "Pull request", repo: "Repository", link: "" };

  function workRow(i, now) {
    const reason = i.reason === "review" ? "Review requested" : "Assigned to you";
    const ctx = [`${i.repo} #${i.number}`, "Open", reason, relativeTime(i.updatedAt, now)].filter(Boolean);
    return { id: `w:${itemKey(i)}`, type: i.kind, title: i.title, repo: i.repo, number: i.number, ctx, href: i.url, typeLabel: TYPE_LABEL[i.kind], key: itemKey(i) };
  }

  function recentRow(i, now) {
    const kind = i.kind === "pull" ? "pull" : i.kind === "issue" ? "issue" : "repo";
    const ctx = kind === "repo" ? ["Repository", `Visited ${relativeTime(i.at, now)}`] : [`${i.repo} #${i.number}`, `Visited ${relativeTime(i.at, now)}`];
    return { id: `r:${i.key}`, type: kind, title: kind === "repo" ? i.repo : i.title, repo: i.repo, number: i.number || 0, ctx, href: i.url, typeLabel: TYPE_LABEL[kind], key: i.key, bold: kind === "repo" };
  }

  function repoRow(r, now) {
    return { id: `p:${low(r.repo)}`, type: "repo", title: r.repo, repo: r.repo, number: 0, ctx: ["Repository", `Pushed ${relativeTime(r.pushedAt, now)}`], href: r.url, typeLabel: TYPE_LABEL.repo, key: low(r.repo), bold: true };
  }

  const link = (id, title, href) => ({ id, type: "link", title, href, typeLabel: "", key: id, fixed: true });

  // The personal lists and local data → the groups the panel draws (no text typed).
  // input: { scope, ctx, lists:{assigned,review,repos}, recent, now, tokenName, mappedOwners, serving }
  // A list is { status: "ok"|"cannot"|"limited"|"error"|"none"|"loading", items, truncated, waitMs }.
  function buildSections(input) {
    const { scope, ctx, lists, recent, now, tokenName, mappedOwners, serving } = input;
    const urls = fixedUrls(scope, ctx);
    const groups = [];
    const lines = [];
    const loading = ["assigned", "review"].some((n) => lists[n]?.status === "loading") ;

    // -- Your work
    const work = { id: "work", title: "Your work", rows: [], lines: [], loading };
    if (serving === "none" || lists.assigned?.status === "none") {
      work.rows.push(link("fixed:assigned", "Issues assigned to you", urls.pageAssigned), link("fixed:review", "Review requests", urls.pageReview), link("fixed:pulls", "Your pull requests", urls.pagePulls));
      work.lines.push(noServingLine(scope, ctx));
    } else {
      const merged = [];
      let anyCannot = false;
      let truncatedFetched = false;
      for (const n of ["assigned", "review"]) {
        const l = lists[n];
        if (!l) continue;
        if (l.status === "cannot") { anyCannot = true; continue; }
        if (l.truncated) truncatedFetched = true;
        for (const it of l.items || []) merged.push(it);
      }
      const scoped = merged.filter((i) => inScope(i, scope, ctx)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const rows = scoped.slice(0, WORK_LIMIT).map((i) => workRow(i, now));
      work.rows.push(...rows);
      for (const n of ["assigned", "review"]) if (lists[n]?.status === "cannot") work.lines.push(cannotLine(n, tokenName));
      const anyBad = ["assigned", "review"].some((n) => ["limited", "error"].includes(lists[n]?.status) && !(lists[n].items || []).length);
      if (!rows.length && !anyCannot && !anyBad && !loading) work.lines.unshift(emptyWorkLine(scope, tokenName, truncatedFetched));
      if (!lists.assigned || lists.assigned.status !== "cannot") work.rows.push(link("fixed:assigned", "All assigned issues on GitHub", urls.assigned));
      else work.rows.push(link("fixed:assigned-page", "Issues assigned to you", urls.pageAssigned));
      if (!lists.review || lists.review.status !== "cannot") work.rows.push(link("fixed:review", "All review requests on GitHub", urls.review));
      else work.rows.push(link("fixed:review-page", "Review requests", urls.pageReview));
      if (scope === "everywhere") {
        const ol = ownerLine(mappedOwners);
        if (ol) work.lines.push(ol);
      }
    }
    groups.push(work);

    // -- Recent
    const shownKeys = new Set(work.rows.filter((r) => !r.fixed).map((r) => r.key));
    const storedAll = Array.isArray(recent) ? recent : [];
    const recentScoped = storedAll.filter((i) => inScope(i, scope, ctx) && !shownKeys.has(itemKey(i))).slice(0, RECENT_LIMIT);
    const rec = { id: "recent", title: "Recent", rows: recentScoped.map((i) => recentRow(i, now)), lines: [] };
    if (!rec.rows.length) {
      const ln = emptyRecentLine(scope, storedAll.length > 0, storedAll.some((i) => inScope(i, scope, ctx)));
      if (ln) rec.lines.push(ln);
    }
    if (rec.rows.length || rec.lines.length) groups.push(rec);

    // -- Active repositories
    const recentRepoKeys = new Set(rec.rows.filter((r) => r.type === "repo").map((r) => low(r.repo)));
    const rl = lists.repos;
    if (scope !== "repo" && rl && ["ok", "limited", "error", "loading"].includes(rl.status)) {
      const all = (rl.items || []).filter((r) => inScope(r, scope, ctx) && !recentRepoKeys.has(low(r.repo)));
      const sorted = all.slice().sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));
      const shown = sorted.slice(0, REPO_LIMIT);
      const more = sorted.length > REPO_LIMIT || !!rl.truncated;
      const repos = { id: "repos", title: "Active repositories", label: "Recent pushes", rows: shown.map((r) => repoRow(r, now)), lines: [] };
      if (more && (shown.length || scope === "owner" || scope === "everywhere")) {
        if (scope === "owner") repos.rows.push(link("fixed:see-all", "See all on GitHub", urls.ownerRepos));
        else repos.rows.push(link("fixed:my-repos", "Your repositories on GitHub", urls.myRepos));
      }
      if (repos.rows.length) groups.push(repos);
    }
    return { groups, statusLines: statusLines(lists) };
  }

  // Typing: local filter over every fetched item and every stored recent item, within the scope.
  function buildMatches(input) {
    const { query, scope, ctx, lists, recent, now } = input;
    const seen = new Set();
    const rows = [];
    const push = (it, row) => {
      const k = itemKey(it);
      if (seen.has(k) || rows.length >= MATCH_LIMIT) return;
      const m = matchRanges(it, query);
      if (!m) return;
      seen.add(k);
      rows.push({ ...row, ranges: m });
    };
    for (const n of ["assigned", "review"]) {
      for (const it of (lists[n]?.status === "cannot" ? [] : lists[n]?.items || []).filter((i) => inScope(i, scope, ctx)).slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) push(it, workRow(it, now));
    }
    for (const it of (recent || []).filter((i) => inScope(i, scope, ctx))) push({ ...it, kind: it.kind }, recentRow(it, now));
    if (scope !== "repo") {
      for (const it of (lists.repos?.items || []).filter((i) => inScope(i, scope, ctx)).slice().sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt))) push(it, repoRow(it, now));
    }
    const search = link("search", `Search GitHub for “${squash(query)}”`, searchUrl(query, scope, ctx));
    search.hint = [qualifier(scope, ctx), squash(query)].filter(Boolean).join(" ");
    search.type = "search";
    const groups = [];
    if (rows.length) groups.push({ id: "matches", title: "Matches in your work and recent items", rows, lines: [] });
    const none = !rows.length ? { text: "No matches in your work or recent items.", second: "Search GitHub to look beyond them." } : null;
    groups.push({ id: "search", title: "", rows: [search], lines: [] });
    return { groups, none, statusLines: statusLines(lists) };
  }

  // ---- shortcut wording ----------------------------------------------------

  // The key combination in the words of the platform ("Alt+Shift+K" or "⌃⇧K").
  function shortcutText(raw, mac) {
    const s = String(raw || "");
    if (!s) return "";
    if (!mac) return s.replace(/\bMacCtrl\b/g, "Ctrl");
    const map = { MacCtrl: "⌃", Ctrl: "⌃", Command: "⌘", Alt: "⌥", Shift: "⇧" };
    return s.split("+").map((p) => map[p] || p).join("");
  }

  function footerShortcut(state) {
    const mac = state.platform === "mac";
    if (state.choice === "cmdk") return mac ? "⌘K" : "Ctrl+K";
    return shortcutText(state.shortcut, mac) || "Not set";
  }

  // ---- keyboard ------------------------------------------------------------

  // The combination of the ⌘K value: Command+K on Mac, Control+K elsewhere, with nothing else held.
  function isCmdK(e, mac) {
    if (!e || low(e.key) !== "k" || e.shiftKey || e.altKey) return false;
    return mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
  }

  const api = {
    WORK_LIMIT, RECENT_LIMIT, REPO_LIMIT, MATCH_LIMIT, MIN_WAIT_MS,
    pageContext, scopeLabel, parseVisit, relativeTime, inScope, itemKey,
    matchRanges, searchUrl, fixedUrls, statusLines, waitFor, cannotLine, noServingLine, ownerLine,
    emptyWorkLine, emptyRecentLine, buildSections, buildMatches, shortcutText, footerShortcut, isCmdK, joinNames,
  };
  (typeof globalThis !== "undefined" ? globalThis : window).GHQJ_MODEL = api;
})();
