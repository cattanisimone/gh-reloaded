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
//
// Auth supports more than one saved token (Settings → GitHub tokens): one
// is the default, and any of the others can be mapped to a GitHub
// organization login. Every call site that hits a repo-or-org-scoped
// endpoint passes `{ owner }` so resolveTokenRecord() can pick the token
// mapped to that owner, falling back to the default when there's no
// mapping — never by trying every saved token in turn. A caller with no
// owner in scope at all (none currently) falls straight through to the
// default token.

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28"; // GitHub's one stable REST API version string.

// Tiny in-memory cache so a burst of re-renders (SPA nav, polling
// fallback) across any feature doesn't re-hit the API and eat into rate
// limits. Shared across features on purpose — they're all hitting the
// same underlying GitHub data. Keyed by which token record served the
// request (see resolveTokenRecord) as well as the request itself, so a
// response fetched under one credential can never be served back under
// another — two tokens can legitimately see different data for the same
// path (different repo access, different org membership).
const cache = new Map(); // key -> { at, data }
const CACHE_TTL_MS = 60_000;
const ANON_TOKEN_ID = "anon";

function cacheGet(key) {
  const cached = cache.get(key);
  return cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.data : undefined;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
}

// Removes every cache entry that was served by a given token id — called
// whenever that token's secret changes or the token is removed, so a
// still-fresh response fetched under the old credential can't keep being
// served after the credential it depended on is gone.
function purgeCacheForToken(tokenId) {
  const prefix = `${tokenId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function genTokenId() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Migrates the old single `githubToken` setting to the new
// `githubTokens` list the first time this runs after an update — a
// single configured token keeps working exactly as before, just as the
// new default entry. Safe to call repeatedly; it's a no-op once
// `githubTokens` exists (even as an empty list, which means "the user
// removed every token").
let migratePromise = null;
async function migrateLegacyToken() {
  if (!migratePromise) {
    migratePromise = (async () => {
      const { githubTokens, githubToken } = await chrome.storage.local.get([
        "githubTokens",
        "githubToken",
      ]);
      if (githubTokens !== undefined || !githubToken) return;
      const id = genTokenId();
      await chrome.storage.local.set({
        githubTokens: [{ id, name: "Default", token: githubToken, org: "" }],
        defaultTokenId: id,
      });
      await chrome.storage.local.remove("githubToken");
    })();
  }
  return migratePromise;
}

// Invalidate cached responses as soon as a token's secret changes or the
// token is removed — a rename or an org re-mapping doesn't affect
// already-fetched data, but the credential itself does.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.githubTokens) return;
  const oldById = new Map((changes.githubTokens.oldValue || []).map((r) => [r.id, r.token]));
  const newById = new Map((changes.githubTokens.newValue || []).map((r) => [r.id, r.token]));
  for (const [id, oldToken] of oldById) {
    if (newById.get(id) !== oldToken) purgeCacheForToken(id);
  }
});

export async function getTokenRecords() {
  await migrateLegacyToken();
  const { githubTokens } = await chrome.storage.local.get("githubTokens");
  return Array.isArray(githubTokens) ? githubTokens : [];
}

export async function getDefaultTokenId() {
  const { defaultTokenId } = await chrome.storage.local.get("defaultTokenId");
  return defaultTokenId || null;
}

export async function hasAnyToken() {
  const records = await getTokenRecords();
  return records.some((r) => r.token);
}

// Picks which saved token record applies to a request against
// resources owned by `owner` (an organization or user login): an
// explicit org mapping wins over the default token. No further
// fallback — a mapped org whose token is missing access should surface
// its own error rather than silently retrying under a different
// credential (per the "do not silently try every saved token" rule).
export async function resolveTokenRecord(owner) {
  const records = await getTokenRecords();
  if (!records.length) return null;
  const normalizedOwner = (owner || "").trim().toLowerCase();
  if (normalizedOwner) {
    const mapped = records.find((r) => (r.org || "").trim().toLowerCase() === normalizedOwner);
    if (mapped) return mapped;
  }
  const defaultId = await getDefaultTokenId();
  return records.find((r) => r.id === defaultId) || records[0];
}

export async function ghFetch(path, { owner } = {}) {
  const record = await resolveTokenRecord(owner);
  const cacheKey = `${record?.id || ANON_TOKEN_ID}:${path}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (record?.token) headers.Authorization = `Bearer ${record.token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

export async function ghGraphQL(query, variables, { owner } = {}) {
  const record = await resolveTokenRecord(owner);
  const cacheKey = `${record?.id || ANON_TOKEN_ID}:gql:` + JSON.stringify({ query, variables });
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  };
  if (record?.token) headers.Authorization = `Bearer ${record.token}`;

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
  cacheSet(cacheKey, json.data);
  return json.data;
}

// --- Small degrade-gracefully wrappers used by more than one feature. Any
// of these (issue dependencies, Projects v2 Status, org-level custom
// fields) can be absent on a given repo/org — treat that as "no data",
// not a fatal error. ---

export async function safeDeps(owner, repo, number, direction) {
  try {
    return await ghFetch(
      `/repos/${owner}/${repo}/issues/${number}/dependencies/${direction}?per_page=100`,
      { owner }
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
    const data = await ghGraphQL(STATUS_QUERY, { owner, repo, number }, { owner });
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
    const values = await ghFetch(`/repos/${owner}/${repo}/issues/${number}/issue-field-values`, {
      owner,
    });
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
