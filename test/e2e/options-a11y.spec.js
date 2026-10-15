// E2E: labels, switch semantics, focus order and focus rings.
import { test, expect } from "./support/extension.js";
import { openOptions, PANELS } from "./support/options.js";

test("every input and button has an accessible name", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  await page.locator("#add-token").click();
  await page.evaluate(() => { location.hash = "shortcuts-section"; });
  await page.locator("#add-shortcut").click();
  const unnamed = [];
  for (const id of PANELS) {
    await page.evaluate((h) => { location.hash = h; }, id);
    const names = await page.locator(`#${id} :is(input, button, select)`).evaluateAll((els) =>
      els.map((e) => ({ id: e.id || e.className, name: (e.labels && e.labels.length ? e.labels[0].textContent : "") || e.getAttribute("aria-label") || e.textContent.trim() || e.getAttribute("title") })));
    unnamed.push(...names.filter((n) => !n.name));
  }
  expect(unnamed).toEqual([]);
});

test("Space toggles a switch and updates aria-checked", async ({ context, page }) => {
  const worker = await openOptions(context, page);
  const sw = page.locator("#feature-ghfw");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get("ghfwEnabled"))).toEqual({ ghfwEnabled: false });
});

test("Tab order goes sidebar then panel", async ({ context, page }) => {
  await openOptions(context, page);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => (document.activeElement.closest(".sidebar") ? "side" : document.activeElement.closest(".content") ? "content" : "other")));
  }
  const firstContent = seen.indexOf("content");
  expect(firstContent).toBeGreaterThan(0);
  expect(seen.slice(0, firstContent).every((s) => s === "side")).toBe(true);
  expect(seen.slice(firstContent).every((s) => s === "content")).toBe(true);
});

test("keyboard focus shows a ring on links, buttons, switches and inputs", async ({ context, page }) => {
  await openOptions(context, page);
  const ring = (sel) => page.locator(sel).first().evaluate((e) => { e.focus({ focusVisible: true }); const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.boxShadow]; });
  for (const sel of ['.nav a', "#features a.cfg", "#feature-ghdg"]) {
    const [style, width] = await ring(sel);
    expect(style, sel).not.toBe("none");
    expect(parseFloat(width), sel).toBeGreaterThan(0);
  }
  await page.evaluate(() => { location.hash = "advanced-section"; });
  for (const sel of ["#ghsm-stale-days", "#ghmi-tile-reset"]) {
    const [style, width] = await ring(sel);
    expect(style, sel).not.toBe("none");
    expect(parseFloat(width), sel).toBeGreaterThan(0);
  }
});

test("status lines keep role=status", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(page.locator("#tokens-status")).toHaveAttribute("role", "status");
  await expect(page.locator("#shortcuts-status")).toHaveAttribute("role", "status");
});
