// E2E: the Split diff: one column switch in Settings → Features.
import { test, expect } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { setup, sampleFiles, URLS, modes } from "./support/split.js";

const sw = (page) => page.locator("#feature-ghsoc");

test("the switch is on by default, with nothing stored, and has an accessible name", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#features").getByRole("switch", { name: "Split diff: one column" })).toHaveCount(1);
  expect((await worker.evaluate(() => chrome.storage.local.get("ghsocEnabled"))).ghsocEnabled).toBeUndefined();
  await expect(page.locator("#features .row", { hasText: "Split diff: one column" }).locator("a.cfg")).toHaveCount(0);
});

test("switching it off then on writes ghsocEnabled false, then true", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  expect((await worker.evaluate(() => chrome.storage.local.get("ghsocEnabled"))).ghsocEnabled).toBe(false);
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
  expect((await worker.evaluate(() => chrome.storage.local.get("ghsocEnabled"))).ghsocEnabled).toBe(true);
});

test("with the switch off, a saved false is shown as off and every diff is untouched", async ({ context, page }) => {
  await openOptions(context, page);
  await page.evaluate(() => chrome.storage.local.set({ ghsocEnabled: false }));
  await page.reload();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  for (const kind of ["hashed", "unhashed", "classic"]) {
    const p = await context.newPage();
    const { url } = await setup(context, kind, sampleFiles());
    await p.goto(url);
    await p.waitForTimeout(400);
    expect(await modes(p), kind).toEqual([null, null, null, null, null]);
    await expect(p.locator("[data-ghsoc-control]")).toHaveCount(0);
    await p.close();
    await context.unrouteAll();
  }
  void URLS;
});
