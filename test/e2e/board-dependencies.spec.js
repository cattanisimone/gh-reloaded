// E2E: the board-dependencies feature on a Projects board. It's off by
// default and turned on by a switch in the view-tabs bar. Main path (an
// arrow is drawn between two dependent cards once enabled) plus the
// default-off state (the switch is present but unchecked, no arrows).
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";

// Card #2 blocks card #3 — both are on the board, so one arrow is drawn.
const API = [
  {
    match: (p) => p === "/repos/acme/web/issues/2/dependencies/blocking",
    json: [{ number: 3, repository_url: "https://api.github.com/repos/acme/web" }],
  },
];

test("draws a dependency arrow between two cards when enabled", async ({ context, page }) => {
  await seedStorage(context, { ghbdEnabled: true });
  await routeApi(context, API);
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  await expect(page.locator("#ghbd-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#ghbd-root path.ghbd-edge")).toHaveCount(1);
});

test("shows the switch unchecked and draws nothing while off (the default)", async ({ context, page }) => {
  await routeApi(context, API);
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  // The switch is offered on a board view...
  await expect(page.locator("#ghbd-toggle")).toHaveAttribute("aria-checked", "false");
  // ...but no overlay/arrows until it's turned on.
  await page.waitForTimeout(1000);
  await expect(page.locator("#ghbd-root")).toHaveCount(0);
});
