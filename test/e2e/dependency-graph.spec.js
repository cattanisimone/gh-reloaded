// E2E: the dependency-graph feature on an issue page. Main path (graph
// renders from the mocked API) plus the disabled state.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const SUB_ISSUES = [
  {
    number: 2,
    title: "Set up the build",
    state: "open",
    html_url: "https://github.com/acme/web/issues/2",
    repository_url: "https://api.github.com/repos/acme/web",
  },
  {
    number: 3,
    title: "Wire up the dashboard",
    state: "open",
    html_url: "https://github.com/acme/web/issues/3",
    repository_url: "https://api.github.com/repos/acme/web",
  },
];

// #3 is blocked by #2 → one internal edge in the graph.
const API = [
  { match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: SUB_ISSUES },
  {
    match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by",
    json: [SUB_ISSUES[0]],
  },
];

test("renders the dependency graph after the Sub-issues section", async ({ context, page }) => {
  await routeApi(context, API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root).toBeVisible();
  await expect(root.locator(".ghdg-header-title")).toContainText("Dependency graph");
  // One card per sub-issue.
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
  await expect(root).toContainText("Set up the build");
});

// #2 → #3 → #4 → #5 chain, plus direct #2 → #4 and #2 → #5 edges the longer
// chain already implies (the latter at depth three).
const mk = (number, title) => ({
  number,
  title,
  state: "open",
  html_url: `https://github.com/acme/web/issues/${number}`,
  repository_url: "https://api.github.com/repos/acme/web",
});
const CHAIN = [mk(2, "A"), mk(3, "B"), mk(4, "C"), mk(5, "D")];
const CHAIN_API = [
  { match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: CHAIN },
  { match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by", json: [CHAIN[0]] },
  { match: (p) => p === "/repos/acme/web/issues/4/dependencies/blocked_by", json: [CHAIN[1], CHAIN[0]] },
  { match: (p) => p === "/repos/acme/web/issues/5/dependencies/blocked_by", json: [CHAIN[2], CHAIN[0]] },
];

test("hides transitive edges at any depth by default and restores them when toggled off", async ({
  context,
  page,
}) => {
  await routeApi(context, CHAIN_API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(4); // cards are never removed

  const edges = root.locator("svg.ghdg-edges path.ghdg-edge");
  const toggle = root.locator(".ghdg-transitive-check");

  // On by default: A→C and A→D are implied by A→B→C→D, leaving the chain.
  await expect(toggle).toBeChecked();
  await expect(edges).toHaveCount(3);

  // Off: every explicit edge is back, live — same 4 cards, no reload.
  await toggle.uncheck();
  await expect(edges).toHaveCount(5);
  await expect(root.locator(".ghdg-node")).toHaveCount(4);

  // On again.
  await toggle.check();
  await expect(edges).toHaveCount(3);
});

// #2 → #3 → #4, #5 → #4 and an unrelated #6: selecting #3 reaches #2 upstream
// and #4 downstream, but not the sibling #5 or the unrelated #6.
const FOCUS = [mk(2, "A"), mk(3, "B"), mk(4, "C"), mk(5, "D"), mk(6, "E")];
const FOCUS_API = [
  { match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: FOCUS },
  { match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by", json: [FOCUS[0]] },
  { match: (p) => p === "/repos/acme/web/issues/4/dependencies/blocked_by", json: [FOCUS[1], FOCUS[3]] },
];

test("clicking a card fades everything outside its upstream and downstream, and clears again", async ({
  context,
  page,
}) => {
  await routeApi(context, FOCUS_API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  const nodes = root.locator(".ghdg-node");
  const edges = root.locator("svg.ghdg-edges path.ghdg-edge");
  await expect(nodes).toHaveCount(5);
  await expect(edges).toHaveCount(3);
  await expect(root.locator(".is-dimmed")).toHaveCount(0);

  const card = (n) => root.locator(`.ghdg-node[data-id="${n}"]`);

  // Select #3: #2 (upstream), #3 itself and #4 (downstream) stay; #5 and #6 fade.
  await card(3).click();
  await expect(card(3)).toHaveClass(/is-selected/);
  await expect(root.locator(".ghdg-node.is-dimmed")).toHaveCount(2);
  await expect(card(5)).toHaveClass(/is-dimmed/);
  await expect(card(6)).toHaveClass(/is-dimmed/);
  await expect(card(2)).not.toHaveClass(/is-dimmed/);
  await expect(card(4)).not.toHaveClass(/is-dimmed/);
  // Only the #5 → #4 edge leaves the lineage.
  await expect(root.locator("path.ghdg-edge.is-dimmed")).toHaveCount(1);
  await expect(root.locator('path.ghdg-edge.is-dimmed[data-from="5"]')).toHaveCount(1);

  // Click the same card again: cleared.
  await card(3).click();
  await expect(root.locator(".is-dimmed")).toHaveCount(0);
  await expect(root.locator(".is-selected")).toHaveCount(0);

  // Select, then clear by clicking the empty graph area.
  await card(2).click();
  await expect(root.locator(".ghdg-node.is-dimmed")).toHaveCount(2); // #5 and #6 are unrelated to #2
  await root.locator(".ghdg-graph-scroll").click({ position: { x: 2, y: 2 } });
  await expect(root.locator(".is-dimmed")).toHaveCount(0);

  // Select, then clear with Escape.
  await card(6).click();
  await expect(root.locator(".ghdg-node.is-dimmed")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(root.locator(".is-dimmed")).toHaveCount(0);
});

test("a card can be selected and cleared from the keyboard", async ({ context, page }) => {
  await routeApi(context, FOCUS_API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  const card = root.locator('.ghdg-node[data-id="6"]');
  await expect(card).toHaveAttribute("role", "button");
  await expect(card).toHaveAttribute("aria-pressed", "false");

  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveClass(/is-selected/);
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(root.locator(".ghdg-node.is-dimmed")).toHaveCount(4);

  await page.keyboard.press("Space");
  await expect(root.locator(".is-dimmed")).toHaveCount(0);
  await expect(card).toHaveAttribute("aria-pressed", "false");
});

test("in full screen, Escape clears the selection first and closes the view on the next press", async ({
  context,
  page,
}) => {
  await routeApi(context, FOCUS_API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  // The full-screen button ignores clicks until the graph has loaded.
  await expect(page.locator("#ghdg-root .ghdg-node")).toHaveCount(5);
  await page.locator("#ghdg-root .ghdg-fs-btn").click();
  const fs = page.locator("#ghdg-fs");
  await expect(fs.locator(".ghdg-node")).toHaveCount(5);
  await fs.locator('.ghdg-node[data-id="6"]').click();
  await expect(fs.locator(".ghdg-node.is-dimmed")).toHaveCount(4);

  await page.keyboard.press("Escape");
  await expect(fs).toBeVisible();
  await expect(fs.locator(".is-dimmed")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(fs).toHaveCount(0);
});

test("opens full screen, shows larger cards, and closes with the button and Escape", async ({
  context,
  page,
}) => {
  await routeApi(context, API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);

  // Enter full screen → the same graph, viewport-sized, with larger cards.
  await root.locator(".ghdg-fs-btn").click();
  const fs = page.locator("#ghdg-fs");
  await expect(fs).toBeVisible();
  await expect(fs.locator(".ghdg-node.is-large")).toHaveCount(2);
  await expect(fs).toContainText("Set up the build");

  // Close with the explicit control; the embedded graph is untouched.
  await fs.locator(".ghdg-close-btn").click();
  await expect(fs).toHaveCount(0);
  await expect(root.locator(".ghdg-node")).toHaveCount(2);

  // Reopen, then close with Escape.
  await root.locator(".ghdg-fs-btn").click();
  await expect(page.locator("#ghdg-fs")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#ghdg-fs")).toHaveCount(0);
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
});

test("full screen shows the graphed issue's title and metadata in its header", async ({
  context,
  page,
}) => {
  await routeApi(context, [
    {
      match: (p) => p === "/repos/acme/web/issues/1",
      json: {
        number: 1,
        title: "Ship the new dashboard",
        state: "open",
        html_url: "https://github.com/acme/web/issues/1",
      },
    },
    {
      match: (p) => p === "/repos/acme/web/issues/1/issue-field-values",
      json: [
        { issue_field_name: "Team", value: "Platform" },
        { issue_field_name: "Effort", value: 8 },
      ],
    },
    ...API,
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
  await root.locator(".ghdg-fs-btn").click();

  const parent = page.locator("#ghdg-fs .ghdg-fs-parent");
  await expect(parent).toBeVisible();
  await expect(parent).toContainText("Ship the new dashboard");
  await expect(parent).toContainText("#1");
  await expect(parent).toContainText("Platform");
  await expect(parent).toContainText("8 pts");
});

test("external dependency cards sit on a plain white surface, not a tinted status fill", async ({
  context,
  page,
}) => {
  const BLOCKER = {
    number: 77,
    title: "Upstream auth rework",
    state: "open",
    html_url: "https://github.com/other/lib/issues/77",
    repository_url: "https://api.github.com/repos/other/lib",
  };
  await routeApi(context, [
    {
      method: "POST",
      match: (p) => p === "/graphql",
      json: {
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{ fieldValueByName: { name: "Backlog", color: "GRAY" } }],
              },
            },
          },
        },
      },
    },
    { match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: SUB_ISSUES },
    { match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by", json: [BLOCKER] },
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const external = page.locator("#ghdg-root .ghdg-node.is-external");
  await expect(external).toHaveCount(1);
  await expect(external).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("manual refresh picks up a newly added sub-issue without reloading", async ({
  context,
  page,
}) => {
  const NEW_CHILD = {
    number: 4,
    title: "Added after load",
    state: "open",
    html_url: "https://github.com/acme/web/issues/4",
    repository_url: "https://api.github.com/repos/acme/web",
  };
  let subCalls = 0;
  await routeApi(context, [
    {
      match: /\/repos\/acme\/web\/issues\/1\/sub_issues/,
      json: () => (++subCalls === 1 ? SUB_ISSUES : [...SUB_ISSUES, NEW_CHILD]),
    },
    {
      match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by",
      json: [SUB_ISSUES[0]],
    },
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);

  await root.locator(".ghdg-refresh-btn").click();
  await expect(root.locator(".ghdg-node")).toHaveCount(3);
  await expect(root).toContainText("Added after load");
});

test("a failed refresh keeps the last graph and offers a retry", async ({ context, page }) => {
  let subCalls = 0;
  await routeApi(context, [
    // The second sub_issues request (the refresh) fails; the first succeeds.
    {
      match: (p) => p.endsWith("/issues/1/sub_issues") && ++subCalls >= 2,
      status: 500,
      json: { message: "boom" },
    },
    { match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: SUB_ISSUES },
    {
      match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by",
      json: [SUB_ISSUES[0]],
    },
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);

  await root.locator(".ghdg-refresh-btn").click();

  // The graph is left on screen; a retry banner appears rather than an error.
  await expect(root.locator(".ghdg-notice")).toBeVisible();
  await expect(root.locator(".ghdg-retry-btn")).toBeVisible();
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
});

test("auto-refresh reflects a change within a short interval", async ({ context, page }) => {
  const NEW_CHILD = {
    number: 4,
    title: "Appeared automatically",
    state: "open",
    html_url: "https://github.com/acme/web/issues/4",
    repository_url: "https://api.github.com/repos/acme/web",
  };
  let subCalls = 0;
  await seedStorage(context, { ghdgAutoRefreshMs: 400 });
  await routeApi(context, [
    {
      match: /\/repos\/acme\/web\/issues\/1\/sub_issues/,
      json: () => (++subCalls === 1 ? SUB_ISSUES : [...SUB_ISSUES, NEW_CHILD]),
    },
    {
      match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by",
      json: [SUB_ISSUES[0]],
    },
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);

  // No user action: the periodic refresh picks up the new child on its own.
  await expect(root.locator(".ghdg-node")).toHaveCount(3);
  await expect(root).toContainText("Appeared automatically");
});

test("a rate-limited auto-refresh backs off instead of polling at the same cadence", async ({
  context,
  page,
}) => {
  let subCalls = 0;
  await seedStorage(context, { ghdgAutoRefreshMs: 200 });
  await routeApi(context, [
    {
      match: /\/repos\/acme\/web\/issues\/1\/sub_issues/,
      // The initial load succeeds; every auto-refresh after it is rate-limited.
      status: () => (++subCalls === 1 ? 200 : 403),
      json: () => (subCalls === 1 ? SUB_ISSUES : { message: "API rate limit exceeded" }),
    },
    {
      match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocked_by",
      json: [SUB_ISSUES[0]],
    },
  ]);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2); // initial load

  // Each auto-refresh is rejected as rate-limited, so the controller stretches
  // the cadence (200ms → 800ms → 3200ms …) rather than re-polling every 200ms.
  // A fixed-cadence timer would fire ~7 times across this window; backoff keeps
  // it to a couple, so ordinary use can't exhaust the API quota.
  await page.waitForTimeout(1600);
  expect(subCalls).toBeLessThanOrEqual(4); // 1 load + a few backed-off retries

  // The last good graph stays on screen and a retry is still offered.
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
  await expect(root.locator(".ghdg-retry-btn").first()).toBeVisible();
});

test("renders nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghdgEnabled: false });
  await routeApi(context, API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  // Give the content script's load + poll a chance to run before asserting.
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghdg-root")).toHaveCount(0);
});
