// background/notifications.js — background half of the notifications engine
// (see features/notifications/). For the rows the page has loaded it reads,
// read-only, the facts the classifier needs: for a review request the PR's
// state, head commit, pending reviewers, reviews and review-request events;
// for a mention the body and the last comments and reviews with their times.
// It also reads the signed-in token's own login per owner (the classifier
// refuses a token that belongs to another account), and optionally the
// first pages of GET /notifications (classic token, scope `notifications`).
//
// Limits: one aliased GraphQL query per repository and batch of 25, two in
// flight; at most 2 pages of 50 from the Notifications API with the default
// token. Nothing is written to GitHub, nothing is stored: text is read and
// matched in memory only. Failures are reported in-band (capabilities,
// rateLimited/retryAt) so the engine keeps what it already classified.

import { ghFetchRaw, ghGraphQL, mapWithLimit, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHNT_FETCH";

const BATCH = 25;
const IN_FLIGHT = 2;
const API_PAGES = 2;
const NAME = /^[A-Za-z0-9._-]+$/;

const actor = `__typename ... on User { login } ... on Team { slug organization { login } }`;
const REVIEW_FIELDS = `
  state headRefOid
  author { login }
  reviewRequests(first: 100) { totalCount nodes { requestedReviewer { ${actor} } } }
  reviews(last: 50) { totalCount nodes { state submittedAt author { login __typename } commit { oid } } }
  timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) {
    totalCount
    nodes { __typename ... on ReviewRequestedEvent { createdAt requestedReviewer { ${actor} } } ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { ${actor} } } }
  }
`;
const COMMENT_FIELDS = `comments(last: 50) { totalCount nodes { url body createdAt lastEditedAt author { login } } }`;
const MENTION_ISSUE = `state url body createdAt lastEditedAt author { login } ${COMMENT_FIELDS}`;
const MENTION_PULL = `${MENTION_ISSUE}
  reviews(last: 50) { totalCount nodes { url body createdAt lastEditedAt author { login } } }
  reviewThreads(first: 1) { totalCount }`;

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const alias = (r) => `${r.kind === "pull" ? "p" : "i"}${r.number}`;

export function buildQuery(rows) {
  const parts = rows.map((r) => {
    if (r.kind === "pull") return `${alias(r)}: pullRequest(number: ${r.number}) { ${r.reason === "review_requested" ? REVIEW_FIELDS : MENTION_PULL} }`;
    return `${alias(r)}: issue(number: ${r.number}) { ${MENTION_ISSUE} }`;
  });
  return `query($owner: String!, $repo: String!) { viewer { login } repository(owner: $owner, name: $repo) { ${parts.join("\n")} } }`;
}

function who(a) {
  if (a?.__typename === "User" && a.login) return { target: "User", name: a.login };
  if (a?.__typename === "Team" && a.slug) return { target: "Team", name: a.organization?.login ? `${a.organization.login}/${a.slug}` : a.slug };
  return null;
}

export function normalizeReview(pr, viewer) {
  if (!pr || typeof pr !== "object") return { ok: false, why: "pull request not readable" };
  const users = [];
  const teams = [];
  for (const n of pr.reviewRequests?.nodes || []) {
    const w = who(n?.requestedReviewer);
    if (w?.target === "User") users.push(w.name);
    else if (w?.target === "Team") teams.push(w.name);
  }
  const reviews = (pr.reviews?.nodes || [])
    .filter((r) => r?.author?.login)
    .map((r) => ({ author: r.author.login, bot: r.author.__typename === "Bot", state: r.state, oid: r.commit?.oid || "", at: r.submittedAt || "" }));
  const events = (pr.timelineItems?.nodes || [])
    .map((e) => ({ w: who(e?.requestedReviewer), type: e?.__typename === "ReviewRequestedEvent" ? "added" : e?.__typename === "ReviewRequestRemovedEvent" ? "removed" : "", at: e?.createdAt || "" }))
    .filter((e) => e.w && e.type)
    .map((e) => ({ type: e.type, target: e.w.target, name: e.w.name, at: e.at }));
  return {
    ok: true,
    kind: "pull",
    viewer: viewer || "",
    state: pr.state,
    headOid: pr.headRefOid || "",
    author: pr.author?.login || "",
    users,
    teams,
    requestsTotal: pr.reviewRequests?.totalCount ?? Infinity,
    reviews,
    reviewsTotal: pr.reviews?.totalCount ?? Infinity,
    events,
    eventsTotal: pr.timelineItems?.totalCount ?? Infinity,
  };
}

export function normalizeMention(node, kind, viewer) {
  if (!node || typeof node !== "object") return { ok: false, why: `${kind === "pull" ? "pull request" : "issue"} not readable` };
  const item = (n, source) => ({ source, text: n?.body || "", at: n?.createdAt || "", editedAt: n?.lastEditedAt || "", author: n?.author?.login || "", url: n?.url || "" });
  const texts = [item(node, "body"), ...(node.comments?.nodes || []).map((n) => item(n, "comment")), ...(node.reviews?.nodes || []).map((n) => item(n, "review"))];
  return {
    ok: true,
    kind,
    viewer: viewer || "",
    state: node.state,
    texts,
    commentsTotal: node.comments?.totalCount ?? Infinity,
    mentionReviewsTotal: kind === "pull" ? node.reviews?.totalCount ?? Infinity : 0,
    threadsTotal: kind === "pull" ? node.reviewThreads?.totalCount ?? Infinity : 0,
  };
}

// Why the Notifications API did not answer. A classic token's scope headers
// can prove the scope missing; everything else stays cause-less.
export function apiFailure(e) {
  if (e?.rateLimited) return { state: "rate-limited", retryAt: e.retryAt ?? null };
  const classic = Array.isArray(e?.scopes);
  const lacks = classic && !e.scopes.includes("notifications") && !e.scopes.includes("repo") && (e.acceptedScopes || []).includes("notifications");
  return { state: lacks ? "missing-scope" : "unavailable" };
}

const subjectKey = (item) => {
  const m = /\/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)$/.exec(item?.subject?.url || "");
  return m ? { key: `${m[1]}/${m[2]}#${m[4]}`.toLowerCase(), kind: m[3] === "pulls" ? "pull" : "issue", owner: m[1], repo: m[2], number: Number(m[4]) } : null;
};

