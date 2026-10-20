// features/linked-pr-status/signal.js — the pure rules behind the linked-PR
// row on Projects board cards: one primary signal per pull request, the
// aggregate for several, and the next-step sentence of the detail modal.
// Loaded before content.js as a plain global (content scripts cannot
// import), like features/pr-triage/classify.js.
//
// Priority for an open, non-draft PR: Changes requested > Checks failed >
// Review pending > Checks pending > Approved. Draft, merged and closed come
// first and are neutral. "Approved" describes the review only: nothing here
// ever says "ready" or "mergeable", and a PR that could not be read is
// "Status unavailable", never a success.

(function (global) {
  const FAILED = new Set(["FAILURE", "ERROR"]);
  const RUNNING = new Set(["PENDING", "EXPECTED"]);

  // tone: bad (needs attention), warn (waiting), done (merged), neutral.
  const sig = (id, label, tone, glyph, attention = false) => ({ id, label, tone, glyph, attention });

  function signalOf(pr) {
    if (!pr || pr.ok === false) return sig("unavailable", "Status unavailable", "neutral", "?");
    if (pr.merged || pr.state === "MERGED") return sig("merged", "Merged", "done", "●");
    if (pr.state === "CLOSED") return sig("closed", "Closed", "neutral", "●");
    if (pr.isDraft) return sig("draft", "Draft", "neutral", "○");
    if (pr.reviewDecision === "CHANGES_REQUESTED") return sig("changes", "Changes requested", "bad", "✕", true);
    if (FAILED.has(pr.checks)) return sig("failed", "Checks failed", "bad", "✕", true);
    if (pr.reviewDecision === "REVIEW_REQUIRED") return sig("review", "Review pending", "warn", "●");
    if (RUNNING.has(pr.checks)) return sig("running", "Checks pending", "warn", "●");
    if (pr.reviewDecision === "APPROVED") return sig("approved", "Approved", "neutral", "✓");
    return sig("open", "Open", "neutral", "○");
  }

  // The card text for the linked PRs of one issue. `compact` is the short
  // wording for cards narrower than 300px.
  function summarize(prs, { compact = false } = {}) {
    const list = (prs || []).filter(Boolean);
    if (!list.length) return null;
    if (list.length === 1) return { kind: "one", pr: list[0], signal: signalOf(list[0]) };
    const needs = list.filter((p) => signalOf(p).attention).length;
    const noun = compact ? "PRs" : "linked PRs";
    const tail = needs ? ` · ${needs} needs attention` : "";
    return { kind: "many", count: list.length, needs, text: `${list.length} ${noun}${tail}` };
  }

  // One plain sentence for the modal. `failing` is the list of failing check names.
  function nextStep(pr) {
    const s = signalOf(pr);
    switch (s.id) {
      case "unavailable": return "Open the pull request to see its state.";
      case "merged": return "Nothing to do: this pull request is merged.";
      case "closed": return "Nothing to do: this pull request is closed without merging.";
      case "draft": return "Waiting for the author to mark it ready for review.";
      case "changes": return pr.checks && FAILED.has(pr.checks)
        ? "Address the review feedback and fix the failing checks."
        : "Address the review feedback.";
      case "failed": return "Fix the failing checks.";
      case "review": return "Waiting for a reviewer.";
      case "running": return "Waiting for the checks to finish.";
      case "approved": return "Approved by reviewers. Merge rules are not evaluated here.";
      default: return "No review or checks rule applies.";
    }
  }

  // Checks wording for the modal: "Failing", "Pending", "Passing", "None".
  function checksText(pr) {
    if (!pr || pr.ok === false) return "Unavailable";
    if (FAILED.has(pr.checks)) return "Failing";
    if (RUNNING.has(pr.checks)) return "Pending";
    if (pr.checks === "SUCCESS") return "Passing";
    return "None reported";
  }

  function reviewText(pr) {
    if (!pr || pr.ok === false) return "Unavailable";
    switch (pr.reviewDecision) {
      case "CHANGES_REQUESTED": return "Changes requested";
      case "REVIEW_REQUIRED": return "Review pending";
      case "APPROVED": return "Approved";
      default: return "No review required";
    }
  }

  global.GHLPS_SIGNAL = { signalOf, summarize, nextStep, checksText, reviewText };
})(typeof window !== "undefined" ? window : globalThis);
