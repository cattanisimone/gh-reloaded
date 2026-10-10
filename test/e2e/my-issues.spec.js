// E2E: the my-issues feature on the My Issues dashboard. The native list
// shows until "Group by project" is picked. Covers: the grouped Project
// tiles (Status order, distribution bar, legend, row anatomy, per-Status
// cap), the toolbar (distinct summary, Expand/Collapse all), the states
// (loading, empty, no token, error, truncated), SPA re-injection, the
// restore path, the collapsible sidebar (grid and flex panes, fail-safe),
// and the disabled-feature state. All names are invented.
import fs from "node:fs";
import path from "node:path";
import { test, expect, routeGithub, routeApi, seedStorage, FIXTURES_DIR } from "./support/extension.js";

const ISSUES_URL = "https://github.com/issues";

const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };

const BAKERY = { id: "P1", title: "Bakery App", number: 1, url: "https://github.com/orgs/acme/projects/1" };
const FLEET = { id: "P2", title: "Delivery Fleet", number: 2, url: "https://github.com/orgs/acme/projects/2" };

// Each Project's real Status option order. Neither is alphabetical, so
// the tiles honoring it prove the order comes from the query.
const OPTIONS = {
  P1: [
    { id: "b-open", name: "Open" },
    { id: "b-prog", name: "In Progress" },
    { id: "b-block", name: "Blocked" },
  ],
  P2: [
    { id: "f-todo", name: "Todo" },
    { id: "f-doing", name: "Doing" },
  ],
};

const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

function node(number, title, repo, updatedAt, items = []) {
  return {
    __typename: "Issue",
    number,
    title,
    url: `https://github.com/${repo}/issues/${number}`,
    state: "OPEN",
    updatedAt,
    repository: { nameWithOwner: repo },
    projectItems: { nodes: items },
  };
}
const inBakery = (name, color, optionId) => ({
  project: BAKERY,
  fieldValueByName: { name, color, optionId },
});
const inFleet = (name, color, optionId) => ({
  project: FLEET,
  fieldValueByName: name ? { name, color, optionId } : {},
});

// 7 Open (more than the 5-per-Status cap), 1 In Progress, 1 Blocked in
// Bakery App; Todo / Doing / No Status in Delivery Fleet; one issue in
// BOTH projects; two in no project, one of them in a repo whose name is
// shared by two owners (acme/site and crumb/site).
const ISSUES = [
  ...Array.from({ length: 7 }, (_, i) =>
    node(100 + i, `Bake item ${i + 1}`, "acme/orders-api", hoursAgo(2 + i), [inBakery("Open", "GREEN", "b-open")])
  ),
  node(120, "Prototype live oven status", "acme/ovens-hub", hoursAgo(1), [inBakery("In Progress", "YELLOW", "b-prog")]),
  node(130, "Card payments at the counter", "acme/pos", hoursAgo(24 * 21), [inBakery("Blocked", "RED", "b-block")]),
  node(591, "Add pickup time slots", "acme/orders-api", hoursAgo(1), [
    inBakery("Open", "GREEN", "b-open"),
    inFleet("Todo", "BLUE", "f-todo"),
  ]),
  node(28, "Van temperature alerts", "acme/fleet", hoursAgo(5), [inFleet("Doing", "ORANGE", "f-doing")]),
  node(40, "Fuel card reconciliation", "acme/fleet", hoursAgo(24 * 150), [inFleet(null)]),
  node(199, "Typo on the about page", "acme/site", hoursAgo(50)),
  node(4, "Update the croissant photo", "crumb/site", hoursAgo(24 * 7)),
];
// Distinct issues: 7 + 1 + 1 + 1 (shared) + 1 + 1 + 2 = 14.

const searchResponse = (nodes = ISSUES, extra = {}) => ({
  data: {
    search: {
      issueCount: nodes.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
      ...extra,
    },
  },
});

// The search and the per-project Status-order query both hit /graphql;
// branch on the request body so each gets its own shape. `searched`
// collects every search the extension runs. Registered after routeApi so
// it wins for /graphql while REST falls through to routeApi's defaults.
async function routeGraphql(context, { search = () => searchResponse(), searched = [], bodies = [] } = {}) {
  await context.route("https://api.github.com/graphql", async (route) => {
    let body = {};
    bodies.push(route.request().postData() || "");
    try {
      body = JSON.parse(route.request().postData() || "{}");
    } catch {}
    const id = body.variables?.id;
    if (/node\s*\(/.test(body.query || "") || id) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { node: { field: { options: OPTIONS[id] || [] } } } }),
      });
    }
    searched.push(body.variables || {});
    const out = await search(body.variables || {});
    return route.fulfill({
      status: out.status || 200,
      contentType: "application/json",
      body: JSON.stringify(out.status ? { message: out.message || "error" } : out),
    });
  });
}

