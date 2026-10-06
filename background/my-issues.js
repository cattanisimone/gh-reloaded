// background/my-issues.js — background half of the "My Issues by Project"
// feature (see features/my-issues/). Given the search query currently in
// effect on GitHub's own My Issues dashboard, returns the matching issues
// grouped as Project → Status → issues, so the content script can render a
// personal overview alongside the native flat list.
//
// Why fetch here rather than read the rows already in the page: the
// dashboard virtualizes and paginates its list, so the DOM only ever holds
// a slice of the real result set. Running the same search through the API
// (GraphQL `search`, paginated to completion) is the only way the grouped
// view can reflect the COMPLETE filtered set rather than whatever happens
// to be rendered right now.
//
// Grouping rules come straight from the issue: each Project's own Status
// options and ordering are used as-is (no invented global columns), an
// issue in several Projects appears under each with the status it has in
// THAT Project, and issues with no Project (or whose Project can't be read
// under the token's permissions) fall into an explicit "No Project" group
// rather than being dropped.

import { ghGraphQL } from "../lib/github-api.js";

export const MESSAGE_TYPE = "GHMI_FETCH_GROUPS";

// One page is a round trip; the cap bounds a pathological result set (and
// the API cost) while still covering the overwhelming majority of personal
// dashboards. When the real set is larger, the response is flagged
// `truncated` so the UI can say so rather than present a partial list as
// complete.
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

// How many of an issue's Project memberships one page returns, and how many
// such pages to follow per issue. An issue in more than one page of Projects
// is rare, but when it happens the extra pages are fetched so the issue still
// lands under every Project it belongs to rather than silently losing some.
const PROJECT_ITEMS_PAGE = 50;
const MAX_PROJECT_ITEM_PAGES = 10;

// The nested projectItems selection — reused by the search query and the
// per-issue follow-up that paginates it. `pageInfo` is requested so an issue
// in more Projects than one page returns can be detected and completed.
const PROJECT_ITEMS_SELECTION = `
  projectItems(first: $projectItemsFirst, after: $projectItemsAfter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      project { id title number url }
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name color optionId }
      }
    }
  }
`;

const SEARCH_QUERY = `
  query($q: String!, $first: Int!, $after: String, $projectItemsFirst: Int!, $projectItemsAfter: String) {
    search(query: $q, type: ISSUE, first: $first, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on Issue {
          id
          number
          title
          url
          state
          updatedAt
          repository { nameWithOwner }
          ${PROJECT_ITEMS_SELECTION}
        }
      }
    }
  }
`;

// Follows the projectItems cursor for a single issue, used only when the
// search's first page didn't return all of an issue's memberships.
const ISSUE_PROJECT_ITEMS_QUERY = `
  query($id: ID!, $projectItemsFirst: Int!, $projectItemsAfter: String) {
    node(id: $id) {
      ... on Issue {
        ${PROJECT_ITEMS_SELECTION}
      }
    }
  }
`;

// A Project's Status field carries its own ordered option list — the real
// board columns, in board order. Read it once per Project so status groups
// can be ordered the way the Project actually orders them, instead of
// alphabetically or by whatever order issues happened to come back in.
const PROJECT_STATUS_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { options { id name } }
        }
      }
    }
  }
