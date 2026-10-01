// E2E: the full-width-board feature on a Projects board. It's a pure
// CSS-class toggle on <body> (on by default), so the main path is "the
// class is applied on a board" and the disabled state is "it isn't".
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";

test("stretches the board to full width by default", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
});

test("leaves the board alone when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghfwEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("body.ghfw-active")).toHaveCount(0);
});
