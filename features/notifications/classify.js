// features/notifications/classify.js — the pure rules of the notifications
// engine: given one notification (reason, subject) and the facts the
// background read about it, which section is it in? Exactly one of
// "attention" (Needs attention), "waiting", "informational" or
// "unverifiable", with the evidence. Rules run top to bottom, the first
// match wins. Never "attention" without evidence; when in doubt,
// "unverifiable". See .plans/101.html (kept in the pull request) for the
// table these numbers refer to.
//
// A plain global (content scripts cannot import), loaded before engine.js.

(function (global) {
  const DAY_MS = 86_400_000;
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const out = (section, rule, evidence, extra = {}) => ({ section, rule, evidence, ...extra });
  const unverifiable = (rule, ...evidence) => out("unverifiable", rule, evidence);

  // A review that can prove something: submitted, opinionated, not by the
  // PR author (an author's reply is a COMMENTED review) and not by a bot.
  function counted(review, prAuthor) {
    return (
      ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(review.state) &&
      !review.bot &&
      !same(review.author, prAuthor)
    );
  }

  // --- mentions ------------------------------------------------------------

  // Removes what is not a real mention: fenced and indented code, block
  // quotes, inline code spans.
  function stripCode(text) {
    const kept = [];
    let fence = null;
    for (const line of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        continue;
      }
      if (f) {
        fence = f[1];
        continue;
      }
      if (/^( {4}|\t)/.test(line) || /^ {0,3}>/.test(line)) continue;
      kept.push(line);
    }
    return kept.join("\n").replace(/(`+)[\s\S]*?\1/g, " ");
  }

  // @login with word boundaries, case-insensitive: not preceded by a login
  // character or "/" (x@alice, a/@alice), not followed by a login character
  // (@alice-bot, @alicex).
  function hasMention(text, login) {
    if (!login) return false;
    const escaped = String(login).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_\\-/])@${escaped}(?![A-Za-z0-9-])`, "i").test(stripCode(text));
  }

  function classifyMention(facts, ctx, now) {
    const me = ctx.me;
    const windowStart = now - ctx.windowDays * DAY_MS;
    const matches = (facts.texts || [])
      .filter((t) => !same(t.author, me) && hasMention(t.text, me))
      .map((t) => ({ ...t, created: Date.parse(t.at), edited: t.editedAt ? Date.parse(t.editedAt) : NaN }))
      .filter((t) => !Number.isNaN(t.created));
    const recent = matches.filter((t) => t.created >= windowStart).sort((a, b) => b.created - a.created)[0];
    if (recent) {
      return out("attention", 9, ["Direct mention"], { scope: "direct", at: recent.at, href: recent.url || "" });
    }
    const editedInside = matches.some((t) => t.edited >= windowStart);
    const readInFull = facts.commentsTotal <= 50 && facts.mentionReviewsTotal <= 50 && facts.threadsTotal === 0;
    const newest = matches.sort((a, b) => b.created - a.created)[0];
    if (newest && !editedInside && readInFull) {
      return out("informational", 10, ["Mentioned more than the window ago"], { at: newest.at });
    }
    return unverifiable(11, newest ? (editedInside ? "mention in an item edited inside the window" : "read set incomplete") : "no mention found in what was read", "read: body, last 50 comments, last 50 reviews");
  }

  // --- review requests -----------------------------------------------------

  function classifyReview(facts, ctx) {
    const me = ctx.me;
    if (facts.kind !== "pull") return unverifiable(12, "review request on an issue");
    if (facts.state !== "OPEN") return out("informational", 2, [`Pull request ${String(facts.state || "").toLowerCase()}`]);

    const complete = facts.requestsTotal <= 100 && facts.reviewsTotal <= 50 && facts.eventsTotal <= 100;
    const reviews = (facts.reviews || []).filter((r) => counted(r, facts.author));
    const mineOnHead = reviews.find((r) => same(r.author, me) && r.oid === facts.headOid);
    const pendingMe = (facts.users || []).some((u) => same(u, me));
    const pendingTeams = facts.teams || [];
    const events = facts.events || [];

    if (pendingMe && mineOnHead) {
      return unverifiable(4, "re-requested, already reviewed this commit", `my review: ${mineOnHead.at}`);
    }
    if (pendingMe && complete) {
      return out("attention", 3, ["Direct review request", `head ${facts.headOid}`], { scope: "direct" });
    }
    if (!pendingMe && mineOnHead && complete) {
      return out("waiting", 5, ["My review on the latest commit"], { at: mineOnHead.at });
    }

    if (complete && !pendingMe) {
      const removedMe = events.some((e) => e.type === "removed" && e.target === "User" && same(e.name, me));
      const everTeams = new Set([...events.filter((e) => e.type === "added" && e.target === "Team").map((e) => e.name), ...pendingTeams]);
      const allPending = [...everTeams].every((t) => pendingTeams.includes(t));
      if (!removedMe && pendingTeams.length && allPending) {
        const others = reviews.filter((r) => !same(r.author, me)).map((r) => `${r.author} ${r.state}`);
        return out("attention", 6, [`Team review request pending: ${pendingTeams.join(", ")}`, ...others.map((o) => `review by ${o} (does not satisfy a pending request)`)], { scope: "team", teams: pendingTeams });
      }
      const noneRemoved = !events.some((e) => e.type === "removed");
      if (!pendingTeams.length && everTeams.size && noneRemoved) {
        const requestedAt = Math.max(...events.filter((e) => e.type === "added" && e.target === "Team").map((e) => Date.parse(e.at) || 0));
        const answer = reviews
          .filter((r) => !same(r.author, me) && Date.parse(r.at) > requestedAt)
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
        if (answer) {
          return out("waiting", 7, [`Team ${[...everTeams].join(", ")} request answered by ${answer.author}`], { at: answer.at });
        }
      }
    }
    return unverifiable(8, complete ? "request state not provable (removed, partly satisfied or no request)" : "review data incomplete (more than the page size read)");
  }

  // --- entry point ---------------------------------------------------------

  const KNOWN_QUIET = ["subscribed", "ci_activity", "state_change", "comment", "author", "assign", "team_mention", "manual", "security_alert", "approval_requested", "invitation"];

  // input: { row: { reason, kind, rawLabel }, facts, ctx: { me, windowDays, rateLimited, why }, now }
  //   kind: "pull" | "issue" | any other subject kind ("discussion", "commit", "run"…)
  function classify({ row, facts, ctx, now = Date.now() }) {
    const reason = row.reason;
    const isPI = row.kind === "pull" || row.kind === "issue";

    if (isPI && (reason === "review_requested" || reason === "mention")) {
      if (!facts || !facts.ok) {
        return unverifiable(1, ctx.rateLimited ? "rate limited" : (facts && facts.why) || ctx.why || "pull request data unavailable");
      }
      if (!ctx.me) return unverifiable(1, "signed-in login unknown");
      if (!facts.viewer) return unverifiable(1, "token login unknown");
      if (!same(ctx.me, facts.viewer)) return unverifiable(1, "token belongs to another account");
      return reason === "mention" ? classifyMention(facts, ctx, now) : classifyReview(facts, ctx);
    }

    if (reason === "mention" || reason === "review_requested") return unverifiable(12, "subject kind not read", `subject: ${row.kind}`);
    if (reason === "unknown" || !KNOWN_QUIET.includes(reason)) return unverifiable(12, "unrecognised reason label", `label: ${row.rawLabel || ""}`);
    return out("informational", 13, [`Native reason: ${reason}`, `subject: ${row.kind}`]);
  }

  // Does this row need facts from the background?
  function needsFacts(row) {
    return (row.kind === "pull" || row.kind === "issue") && (row.reason === "review_requested" || row.reason === "mention");
  }

  global.GHNT_CLASSIFY = { classify, needsFacts, hasMention, stripCode, counted };
})(typeof window !== "undefined" ? window : globalThis);
