// E2E: the quick-create feature on a Projects board. User-defined
// shortcut buttons are injected into the project's top bar, between its
// Insights/Workflows and Project details/"..." groups, or float at the
// bottom-right when that bar can't be found. Main path (a configured
// shortcut renders, in the right place, on current and previous markup),
// the floating fallback, plus the disabled state.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const SHORTCUTS = [
  { label: "New bug", url: "https://github.com/acme/web/issues/new?template=bug", icon: "issue", color: "#cf222e" },
];

// Visible text of the root's neighbours in the top bar, so a test can
// assert it sits between the two button groups.
async function neighbours(page) {
  return page.locator("#ghqc-root").evaluate((root) => ({
    parentIsBody: root.parentElement === document.body,
    before: root.previousElementSibling?.textContent.trim(),
    after: root.nextElementSibling?.textContent.trim(),
  }));
}

test("injects a configured quick-create shortcut button", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const btn = page.locator("#ghqc-root .ghqc-btn");
  await expect(btn).toHaveCount(1);
  await expect(btn).toContainText("New bug");
  await expect(btn).toHaveAttribute("href", SHORTCUTS[0].url);
});

test("places the buttons between the Insights and Project details groups", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("places the buttons in the top bar on the previous class naming", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board-legacy-classes.html");
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("finds the top bar by the Insights text when the groups are unrecognisable", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html", {
    transform: (html) => html.replaceAll('class="ButtonGroup__Mn78Op"', 'class="Group__Zz99"'),
  });
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("falls back to a floating button when the top bar is missing", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html", {
    transform: (html) => html.replace(/<div class="topBarActions__[\s\S]*?\n      <\/div>/, ""),
  });
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveClass(/is-floating/, { timeout: 10000 });
  await expect(root.locator(".ghqc-btn")).toContainText("New bug");
  expect((await neighbours(page)).parentIsBody).toBe(true);
  await expect(page.getByRole("button", { name: "Insights" })).toHaveCount(0);
});

test("injects nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS, quickCreateEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghqc-root")).toHaveCount(0);
});
