// E2E: the "Notification reason tags" switch in Settings → Features. It is on
// when unset, writes ghntModules.reasonTags and keeps every other key of that
// object; its permission hints are listed with the token permissions.
import { test, expect } from "./support/extension.js";
import { openOptions } from "./support/options.js";

const sw = (page) => page.locator("#feature-ghnt-reason-tags");

test("reason tags switch is on when unset and nothing is written by opening Settings", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
  expect(await worker.evaluate(() => chrome.storage.local.get("ghntModules"))).toEqual({});
});

test("turning it off writes ghntModules.reasonTags and keeps the other modules; on again restores it", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await worker.evaluate(() => chrome.storage.local.set({ ghntModules: { filterBar: true } }));
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get("ghntModules"))).toEqual({ ghntModules: { filterBar: true, reasonTags: false } });
  await sw(page).click();
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get("ghntModules"))).toEqual({ ghntModules: { filterBar: true, reasonTags: true } });
  await page.reload();
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
});

test("a stored false loads as off; a change made elsewhere updates the switch", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  await worker.evaluate(() => chrome.storage.local.set({ ghntModules: { reasonTags: false } }));
  await page.reload();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await worker.evaluate(() => chrome.storage.local.set({ ghntModules: { reasonTags: true } }));
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
});

test("the Features row explains the reads, and the Issues and Pull requests rows mention the feature", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(page.locator("#features")).toContainText("Reads review requests and mentions across every repository in your inbox; shows Unverifiable where the token has no access.");
  const rows = page.locator("#tokens-section .permission-row");
  await expect(rows.filter({ hasText: "Issues" }).first()).toContainText("Notification reason tags");
  await expect(rows.filter({ hasText: "Pull requests" }).first()).toContainText("Notification reason tags");
});