async function setup(context, page, { storage = {}, fixture = "my-issues.html", graphql = {} } = {}) {
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "grouped", ghmiSidebar: "expanded", ...TOKENS, ...storage });
  await routeApi(context);
  await routeGraphql(context, graphql);
  await routeGithub(context, fixture);
  await page.goto(ISSUES_URL);
}

const tile = (page, title) =>
  page.locator(".ghmi-tile", { has: page.locator(".ghmi-tile-title", { hasText: title }) });

test("renders a tile per project, statuses in the project's real order, with bar and legend", async ({ context, page }) => {
  await setup(context, page);

  await expect(page.locator("#ghmi-root .ghmi-seg-btn[data-view='grouped']")).toHaveClass(/is-active/);
  await expect(page.locator(".ghmi-tile-title")).toHaveText(["Bakery App", "Delivery Fleet", "No Project"]);

  const bakery = tile(page, "Bakery App");
  await expect(bakery.locator(".ghmi-status-name")).toHaveText(["Open", "In Progress", "Blocked"]);
  await expect(tile(page, "Delivery Fleet").locator(".ghmi-status-name")).toHaveText(["Todo", "Doing", "No Status"]);

  // Header: project link, count pill, "Open project" link.
  await expect(bakery.locator("a.ghmi-tile-title")).toHaveAttribute("href", BAKERY.url);
  await expect(bakery.locator(".ghmi-count").first()).toHaveText("10");
  await expect(bakery.locator(".ghmi-open-project")).toHaveAttribute("href", BAKERY.url);

  // The bar is an image whose label is the legend text, names verbatim.
  const legend = "8 Open · 1 In Progress · 1 Blocked";
  await expect(bakery.locator(".ghmi-legend")).toHaveText(legend);
  await expect(bakery.locator(".ghmi-dist")).toHaveAttribute("role", "img");
  await expect(bakery.locator(".ghmi-dist")).toHaveAttribute("aria-label", legend);
  await expect(bakery.locator(".ghmi-dist-seg")).toHaveCount(3);
  await expect(tile(page, "Delivery Fleet").locator(".ghmi-legend")).toHaveText("1 Todo · 1 Doing · 1 No Status");

  // The native list is hidden while grouped.
  await expect(page.locator(".issue-list")).toBeHidden();
});

test("the toolbar counts distinct issues, not the sum of the tiles", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator(".ghmi-summary")).toHaveText("14 issues in 2 projects");
});

