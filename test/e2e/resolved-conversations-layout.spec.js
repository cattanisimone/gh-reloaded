// E2E: Resolved conversations, layout. The bar's edges, gap and size are
// compared with the first resolved conversation's own border box, at the
// widths of the visual contract, in light and dark. The fixture's layout
// mirrors the live column (776px at 1280, 318px at 390).
import { test, expect } from "./support/extension.js";
import { PR, bar, button, setup, measure } from "./support/resolved.js";

const SIZES = [
  { w: 1500, h: 900 },
  { w: 1280, h: 900 },
  { w: 1100, h: 900 },
  { w: 800, h: 900 },
  { w: 390, h: 800 },
  { w: 320, h: 800 },
];

for (const dark of [false, true]) {
  for (const { w, h } of SIZES) {
    test(`bar sits on the first resolved conversation's border edges, ${w}px ${dark ? "dark" : "light"}`, async ({ context, page }) => {
      await setup(context);
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`${PR}?n=7&loadmore${dark ? "&dark" : ""}`);
      await expect(bar(page)).toBeVisible();
      const m = await measure(page);
      const ctx = JSON.stringify({ w, bar: m.bar, thread: m.thread, btn: m.btn });
      expect(Math.abs(m.bar.x - m.thread.x), `left edge ${ctx}`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.bar.right - m.thread.right), `right edge ${ctx}`).toBeLessThanOrEqual(1);
      expect(m.bar.w / m.thread.w, `width share ${ctx}`).toBeGreaterThanOrEqual(0.99);
      expect(Math.abs(m.thread.y - m.bar.bottom - 16), `16px gap ${ctx}`).toBeLessThanOrEqual(1);
      // Count text starts where the thread's chevron button does (both 9px inside the border box).
      expect(Math.abs(m.glyph - m.chev.x), `glyph vs chevron ${ctx}`).toBeLessThanOrEqual(1.5);
      // One row: the button hugs its content, on the right, inside the border, one line.
      expect(m.btn.h, `button height ${ctx}`).toBeGreaterThanOrEqual(27);
      expect(m.btn.h, `button height ${ctx}`).toBeLessThanOrEqual(29);
      expect(m.radius).toBe("6px");
      expect(m.border).toBe("1px");
      expect(m.btn.right, `button inside the bar ${ctx}`).toBeLessThanOrEqual(m.bar.right - 1);
      expect(m.btnLabel.h, `button label on one line ${ctx}`).toBeLessThan(24);
      expect(m.scrollW, "no horizontal scroll").toBeLessThanOrEqual(m.innerW);
      if (w >= 800) {
        const short = await (async () => {
          await page.goto(`${PR}?n=7${dark ? "&dark" : ""}`);
          await expect(bar(page)).toBeVisible();
          return measure(page);
        })();
        expect(Math.abs(short.bar.h - 46), `bar height one row ${JSON.stringify(short.bar)}`).toBeLessThanOrEqual(2);
      }
    });
  }
}

test("at 390px only the count wraps: the long Load more copy takes several lines, the button stays one line on the right", async ({ context, page }) => {
  await setup(context);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${PR}?n=66&loadmore`);
  await expect(bar(page)).toBeVisible();
  const m = await measure(page);
  expect(m.bar.h).toBeGreaterThan(60); // the label wrapped
  expect(m.btn.h).toBeLessThanOrEqual(29);
  expect(m.btn.right).toBeLessThanOrEqual(m.bar.right - 1);
  await expect(button(page)).toHaveText("Expand loaded resolved");
});

test("the threads keep their position and width; only the bar's own height and gap are added", async ({ context, page }) => {
  for (const w of [1280, 390]) {
    await setup(context, { storage: { ghrcEnabled: false } });
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${PR}?n=5`);
    const rects = () => page.evaluate(() => [...document.querySelectorAll("review-thread-collapsible")].map((t) => { const b = t.getBoundingClientRect(); return { x: b.x, w: b.width, h: b.height }; }));
    await expect(page.locator("review-thread-collapsible")).toHaveCount(7);
    const before = await rects();
    await context.unrouteAll();
    await setup(context, { storage: { ghrcEnabled: true } });
    await page.goto(`${PR}?n=5`);
    await expect(bar(page)).toBeVisible();
    const after = await rects();
    expect(after.map(({ x, w: ww, h }) => ({ x, w: ww, h }))).toEqual(before);
  }
});

test("the button keeps Primer's native look: 28px, 6px radius, 1px border, hover and keyboard focus", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(bar(page)).toBeVisible();
  const read = () => button(page).evaluate((b) => { const s = getComputedStyle(b); return { h: b.getBoundingClientRect().height, radius: s.borderTopLeftRadius, bw: s.borderTopWidth, pad: s.paddingLeft, fs: s.fontSize, fw: s.fontWeight, bg: s.backgroundColor, outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor, offset: s.outlineOffset }; });
  const rest = await read();
  expect(rest).toMatchObject({ h: 28, radius: "6px", bw: "1px", fs: "12px", fw: "500" });
  await button(page).hover();
  await expect.poll(async () => (await read()).bg).not.toBe(rest.bg);
  await page.mouse.move(0, 0);
  await page.locator("select").focus(); // the last focusable element before the bar
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  const focus = await read();
  expect(focus.outline).toBe("solid 2px rgb(9, 105, 218)");
  expect(focus.offset).toBe("-2px");
});
