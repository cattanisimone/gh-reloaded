// E2E: hash routing between the Settings panels.
import { test, expect } from "./support/extension.js";
import { openOptions, PANELS } from "./support/options.js";

const visiblePanels = (page) => page.locator(".panel-view:not([hidden])").evaluateAll((els) => els.map((e) => e.id));

test("Configure opens the group and focuses it", async ({ context, page }) => {
  await openOptions(context, page);
  await page.locator("#features a.cfg").nth(1).click();
  await expect.poll(() => visiblePanels(page)).toEqual(["advanced-section"]);
  await expect(page.locator("#advanced-standup h2")).toBeFocused();
  await expect(page.locator("#advanced-standup h2")).toBeInViewport();
  await page.goBack();
  await page.locator("#features a.cfg").nth(2).click();
  await expect(page.locator("#advanced-my-issues h2")).toBeFocused();
});

test("Enter on a focused Configure", async ({ context, page }) => {
  await openOptions(context, page);
  await page.locator("#features a.cfg").nth(0).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => visiblePanels(page)).toEqual(["shortcuts-section"]);
  await expect(page.locator("#shortcuts-title")).toBeFocused();
});

test("deep link #advanced-standup", async ({ context, page }) => {
  await openOptions(context, page, "#advanced-standup");
  await expect.poll(() => visiblePanels(page)).toEqual(["advanced-section"]);
  await expect(page.locator("#advanced-standup h2")).toBeFocused();
  await expect(page.locator('.nav a[aria-current="page"]')).toHaveText("Advanced");
});

test("back returns to Features, forward to Advanced", async ({ context, page }) => {
  await openOptions(context, page);
  await page.locator('.nav a[href="#advanced-section"]').click();
  await expect.poll(() => visiblePanels(page)).toEqual(["advanced-section"]);
  await page.goBack();
  await expect.poll(() => visiblePanels(page)).toEqual(["features"]);
  await expect(page.locator('.nav a[aria-current="page"]')).toHaveText("Features");
  await page.goForward();
  await expect.poll(() => visiblePanels(page)).toEqual(["advanced-section"]);
});

test("old hashes still open their section; unknown hashes show Features", async ({ context, page }) => {
  await openOptions(context, page);
  for (const id of PANELS) {
    await page.evaluate((h) => { location.hash = h; }, id);
    await expect.poll(() => visiblePanels(page)).toEqual([id]);
  }
  await page.evaluate(() => { location.hash = "nonsense"; });
  await expect.poll(() => visiblePanels(page)).toEqual(["features"]);
});

test("unsaved edits survive a switch to another section", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  const input = page.locator("#token-default .tok-secret");
  await input.fill("ghp_unsaved1234");
  await page.locator('.nav a[href="#features"]').click();
  await page.locator('.nav a[href="#tokens-section"]').click();
  await expect(input).toHaveValue("ghp_unsaved1234");
});

test("a malformed hash falls back to Features", async ({ context, page }) => {
  await openOptions(context, page, "#%E0");
  await expect.poll(() => visiblePanels(page)).toEqual(["features"]);
  await expect(page.locator('.nav a[aria-current="page"]')).toHaveText("Features");
});

test("at phone width the focused heading clears the tab bar and the active tab is visible", async ({ context, page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openOptions(context, page, "#advanced-my-issues");
  const m = await page.evaluate(() => {
    const h = document.querySelector("#advanced-my-issues h2").getBoundingClientRect();
    const bar = document.querySelector(".sidebar").getBoundingClientRect();
    const nav = document.querySelector(".nav").getBoundingClientRect();
    const a = document.querySelector('.nav a[aria-current="page"]').getBoundingClientRect();
    return { clear: h.top >= bar.bottom - 0.5, tabVisible: a.left >= nav.left - 0.5 && a.right <= nav.right + 0.5 };
  });
  expect(m).toEqual({ clear: true, tabVisible: true });
});
