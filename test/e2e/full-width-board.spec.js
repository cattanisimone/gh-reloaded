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

test("stretches the board container to the window's right edge", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expect(page.locator('[class*="boardContainer__"]')).toHaveCSS("margin-right", /^-?\d/);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
});

test("stretches a grouped board (Group by)", async ({ context, page }) => {
  await routeGithub(context, "board-standup-grouped.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
});

test("measures the board offset next to an open slice-by panel", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("0px");
  await page.evaluate(() => {
    const panel = document.createElement("div");
    panel.className = "SlicerPanel__Cj5ISm";
    panel.style.cssText = "float:left;width:200px;height:50px";
    document.querySelector('[class*="boardContainer__"]').before(panel);
    document.querySelector('[class*="boardContainer__"]').style.marginLeft = "200px";
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("200px");
  await page.evaluate(() => { document.querySelector('[class*="SlicerPanel__"]').style.width = "300px"; document.querySelector('[class*="boardContainer__"]').style.marginLeft = "300px"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("300px");
});

test("still stretches a board on the previous class naming", async ({ context, page }) => {
  await routeGithub(context, "board-legacy-classes.html");
  await page.goto(BOARD_URL);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
});

test("re-applies full width after the board re-renders", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--ghfw-board-left");
    const old = document.querySelector('[class*="boardContainer__"]');
    const fresh = old.cloneNode(true);
    fresh.style.marginLeft = "40px";
    old.replaceWith(fresh);
    history.pushState({}, "", "/orgs/acme/projects/7/views/2");
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("40px");
});

test("does nothing on a Table view", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('nav[aria-label="Select view"] [aria-selected="true"] svg').setAttribute("class", "octicon octicon-table");
    history.pushState({}, "", "/orgs/acme/projects/7/views/3");
  });
  await expect(page.locator("body.ghfw-active")).toHaveCount(0);
});
