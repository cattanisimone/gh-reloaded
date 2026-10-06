// E2E: the my-issues feature on the My Issues dashboard. Off by default per
// view (the native list shows until "Group by project" is picked). Main
// path (grouped view renders Project → Status → issues in the project's real
// status order and hides the native list), restore path (switching back
// shows the native list again), and the disabled-feature state (nothing
// injected at all).
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const ISSUES_URL = "https://github.com/issues";

const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };

// The issue search: two assigned issues in the "Platform" project (one per
// status) plus one in no project at all.
const SEARCH = {
  data: {
    search: {
      issueCount: 3,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          __typename: "Issue",
          number: 2,
          title: "Set up the build",
          url: "https://github.com/acme/web/issues/2",
          state: "OPEN",
          updatedAt: "2026-05-01T00:00:00Z",
          repository: { nameWithOwner: "acme/web" },
          projectItems: {
            nodes: [
              {
                project: { id: "P1", title: "Platform", number: 1, url: "https://github.com/orgs/acme/projects/1" },
                fieldValueByName: { name: "Backlog", color: "GRAY", optionId: "o-back" },
              },
            ],
          },
        },
        {
          __typename: "Issue",
          number: 7,
          title: "Ship the dashboard",
          url: "https://github.com/acme/web/issues/7",
          state: "OPEN",
          updatedAt: "2026-04-01T00:00:00Z",
          repository: { nameWithOwner: "acme/web" },
          projectItems: {
            nodes: [
              {
                project: { id: "P1", title: "Platform", number: 1, url: "https://github.com/orgs/acme/projects/1" },
                fieldValueByName: { name: "Active", color: "YELLOW", optionId: "o-act" },
              },
            ],
          },
        },
        {
          __typename: "Issue",
          number: 9,
          title: "Fix the rate limiter",
          url: "https://github.com/acme/api/issues/9",
          state: "OPEN",
          updatedAt: "2026-03-01T00:00:00Z",
          repository: { nameWithOwner: "acme/api" },
          projectItems: { nodes: [] },
        },
      ],
    },
  },
};

// The project's real Status order: Backlog, then Active — the reverse of
// alphabetical, so the grouped view honoring it proves the ordering comes
// from this query, not from a sort on the names.
const OPTIONS = {
  data: { node: { field: { options: [{ id: "o-back", name: "Backlog" }, { id: "o-act", name: "Active" }] } } },
};

// The search and the per-project Status-order query both hit /graphql;
// branch on the request body so each gets its own shape (the shared routeApi
// helper only sees the URL). Registered after routeApi so it wins for
// /graphql while REST falls through to routeApi's defaults.
async function routeGraphql(context) {
  await context.route("https://api.github.com/graphql", async (route) => {
    let body = {};
    try {
      body = JSON.parse(route.request().postData() || "{}");
    } catch {}
    const isOptions = /node\s*\(/.test(body.query || "") || body.variables?.id;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(isOptions ? OPTIONS : SEARCH),
    });
  });
}

test("groups issues by project and status in the project's real order, hiding the native list", async ({ context, page }) => {
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "grouped", ...TOKENS });
  await routeApi(context);
  await routeGraphql(context);
  await routeGithub(context, "my-issues.html");
  await page.goto(ISSUES_URL);

  // The control is mounted and set to the grouped view.
  const grouped = page.locator("#ghmi-root .ghmi-seg-btn[data-view='grouped']");
  await expect(grouped).toHaveClass(/is-active/);

  // Platform project with its two issues; statuses in board order
  // (Backlog before Active), not alphabetical.
  const platform = page.locator(".ghmi-project", {
    has: page.locator(".ghmi-project-title", { hasText: "Platform" }),
  });
  await expect(platform).toBeVisible();
  await expect(platform.locator(".ghmi-status-name")).toHaveText(["Backlog", "Active"]);
  await expect(page.locator(".ghmi-issue-ref", { hasText: "acme/web#2" })).toBeVisible();

  // Issue #9 has no project → the explicit No Project group.
  await expect(page.locator(".ghmi-project-title", { hasText: "No Project" })).toBeVisible();
  await expect(page.locator(".ghmi-issue-ref", { hasText: "acme/api#9" })).toBeVisible();

  // The native results list is hidden while grouped.
  await expect(page.locator(".issue-list")).toBeHidden();
});

test("derives the query from the dashboard tab when the URL carries no q", async ({ context, page }) => {
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "grouped", ...TOKENS });
  await routeApi(context);

  // Capture the `q` the content script actually searches for (the search
  // query, not the per-project Status-order follow-ups).
  const searched = [];
  await context.route("https://api.github.com/graphql", async (route) => {
    let body = {};
    try {
      body = JSON.parse(route.request().postData() || "{}");
    } catch {}
    const isOptions = /node\s*\(/.test(body.query || "") || body.variables?.id;
    if (!isOptions) searched.push(body.variables?.q || "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(isOptions ? OPTIONS : SEARCH),
    });
  });
  await routeGithub(context, "my-issues.html");

  // The "Created" tab (/issues/created) carries no `q` — the grouped view
  // must reproduce it as author:@me, not fall back to the assigned default.
  await page.goto("https://github.com/issues/created");
  await expect(page.locator("#ghmi-root .ghmi-seg-btn[data-view='grouped']")).toHaveClass(/is-active/);
  await expect.poll(() => searched.length).toBeGreaterThan(0);
  expect(searched.some((q) => q.includes("author:@me"))).toBe(true);
  expect(searched.some((q) => q.includes("assignee:@me"))).toBe(false);
});

test("switching back to List restores the native list", async ({ context, page }) => {
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "grouped", ...TOKENS });
  await routeApi(context);
  await routeGraphql(context);
  await routeGithub(context, "my-issues.html");
  await page.goto(ISSUES_URL);

  await expect(page.locator(".issue-list")).toBeHidden();
  await page.locator("#ghmi-root .ghmi-seg-btn[data-view='list']").click();
  await expect(page.locator(".issue-list")).toBeVisible();
  await expect(page.locator(".ghmi-panel")).toBeHidden();
});

test("injects nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghmiEnabled: false });
  await routeApi(context);
  await routeGraphql(context);
  await routeGithub(context, "my-issues.html");
  await page.goto(ISSUES_URL);

  await page.waitForTimeout(1000);
  await expect(page.locator("#ghmi-root")).toHaveCount(0);
  await expect(page.locator(".issue-list")).toBeVisible();
});
