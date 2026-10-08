// background/standup-mode.js — background half of the "Standup mode"
// feature (see features/standup-mode/). Given the cards currently on a
// Projects board, reads their Project status history, labels, comments
// and dependencies and works out which ones need attention in a standup:
// stale in a review/deploy-like column, blocked for no visible reason,
// on a critical path that is at risk, plus which columns are bottlenecks.
//
// The rules are pure functions over plain data (computeSignals and the
// helpers it uses) so they can be unit tested without GitHub; the part
// that talks to GitHub only gathers that data and degrades to "no
// signals" rather than failing when the token or Projects access is
// missing.

import { ghGraphQL, safeDeps, hasAnyToken } from "../lib/github-api.js";
import { computeCriticalPath, median } from "./dependency-graph.js";
import { fetchBoardEdges } from "./board-dependencies.js";

export const MESSAGE_TYPE = "GHSM_FETCH_SIGNALS";

export const DEFAULT_STALE_DAYS = 3;
export const DEFAULT_REVIEW_KEYWORDS = ["review", "qa", "test", "deploy", "release"];

const DAY_MS = 86_400_000;
const CHUNK_SIZE = 15; // issues per GraphQL request
const BOTTLENECK_MIN_CARDS = 3;
const BOTTLENECK_SHARE = 0.4;
const BOTTLENECK_AGE_FACTOR = 3; // oldest card vs the median age of open cards

// What a comment has to look like to count as "explaining the block".
const BLOCK_EXPLANATION_RE = /block|wait|depend|pending|on hold|stuck/i;

