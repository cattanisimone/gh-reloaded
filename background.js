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
const cache = new Map(); // path -> { at, data }
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

/**
 * Builds the dependency graph for the direct sub-issues of one issue.
 *
 * v1 scope: only the parent's direct sub-issues are nodes. An edge is drawn
 * A -> B ("A blocks B") only when BOTH A and B are in that direct set.
 * Blockers that live outside the set are not shown yet (see README).
 */
async function fetchDependencyGraph({ owner, repo, issueNumber }) {
  const subIssues = await ghFetch(
    `/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`
  );

  const numbers = new Set(subIssues.map((i) => i.number));
  const edges = [];

  await Promise.all(
    subIssues.map(async (issue) => {
      try {
        const blockers = await ghFetch(
          `/repos/${owner}/${repo}/issues/${issue.number}/dependencies/blocked_by?per_page=100`
        );
        for (const blocker of blockers) {
          if (numbers.has(blocker.number)) {
            edges.push({ from: blocker.number, to: issue.number });
          }
        }
      } catch (e) {
        // The Dependencies API 404s on repos/orgs that don't have it enabled.
        // Degrade to "no edges" rather than failing the whole graph.
        if (e.status !== 404) throw e;
      }
    })
  );

  return {
    nodes: subIssues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state, // "open" | "closed"
      url: i.html_url,
    })),
    edges,
  };
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
