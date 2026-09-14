// background/board-dependencies.js — background half of the "Board
// dependency arrows" feature (see features/board-dependencies/). Given the
// issues currently visible on a Projects board, returns which of them
// block one another so the content script can draw an arrow between the
// two cards.
//
// Deliberately scoped to pairs where BOTH ends are in the given set: an
// arrow only makes sense between two cards that are actually on screen.
// Dependencies pointing outside that set are just dropped, not surfaced
// as a placeholder node (unlike the issue-page dependency graph) — a
// board can have hundreds of cards, and any of them may depend on
// anything, so rendering "external" nodes here doesn't scale the same way.

import { safeDeps, repoFromUrl } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHBD_FETCH_BOARD_DEPS";

function keyOf(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

/**
 * `items`: [{ owner, repo, number }, ...] — every issue/PR currently
 * rendered as a card on the board. Returns `{ edges: [{from, to}, ...] }`
 * with `from`/`to` as "owner/repo#number" keys matching `items`. `from`
 * blocks `to`.
 */
async function fetchBoardEdges(items) {
  const known = new Set(items.map((i) => keyOf(i.owner, i.repo, i.number)));
  const edgeKeys = new Set();
  const edges = [];

  function addEdge(fromKey, toKey) {
    if (fromKey === toKey) return;
    const k = `${fromKey}->${toKey}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from: fromKey, to: toKey });
  }

  await Promise.all(
    items.map(async (item) => {
      const selfKey = keyOf(item.owner, item.repo, item.number);
      const [blockers, blocking] = await Promise.all([
        safeDeps(item.owner, item.repo, item.number, "blocked_by"),
        safeDeps(item.owner, item.repo, item.number, "blocking"),
      ]);

      for (const blocker of blockers) {
        const r = repoFromUrl(blocker.repository_url, item.owner, item.repo);
        const k = keyOf(r.owner, r.repo, blocker.number);
        if (known.has(k)) addEdge(k, selfKey);
      }
      for (const blocked of blocking) {
        const r = repoFromUrl(blocked.repository_url, item.owner, item.repo);
        const k = keyOf(r.owner, r.repo, blocked.number);
        if (known.has(k)) addEdge(selfKey, k);
      }
    })
  );

  return edges;
}

export async function handleMessage(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return { edges: await fetchBoardEdges(items) };
}