export function keyOf(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

export function normalizeOptions(raw = {}) {
  const days = Math.floor(Number(raw.staleDays));
  const staleDays = Number.isFinite(days) && days >= 1 ? days : DEFAULT_STALE_DAYS;
  const list = Array.isArray(raw.reviewKeywords)
    ? raw.reviewKeywords
    : typeof raw.reviewKeywords === "string"
      ? raw.reviewKeywords.split(",")
      : [];
  const reviewKeywords = list.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  return { staleDays, reviewKeywords: reviewKeywords.length ? reviewKeywords : DEFAULT_REVIEW_KEYWORDS };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A keyword matches at the start of a word, so "review" covers "In
// review" and "Code reviewing", and "test" does not match "latest".
export function isReviewLike(statusName, keywords) {
  if (!statusName) return false;
  return keywords.some((k) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}`, "i").test(statusName));
}

export function ageInDays(since, now) {
  const t = typeof since === "number" ? since : Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// Priority is read as a ranked chip: 3 critical/P0, 2 high/P1, 1 medium/
// P2, 0 low/P3. Any other value keeps its name with no rank, so a board's
// own vocabulary still shows even when it isn't recognized for tinting.
export function priorityRank(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (/^(p0|critical|urgent|blocker)\b/.test(n)) return 3;
  if (/^(p1|high)\b/.test(n)) return 2;
  if (/^(p2|medium|med|normal)\b/.test(n)) return 1;
  if (/^(p3|low|minor)\b/.test(n)) return 0;
  return null;
}

/**
 * Columns that hold a disproportionate share of the open work, or whose
 * oldest card is far older than the rest of the board. The leftmost
 * column is the intake (backlog) and is never flagged, and only open
 * cards count, so a Done column full of closed issues can't be one.
 * `cards`: [{ column, columnIndex, open, ageDays }]
 */
export function computeBottlenecks(cards, staleDays) {
  const open = cards.filter((c) => c.open && c.column);
  const byColumn = new Map();
  for (const c of open) {
    if (!byColumn.has(c.column)) byColumn.set(c.column, { index: c.columnIndex, cards: [] });
    byColumn.get(c.column).cards.push(c);
  }
  const columnCount = new Set(cards.map((c) => c.columnIndex)).size;
  const boardMedianAge = median(open.filter((c) => c.ageDays != null).map((c) => c.ageDays));
  const result = [];
  for (const [column, { index, cards: inColumn }] of byColumn) {
    if (index === 0) continue;
    const count = inColumn.length;
    const share = count / open.length;
    if (columnCount >= 3 && count >= BOTTLENECK_MIN_CARDS && share >= BOTTLENECK_SHARE) {
      result.push({ column, reason: `${count} of ${open.length} open cards (${Math.round(share * 100)}%)` });
      continue;
    }
    const ages = inColumn.map((c) => c.ageDays).filter((a) => a != null);
    const oldest = ages.length ? Math.max(...ages) : null;
    if (
      oldest != null &&
      oldest >= staleDays * 2 &&
      oldest >= boardMedianAge * BOTTLENECK_AGE_FACTOR
    ) {
      result.push({ column, reason: `oldest card has been here ${oldest} days` });
    }
  }
  return result;
}

/**
 * The attention rules.
 *
 *  items:        [{ key, column, columnIndex }] — the cards on the board
 *                (column is the visible column heading).
 *  data:         key -> { state, labels, comments, statusSince, priority,
 *                targetDate, effort } as read from GitHub; an item with no
 *                entry just has no API-backed signals.
 *  edges:        [{ from, to }] — `from` blocks `to`, both on the board.
 *  openBlockers: key -> number of open blocking issues, only for the cards
 *                that were checked (those marked blocked).
 *  options:      normalizeOptions() output.
 *  now:          ms since epoch.
 */
export function computeSignals({ items, data, edges = [], openBlockers = {}, options, now }) {
  const { staleDays, reviewKeywords } = options;
  const today = new Date(now).toISOString().slice(0, 10);
  const cards = {};
  const summary = { stale: [], orphan: [], critical: [], bottleneck: [] };

  const info = items.map((item) => {
    const d = data[item.key];
    const open = !!d && String(d.state).toLowerCase() !== "closed" && String(d.state).toLowerCase() !== "merged";
    const ageDays = d?.statusSince ? ageInDays(d.statusSince, now) : null;
    return { ...item, d, open, ageDays };
  });
  const infoByKey = new Map(info.map((i) => [i.key, i]));

  const nodes = info.filter((i) => i.d).map((i) => ({
    id: i.key,
    state: i.open ? "open" : "closed",
    effort: i.d.effort ?? null,
  }));
  const criticalIds = computeCriticalPath(nodes, edges).pathIds;

  for (const i of info) {
    const flags = [];
    const reasons = {};
    const d = i.d;

    if (d && i.open) {
      if (i.ageDays != null && i.ageDays >= staleDays && isReviewLike(i.column, reviewKeywords)) {
        flags.push("stale");
        reasons.stale = `In "${i.column}" for ${i.ageDays} days`;
      }

      const markedBlocked =
        (d.labels || []).some((l) => /blocked/i.test(l)) || /blocked/i.test(i.column || "");
      const checked = Object.prototype.hasOwnProperty.call(openBlockers, i.key);
      if (
        markedBlocked &&
        checked &&
        openBlockers[i.key] === 0 &&
        !(d.comments || []).some((c) => BLOCK_EXPLANATION_RE.test(c))
      ) {
        flags.push("orphan");
        reasons.orphan = "Marked blocked, but no open blocker and no comment explaining it";
      }

      if (criticalIds.has(i.key)) {
        const overdue = d.targetDate && d.targetDate < today;
        const staleBlockers = edges
          .filter((e) => e.to === i.key)
          .map((e) => infoByKey.get(e.from))
          .filter((b) => b && b.open && b.ageDays != null && b.ageDays >= staleDays);
        if (overdue || staleBlockers.length) {
          flags.push("critical");
          reasons.critical = overdue
            ? `On the critical path and past its target date (${d.targetDate})`
            : `On the critical path, blocked by #${staleBlockers[0].key.split("#")[1]} for ${staleBlockers[0].ageDays} days`;
        }
      }
    }

    if (d) {
      const rank = priorityRank(d.priority);
      cards[i.key] = {
        flags,
        reasons,
        ageDays: i.ageDays,
        priority: d.priority ? { name: d.priority, rank } : null,
      };
      if (flags.includes("stale")) summary.stale.push(i.key);
      if (flags.includes("orphan")) summary.orphan.push(i.key);
      if (flags.includes("critical")) summary.critical.push(i.key);
    }
  }

  const columns = computeBottlenecks(
    info.map((i) => ({ column: i.column, columnIndex: i.columnIndex, open: i.open, ageDays: i.ageDays })),
    staleDays
  );
  summary.bottleneck = columns.map((c) => c.column);

  return { cards, columns, summary };
}

// ---- GitHub side ----