test("a row shows state icon, title, repo#number without the owner, and time since update", async ({ context, page }) => {
  await setup(context, page);
  const fleet = tile(page, "Delivery Fleet");
  const row = fleet.locator(".ghmi-row", { hasText: "Van temperature alerts" });

  await expect(row.locator(".ghmi-row-icon svg")).toBeVisible();
  await expect(row.locator("a.ghmi-row-title")).toHaveAttribute("href", "https://github.com/acme/fleet/issues/28");
  await expect(row.locator("a.ghmi-row-title")).toHaveAttribute("title", "Van temperature alerts");
  await expect(row.locator(".ghmi-row-ref")).toHaveText("fleet#28");
  await expect(row.locator(".ghmi-row-ref")).toHaveAttribute("title", "acme/fleet#28");
  await expect(row.locator("time")).toHaveText("5h");
  await expect(row.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

  // The owner stays only where a repo name is shared by two owners.
  const none = tile(page, "No Project");
  await expect(none.locator(".ghmi-row-ref")).toHaveText(["acme/site#199", "crumb/site#4"]);
});

test("an issue in two projects shows in both tiles with each project's status", async ({ context, page }) => {
  await setup(context, page);
  const title = "Add pickup time slots";
  await expect(tile(page, "Bakery App").locator(".ghmi-status", { hasText: "Open" }).locator(".ghmi-row", { hasText: title })).toHaveCount(1);
  await expect(tile(page, "Delivery Fleet").locator(".ghmi-status", { hasText: "Todo" }).locator(".ghmi-row", { hasText: title })).toHaveCount(1);
});

test("shows 5 per status then 'Show N more', which expands in place", async ({ context, page }) => {
  await setup(context, page);
  const open = tile(page, "Bakery App").locator(".ghmi-status", { hasText: "Open" }).first();
  await expect(open.locator(".ghmi-row")).toHaveCount(5);
  const more = open.locator(".ghmi-more");
  await expect(more).toHaveText("Show 3 more");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  await more.click();
  await expect(open.locator(".ghmi-row")).toHaveCount(8);
  await expect(open.locator(".ghmi-more")).toHaveCount(0);

  // The cap is per status: the others are never hidden behind Open's backlog.
  await expect(tile(page, "Bakery App").locator(".ghmi-row", { hasText: "Card payments" })).toBeVisible();
  // No button at or under the cap.
  await expect(tile(page, "Delivery Fleet").locator(".ghmi-more")).toHaveCount(0);
});

test("Collapse all and Expand all toggle every tile; a collapsed tile keeps header, bar and legend", async ({ context, page }) => {
  await setup(context, page);
  await page.getByRole("button", { name: "Collapse all" }).click();
  for (const t of await page.locator(".ghmi-tile").all()) await expect(t).not.toHaveAttribute("open", "");
  const bakery = tile(page, "Bakery App");
  await expect(bakery.locator(".ghmi-tile-title")).toBeVisible();
  await expect(bakery.locator(".ghmi-dist")).toBeVisible();
  await expect(bakery.locator(".ghmi-legend")).toBeVisible();
  await expect(bakery.locator(".ghmi-row").first()).toBeHidden();

  await page.getByRole("button", { name: "Expand all" }).click();
  for (const t of await page.locator(".ghmi-tile").all()) await expect(t).toHaveAttribute("open", "");
  await expect(bakery.locator(".ghmi-row").first()).toBeVisible();
});

test("the grid has several columns when wide, and the status gutter stacks in a narrow tile", async ({ context, page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await setup(context, page, { storage: { ghmiSidebar: "collapsed" } });
  const a = await tile(page, "Bakery App").boundingBox();
  const b = await tile(page, "Delivery Fleet").boundingBox();
  expect(Math.abs(a.y - b.y)).toBeLessThan(2); // side by side
  const pill = await tile(page, "Delivery Fleet").locator(".ghmi-status-name").first().boundingBox();
  const row = await tile(page, "Delivery Fleet").locator(".ghmi-row").first().boundingBox();
  expect(row.x).toBeGreaterThan(pill.x + pill.width); // gutter beside the rows

  await page.setViewportSize({ width: 520, height: 900 });
  await expect.poll(async () => {
    const p = await tile(page, "Delivery Fleet").locator(".ghmi-status-name").first().boundingBox();
    const r = await tile(page, "Delivery Fleet").locator(".ghmi-row").first().boundingBox();
    return r.y >= p.y + p.height - 1 && Math.abs(r.x - p.x) < 40;
  }).toBe(true); // gutter stacked above its rows
});

test("the No Project tile lists issues flat, without a status gutter", async ({ context, page }) => {
  await setup(context, page);
  const none = tile(page, "No Project");
  await expect(none.locator(".ghmi-row")).toHaveCount(2);
  await expect(none.locator(".ghmi-status-name")).toHaveCount(0);
  await expect(none.locator(".ghmi-open-project")).toHaveCount(0);
});

test("collapsed tiles survive a re-render of the page", async ({ context, page }) => {
  await setup(context, page);
  await tile(page, "Delivery Fleet").locator("summary").click({ position: { x: 5, y: 5 } });
  await expect(tile(page, "Delivery Fleet")).not.toHaveAttribute("open", "");
  // Drop our node as a GitHub re-render would; it comes back, still collapsed.
  await page.evaluate(() => document.getElementById("ghmi-root").remove());
  await expect(page.locator("#ghmi-root")).toHaveCount(1);
  await expect(tile(page, "Delivery Fleet")).not.toHaveAttribute("open", "");
  await expect(tile(page, "Bakery App")).toHaveAttribute("open", "");
});

test("shows loading, empty, no-token and error states in place of the tiles", async ({ context, page }) => {
  // Loading, then empty.
  let release;
  const gate = new Promise((r) => (release = r));
  await setup(context, page, { graphql: { search: async () => (await gate, searchResponse([])) } });
  await expect(page.locator(".ghmi-message")).toHaveText("Loading issues…");
  release();
  await expect(page.locator(".ghmi-message")).toHaveText("No issues match this search.");
});

test("shows a no-token state with a way to open settings", async ({ context, page }) => {
  await setup(context, page, {
    storage: { githubTokens: [], defaultTokenId: null },
    graphql: { search: () => ({ status: 401, message: "Bad credentials" }) },
  });
  await expect(page.locator(".ghmi-message")).toContainText("Add a GitHub token to group issues by project.");
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
});

test("shows an API error and points back to the native list", async ({ context, page }) => {
  await setup(context, page, { graphql: { search: () => ({ status: 500, message: "boom" }) } });
  await expect(page.locator(".ghmi-message")).toContainText("Couldn't load issues");
  await expect(page.locator(".ghmi-message")).toContainText("Switch to List for the native view.");
});

test("labels a truncated set as 'first N of M' in the toolbar", async ({ context, page }) => {
  // Every page says there is another one, so the fetch stops at its cap.
  const search = () => ({
    data: {
      search: {
        issueCount: 742,
        pageInfo: { hasNextPage: true, endCursor: "c" },
        nodes: [node(1, "One", "acme/web", hoursAgo(1))],
      },
    },
  });
  await setup(context, page, { graphql: { search } });
  await expect(page.locator(".ghmi-summary")).toHaveText(/Showing the first \d+ of 742 issues\. Narrow the search to see all\./);
});

test("follows search pages until the end", async ({ context, page }) => {
  const searched = [];
  const search = (vars) =>
    vars.after
      ? { data: { search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(2, "Second page issue", "acme/web", hoursAgo(2))] } } }
      : { data: { search: { issueCount: 2, pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node(1, "First page issue", "acme/web", hoursAgo(1))] } } };
  await setup(context, page, { graphql: { search, searched } });
  await expect(page.locator(".ghmi-row", { hasText: "Second page issue" })).toBeVisible();
  await expect(page.locator(".ghmi-row", { hasText: "First page issue" })).toBeVisible();
  expect(searched.length).toBe(2);
});

