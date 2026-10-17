// E2E: the Advanced section of the Settings page (Standup signals, My Issues tile width).
// Empty or invalid input clears the setting; Reset to defaults clears both.
import { test, expect, backgroundWorker } from "./support/extension.js";

async function openOptions(context, page, hash = "#advanced-section") {
  const worker = await backgroundWorker(context);
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/options/options.html${hash}`);
  return worker;
}

const stored = (worker) => worker.evaluate(() => chrome.storage.local.get(["ghmiTileMin", "ghmiTileMax"]));

test("the Advanced section saves, validates and clears the tile widths", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await expect(page.locator('nav a[href="#advanced-section"]')).toBeVisible();
  const min = page.locator("#ghmi-tile-min");
  const max = page.locator("#ghmi-tile-max");

  await min.fill("700");
  await min.dispatchEvent("change");
  await max.fill("900");
  await max.dispatchEvent("change");
  await expect.poll(() => stored(worker)).toEqual({ ghmiTileMin: 700, ghmiTileMax: 900 });

  // A max below the min is rejected and the field cleared.
  await max.fill("500");
  await max.dispatchEvent("change");
  await expect.poll(() => stored(worker)).toEqual({ ghmiTileMin: 700 });
  await expect(max).toHaveValue("");

  // Out-of-range values are clamped.
  await min.fill("100");
  await min.dispatchEvent("change");
  await expect.poll(() => stored(worker)).toEqual({ ghmiTileMin: 280 });
  await expect(min).toHaveValue("280");

  // Junk clears.
  await min.fill("");
  await min.dispatchEvent("change");
  await expect.poll(() => stored(worker)).toEqual({});
});

test("Reset to defaults clears both fields and both keys", async ({ context, page }) => {
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghmiTileMin: 700, ghmiTileMax: 900 }));
  await openOptions(context, page);
  await expect(page.locator("#ghmi-tile-min")).toHaveValue("700");
  await expect(page.locator("#ghmi-tile-max")).toHaveValue("900");
  await page.locator("#ghmi-tile-reset").click();
  await expect(page.locator("#ghmi-tile-min")).toHaveValue("");
  await expect(page.locator("#ghmi-tile-max")).toHaveValue("");
  await expect.poll(() => stored(worker)).toEqual({});
});

const storedStandup = (worker) => worker.evaluate(() => chrome.storage.local.get(["ghsmStaleDays", "ghsmReviewKeywords"]));

test("Standup fields live in Advanced and save, validate and clear", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  const days = page.locator("#advanced-standup #ghsm-stale-days");
  const words = page.locator("#advanced-standup #ghsm-review-keywords");
  await expect(days).toHaveValue("");
  await expect(days).toHaveAttribute("placeholder", "3");
  await expect(words).toHaveAttribute("placeholder", "review, qa, test, deploy, release");

  await days.fill("4.7");
  await days.dispatchEvent("change");
  await words.fill("  qa, uat ");
  await words.dispatchEvent("change");
  await expect.poll(() => storedStandup(worker)).toEqual({ ghsmStaleDays: 4, ghsmReviewKeywords: "qa, uat" });
  await expect(days).toHaveValue("4");

  await days.fill("0");
  await days.dispatchEvent("change");
  await words.fill("");
  await words.dispatchEvent("change");
  await expect.poll(() => storedStandup(worker)).toEqual({});
  await expect(days).toHaveValue("");
});

test("turning Standup and My Issues off keeps their saved values, still editable", async ({ context, page }) => {
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghsmStaleDays: 6, ghsmReviewKeywords: "qa", ghmiTileMin: 700 }));
  await openOptions(context, page, "#features");
  await page.locator("#feature-ghsm").click();
  await page.locator("#feature-ghmi").click();
  await expect(page.locator("#feature-ghsm")).toHaveAttribute("aria-checked", "false");
  const all = await worker.evaluate(() => chrome.storage.local.get(null));
  expect(all).toMatchObject({ ghsmEnabled: false, ghmiEnabled: false, ghsmStaleDays: 6, ghsmReviewKeywords: "qa", ghmiTileMin: 700 });
  await page.locator('.nav a[href="#advanced-section"]').click();
  await expect(page.locator("#ghsm-stale-days")).toBeEnabled();
  await expect(page.locator("#ghsm-stale-days")).toHaveValue("6");
  await expect(page.locator("#ghmi-tile-min")).toHaveValue("700");
});

test("PR triage switch defaults on, has no Configure link, and persists", async ({ context, page }) => {
  const worker = await openOptions(context, page, "#features");
  const sw = page.locator("#feature-ghprt");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".row", { has: sw }).locator("a.cfg")).toHaveCount(0);
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  expect(await worker.evaluate(() => chrome.storage.local.get("ghprtEnabled"))).toEqual({ ghprtEnabled: false });
});
