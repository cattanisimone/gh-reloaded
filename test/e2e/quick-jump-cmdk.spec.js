// E2E: the ⌘K / Ctrl+K value of the Shortcut selector. A fixture listener stands in for GitHub's own handler of the key.
import { test, expect } from "./support/extension.js";
import { seedStorage, backgroundWorker } from "./support/extension.js";
import { setup, toggle, panel, input, EDITABLES, TOKENS } from "./support/quick-jump.js";

const COUNT = `<script>window.__k = 0; window.__alt = 0; document.addEventListener("keydown", (e) => { if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") window.__k++; if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "k") window.__alt++; });</script>`;
const PAGES = { "*": { body: EDITABLES + COUNT, title: "acme/web", repoHeader: true } };
const CMDK = { ...TOKENS, ghqjShortcut: "cmdk" };
const count = (page, name = "__k") => page.evaluate((n) => window[n], name);

async function ready(page) {
  await page.goto("https://github.com/acme/web");
  await page.locator("#main").waitFor();
  await page.waitForTimeout(700);
  await page.mouse.click(5, 400);
}

test("with ⌘K chosen: Ctrl+K outside editable elements opens and closes the panel and GitHub's handler does not run", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  expect(await count(page)).toBe(0);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page)).toBe(0);
});

test("with ⌘K chosen: inside the panel's input the key closes it; Ctrl+Alt+K is never taken", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(input(page)).toBeFocused();
  await input(page).fill("abc");
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Control+Alt+k");
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page, "__alt")).toBe(1);
});

test("with ⌘K chosen: in an input, a textarea or a contenteditable the key reaches the page untouched", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  let n = 0;
  for (const sel of ["#field", "#comment", "#editor"]) {
    await page.locator(sel).focus();
    await page.keyboard.press("Control+k");
    n++;
    await expect(panel(page)).toHaveCount(0);
    expect(await count(page)).toBe(n);
  }
});

test("with ⌘K chosen the browser shortcut keeps working", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  for (let i = 0; i < 10 && !(await panel(page).count()); i++) await toggle(context, page);
  await expect(panel(page)).toBeVisible();
});

test("by default and with the browser value, Ctrl+K stays GitHub's; choosing it again frees the key without a reload", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghqjShortcut: "browser" }));
  await page.waitForTimeout(500);
  await page.mouse.click(5, 400);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page)).toBe(1);
  await worker.evaluate(() => chrome.storage.local.set({ ghqjShortcut: "cmdk" }));
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toBeVisible();
});

test("no token: Ctrl+K reaches the page whatever the saved choice", async ({ context, page }) => {
  await setup(context, { storage: { ghqjShortcut: "cmdk" }, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page)).toBe(1);
  void seedStorage;
});

test("switched off: Ctrl+K reaches the page", async ({ context, page }) => {
  await setup(context, { storage: { ...CMDK, ghqjEnabled: false }, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page)).toBe(1);
});

test("the footer shows the chosen key", async ({ context, page }) => {
  await setup(context, { storage: CMDK, pages: PAGES });
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(page.locator(".ghqj-sc-keys")).toHaveText("Ctrl+K");
});
