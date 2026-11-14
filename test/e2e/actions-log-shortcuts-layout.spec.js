// E2E: geometry, native look, theming and stability of the Actions log
// shortcuts row (the plan's visual contract), against fixtures that mirror the live layout.
import { test, expect } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";
import { setup, row, copyBtn, openBtn, JOB_URL, RUN_URL } from "./support/actions-logs.js";

const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });

for (const width of [1500, 1100, 800]) {
  test(`${width}px: one line, right-aligned to the job box, buttons 28px, gap 8px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(context);
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    const logs = await rect(page.locator("#logs"));
    const c = await rect(copyBtn(page));
    const o = await rect(openBtn(page));
    expect(Math.abs(o.right - logs.right)).toBeLessThanOrEqual(1);
    expect(c.h).toBe(28);
    expect(o.h).toBe(28);
    expect(Math.abs(o.x - c.right - 8)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.y - c.y)).toBeLessThanOrEqual(1);
    const col = await rect(row(page));
    const parent = await rect(page.locator("#logs").locator(".."));
    expect(col.w / parent.w).toBeGreaterThanOrEqual(0.99);
  });
}

for (const width of [390, 320]) {
  test(`${width}px: one line, left-aligned, nothing overlaps, no horizontal scroll`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(context);
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    const c = await rect(copyBtn(page));
    const o = await rect(openBtn(page));
    expect(c.x).toBeCloseTo(16, 0);
    expect(Math.abs(o.y - c.y)).toBeLessThanOrEqual(1);
    expect(o.right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("a failed copy shows the command on its own line below the buttons, nothing overlaps (320px)", async ({ context, page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await setup(context);
  await page.goto(JOB_URL);
  await expect(copyBtn(page)).toBeVisible();
  const iso = await isolatedWorld(context, page);
  await iso.evaluate(`Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true }); document.execCommand = () => false; 1`);
  await copyBtn(page).click();
  await expect(page.locator(".ghals-cmd")).toBeVisible();
  const c = await rect(copyBtn(page));
  const cmd = await rect(page.locator(".ghals-cmd"));
  expect(cmd.y).toBeGreaterThanOrEqual(c.bottom);
  expect(cmd.right).toBeLessThanOrEqual(320);
  await expect(copyBtn(page)).toBeVisible();
});

test("native look: height, radius, border, padding, font, no margin", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  const s = await copyBtn(page).evaluate((e) => { const c = getComputedStyle(e); return { h: c.height, r: c.borderTopLeftRadius, bw: c.borderTopWidth, pl: c.paddingLeft, pr: c.paddingRight, fs: c.fontSize, fw: c.fontWeight, m: c.margin }; });
  expect(s).toEqual({ h: "28px", r: "6px", bw: "1px", pl: "12px", pr: "12px", fs: "12px", fw: "500", m: "0px" });
});

test("hover and pressed are darker than rest; keyboard focus ring is 2px #0969da at -2px", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  const b = copyBtn(page);
  const lum = (css) => { const m = css.match(/[\d.]+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const bg = () => b.evaluate((e) => getComputedStyle(e).backgroundColor);
  const rest = lum(await bg());
  await b.hover();
  await expect.poll(async () => lum(await bg())).toBeLessThan(rest);
  const hover = lum(await bg());
  await page.mouse.down();
  await expect.poll(async () => lum(await bg())).toBeLessThan(hover);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Tab");
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    focused = await b.evaluate((e) => e === document.activeElement);
    if (!focused) await page.keyboard.press("Tab");
  }
  expect(focused).toBe(true);
  const o = await b.evaluate((e) => { const c = getComputedStyle(e); return { w: c.outlineWidth, s: c.outlineStyle, c: c.outlineColor, off: c.outlineOffset }; });
  expect(o).toEqual({ w: "2px", s: "solid", c: "rgb(9, 105, 218)", off: "-2px" });
});

test("keyboard: Tab to Copy and Enter copies", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  await copyBtn(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ghals-msg")).toHaveText("Copied");
});

test("theme: colours follow the page's --button-default-* variables (dark, and a non-default theme)", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
  const look = () => copyBtn(page).evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, bd: c.borderTopColor }; });
  await expect.poll(look).toEqual({ bg: "rgb(33, 40, 48)", bd: "rgb(61, 68, 77)" });
  await page.evaluate(() => document.documentElement.setAttribute("data-dark-theme", "dark_dimmed"));
  await expect.poll(async () => (await look()).bg).toBe("rgb(45, 51, 59)");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--button-default-bgColor-rest").trim())).toBe("#2d333b");
});

test("run page: row above the Summary card, right edge on the card's border edge", async ({ context, page }) => {
  await setup(context, { fixture: "actions-run-failed.html" });
  await page.goto(RUN_URL);
  await expect(copyBtn(page)).toBeVisible();
  const card = await rect(page.locator(".actions-workflow-stats"));
  const c = await rect(copyBtn(page));
  expect(Math.abs(c.right - card.right)).toBeLessThanOrEqual(1);
  expect(c.bottom).toBeLessThanOrEqual(card.y);
});

test("stability: Copy and the native content do not move through a slow detection answer", async ({ context, page }) => {
  await setup(context, { delay: 3000 });
  await page.goto(JOB_URL);
  await expect(copyBtn(page)).toBeVisible();
  const before = { c: await rect(copyBtn(page)), logs: await rect(page.locator("#logs")) };
  await page.waitForTimeout(3600);
  const after = { c: await rect(copyBtn(page)), logs: await rect(page.locator("#logs")) };
  expect(Math.abs(after.c.x - before.c.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.c.y - before.c.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.logs.y - before.logs.y)).toBeLessThanOrEqual(1);
  await expect(openBtn(page)).toHaveCount(0); // a late answer is applied on the next view
});

test("the native content moves down once, by the row, and never again from in-progress to concluded", async ({ context, page }) => {
  await setup(context, { fixture: "actions-job-in-progress.html" });
  await page.goto(JOB_URL);
  await expect(row(page)).toHaveCount(1);
  const top = (await rect(page.locator("#logs"))).y;
  await page.evaluate(() => { document.querySelector(".CheckRun-header span.js-updatable-content").textContent = " failed Nov 13, 2026 in 29s "; });
  await expect(copyBtn(page)).toBeVisible();
  expect(Math.abs((await rect(page.locator("#logs"))).y - top)).toBeLessThanOrEqual(1);
});

test("a click message goes on its own line: the buttons keep their place at the job box's right edge", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(context);
  await page.goto(JOB_URL);
  await expect(openBtn(page)).toBeVisible();
  const before = await rect(openBtn(page));
  await copyBtn(page).click();
  await expect(page.locator(".ghals-msg")).toHaveText("Copied");
  const after = await rect(openBtn(page));
  expect(Math.abs(after.right - before.right)).toBeLessThanOrEqual(1);
  expect(Math.abs((await rect(page.locator("#logs"))).right - after.right)).toBeLessThanOrEqual(1);
});
