// background.js — service worker.
//
// All GitHub API calls happen here rather than in the content script:
// content scripts run in the page's isolated world and their network
// requests can get tangled up with the host page's CSP, so it's simpler
// and more robust to centralize fetches in the background, where the
// extension's own `host_permissions` apply cleanly.

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28"; // GitHub's one stable REST API version string.

// Tiny in-memory cache so a burst of re-renders (SPA nav, polling fallback)
// doesn't re-hit the API and eat into rate limits.
const cache = new Map(); // key -> { at, data }
const CACHE_TTL_MS = 60_000;

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function getToken() {
  const { githubToken } = await chrome.storage.local.get("githubToken");
  return githubToken || null;
}

async function ghFetch(path) {
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

async function ghGraphQL(query, variables) {
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

// --- Small degrade-gracefully wrappers: any of these features (issue
// dependencies, Projects v2 Status, org-level custom fields) can be absent
// on a given repo/org — treat that as "no data", not a fatal error. ---

async function safeDeps(owner, repo, number, direction) {
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

async function safeStatus(owner, repo, number) {
  try {
    const data = await ghGraphQL(STATUS_QUERY, { owner, repo, number });
    const nodes = data?.repository?.issue?.projectItems?.nodes || [];
    const withStatus = nodes.find((n) => n.fieldValueByName);
    return withStatus ? { name: withStatus.fieldValueByName.name, color: withStatus.fieldValueByName.color } : null;
  } catch {
    return null;
  }
}

async function safeFields(owner, repo, number) {
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
    if (e.status === 404) return {};
    return {}; // org-level custom fields are optional — never fail the graph over them
  }
}

function repoFromUrl(repositoryUrl, fallbackOwner, fallbackRepo) {
  const m = /repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl || "");
  return m ? { owner: m[1], repo: m[2] } : { owner: fallbackOwner, repo: fallbackRepo };
}

function externalKey(owner, repo, num) {
  return `${owner}/${repo}#${num}`;
}

/**
 * Builds the dependency graph for the direct sub-issues of one issue.
 *
 * Nodes:
 *  - one per direct sub-issue ("internal"), enriched with Projects v2
 *    Status, and the org-level "Team" / "Business Value" custom fields.
 *  - one per issue that blocks (or is blocked by) a sub-issue but isn't
 *    itself one of them ("external"), enriched only with "Team".
 *
 * Edges: A -> B means "A blocks B". Both directions of the Dependencies
 * API are read (blocked_by and blocking) so external dependencies show up
 * on whichever side they're on, without double-counting edges between two
 * internal sub-issues (those are only added once, from the blocked_by side).
 */
async function fetchDependencyGraph({ owner, repo, issueNumber }) {
  const subIssues = await ghFetch(
    `/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`
  );
  const numbers = new Set(subIssues.map((i) => i.number));

  const edges = [];
  const externalByKey = new Map();

  function upsertExternal(issue) {
    const r = repoFromUrl(issue.repository_url, owner, repo);
    const key = externalKey(r.owner, r.repo, issue.number);
    if (!externalByKey.has(key)) {
      externalByKey.set(key, {
        id: key,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        external: true,
        owner: r.owner,
        repo: r.repo,
      });
    }
    return key;
  }

  await Promise.all(
    subIssues.map(async (issue) => {
      const [blockers, blocking] = await Promise.all([
        safeDeps(owner, repo, issue.number, "blocked_by"),
        safeDeps(owner, repo, issue.number, "blocking"),
      ]);

      for (const blocker of blockers) {
        if (numbers.has(blocker.number)) {
          edges.push({ from: blocker.number, to: issue.number });
        } else {
          edges.push({ from: upsertExternal(blocker), to: issue.number });
        }
      }

      for (const blocked of blocking) {
        if (numbers.has(blocked.number)) continue; // already captured from the other side above
        edges.push({ from: issue.number, to: upsertExternal(blocked) });
      }
    })
  );

  const [internalNodes, externalNodes] = await Promise.all([
    Promise.all(
      subIssues.map(async (issue) => {
        const [status, fields] = await Promise.all([
          safeStatus(owner, repo, issue.number),
          safeFields(owner, repo, issue.number),
        ]);
        return {
          id: issue.number,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          url: issue.html_url,
          status, // { name, color } | null
          businessValue: fields["Business Value"] || null, // { value, color } | null
          team: fields["Team"]?.value || null,
        };
      })
    ),
    Promise.all(
      Array.from(externalByKey.values()).map(async (n) => {
        const fields = await safeFields(n.owner, n.repo, n.number);
        return { ...n, team: fields["Team"]?.value || null };
      })
    ),
  ]);

  return { nodes: [...internalNodes, ...externalNodes], edges };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GHDG_FETCH_GRAPH") return;

  (async () => {
    const hasToken = !!(await getToken());
    try {
      const graph = await fetchDependencyGraph(msg.payload);
      sendResponse({ ok: true, graph, hasToken });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e.message || String(e),
        status: e.status,
        hasToken,
      });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