async function readApi() {
  if (!(await resolveTokenRecord())?.token) return { state: "not-tried", items: [] };
  const items = [];
  try {
    for (let page = 1; page <= API_PAGES; page++) {
      const res = await ghFetchRaw(`/notifications?per_page=50&page=${page}`);
      if (Array.isArray(res.data)) items.push(...res.data);
      if (!/rel="next"/.test(res.link)) break;
    }
  } catch (e) {
    return { ...apiFailure(e), items: [] };
  }
  // Empty data proves nothing (a fine-grained token, a filtered account).
  return { state: items.length ? "ok" : "unavailable", items };
}

export async function handleMessage({ rows, api } = {}) {
  const result = { facts: {}, capabilities: {}, api: { state: "not-tried", items: [] }, rateLimited: false, retryAt: null, reasons: {} };
  const note = (e) => {
    result.rateLimited = true;
    if (e.retryAt != null) result.retryAt = Math.max(result.retryAt ?? 0, e.retryAt);
  };

  if (api) {
    const read = await readApi();
    // Only the fields the page needs, in the REST shape collect.fromApiItem reads.
    result.api = { state: read.state, items: read.items.map((i) => ({ id: i.id, reason: i.reason, unread: !!i.unread, subject: { url: i.subject?.url || "", type: i.subject?.type || "", title: i.subject?.title || "" }, repository: { full_name: i.repository?.full_name || "" } })) };
    if (read.state === "rate-limited") note({ retryAt: read.retryAt });
  }

  // Effective rows: the page's, with the REST reason winning, plus API-only items.
  const byKey = new Map();
  for (const r of rows || []) {
    if (NAME.test(r?.owner || "") && NAME.test(r?.repo || "") && Number.isInteger(r.number)) byKey.set(r.key, { ...r });
  }
  for (const item of apiRows(result.api.items)) {
    const have = byKey.get(item.key);
    if (have) have.reason = item.reason;
    else byKey.set(item.key, item);
  }
  for (const r of byKey.values()) result.reasons[r.key] = r.reason;

  const wanted = [...byKey.values()].filter((r) => (r.kind === "pull" || r.kind === "issue") && (r.reason === "review_requested" || r.reason === "mention"));
  const groups = new Map();
  for (const r of wanted) {
    const id = `${r.owner}/${r.repo}`.toLowerCase();
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  const tasks = [];
  for (const list of groups.values()) for (const batch of chunk(list, BATCH)) tasks.push(batch);
  const cap = (owner, state) => {
    const k = `pr:${owner.toLowerCase()}`;
    // The first non-ok answer for an owner stays; ok never overwrites it.
    if (!result.capabilities[k] || (result.capabilities[k] === "ok" && state !== "ok")) result.capabilities[k] = state;
  };
  const fail = (batch, why, state) => {
    for (const r of batch) result.facts[r.key] = { ok: false, why };
    cap(batch[0].owner, state);
  };

  await mapWithLimit(tasks, IN_FLIGHT, async (batch) => {
    const { owner, repo } = batch[0];
    if (result.rateLimited) return fail(batch, "rate limited", "rate-limited");
    if (!(await resolveTokenRecord(owner))?.token) return fail(batch, "no token for this owner", "no-token");
    let data;
    try {
      data = await ghGraphQL(buildQuery(batch), { owner, repo }, { owner, allowPartial: true });
    } catch (e) {
      if (e.graphqlErrors?.some((g) => g.type === "RATE_LIMITED")) e.rateLimited = true;
      if (e.rateLimited) {
        note(e);
        return fail(batch, "rate limited", "rate-limited");
      }
      if (e.status === 401 || e.status === 403) return fail(batch, "token denied", "denied");
      return fail(batch, "request failed", "unavailable");
    }
    if (data?.repository == null) return fail(batch, "repository not readable with this token", "denied");
    const viewer = data.viewer?.login || "";
    for (const r of batch) {
      const node = data.repository[alias(r)];
      result.facts[r.key] = r.kind === "pull" && r.reason === "review_requested" ? normalizeReview(node, viewer) : normalizeMention(node, r.kind, viewer);
    }
    cap(owner, "ok");
  });
  return result;
}

function apiRows(items) {
  return items
    .map((i) => ({ i, k: subjectKey(i) }))
    .filter((x) => x.k)
    .map((x) => ({ ...x.k, reason: x.i.reason || "unknown", inPage: false }));
}
