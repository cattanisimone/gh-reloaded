// background/dependency-graph.js — background half of the "Dependency
// graph" feature (see features/dependency-graph/). Talks to GitHub
// through lib/github-api.js and exports a handler that background.js's
// generic message router dispatches to.

import { ghFetch, safeDeps, safeStatus, safeFields, repoFromUrl } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHDG_FETCH_GRAPH";

function externalKey(owner, repo, num) {
  return `${owner}/${repo}#${num}`;
}

/**
 * Removes any edge (u,v) already implied by a longer path u -> ... -> v
 * among the given node ids ("A blocks C" adds nothing new if A -> B -> C
 * already forces the same order). Scoped to internal sub-issues only —
 * declutters the common case without reasoning about external nodes too.
 * Never drops an edge already marked `critical`: that's a real segment of
 * the displayed critical-path chain, not visual noise.
 */
function transitiveReduce(ids, edgeList) {
  const idSet = new Set(ids);
  const adj = new Map(ids.map((id) => [id, new Set()]));
  for (const e of edgeList) {
    if (idSet.has(e.from) && idSet.has(e.to)) adj.get(e.from).add(e.to);
  }

  function reachable(start, target) {
    const seen = new Set();
    const stack = Array.from(adj.get(start) || []);
    while (stack.length) {
      const n = stack.pop();
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const nxt of adj.get(n) || []) stack.push(nxt);
    }
    return false;
  }

  const redundant = new Set();
  for (const e of edgeList) {
    if (e.critical) continue;
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    adj.get(e.from).delete(e.to);
    if (reachable(e.from, e.to)) {
      redundant.add(`${e.from}->${e.to}`);
    } else {
      adj.get(e.from).add(e.to); // not actually redundant — put it back
    }
  }

  return edgeList.filter((e) => !redundant.has(`${e.from}->${e.to}`));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Longest path by total "Effort", restricted to internal nodes/edges only
 * (external dependencies aren't part of this feature's own estimate).
 *
 * "Done" sub-issues (GitHub's own issue `state`, not a Status option name
 * — every board can call its terminal column whatever it wants) are
 * ignored entirely: completed work shouldn't show up in a path meant to
 * highlight what's left. Rather than just zeroing their effort, they're
 * removed from the graph and their predecessors are bridged directly to
 * their successors, so the path skips transparently over finished work
 * instead of stopping there or routing through it.
 *
 * An unestimated sub-issue doesn't count as 0 effort — that would
 * artificially shrink the critical path just because someone hasn't sized
 * a story yet. It's assumed to cost the median of whatever IS estimated
 * elsewhere in this same feature instead. With nothing estimated anywhere,
 * that median is 0 and the path degrades to "most hops", as before.
 */