test("derives the query from the dashboard tab when the URL carries no q", async ({ context, page }) => {
  const searched = [];
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "grouped", ...TOKENS });
  await routeApi(context);
  await routeGraphql(context, { searched });
  await routeGithub(context, "my-issues.html");
  await page.goto("https://github.com/issues/created");
  await expect(page.locator("#ghmi-root .ghmi-seg-btn[data-view='grouped']")).toHaveClass(/is-active/);
  await expect.poll(() => searched.length).toBeGreaterThan(0);
  expect(searched.some((v) => (v.q || "").includes("author:@me"))).toBe(true);
  expect(searched.some((v) => (v.q || "").includes("assignee:@me"))).toBe(false);
});

test("re-fetches and regroups when the query changes, and not on a re-render with the same query", async ({ context, page }) => {
  const searched = [];
  await setup(context, page, { graphql: { searched } });
  await expect(page.locator(".ghmi-tile").first()).toBeVisible();
  const first = searched.length;

  // Same query, our node dropped and re-mounted: no extra search.
  await page.evaluate(() => document.getElementById("ghmi-root").remove());
  await expect(page.locator(".ghmi-tile").first()).toBeVisible();
  expect(searched.length).toBe(first);

  // A different query (as a search edit or saved view would produce).
  await page.evaluate(() => history.pushState({}, "", "/issues?q=" + encodeURIComponent("label:bug")));
  await expect.poll(() => searched.some((v) => (v.q || "").startsWith("label:bug"))).toBe(true);
});

test("re-injects the switch after a turbo navigation and a list re-render", async ({ context, page }) => {
  await setup(context, page, { storage: { ghmiView: "list" } });
  await expect(page.locator("#ghmi-root")).toHaveCount(1);
  await page.evaluate(() => {
    document.getElementById("ghmi-root").remove();
    document.dispatchEvent(new Event("turbo:load"));
  });
  await expect(page.locator("#ghmi-root")).toHaveCount(1);
  await expect(page.locator("#ghmi-root .ghmi-seg-btn[data-view='list']")).toHaveClass(/is-active/);
});

test("switching back to List restores the native list", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator(".issue-list")).toBeHidden();
  await page.locator("#ghmi-root .ghmi-seg-btn[data-view='list']").click();
  await expect(page.locator(".issue-list")).toBeVisible();
  await expect(page.locator(".ghmi-panel")).toBeHidden();
  await expect(page.getByRole("button", { name: "Collapse all" })).toBeHidden();
});

