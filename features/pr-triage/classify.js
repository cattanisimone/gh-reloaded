// features/pr-triage/classify.js — the pure rules behind PR triage: given
// who "me" is and the facts the background normalised for one pull request,
// whose move is it? Each PR gets at most one placement; the author role
// comes first. Loaded before content.js as a plain global (content scripts
// cannot import), like features/my-issues/layout.js.
//
// Deliberately absent: "ready to merge" (branch rules may still block) and
// "unread" (GitHub exposes no reliable signal). A changes-requested review
// from me never becomes my move again until GitHub shows a new request for
// my review; new commits alone prove nothing.

(function (global) {
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const names = (users, teams) => [...users, ...teams.map((t) => `@${t}`)].join(", ");
  const none = { placement: null, label: "", title: "" };

  function asAuthor(f) {
    const blockers = f.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && !f.users.some((u) => same(u, r.author)));
    if (blockers.length) {
      const who = [...new Set(blockers.map((r) => r.author))].join(", ");
      return { placement: "yours", label: `Changes requested by ${who}`, title: `Changes requested by ${who}; not requested again` };
    }
    if (f.checks === "FAILURE" || f.checks === "ERROR") {
      return { placement: "yours", label: "Checks failing", title: "Your turn: the latest checks are failing" };
    }
    if (f.mergeable === "CONFLICTING") {
      return { placement: "yours", label: "Merge conflict", title: "Your turn: the branch conflicts with its base" };
    }
    if (f.isDraft) return none;
    if (f.users.length || f.teams.length) {
      const who = names(f.users, f.teams);
      return { placement: "waiting", label: `Waiting on review · ${who}`, title: `Review requested from ${who}` };
    }
    if (f.checks === "PENDING" || f.checks === "EXPECTED") {
      return { placement: "waiting", label: "Waiting on checks", title: "Checks are still running" };
    }
    return none;
  }

  function asReviewer(me, f) {
    if (f.users.some((u) => same(u, me))) {
      return { placement: "yours", label: "Review requested", title: "Your review was requested" };
    }
    const mine = f.reviews.find((r) => same(r.author, me));
    if (mine && mine.state === "CHANGES_REQUESTED") {
      const newer = mine.oid && f.headOid && mine.oid !== f.headOid;
      return {
        placement: "waiting",
        label: newer ? "Waiting on author · new commits since your review" : "Waiting on author",
        title: `You requested changes${mine.at ? ` on ${mine.at.slice(0, 10)}` : ""}; you were not asked to review again${newer ? ", although there are new commits" : ""}`,
      };
    }
    if (mine && mine.state === "APPROVED") return none;
    if (f.teams.length) {
      const who = names([], f.teams);
      return { placement: "team", label: `Team review requested · ${who}`, title: `Review requested from ${who}; membership is not checked` };
    }
    return none;
  }

  function classify(me, facts) {
    if (!facts || !facts.ok) {
      return { placement: "unavailable", label: "Triage unavailable", title: "Review data could not be loaded for this pull request" };
    }
    if (facts.state && facts.state !== "OPEN") return none;
    return same(facts.author, me) ? asAuthor(facts) : asReviewer(me, facts);
  }

  function summarize(placements) {
    const out = { yours: 0, waiting: 0, unavailable: 0 };
    for (const p of placements) if (p in out) out[p]++;
    return out;
  }

  global.GHPRT_CLASSIFY = { classify, summarize };
})(typeof window !== "undefined" ? window : globalThis);
