// background/linked-pr-status.js — background half of "Linked PR status" (see
// features/linked-pr-status/). Two messages:
//
//  - GHLPS_FETCH: for the issues on the visible board cards, the pull
//    requests explicitly linked to each one (the issue's Development links,
//    Issue.closedByPullRequestsReferences) with their lifecycle, review
//    decision and checks rollup, kept apart.
//  - GHLPS_DETAIL: the failing check names of one pull request, asked only
//    when the detail modal opens so the board query stays small.
//
// Aliased GraphQL, 20 issues per query, two queries in flight, through
// lib/github-api.js (which caches a response for 60 s). Issues are grouped by
// owner and each group is queried with the token mapped to that owner or the
// default one; saved tokens are never tried in turn. Nothing is inferred: a
// pull request that only mentions an issue is not returned by GitHub here.
// An issue that cannot be read comes back as { ok: false } (the page shows
// nothing: its links are unknown); a pull request that is known but cannot
// be read fully comes back as { ok: false } too (the page says "Status
// unavailable"). A refusal of a whole batch is thrown with its HTTP status.

import { ghGraphQL, GQL_ERRORS, mapWithLimit, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHLPS_FETCH";
export const DETAIL_MESSAGE_TYPE = "GHLPS_DETAIL";

const BATCH = 20;
const IN_FLIGHT = 2;
const NAME = /^[A-Za-z0-9._-]+$/;

const PR_FIELDS = `
  number title url state isDraft reviewDecision
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const keyOf = (i) => `${i.owner}/${i.repo}#${i.number}`;

function validIssue(i) {
  return i && NAME.test(i.owner || "") && NAME.test(i.repo || "") && Number.isInteger(i.number) && i.number > 0;
}

export function buildQuery(issues) {
  const aliases = issues
    .filter(validIssue)
    .map(
      (i, n) =>
        `i${n}: repository(owner: "${i.owner}", name: "${i.repo}") { issue(number: ${i.number}) { closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ${PR_FIELDS} } } } }`
    );
  return `query { ${aliases.join("\n")} }`;
}

export function normalizePr(pr) {
  if (!pr || typeof pr !== "object" || !pr.number) return { ok: false };
  return {
    ok: true,
    number: pr.number,
    title: pr.title || "",
    url: pr.url || "",
    repo: pr.repository?.nameWithOwner || "",
    state: pr.state,
    merged: pr.state === "MERGED",
    isDraft: !!pr.isDraft,
    reviewDecision: pr.reviewDecision || null,
    checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
  };
}

// Which pull requests of an alias did GraphQL report an error on? Returns
// { issue: true } when the error is above the list (the links are unknown) or
// { prs: Set<index> } for errors below a node.
function errorsFor(errors, alias) {
  const out = { issue: false, prs: new Set() };
  for (const e of errors || []) {
    if (!Array.isArray(e.path) || e.path[0] !== alias) continue;
    const at = e.path.indexOf("nodes");
    if (at >= 0 && Number.isInteger(e.path[at + 1])) out.prs.add(e.path[at + 1]);
    else out.issue = true;
  }
  return out;
}

export function normalizeIssue(node, errs = { issue: false, prs: new Set() }) {
  if (errs.issue || !node?.issue) return { ok: false };
  const nodes = node.issue.closedByPullRequestsReferences?.nodes;
  if (!Array.isArray(nodes)) return { ok: false };
  const prs = nodes
    .map((n, i) => (errs.prs.has(i) ? { ...(n ? normalizePr(n) : {}), ok: false } : n ? normalizePr(n) : null))
    .filter(Boolean);
  return { ok: true, prs };
}

export async function handleMessage({ issues } = {}) {
  const wanted = new Map();
  for (const i of issues || []) if (validIssue(i)) wanted.set(keyOf(i), i);
  const facts = {};
  if (!wanted.size) return { facts };

  const byOwner = new Map();
  for (const i of wanted.values()) {
    const o = i.owner.toLowerCase();
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(i);
  }

  // No token for an owner: that owner's cards get no facts; never query
  // anonymously. One unreadable owner must not hide the rest of the board.
  let tokenError = null;
  for (const owner of [...byOwner.keys()]) {
    if (!(await resolveTokenRecord(owner))?.token) {
      byOwner.delete(owner);
      tokenError = tokenError || Object.assign(new Error("No GitHub token for this repository owner"), { status: 401 });
    }
  }
  if (!byOwner.size) throw tokenError;

  const batches = [];
  for (const [owner, list] of byOwner) for (const batch of chunk(list, BATCH)) batches.push({ owner, batch });

  const failures = [];
  await mapWithLimit(batches, IN_FLIGHT, async ({ owner, batch }) => {
    try {
      await runBatch(owner, batch, facts);
    } catch (e) {
      failures.push(e);
    }
  });
  // A rate limit backs the whole page off; otherwise throw only when nothing
  // at all could be read, and keep what the other batches returned.
  const limited = failures.find((e) => e.rateLimited);
  if (limited) throw limited;
  if (failures.length === batches.length) throw failures[0];
  return { facts };
}

async function runBatch(owner, batch, facts) {
  {
    let data;
    try {
      data = await ghGraphQL(buildQuery(batch), {}, { owner, allowPartial: true });
    } catch (e) {
      if (e.graphqlErrors?.some((g) => g.type === "RATE_LIMITED")) e.rateLimited = true;
      throw e;
    }
    const errors = data?.[GQL_ERRORS] || [];
    if (errors.some((g) => g.type === "RATE_LIMITED")) {
      const err = new Error("GitHub rate limit");
      err.status = 429;
      err.rateLimited = true;
      throw err;
    }
    // Every repository null: the token cannot see any of them, a refusal
    // rather than unreadable issues.
    if (!data || batch.every((_, n) => data[`i${n}`] == null)) {
      const err = new Error("GitHub could not read these repositories with the token");
      err.status = 403;
      throw err;
    }
    batch.forEach((issue, n) => {
      facts[keyOf(issue)] = normalizeIssue(data[`i${n}`], errorsFor(errors, `i${n}`));
    });
  }
}

// --- detail: failing check names of one pull request ---

const DETAIL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
      __typename
      ... on CheckRun { name conclusion }
      ... on StatusContext { context state }
    } } } } } }
  } }
}`;

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

export function failingChecks(data) {
  const nodes = data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const names = [];
  for (const n of nodes) {
    if (n?.__typename === "CheckRun" && FAILING_CONCLUSIONS.has(n.conclusion)) names.push(n.name);
    else if (n?.__typename === "StatusContext" && (n.state === "FAILURE" || n.state === "ERROR")) names.push(n.context);
  }
  return names;
}

export async function handleDetail({ owner, repo, number } = {}) {
  if (!NAME.test(owner || "") || !NAME.test(repo || "") || !Number.isInteger(number) || number <= 0) {
    throw new Error("Not a pull request");
  }
  if (!(await resolveTokenRecord(owner))?.token) {
    const err = new Error("No GitHub token for this repository owner");
    err.status = 401;
    throw err;
  }
  const data = await ghGraphQL(DETAIL_QUERY, { owner, repo, number }, { owner });
  if (data?.repository == null) {
    const err = new Error("GitHub could not read this repository with the token");
    err.status = 403;
    throw err;
  }
  return { failing: failingChecks(data) };
}

// The router in background.js finds a feature by one MESSAGE_TYPE; the detail
// message is its own tiny feature module.
export const detail = { MESSAGE_TYPE: DETAIL_MESSAGE_TYPE, handleMessage: handleDetail };
