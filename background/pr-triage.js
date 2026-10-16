// background/pr-triage.js — background half of "PR triage" (see
// features/pr-triage/). Given the pull request numbers visible on a
// repository's /pulls page, returns the review facts the content script's
// classifier needs: the author, who is asked to review, each reviewer's
// latest opinionated review (and the commit it was on), the head commit and
// the checks rollup of the last commit.
//
// One aliased GraphQL query per batch of 25 numbers, two batches in flight,
// through lib/github-api.js (which caches a response for 60 s). Only the
// repository the page shows is queried, with the token mapped to its owner
// or the default one. A pull request that cannot be read (missing alias,
// per-alias error) comes back as { ok: false } so the page says "Triage
// unavailable" instead of guessing; a refusal of the whole request is thrown
// with its HTTP status so the page can say why.

import { ghGraphQL, mapWithLimit, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHPRT_FETCH";

const BATCH = 25;
const IN_FLIGHT = 2;
const NAME = /^[A-Za-z0-9._-]+$/;

const FIELDS = `
  state isDraft mergeable headRefOid
  author { login }
  reviewRequests(first: 30) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
  }
  latestOpinionatedReviews(first: 30) {
    nodes { author { login } state submittedAt commit { oid } }
  }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildQuery(numbers) {
  const aliases = numbers
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((n) => `p${n}: pullRequest(number: ${n}) { ${FIELDS} }`);
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${aliases.join("\n")} } }`;
}

export function normalize(pr) {
  if (!pr || typeof pr !== "object") return { ok: false };
  const users = [];
  const teams = [];
  for (const n of pr.reviewRequests?.nodes || []) {
    const r = n?.requestedReviewer;
    if (r?.__typename === "User" && r.login) users.push(r.login);
    else if (r?.__typename === "Team" && r.slug) teams.push(r.organization?.login ? `${r.organization.login}/${r.slug}` : r.slug);
  }
  const reviews = (pr.latestOpinionatedReviews?.nodes || [])
    .filter((r) => r?.author?.login)
    .map((r) => ({ author: r.author.login, state: r.state, oid: r.commit?.oid || "", at: r.submittedAt || "" }));
  return {
    ok: true,
    state: pr.state,
    isDraft: !!pr.isDraft,
    mergeable: pr.mergeable || null,
    headOid: pr.headRefOid || "",
    author: pr.author?.login || "",
    users,
    teams,
    reviews,
    checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null,
  };
}

export async function handleMessage({ owner, repo, numbers } = {}) {
  if (!NAME.test(owner || "") || !NAME.test(repo || "")) throw new Error("Not a repository");
  const wanted = [...new Set((numbers || []).filter((n) => Number.isInteger(n) && n > 0))];
  const facts = {};
  if (!wanted.length) return { facts };

  // No token: the page says so; never query anonymously.
  if (!(await resolveTokenRecord(owner))?.token) {
    const err = new Error("No GitHub token for this repository owner");
    err.status = 401;
    throw err;
  }

  await mapWithLimit(chunk(wanted, BATCH), IN_FLIGHT, async (batch) => {
    let data;
    try {
      data = await ghGraphQL(buildQuery(batch), { owner, repo }, { owner, allowPartial: true });
    } catch (e) {
      if (e.graphqlErrors?.some((g) => g.type === "RATE_LIMITED")) e.rateLimited = true;
      throw e;
    }
    for (const n of batch) facts[n] = normalize(data?.repository?.[`p${n}`]);
  });
  return { facts };
}
