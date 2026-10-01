// E2E: the quick-create feature on a Projects board. User-defined
// shortcut buttons are injected into the project's top bar. Main path
// (a configured shortcut renders) plus the disabled state.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const SHORTCUTS = [
  { label: "New bug", url: "https://github.com/acme/web/issues/new?template=bug", icon: "issue", color: "#cf222e" },
];

test("injects a configured quick-create shortcut button", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const btn = page.locator("#ghqc-root .ghqc-btn");
  await expect(btn).toHaveCount(1);
  await expect(btn).toContainText("New bug");
  await expect(btn).toHaveAttribute("href", SHORTCUTS[0].url);
});

test("injects nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS, quickCreateEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghqc-root")).toHaveCount(0);
});
