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

test("renders nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghdgEnabled: false });
  await routeApi(context, API);
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");

  // Give the content script's load + poll a chance to run before asserting.
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghdg-root")).toHaveCount(0);
});
