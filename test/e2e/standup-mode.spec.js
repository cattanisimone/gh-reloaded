// E2E: the standup-mode feature on a Projects board. On by default: the
// entry button is offered on a Board view, entering spotlights the first
// card and shows its details, the controls walk the board in order, and
// Esc exits. The disabled state is "no entry button is offered".
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";

test("presents the board one card at a time and exits on Esc", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  // The entry button is offered on a Board view by default.
  const enter = page.locator("#ghsm-enter");
  await expect(enter).toHaveCount(1);
  await enter.click();

  // Entering adds the active layer and the overlay, spotlighting card 1.
  await expect(page.locator("body.ghsm-active")).toHaveCount(1);
  await expect(page.locator("#ghsm-root")).toHaveCount(1);
  await expect(page.locator("#ghsm-counter")).toHaveText("Card 1 of 2");
  await expect(page.locator("#ghsm-title")).toHaveText("Set up the build");
  await expect(page.locator("#ghsm-title")).toHaveAttribute("href", /\/acme\/web\/issues\/2$/);
  await expect(page.locator("#ghsm-column")).toHaveText("Todo");
  // The spotlit card is marked so the CSS can lift it.
  await expect(page.locator(".ghsm-current")).toHaveCount(1);

  // On-screen Next walks to the second card, in board order.
  await page.locator("#ghsm-next").click();
  await expect(page.locator("#ghsm-counter")).toHaveText("Card 2 of 2");
  await expect(page.locator("#ghsm-title")).toHaveText("Wire up the dashboard");
  await expect(page.locator("#ghsm-column")).toHaveText("In progress");

  // The keyboard walks back the other way.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#ghsm-counter")).toHaveText("Card 1 of 2");

  // Esc exits cleanly — no active class, no overlay, no stale highlight.
  await page.keyboard.press("Escape");
  await expect(page.locator("body.ghsm-active")).toHaveCount(0);
  await expect(page.locator("#ghsm-root")).toHaveCount(0);
  await expect(page.locator(".ghsm-current")).toHaveCount(0);

  // The entry button is still there to re-enter.
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
});

test("offers no entry button when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghsmEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
});
