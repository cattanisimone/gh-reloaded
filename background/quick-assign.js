// background/quick-assign.js — background half of "Quick assignment" (see
// features/quick-assign/). The page changes assignees through GitHub's own
// picker; this only reads the issue back, read-only, so the page can say
// "confirmed" from GitHub's stored state instead of from its own re-render.
//
// The read goes through lib/github-api.js with `noStore`: GitHub serves
// this endpoint with max-age=60, and a cached body would turn a successful
// Assign-then-Unassign into a false failure. A failed read is returned as
// data ({ error: { kind, ... } }) rather than thrown, so the page can tell
// "no permission to read" from "rate limited" from "no token for a private
// repository" and word the fix.

import { ghFetch, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "QUICK_ASSIGN_READ_ASSIGNEES";

const NAME = /^[A-Za-z0-9._-]+$/;

export function errorKind(err, hasTokenForOwner) {
  if (err?.rateLimited || err?.status === 429) return "rate";
  if (err?.status === 401 || err?.status === 403 || err?.status === 404) return hasTokenForOwner ? "denied" : "notoken";
  return "error";
}

export async function handleMessage({ owner, repo, number } = {}) {
  if (!NAME.test(owner || "") || !NAME.test(repo || "") || !Number.isInteger(number) || number < 1) {
    return { error: { kind: "error" } };
  }
  try {
    const issue = await ghFetch(`/repos/${owner}/${repo}/issues/${number}`, { owner, noStore: true });
    const assignees = (Array.isArray(issue?.assignees) ? issue.assignees : []).map((a) => a?.login).filter(Boolean);
    return { assignees };
  } catch (e) {
    const record = await resolveTokenRecord(owner);
    const error = { kind: errorKind(e, !!record?.token), status: e?.status || 0 };
    if (error.kind === "rate" && e?.retryAt) error.retryAt = e.retryAt;
    return { error };
  }
}