test("only reads: the grouped view sends no GraphQL mutation", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { graphql: { bodies } });
  await expect(page.locator(".ghmi-tile").first()).toBeVisible();
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.some((b) => /mutation/i.test(b))).toBe(false);
});

// ---------------------------------------------------------------- sidebar

const toggle = (page) => page.locator("button.ghmi-sidebar-toggle");
const contentWidth = async (page) => (await page.locator(".dash-content").boundingBox()).width;

test("the sidebar starts collapsed, toggles, persists across reload and works in List view", async ({ context, page }) => {
  await setup(context, page, { storage: { ghmiSidebar: undefined, ghmiView: "list" } });

  // Collapsed on first load, in List view too: an icon rail.
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page)).toHaveAttribute("aria-label", "Expand sidebar");
  await expect.poll(async () => (await page.locator(".dash-sidebar").boundingBox()).width).toBeLessThan(80);
  const narrow = await contentWidth(page);

  // Each nav item keeps its accessible name and gets a tooltip.
  for (const label of ["Assigned to me", "Created by me", "Mentioning me", "Recently updated"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
    await expect(page.getByRole("link", { name: label })).toHaveAttribute("title", label);
  }
  // The Views section is hidden in the rail.
  await expect(page.locator(".views")).toBeHidden();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page)).toHaveAttribute("aria-label", "Collapse sidebar");
  await expect(page.locator(".views")).toBeVisible();
  await expect.poll(async () => (await page.locator(".dash-sidebar").boundingBox()).width).toBeGreaterThan(200);
  expect(await contentWidth(page)).toBeLessThan(narrow);

  // Persisted: collapse, reload, still collapsed.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  // The content area took the freed width again.
  await expect.poll(() => contentWidth(page)).toBeGreaterThanOrEqual(narrow - 1);
});

test("the sidebar toggle is a focusable button", async ({ context, page }) => {
  await setup(context, page);
  await toggle(page).focus();
  await expect(toggle(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("the sidebar also collapses in a flex pane", async ({ context, page }) => {
  await seedStorage(context, { ghmiEnabled: true, ghmiView: "list", ghmiSidebar: "collapsed", ...TOKENS });
  await routeApi(context);
  await routeGraphql(context);
  const html = fs
    .readFileSync(path.join(FIXTURES_DIR, "my-issues.html"), "utf8")
    .replace(
      /\/\*PANE\*\/[\s\S]*?\/\*END-PANE\*\//,
      ".dash-pane { display: flex; gap: 16px; } .dash-sidebar { flex: 0 0 256px; } .dash-content { flex: 1 1 auto; max-width: 700px; }"
    );
  await context.route("https://github.com/**", (route) =>
    route.request().resourceType() === "document"
      ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
      : route.abort()
  );
  await page.goto(ISSUES_URL);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await page.locator(".dash-sidebar").boundingBox()).width).toBeLessThan(80);
  await toggle(page).click();
  await expect.poll(async () => (await page.locator(".dash-sidebar").boundingBox()).width).toBeGreaterThan(200);
});

test("leaves the sidebar native when the feature is disabled", async ({ context, page }) => {
  await setup(context, page, { storage: { ghmiEnabled: false } });
  await page.waitForTimeout(1000);
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.locator(".views")).toBeVisible();
  expect((await page.locator(".dash-sidebar").boundingBox()).width).toBeGreaterThan(200);
  await expect(page.locator("[data-ghmi-sidebar], [data-ghmi-pane]")).toHaveCount(0);
});

test("adds no sidebar toggle when the nav items are not found", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(context, page, { fixture: "my-issues-no-nav.html", storage: { ghmiSidebar: "collapsed" } });
  // The rest of the feature still works…
  await expect(page.locator(".ghmi-tile").first()).toBeVisible();
  await page.waitForTimeout(1000);
  // …but the sidebar is untouched.
  await expect(toggle(page)).toHaveCount(0);
  await expect(page.locator("[data-ghmi-sidebar], [data-ghmi-pane]")).toHaveCount(0);
  expect((await page.locator(".dash-sidebar").boundingBox()).width).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});

test("injects nothing when the feature is disabled", async ({ context, page }) => {
  await setup(context, page, { storage: { ghmiEnabled: false } });
  await page.waitForTimeout(1000);
  await expect(page.locator("#ghmi-root")).toHaveCount(0);
  await expect(page.locator(".issue-list")).toBeVisible();
});