const ITEM_FIELDS = `
  state
  labels(first: 20) { nodes { name } }
  comments(last: 5) { nodes { body } }
  projectItems(first: 20) {
    nodes {
      project { number owner { ... on Organization { login } ... on User { login } } }
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
      priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      target: fieldValueByName(name: "Target date") { ... on ProjectV2ItemFieldDateValue { date } }
      effort: fieldValueByName(name: "Effort") { ... on ProjectV2ItemFieldNumberValue { number } }
    }
  }`;

function buildQuery(count) {
  const vars = [];
  const fields = [];
  for (let n = 0; n < count; n++) {
    vars.push(`$o${n}: String!, $r${n}: String!, $n${n}: Int!`);
    fields.push(
      `i${n}: repository(owner: $o${n}, name: $r${n}) { issueOrPullRequest(number: $n${n}) { ... on Issue { ...IssueF } ... on PullRequest { ...PrF } } }`
    );
  }
  return `query(${vars.join(", ")}) { ${fields.join("\n")} }
    fragment IssueF on Issue { ${ITEM_FIELDS} }
    fragment PrF on PullRequest { ${ITEM_FIELDS} }`;
}

// Picks this project's own item out of an issue's project items — an
// issue can sit on several boards, each with its own Status.
export function pickProjectItem(node, project) {
  const items = node?.projectItems?.nodes || [];
  const owner = (project.owner || "").toLowerCase();
  return (
    items.find(
      (n) => n?.project?.number === project.number && (n.project.owner?.login || "").toLowerCase() === owner
    ) || null
  );
}

export function shapeItemData(node, project) {
  if (!node) return null;
  const item = pickProjectItem(node, project);
  return {
    state: node.state,
    labels: (node.labels?.nodes || []).map((l) => l.name),
    comments: (node.comments?.nodes || []).map((c) => c.body || ""),
    statusSince: item?.status?.updatedAt || null,
    priority: item?.priority?.name || null,
    targetDate: item?.target?.date || null,
    effort: item?.effort?.number ?? null,
  };
}

async function fetchItemData(items, project) {
  const data = {};
  const byOwner = new Map();
  for (const item of items) {
    if (!byOwner.has(item.owner)) byOwner.set(item.owner, []);
    byOwner.get(item.owner).push(item);
  }
  const jobs = [];
  for (const [owner, list] of byOwner) {
    for (let at = 0; at < list.length; at += CHUNK_SIZE) {
      const chunk = list.slice(at, at + CHUNK_SIZE);
      jobs.push(async () => {
        const variables = {};
        chunk.forEach((item, n) => {
          variables[`o${n}`] = item.owner;
          variables[`r${n}`] = item.repo;
          variables[`n${n}`] = item.number;
        });
        try {
          const res = await ghGraphQL(buildQuery(chunk.length), variables, { owner });
          chunk.forEach((item, n) => {
            const shaped = shapeItemData(res?.[`i${n}`]?.issueOrPullRequest, project);
            if (shaped) data[keyOf(item.owner, item.repo, item.number)] = shaped;
          });
        } catch (e) {
          console.warn(`[gh-reloaded] Standup signals: could not read ${owner} items:`, e.message);
        }
      });
    }
  }
  await Promise.all(jobs.map((job) => job()));
  return data;
}

async function countOpenBlockers(item) {
  const blockers = await safeDeps(item.owner, item.repo, item.number, "blocked_by");
  return blockers.filter((b) => b.state === "open").length;
}

export async function handleMessage(payload) {
  const project = { owner: String(payload?.project?.owner || ""), number: Number(payload?.project?.number) };
  const items = (Array.isArray(payload?.items) ? payload.items : []).map((i) => ({
    ...i,
    key: keyOf(i.owner, i.repo, i.number),
  }));
  if (!items.length || !(await hasAnyToken())) return { signals: null };

  const options = normalizeOptions(payload?.options);
  const data = await fetchItemData(items, project);
  if (!Object.keys(data).length) return { signals: null };

  const labelled = items.filter((i) => {
    const d = data[i.key];
    return d && ((d.labels || []).some((l) => /blocked/i.test(l)) || /blocked/i.test(i.column || ""));
  });
  const [edges, counts] = await Promise.all([
    fetchBoardEdges(items).catch(() => []),
    Promise.all(labelled.map((i) => countOpenBlockers(i).catch(() => null))),
  ]);
  const openBlockers = {};
  labelled.forEach((i, n) => {
    if (counts[n] != null) openBlockers[i.key] = counts[n];
  });

  return {
    signals: computeSignals({ items, data, edges, openBlockers, options, now: Date.now() }),
  };
}
