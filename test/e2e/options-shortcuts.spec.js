// E2E: Quick-create shortcuts on the Settings page.
import { test, expect } from "./support/extension.js";
import { openOptions } from "./support/options.js";

test("add, save and reload a shortcut", async ({ context, page }) => {
  const worker = await openOptions(context, page, "#shortcuts-section");
  await page.locator("#add-shortcut").click();
  await page.locator(".sc-label").fill("New bug");
  await page.locator(".sc-url").fill("https://github.com/acme/app/issues/new/choose");
  await page.locator(".sc-swatch").nth(1).click();
  await page.locator("#save-shortcuts").click();
  await expect(page.locator("#shortcuts-status")).toHaveText("Saved 1 shortcut.");
  const { quickCreateShortcuts } = await worker.evaluate(() => chrome.storage.local.get("quickCreateShortcuts"));
  expect(quickCreateShortcuts).toEqual([
    { label: "New bug", url: "https://github.com/acme/app/issues/new/choose", project: "", color: "#0969da", icon: "plus" },
  ]);
  await page.reload();
  await expect(page.locator(".sc-label")).toHaveValue("New bug");
  await expect(page.locator(".sc-swatch.is-selected")).toHaveAttribute("data-color", "#0969da");
});

test("a shortcut without an http(s) link is rejected", async ({ context, page }) => {
  await openOptions(context, page, "#shortcuts-section");
  await page.locator("#add-shortcut").click();
  await page.locator(".sc-label").fill("Bad");
  await page.locator(".sc-url").fill("ftp://x");
  await page.locator("#save-shortcuts").click();
  await expect(page.locator("#shortcuts-status")).toContainText("needs a full http(s) URL");
});