`;

// The dashboard's own query string drives the grouped view so the two
// always agree. Empty (no saved view / no search box text) falls back to
// the dashboard's own default: issues assigned to the current user. The
// grouped view is scoped to issues (PR review requests are out of scope for
// this MVP), so `is:issue` is forced on unless the query already pins the
// issue/PR type itself — appending it to an explicit `is:pr` query would
// just contradict it and return nothing.
export function normalizeQuery(raw) {
  const q = (raw || "").trim();
  if (!q) return "assignee:@me is:issue is:open";
  if (/\bis:(issue|pr)\b|\btype:(issue|pr)\b/i.test(q)) return q;
  return `${q} is:issue`;
}

function cmpStr(a, b) {
  return String(a || "").toLowerCase().localeCompare(String(b || "").toLowerCase());
}

// Most-recently-updated first within a status group (the "what did I touch
// last" ordering the issue suggests), with a stable repo/number tiebreak so
// the output is deterministic when timestamps collide or are absent.
function compareIssues(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return cmpStr(a.nameWithOwner, b.nameWithOwner) || (a.number || 0) - (b.number || 0);
}

// Known board order first (by the Project's own option index), then any
// status whose option index we couldn't read (options query denied/absent),
// then "No Status" (a null name) always last.
function statusRank(status, orderMap) {
  if (!status.name) return Number.MAX_SAFE_INTEGER;
  const idx = status.optionId != null ? orderMap[status.optionId] : undefined;
  return idx == null ? Number.MAX_SAFE_INTEGER - 1 : idx;
}

/**
 * Pure grouping: turns a flat list of normalized issues into
 * `{ projects, noProject }`.
 *
 * `issues`: [{ number, title, url, state, updatedAt, nameWithOwner,
 *   projectItems: [{ projectId, projectTitle, projectNumber, projectUrl,
 *   status: { name, color, optionId } | null }] }]
 * `optionOrderByProject`: { [projectId]: { [optionId]: index } } — each
 *   Project's real Status option ordering, used only for sorting.
 *
 * An issue is placed under every Project it belongs to (with that Project's
 * status), or into `noProject` when it belongs to none. One issue under two
 * Projects is still one issue — the same object is referenced from both,
 * never duplicated into separate assignments.
 */
export function buildGroups(issues, optionOrderByProject = {}) {
  const projectsById = new Map();
  const noProject = [];

  for (const issue of issues) {
    const items = issue.projectItems || [];
    if (!items.length) {
      noProject.push(issue);
      continue;
    }
    for (const item of items) {
      let project = projectsById.get(item.projectId);
      if (!project) {
        project = {
          id: item.projectId,
          title: item.projectTitle,
          number: item.projectNumber,
          url: item.projectUrl,
          statuses: new Map(),
        };
        projectsById.set(item.projectId, project);
      }
      const status = item.status || null;
      const key = status ? `opt:${status.optionId || status.name}` : "__none__";
      let group = project.statuses.get(key);
      if (!group) {
        group = {
          name: status?.name || null,
          color: status?.color || null,
          optionId: status?.optionId || null,
          issues: [],
        };
        project.statuses.set(key, group);
      }
      group.issues.push(issue);
    }
  }

  const projects = [...projectsById.values()]
    .map((project) => {
      const orderMap = optionOrderByProject[project.id] || {};
      const statuses = [...project.statuses.values()].sort(
        (a, b) => statusRank(a, orderMap) - statusRank(b, orderMap) || cmpStr(a.name, b.name)
      );
      for (const status of statuses) status.issues.sort(compareIssues);
      const count = statuses.reduce((n, s) => n + s.issues.length, 0);
      return { id: project.id, title: project.title, number: project.number, url: project.url, statuses, count };
    })
    .sort((a, b) => cmpStr(a.title, b.title) || (a.number || 0) - (b.number || 0));

  noProject.sort(compareIssues);
  return { projects, noProject };
}

function toIssue(node) {
  const items = (node.projectItems?.nodes || [])
    .map((it) => ({
      projectId: it.project?.id,
      projectTitle: it.project?.title || "Untitled project",
      projectNumber: it.project?.number,
      projectUrl: it.project?.url,
      // Only a single-select value carries a `name` (via the inline
      // fragment). A field literally named "Status" that is some other type
      // comes back as an empty object — treat that as "no status" rather
      // than a phantom status group keyed on undefined.
      status: it.fieldValueByName?.name
        ? { name: it.fieldValueByName.name, color: it.fieldValueByName.color, optionId: it.fieldValueByName.optionId }
        : null,
    }))
    // A project item whose project came back null means the token can't
    // read that Project — treat it as "not in a readable Project" (the
    // issue still surfaces under "No Project") rather than inventing a
    // group with no identity.
    .filter((it) => it.projectId);

  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    updatedAt: node.updatedAt || "",
    nameWithOwner: node.repository?.nameWithOwner || "",
    projectItems: items,
  };
}

// Follows the projectItems cursor for one issue and returns the memberships
// beyond its first page. Degrades gracefully: a failed/partial follow-up
// keeps whatever the first page already gave rather than failing the issue.
async function fetchRemainingProjectItems(issueId, after) {
  const extra = [];
  let cursor = after;
  let hasNextPage = true;
  let pages = 0;
  while (hasNextPage && cursor && pages < MAX_PROJECT_ITEM_PAGES) {
    const data = await ghGraphQL(
      ISSUE_PROJECT_ITEMS_QUERY,
      { id: issueId, projectItemsFirst: PROJECT_ITEMS_PAGE, projectItemsAfter: cursor },
      { partial: true }
    );
    const conn = data?.node?.projectItems;
    if (!conn) break;
    extra.push(...(conn.nodes || []));
    hasNextPage = !!conn.pageInfo?.hasNextPage;
    cursor = conn.pageInfo?.endCursor || null;
    pages++;
  }
  return extra;
}

async function fetchAllIssues(query) {
  const issues = [];
  let totalCount = 0;
  let after = null;
  let hasNextPage = false;
  let pages = 0;

  do {
    // `partial: true`: GitHub can return readable issues alongside an error
    // for one inaccessible Project node — take the readable data and let
    // toIssue() drop the unreadable membership to "No Project" rather than
    // failing the whole view. See lib/github-api.js.
    const data = await ghGraphQL(
      SEARCH_QUERY,
      { q: query, first: PAGE_SIZE, after, projectItemsFirst: PROJECT_ITEMS_PAGE, projectItemsAfter: null },
      { partial: true }
    );
    const search = data?.search;
    if (!search) break;
    totalCount = search.issueCount ?? totalCount;
    for (const node of search.nodes || []) {
      // `type: ISSUE` can still return PullRequest nodes; keep only issues.
      if (node && node.__typename === "Issue") issues.push(node);
    }
    hasNextPage = !!search.pageInfo?.hasNextPage;
    after = search.pageInfo?.endCursor || null;
    pages++;
  } while (hasNextPage && after && pages < MAX_PAGES);

  // Complete the Project memberships of any issue that had more than one
  // page of them, so no Project is dropped. Only the rare over-a-page issue
  // triggers a follow-up; the common case adds no extra request.
  await Promise.all(
    issues.map(async (node) => {
      const conn = node.projectItems;
      if (!conn?.pageInfo?.hasNextPage || !node.id) return;
      try {
        const extra = await fetchRemainingProjectItems(node.id, conn.pageInfo.endCursor);
        conn.nodes = [...(conn.nodes || []), ...extra];
      } catch {
        // Keep the first page rather than failing the issue (or the view).
      }
    })
  );

  // Truncated only when we stopped at the page cap with more still to come
  // — not when the cursor simply ran out (that's the genuine end of the set).
  return { issues, totalCount, truncated: hasNextPage && pages >= MAX_PAGES };
}

// Reads each Project's Status option ordering. Degrades per-project: a
// Project whose options can't be read (permissions, or no Status field at
// all) simply contributes no ordering, so its statuses fall back to
// alphabetical rather than failing the whole response.
async function fetchStatusOrder(projectIds) {
  const order = {};
  await Promise.all(
    projectIds.map(async (id) => {
      try {
        const data = await ghGraphQL(PROJECT_STATUS_QUERY, { id }, { partial: true });
        const options = data?.node?.field?.options || [];
        const map = {};
        options.forEach((opt, i) => {
          map[opt.id] = i;
        });
        order[id] = map;
      } catch {
        order[id] = {};
      }
    })
  );
  return order;
}

export async function handleMessage(payload) {
  const query = normalizeQuery(payload?.query);
  const { issues: nodes, totalCount, truncated } = await fetchAllIssues(query);
  const issues = nodes.map(toIssue);

  const projectIds = [...new Set(issues.flatMap((i) => i.projectItems.map((it) => it.projectId)))];
  const order = await fetchStatusOrder(projectIds);

  const { projects, noProject } = buildGroups(issues, order);
  return { query, projects, noProject, totalCount, fetchedCount: issues.length, truncated };
}
