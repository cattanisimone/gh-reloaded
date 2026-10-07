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

test("renders nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghdgEnabled: false });
  await routeApi(context, API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  // Give the content script's load + poll a chance to run before asserting.
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghdg-root")).toHaveCount(0);
});
