// features/actions-log-shortcuts/model.js — pure rules of "Actions log
// shortcuts": which Actions route a path is, what the page's status words
// mean, which attempt the page names and the `gh` command to copy.
// No DOM, no chrome.*: unit-tested through globalThis.GHALS_MODEL.

(function () {
  const ROUTE = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/(attempts\/(\d+)|job\/(\d+)))?\/?$/;

  function parseRoute(pathname) {
    const m = ROUTE.exec(pathname || "");
    if (!m) return null;
    return { owner: m[1], repo: m[2], run: m[3], job: m[6] || null, attempt: m[5] || null, kind: m[6] ? "job" : "run" };
  }

  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // The line under the job title: "failed  Nov 13, 2026 in 29s", "Started 3 minutes ago".
  function readJobStatus(text) {
    const t = squash(text).toLowerCase();
    if (!t) return "unknown";
    if (/^(started|queued|waiting|pending|requested)\b/.test(t)) return "running";
    const word = t.split(" ")[0];
    if (word === "failed") return "failed";
    if (word === "succeeded" || word === "successful" || word === "success") return "success";
    if (word === "cancelled" || word === "canceled") return "cancelled";
    if (word === "skipped") return "skipped";
    if (word === "timed" || word === "timed_out") return "timed out";
    return "unknown";
  }

  // The page-header icon label ("failed:", "currently running:") first, then the Summary "Status" value.
  function readRunStatus(iconLabel, statusValue) {
    const l = squash(iconLabel).toLowerCase().replace(/:$/, "");
    const v = squash(statusValue).toLowerCase();
    if (l === "failed") return "failed";
    if (/^(currently running|queued|waiting|pending|in progress)/.test(l)) return "running";
    if (l === "cancelled" || l === "canceled") return "cancelled";
    if (l === "successful" || l === "succeeded" || l === "success") return "success";
    if (v === "failure") return "failed";
    if (v === "success") return "success";
    if (v === "cancelled" || v === "canceled") return "cancelled";
    if (v === "in progress" || v === "queued" || v === "waiting") return "running";
    return "unknown";
  }

  const flagFor = (status) => (status === "failed" ? "--log-failed" : "--log");
  const isConcluded = (status) => status !== "running" && status !== "unknown";
  const showCopy = isConcluded;

  // links: [{ text, href, hidden }] — the page's sidebar navigation links. Only
  // the visible "Summary" link of this very run names an attempt.
  function readAttempt(links, route) {
    for (const l of links || []) {
      if (l.hidden || squash(l.text) !== "Summary") continue;
      let path;
      try {
        path = new URL(l.href, "https://github.com").pathname;
      } catch {
        continue;
      }
      const r = parseRoute(path);
      if (!r || r.kind !== "run" || !r.attempt) continue;
      if (r.owner.toLowerCase() !== route.owner.toLowerCase() || r.repo.toLowerCase() !== route.repo.toLowerCase() || r.run !== route.run) continue;
      return r.attempt;
    }
    return null;
  }

  function buildCommand(route, flag, attempt) {
    const at = attempt || route.attempt;
    const att = at ? ` --attempt ${at}` : "";
    const repo = ` --repo ${route.owner}/${route.repo}`;
    if (route.kind === "job") return `gh run view ${flag} --job ${route.job}${att}${repo}`;
    return `gh run view ${route.run} ${flag}${att}${repo}`;
  }

  globalThis.GHALS_MODEL = { parseRoute, readJobStatus, readRunStatus, flagFor, isConcluded, showCopy, readAttempt, buildCommand };
})();
