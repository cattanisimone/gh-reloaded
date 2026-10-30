// features/notifications/reason-tag.js — the pure half of the reason tags:
// which tag a notification gets, its aria-label, and the lines of the
// "Why is this here?" popover for every tag in every data state. No DOM, so
// the rules are unit-tested; reason-tags.js renders them.
//
// Only what the engine proved is stated: a direct, team or re-review tag
// needs the review request to be readable, otherwise the row is
// "Unverifiable" and the popover says what is missing. Other native reasons
// (commented, assigned, author…) get no tag.
//
// A plain global (content scripts cannot import), loaded before reason-tags.js.

(function (global) {
  const TAGS = {
    direct: { label: "Direct review request", tone: "accent", icon: "person", short: "a review request addressed to you" },
    team: { label: "Team review request", tone: "attention", icon: "people", short: "the request is addressed to a team, not necessarily owed by you" },
    rerequest: { label: "Re-review requested", tone: "accent", icon: "sync", short: "you were asked to review again" },
    mention: { label: "Mention", tone: "done", icon: "mention", short: "someone mentioned you" },
    subscribed: { label: "Subscribed", tone: "neutral", icon: "bell", short: "you are subscribed to this thread" },
    ci: { label: "CI", tone: "neutral", icon: "play", short: "activity on a workflow run you follow" },
    unverifiable: { label: "Unverifiable", tone: "severe", icon: "question", short: "the review request cannot be proved from the data available" },
  };

  const tag = (id) => ({ id, ...TAGS[id], aria: `${TAGS[id].label}: ${TAGS[id].short}. Press Enter or ? for details.` });

  function tagFor(item) {
    if (!item) return null;
    switch (item.reason) {
      case "review_requested":
        if (item.pending) return null;
        if (item.kind !== "pull") return tag("unverifiable");
        return tag(item.requestedAs === "direct" || item.requestedAs === "team" || item.requestedAs === "rerequest" ? item.requestedAs : "unverifiable");
      case "mention":
        return tag("mention");
      case "subscribed":
        return tag("subscribed");
      case "ci_activity":
        return tag("ci");
      default:
        return null;
    }
  }

  // What the data looked like when the row was classified.
  function dataState(item, ctx) {
    if (item.pending) return "loading";
    if (item.rule === 1) {
      const why = String((item.evidence || [])[0] || "");
      if (/rate limit/.test(why)) return "rate";
      if (/no token/.test(why)) return "no-token";
      if (/another account/.test(why)) return "other";
      if (/token denied|not readable/.test(why)) return "denied";
      return "failed";
    }
    return "fresh";
  }

  const ownerOf = (item) => item.owner || String(item.key || "").split("/")[0] || "this owner";
  const repoOf = (item) => item.repo || String(item.key || "").split("/")[1]?.split("#")[0] || "this repository";
  const needs = (item) => (item.kind === "pull" ? "Pull requests: Read" : "Issues: Read");
  const subject = (item) => (item.kind === "pull" ? "pull request" : "issue");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function reasonName(item) {
    const raw = String(item.rawLabel || "").trim().toLowerCase();
    return raw || String(item.reason || "unknown").replace(/_/g, " ");
  }

  function age(item, ctx) {
    if (item.readAt == null) return null;
    const ms = Math.max(0, ctx.now - item.readAt);
    const what = `Read from the ${subject(item)}`;
    if (ms < 60_000) return `${what} just now.`;
    const min = Math.floor(ms / 60_000);
    if (min < 120) return `${what} ${min} minute${min === 1 ? "" : "s"} ago: may be stale.`;
    const h = Math.floor(min / 60);
    return `${what} ${h} hour${h === 1 ? "" : "s"} ago: may be stale.`;
  }

  function retryLine(ctx) {
    if (!ctx.retryAt) return "GitHub's rate limit was reached; retrying shortly.";
    const when = new Date(ctx.retryAt);
    const hh = String(when.getHours()).padStart(2, "0");
    const mm = String(when.getMinutes()).padStart(2, "0");
    return `GitHub's rate limit was reached; retrying at ${hh}:${mm}.`;
  }

  const L = (kind, text, extra = {}) => ({ kind, text, ...extra });
  // "Read … just now." is a fact; only an older read that "may be stale" is a warning.
  const ageLine = (text) => L(/may be stale/.test(text) ? "warn" : "ok", text);
  const tokensLink = () => L("link", "Open GitHub tokens settings", { action: "tokens" });

  // The "Missing" lines of a state that blocks the data. `what` is the thing
  // that could not be read ("whether the request is for you or a team",
  // "The mention itself").
  function blocked(state, item, ctx, { what, perm }) {
    const owner = ownerOf(item);
    switch (state) {
      case "no-token":
        return [perm === "mention" ? L("warn", `The mention itself was not read: no GitHub token for ${owner}.`) : L("warn", `Missing: no GitHub token for ${owner}, so ${what} cannot be read.`), tokensLink()];
      case "denied":
        return [
          perm === "mention"
            ? L("warn", `The mention was not read: the token for ${owner} was refused or cannot see ${repoOf(item)}. Reading this needs ${needs(item)} (fine-grained) or the repo scope (classic).`)
            : L("warn", `Missing: the token for ${owner} was refused or cannot see ${repoOf(item)}. Reading this needs ${needs(item)} (fine-grained) or the repo scope (classic).`),
          tokensLink(),
        ];
      case "other": {
        const other = item.tokenLogin ? `@${item.tokenLogin}` : "another account";
        const me = ctx.me ? `@${ctx.me}` : "your account";
        return [
          perm === "mention"
            ? L("warn", `The mention was not checked: the token for ${owner} belongs to ${other}, not ${me}.`)
            : L("warn", `Your token for ${owner} belongs to ${other}, but you are signed in as ${me}, so the request cannot be matched to you.`),
          tokensLink(),
        ];
      }
      case "rate":
        return [L("warn", retryLine(ctx))];
      default:
        return [L("warn", "GitHub did not answer; retrying on the next scan.")];
    }
  }

  function reviewLines(t, item, ctx, state) {
    const fresh = age(item, ctx);
    const freshLine = fresh ? [ageLine(fresh)] : [];
    if (item.kind !== "pull") return { lines: [L("info", "This is not a pull request, so the request cannot be read.")], rule: "Rule: a review request is read only from a pull request." };
    if (t.id === "direct") {
      const pending = item.rule === 3;
      return {
        lines: [L("ok", pending ? "A review request for you is pending." : "A request event names you, and it was not removed."), ...freshLine],
        rule: "Rule: direct review request is shown only when the pull request's reviewer list or request events name you.",
      };
    }
    if (t.id === "rerequest") {
      return { lines: [L("ok", "You were requested again after you already reviewed this pull request."), ...freshLine], rule: "Rule: a request event for you after a review of yours means a new review was asked." };
    }
    if (t.id === "team") {
      const teams = (item.teams || []).join(", ") || "a team";
      const others = (item.evidence || []).filter((e) => /^review by /.test(e)).map((e) => L("ok", cap(e)));
      return {
        lines: [L("info", `Request addressed to team ${teams}, not to you.`), ...others, ...freshLine],
        rule: "Rule: pending team request, no request addressed to you. A team request does not mean the review is owed by you.",
      };
    }
    // Unverifiable
    const rule = "Rule: direct vs team is shown only when it can be proved.";
    if (state !== "fresh") return { lines: [...blocked(state, item, ctx, { what: "whether the request is for you or a team" })], rule };
    const why = String((item.evidence || [])[0] || "");
    const msg = /incomplete/.test(why)
      ? "More reviews or requests than one read returns; the result would be a guess."
      : "You were requested and then removed, or the request is partly satisfied; the current request is not provable.";
    return { lines: [L("info", msg), ...freshLine], rule };
  }

  function mentionLines(item, ctx, state) {
    const rule = "Rule: shown whenever GitHub's reason is mention; the popover adds the mention when it could be read.";
    if (state === "loading") return { lines: [L("info", "Checking the mention…")], rule };
    if (["no-token", "denied", "other"].includes(state)) return { lines: blocked(state, item, ctx, { perm: "mention" }), rule };
    if (state === "rate" || state === "failed") return { lines: blocked(state, item, ctx, { perm: "mention" }), rule };
    const fresh = age(item, ctx);
    const freshLine = fresh ? [ageLine(fresh)] : [];
    if (item.by) {
      const where = item.source === "body" ? "the description" : item.source === "review" ? "a review" : "a comment";
      const link = item.href ? [L("link", "Open the mention", { href: item.href })] : [];
      return { lines: [L("ok", `Mentioned by @${item.by} in ${where}.`), ...link, ...freshLine], rule };
    }
    const why = String((item.evidence || [])[0] || "");
    const msg = /edited/.test(why)
      ? "A mention of you was edited recently, so when it was written cannot be proved."
      : /incomplete/.test(why)
        ? "Only the last comments and reviews were read; the mention may be further down."
        : "No mention of you found in what was read; it may be in an older or edited comment.";
    return { lines: [L("info", msg), ...freshLine], rule };
  }

  function popover(item, ctx) {
    const t = tagFor(item);
    const lines = [L("ok", `GitHub reason: ${reasonName(item)}`)];
    if (!t) return { title: "Why is this here?", lines, tag: null };
    let body;
    if (t.id === "subscribed" || t.id === "ci") {
      body = {
        lines: [L("info", "Source: GitHub's label on this page. Nothing else is read for this reason."), L("info", t.id === "ci" ? "From a workflow run you are subscribed to." : "You watch this repository or thread.")],
        rule: t.id === "ci" ? "Rule: shown whenever GitHub's reason is CI activity." : "Rule: shown whenever GitHub's reason is subscribed.",
      };
    } else if (t.id === "mention") {
      body = mentionLines(item, ctx, dataState(item, ctx));
    } else {
      body = reviewLines(t, item, ctx, dataState(item, ctx));
    }
    lines.push(...body.lines);
    // A row already classified keeps its tag through a rate limit: add why it may be stale.
    if (ctx.rateLimited && !["subscribed", "ci"].includes(t.id) && dataState(item, ctx) !== "rate") lines.push(L("warn", retryLine(ctx)));
    lines.push(L("rule", body.rule));
    return { title: "Why is this here?", lines, tag: t };
  }

  global.GHNT_REASON_TAG = { tagFor, popover, dataState, TAGS };
})(typeof window !== "undefined" ? window : globalThis);
