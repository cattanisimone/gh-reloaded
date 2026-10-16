// E2E: placement of the controls on the Settings page.
import { test, expect } from "./support/extension.js";
import { openOptions } from "./support/options.js";

const SWITCHES = ["ghdg", "quick-create", "ghbd", "ghfw", "ghsm", "ghhp", "ghmi"];

test("Features lists 7 switches and Configure only for Quick-create, Standup, My Issues", async ({ context, page }) => {
  await openOptions(context, page);
  const features = page.locator("#features");
  await expect(features.getByRole("switch")).toHaveCount(7);
  for (const s of SWITCHES) await expect(page.locator(`#feature-${s}`)).toHaveCount(1);
  const links = features.locator("a.cfg");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute("href", "#shortcuts-section");
  await expect(links.nth(1)).toHaveAttribute("href", "#advanced-standup");
  await expect(links.nth(2)).toHaveAttribute("href", "#advanced-my-issues");
  await expect(features.locator("input")).toHaveCount(0);
});

test("Standup and tile fields live in their Advanced groups", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(page.locator("#advanced-standup #ghsm-stale-days")).toHaveCount(1);
  await expect(page.locator("#advanced-standup #ghsm-review-keywords")).toHaveCount(1);
  await expect(page.locator("#advanced-my-issues #ghmi-tile-min")).toHaveCount(1);
  await expect(page.locator("#advanced-my-issues #ghmi-tile-max")).toHaveCount(1);
  await expect(page.locator("#advanced-my-issues #ghmi-tile-reset")).toHaveCount(1);
  await expect(page.locator("#advanced-section").getByRole("switch")).toHaveCount(0);
});

test("seeded keys load into the new controls unchanged", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await worker.evaluate(() => chrome.storage.local.set({
    ghsmEnabled: false, ghsmStaleDays: 5, ghsmReviewKeywords: "qa, uat", ghmiEnabled: false, ghprtEnabled: false, ghmiTileMin: 700, ghmiTileMax: 900,
  }));
  await page.reload();
  await expect(page.locator("#feature-ghsm")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#feature-ghmi")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#feature-ghprt")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#ghsm-stale-days")).toHaveValue("5");
  await expect(page.locator("#ghsm-review-keywords")).toHaveValue("qa, uat");
  await expect(page.locator("#ghmi-tile-min")).toHaveValue("700");
  await expect(page.locator("#ghmi-tile-max")).toHaveValue("900");
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  expect(stored).toMatchObject({ ghsmStaleDays: 5, ghsmReviewKeywords: "qa, uat", ghmiTileMin: 700, ghmiTileMax: 900 });
});

test("the first feature row is above the fold on a laptop screen", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOptions(context, page);
  const box = await page.locator("#features .row").first().boundingBox();
  expect(box.y).toBeLessThan(260);
});

test("Repository and Report an issue links are present", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(page.locator(".page-foot a")).toHaveText(["Repository", "Report an issue"]);
});

test("switch off state keeps 3:1 contrast against the card", async ({ context, page }) => {
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await openOptions(context, page);
    const c = await page.locator("#feature-ghbd .switch-track").evaluate((t) => {
      const lum = (s) => { const [r, g, b] = s.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const a = lum(getComputedStyle(t).backgroundColor), b = lum(getComputedStyle(t.closest(".card")).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(c, scheme).toBeGreaterThanOrEqual(3);
  }
});