function computeCriticalPath(internalNodes, edges) {
  const nodeById = new Map(internalNodes.map((n) => [n.id, n]));
  const ids = new Set(internalNodes.map((n) => n.id));
  const isDone = (id) => nodeById.get(id)?.state === "closed";
  const assumedEffort = median(
    internalNodes.filter((n) => n.effort != null).map((n) => Number(n.effort))
  );

  const rawIncoming = new Map(internalNodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) rawIncoming.get(e.to).push(e.from);
  }

  const ancestorMemo = new Map();
  function activeAncestorsOf(id) {
    if (ancestorMemo.has(id)) return ancestorMemo.get(id);
    const result = new Set();
    ancestorMemo.set(id, result); // set early — cycle guard
    for (const p of rawIncoming.get(id) || []) {
      if (isDone(p)) {
        for (const pp of activeAncestorsOf(p)) result.add(pp);
      } else {
        result.add(p);
      }
    }
    return result;
  }

  const activeNodes = internalNodes.filter((n) => !isDone(n.id));
  const incoming = new Map(activeNodes.map((n) => [n.id, Array.from(activeAncestorsOf(n.id))]));
  const effortOf = new Map(
    activeNodes.map((n) => [n.id, n.effort != null ? Number(n.effort) : assumedEffort])
  );

  const best = new Map(); // id -> { total, hops, prev }
  const visiting = new Set();
  function bestOf(id) {
    if (best.has(id)) return best.get(id);
    if (visiting.has(id)) return { total: effortOf.get(id) || 0, hops: 1, prev: null }; // cycle guard
    visiting.add(id);
    const own = effortOf.get(id) || 0;
    let result = { total: own, hops: 1, prev: null };
    for (const p of incoming.get(id) || []) {
      const pBest = bestOf(p);
      const candTotal = pBest.total + own;
      const candHops = pBest.hops + 1;
      if (candTotal > result.total || (candTotal === result.total && candHops > result.hops)) {
        result = { total: candTotal, hops: candHops, prev: p };
      }
    }
    visiting.delete(id);
    best.set(id, result);
    return result;
  }
  for (const n of activeNodes) bestOf(n.id);

  let endId = null;
  let endBest = { total: -Infinity, hops: 0 };
  for (const n of activeNodes) {
    const b = best.get(n.id);
    if (b.total > endBest.total || (b.total === endBest.total && b.hops > endBest.hops)) {
      endBest = b;
      endId = n.id;
    }
  }

  // A single, edge-less node "winning" by default isn't a real critical
  // path — don't highlight anything in that case.
  if (!activeNodes.length || endBest.hops <= 1) {
    return { pathIds: new Set(), pathEdges: new Set(), totalEffort: 0, length: 0 };
  }

  const pathIds = new Set();
  const pathEdges = new Set();
  for (let cur = endId; cur != null; ) {
    pathIds.add(cur);
    const prev = best.get(cur).prev;
    if (prev == null) break;
    pathEdges.add(`${prev}->${cur}`); // may be a bridged (non-literal) edge when it skips a Done node
    cur = prev;
  }

  return { pathIds, pathEdges, totalEffort: Math.max(0, endBest.total), length: endBest.hops };
}

/**
 * Builds the dependency graph for the direct sub-issues of one issue.
 *
 * Nodes:
 *  - one per direct sub-issue ("internal"), enriched with Projects v2
 *    Status, and the org-level "Team" / "Business Value" / "Effort"
 *    custom fields.
 *  - one per issue that blocks (or is blocked by) a sub-issue but isn't
 *    itself one of them ("external"), enriched with Status and "Team".
 *
 * Edges: A -> B means "A blocks B". Both directions of the Dependencies
 * API are read (blocked_by and blocking) so external dependencies show up
 * on whichever side they're on, without double-counting edges between two
 * internal sub-issues (those are only added once, from the blocked_by side).
 */
async function fetchDependencyGraph({ owner, repo, issueNumber }) {
  const subIssues = await ghFetch(
    `/repos/${owner}/${repo}/issues/${issueNumber}/sub_issues?per_page=100`,
    { owner }
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
          effort: fields["Effort"]?.value ?? null,
        };
      })
    ),
    Promise.all(
      Array.from(externalByKey.values()).map(async (n) => {
        const [fields, status] = await Promise.all([
          safeFields(n.owner, n.repo, n.number),
          safeStatus(n.owner, n.repo, n.number),
        ]);
        return { ...n, team: fields["Team"]?.value || null, status };
      })
    ),
  ]);

  const critical = computeCriticalPath(internalNodes, edges);
  const nodes = [
    ...internalNodes.map((n) => ({ ...n, critical: critical.pathIds.has(n.id) })),
    ...externalNodes.map((n) => ({ ...n, critical: false })),
  ];
  const markedEdges = edges.map((e) => ({
    ...e,
    critical: critical.pathEdges.has(`${e.from}->${e.to}`),
  }));
  const reducedEdges = transitiveReduce(internalNodes.map((n) => n.id), markedEdges);

  return {
    nodes,
    edges: reducedEdges,
    criticalPathEffort: critical.totalEffort,
    criticalPathLength: critical.length,
  };
}

export async function handleMessage(payload) {
  return { graph: await fetchDependencyGraph(payload) };
}
