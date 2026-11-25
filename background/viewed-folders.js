// background/viewed-folders.js — background half of "Viewed per folder" (see
// features/viewed-folders/). One message type:
//
//  - GHVF_FETCH: the changed files of one pull request with the signed-in
//    user's viewed state (PullRequest.files { path viewerViewedState }), read
//    through the shared GraphQL client with the token already mapped to the
//    repository owner. Read-only: the query has no mutation and nothing is
//    ever written to GitHub.
//
// No token means no request. Any failure (a token that cannot read the state,
// 401/403/404, GitHub returning no pull request, a rate limit, a timeout, a
// page that fails half way) answers { files: null }: the page then falls back
// to GitHub's own "Viewed" buttons and shows what it can prove. Nothing is
// requested from the user and no permission is added.

import { ghGraphQL, resolveTokenRecord } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHVF_FETCH";

const NAME = /^[A-Za-z0-9._-]+$/;
const PAGE = 100;
const MAX_PAGES = 30; // GitHub lists at most 3000 files of a pull request
const TIMEOUT_MS = 30000;

export const QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: ${PAGE}, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { path viewerViewedState }
        }
      }
    }
  }
`;

// VIEWED is viewed; UNVIEWED and DISMISSED (viewed, then changed by a later commit)
// are not viewed, as the native checkbox shows them. Any other value is not read:
// that file stays unknown.
export function viewedOf(state) {
  if (state === "VIEWED") return true;
  if (state === "UNVIEWED" || state === "DISMISSED") return false;
  return undefined;
}

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function handleMessage({ owner, repo, number } = {}) {
  if (!NAME.test(owner || "") || !NAME.test(repo || "") || !Number.isInteger(number) || number <= 0) return { files: null };
  if (!(await resolveTokenRecord(owner))?.token) return { files: null };

  const files = [];
  let total = null;
  let after = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      // fresh: a cached answer could be a minute old and undo a file the user just ticked.
      const data = await withTimeout(ghGraphQL(QUERY, { owner, repo, number, after }, { owner, fresh: true }));
      const list = data?.repository?.pullRequest?.files;
      if (!list || !Array.isArray(list.nodes)) return { files: null };
      total = Number.isInteger(list.totalCount) ? list.totalCount : total;
      for (const node of list.nodes) {
        const viewed = viewedOf(node?.viewerViewedState);
        if (typeof node?.path === "string" && node.path && viewed !== undefined) files.push({ path: node.path, viewed });
      }
      if (!list.pageInfo?.hasNextPage || !list.pageInfo.endCursor) break;
      after = list.pageInfo.endCursor;
    }
  } catch {
    return { files: null };
  }
  return { files, total };
}
