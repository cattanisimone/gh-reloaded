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

  // --- Go to failed step / Failed steps: N (job pages) -------------------

  // items: [{ number, name, conclusion }] read from the page's own step rows.
  // Only steps the page shows as failed, one per step number, in execution
  // order (the step number; the page order when a number cannot be read).
  function failedSteps(items) {
    const seen = new Set();
    const out = [];
    for (const it of items || []) {
      if (!it || it.conclusion !== "failure") continue;
      const number = String(it.number == null ? "" : it.number).trim();
      if (number && seen.has(number)) continue;
      if (number) seen.add(number);
      out.push({ number, name: squash(it.name) || `Step ${number || out.length + 1}` });
    }
    const n = (s) => (/^\d+$/.test(s.number) ? Number(s.number) : null);
    return out
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const x = n(a.s);
        const y = n(b.s);
        return x != null && y != null && x !== y ? x - y : a.i - b.i;
      })
      .map((e) => e.s);
  }

  const fullLabel = (count) => (count === 1 ? "Go to failed step" : `Failed steps: ${count}`);
  const labelFor = (count, short) => (count < 1 ? null : short ? (count === 1 ? "Go to failure" : `Failed: ${count}`) : fullLabel(count));
  const stepKey = (steps) => steps.map((s) => `${s.number}\u0001${s.name}`).join("\u0002");

  // The candidate places, in the order the control takes the first that fits.
  const PLACES = [
    { id: "name", short: false },
    { id: "subtitle", short: false },
    { id: "name", short: true },
    { id: "subtitle", short: true },
    { id: "edge", short: false },
  ];

  const MIN_GAP = 8;
  const EPS = 0.5;

  // A text rect from Range#getClientRects is the font's content area, a few px
  // taller than the glyphs: the glyph box is that rect inset by GLYPH_INSET px
  // at the top and bottom.
  const GLYPH_INSET = 3;

  // Clearance between the control and one visible text: the larger of the
  // horizontal and the vertical gap between the two boxes (0 when they overlap
  // or touch in an axis). Text on another line counts too: a control directly
  // under a wrapped second name line, or diagonally next to the end of the
  // subtitle, is measured in both axes, so it needs 8px in one of them.
  function textGap(c, t) {
    const gx = Math.max(0, c.left - t.right, t.left - c.right);
    const gy = Math.max(0, c.top - (t.bottom - GLYPH_INSET), t.top + GLYPH_INSET - c.bottom);
    return Math.max(gx, gy);
  }

  // base: GitHub's header as it is without the control; trial: the same
  // measurements with the control in the place `id`. Every field is a number
  // or a rect measured by content.js, so the rule is testable without a DOM.
  //   header { top, bottom, height, covered }   lines [per text]   overflow [per clip box]
  //   texts  [visible rects of GitHub's name and subtitle]   ctrl rect   win { w, h }
  function fits(base, trial, id) {
    const bad = (reason) => ({ ok: false, reason });
    const c = trial.ctrl;
    const w = trial.win;
    if (!c) return bad("no control");
    if (id === "edge") {
      if (c.left < -EPS || c.top < -EPS || c.right > w.w + EPS || c.bottom > w.h + EPS) return bad("outside the window");
      return { ok: true, reason: "" };
    }
    if (Math.abs(trial.header.height - base.header.height) > EPS) return bad("header height changed");
    if (Math.abs(trial.header.covered - base.header.covered) > EPS) return bad("covered stack changed");
    if (base.lines.length !== trial.lines.length || base.lines.some((n, i) => n !== trial.lines[i])) return bad("text lines changed");
    if (base.overflow.length !== trial.overflow.length || base.overflow.some((n, i) => Math.abs(n - trial.overflow[i]) > EPS)) return bad("text overflow changed");
    if (c.top < trial.header.top - EPS || c.bottom > trial.header.bottom + EPS) return bad("outside the header");
    if (c.left < -EPS || c.right > w.w + EPS) return bad("outside the window");
    for (const t of trial.texts) if (textGap(c, t) < MIN_GAP - 0.01) return bad("less than 8px from GitHub's text");
    return { ok: true, reason: "" };
  }

  const landingDelta = (titleTop, covered) => titleTop - covered;
  const needsScroll = (delta) => Math.abs(delta) > 1;

  globalThis.GHALS_MODEL = { parseRoute, readJobStatus, readRunStatus, flagFor, isConcluded, showCopy, readAttempt, buildCommand, failedSteps, fullLabel, labelFor, stepKey, PLACES, fits, landingDelta, needsScroll };
})();
