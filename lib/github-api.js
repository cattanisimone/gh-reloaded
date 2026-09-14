// lib/github-api.js — shared GitHub REST/GraphQL client for the service
// worker. Every feature's background module talks to GitHub through
// this, not through fetch() directly: it's the one place that knows about
// auth, API versioning, and short-lived caching, so a new feature doesn't
// have to reinvent any of that.
//
// This lives in the background rather than in content scripts because
// content scripts run in the page's isolated world and their network
// requests can get tangled up with the host page's CSP — centralizing
// fetches here, where the extension's own `host_permissions` apply
// cleanly, is simpler and more robust.

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28"; // GitHub's one stable REST API version string.

// Tiny in-memory cache so a burst of re-renders (SPA nav, polling
// fallback) across any feature doesn't re-hit the API and eat into rate
// limits. Shared across features on purpose — they're all hitting the
// same underlying GitHub data.
const cache = new Map(); // key -> { at, data }
const CACHE_TTL_MS = 60_000;

export async function getToken() {
  const { githubToken } = await chrome.storage.local.get("githubToken");
  return githubToken || null;
}

export async function ghFetch(path) {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const token = await getToken();
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  cache.set(path, { at: Date.now(), data });
  return data;
}

export async function ghGraphQL(query, variables) {
  const cacheKey = "gql:" + JSON.stringify({ query, variables });
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const token = await getToken();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const err = new Error(`GitHub GraphQL API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  cache.set(cacheKey, { at: Date.now(), data: json.data });
  return json.data;
}

// --- Small degrade-gracefully wrappers used by more than one feature. Any
// of these (issue dependencies, Projects v2 Status, org-level custom
// fields) can be absent on a given repo/org — treat that as "no data",
// not a fatal error. ---

export async function safeDeps(owner, repo, number, direction) {
  try {
    return await ghFetch(
      `/repos/${owner}/${repo}/issues/${number}/dependencies/${direction}?per_page=100`
    );
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

const STATUS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        projectItems(first: 10) {
          nodes {
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name color }
            }
          }
        }
      }
    }
  }
`;

export async function safeStatus(owner, repo, number) {
  try {
    const data = await ghGraphQL(STATUS_QUERY, { owner, repo, number });
    const nodes = data?.repository?.issue?.projectItems?.nodes || [];
    if (!nodes.length) {
      // Most common cause: the token is missing the "Projects: Read-only"
      // permission — GraphQL doesn't error, it just returns no items.
      console.warn(
        `[gh-reloaded] No project items for ${owner}/${repo}#${number} — check the token's "Projects" permission.`
      );
    }
    const withStatus = nodes.find((n) => n.fieldValueByName);
    return withStatus
      ? { name: withStatus.fieldValueByName.name, color: withStatus.fieldValueByName.color }
      : null;
  } catch (e) {
    console.warn(`[gh-reloaded] Status fetch failed for ${owner}/${repo}#${number}:`, e.message);
    return null;
  }
}

export async function safeFields(owner, repo, number) {
  try {
    const values = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/issue-field-values`);
    const byName = {};
    for (const v of values) {
      byName[v.issue_field_name] = {
        value: v.single_select_option?.name ?? v.value,
        color: v.single_select_option?.color ?? null,
      };
    }
    return byName;
  } catch (e) {
    if (e.status !== 404) {
      console.warn(
        `[gh-reloaded] Field values fetch failed for ${owner}/${repo}#${number}:`,
        e.message
      );
    }
    return {}; // org-level custom fields are optional — never fail a feature over them
  }
}

export function repoFromUrl(repositoryUrl, fallbackOwner, fallbackRepo) {
  const m = /repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl || "");
  return m ? { owner: m[1], repo: m[2] } : { owner: fallbackOwner, repo: fallbackRepo };
}
