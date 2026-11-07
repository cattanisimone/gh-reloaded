// E2E: the lightbox's look against the issue's mockups (auto-light at desktop
// width, auto-light-390 on a phone), and the never-upscale rule for SVGs that
// declare only a viewBox.
import { test, expect } from "./support/extension.js";
import { setup, dialog, counter, URL_B } from "./support/gallery.js";

const box = (loc) => loc.evaluate((e) => {
  const r = e.getBoundingClientRect();
  const c = getComputedStyle(e);
  return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, cy: r.y + r.height / 2, bg: c.backgroundColor, border: c.borderTopWidth + " " + c.borderTopStyle, radius: parseFloat(c.borderTopLeftRadius), display: c.display, fs: parseFloat(c.fontSize), fw: c.fontWeight };
});

test.describe("lightbox, desktop (mockup auto-light)", () => {
  test("header: label and GH Reloaded pill, a larger path line with the bold file name, a grey counter pill and close", async ({ context, page }) => {
    await setup(context);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    const label = await box(page.locator(".ghig-label"));
    const pill = await box(page.locator(".ghig-kicker"));
    await expect(page.locator(".ghig-label")).toHaveText("Image gallery");
    await expect(page.locator(".ghig-kicker")).toHaveText("GH Reloaded");
    expect(pill.x).toBeGreaterThan(label.r); // label first, then the pill
    expect(Math.abs(pill.cy - label.cy)).toBeLessThanOrEqual(2);
    expect(pill.border).toBe("1px solid");
    await expect(page.locator(".ghig-dir")).toHaveText("shots/");
    const where = await box(page.locator(".ghig-where"));
    const name = await box(page.locator(".ghig-name"));
    expect(where.y).toBeGreaterThan(label.b - 1); // the path is the second line
    expect(where.fs).toBeGreaterThan(label.fs);
    expect(Number(name.fw)).toBeGreaterThanOrEqual(600);
    const c = await box(counter(page));
    expect(c.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(c.radius).toBeGreaterThanOrEqual(10);
    const close = await box(page.locator(".ghig-close"));
    expect(close.x).toBeGreaterThan(c.r);
  });

  test("stage: #f6f8fa canvas, framed image, round 44px bordered previous and next at its sides", async ({ context, page }) => {
    await setup(context);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    const stage = await box(page.locator(".ghig-stage"));
    expect(stage.bg).toBe("rgb(246, 248, 250)");
    const frame = await page.locator(".ghig-img").evaluate((e) => {
      const c = getComputedStyle(e);
      return { outline: c.outlineWidth + " " + c.outlineStyle, bg: c.backgroundColor };
    });
    expect(frame.outline).toBe("1px solid");
    expect(frame.bg).toBe("rgb(255, 255, 255)");
    for (const sel of [".ghig-prev", ".ghig-next"]) {
      const b = await box(page.locator(sel));
      expect(b.w).toBe(44);
      expect(b.h).toBe(44);
      expect(b.radius).toBeGreaterThanOrEqual(22);
      expect(b.border).toBe("1px solid");
      expect(b.y).toBeGreaterThan(stage.y);
      expect(b.b).toBeLessThan(stage.b);
      expect(Math.abs(b.cy - stage.cy)).toBeLessThanOrEqual(2);
    }
    expect((await box(page.locator(".ghig-prev"))).x - stage.x).toBeLessThan(40);
    expect(stage.r - (await box(page.locator(".ghig-next"))).r).toBeLessThan(40);
  });

  test("footer: key chips for ← → and Esc, and Open file on GitHub as a bordered button with a file icon", async ({ context, page }) => {
    await setup(context);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator(".ghig-hint kbd")).toHaveText(["←", "→", "Esc"]);
    await expect(page.locator(".ghig-hint")).toHaveText("←→ to navigate · Esc to close");
    const open = await box(page.locator(".ghig-open"));
    expect(open.border).toBe("1px solid");
    expect(open.h).toBe(32);
    expect(open.radius).toBe(6);
    await expect(page.locator(".ghig-open svg")).toHaveCount(1);
    const foot = await box(page.locator(".ghig-foot"));
    expect(foot.r - open.r).toBeLessThan(24); // right side of the footer
  });

  test("dark theme: stage and frame follow the dark palette", async ({ context, page }) => {
    await setup(context, { transform: (h) => h.replace('data-color-mode="light"', 'data-color-mode="dark"') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    expect((await box(page.locator(".ghig-stage"))).bg).toBe("rgb(21, 27, 35)");
  });
});

test.describe("lightbox, 390px (mockup auto-light-390)", () => {
  test("previous, Open file on GitHub and next share the footer row; no key hint; file name only", async ({ context, page }) => {
    await setup(context);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    const prev = await box(page.locator(".ghig-prev"));
    const open = await box(page.locator(".ghig-open"));
    const next = await box(page.locator(".ghig-next"));
    const stage = await box(page.locator(".ghig-stage"));
    expect(prev.r).toBeLessThan(open.x);
    expect(open.r).toBeLessThan(next.x);
    for (const b of [prev, next]) expect(Math.abs(b.cy - open.cy)).toBeLessThanOrEqual(2);
    expect(open.y).toBeGreaterThanOrEqual(stage.b - 0.5);
    expect(Math.abs((open.x + open.w / 2) - 195)).toBeLessThanOrEqual(2); // centred
    expect(prev.w).toBe(44);
    await expect(page.locator(".ghig-hint")).toBeHidden();
    await expect(page.locator(".ghig-dir")).toBeHidden();
    await expect(page.locator(".ghig-name-full")).toHaveText("b.png");
    const dlg = await box(dialog(page));
    expect(dlg.w).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("with one image Open file on GitHub stays centred in the footer", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: /\/contents\/shots/, json: [{ name: "b.png", path: "shots/b.png", type: "file" }] }] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("1 of 1");
    const open = await box(page.locator(".ghig-open"));
    expect(Math.abs((open.x + open.w / 2) - 195)).toBeLessThanOrEqual(2);
  });
});

test.describe("never upscaled", () => {
  test("an SVG with only a viewBox renders at most at its natural size", async ({ context, page }) => {
    await setup(context);
    await context.route((u) => u.hostname === "github.com" && u.pathname.endsWith("/c.svg") && u.searchParams.get("raw") === "true", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 150"><rect width="150" height="150" fill="#09f"/></svg>' }),
    );
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".ghig-name-full")).toHaveText("c.svg");
    const img = page.locator(".ghig-img");
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
    const r = await img.evaluate((i) => ({ w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, nw: i.naturalWidth, nh: i.naturalHeight }));
    expect(r.w, JSON.stringify(r)).toBeLessThanOrEqual(r.nw + 0.5);
    expect(r.h, JSON.stringify(r)).toBeLessThanOrEqual(r.nh + 0.5);
    expect(r.w).toBeGreaterThan(0);
  });

  test("a large image is scaled down to fit without distortion", async ({ context, page }) => {
    await setup(context);
    await context.route((u) => u.hostname === "github.com" && u.pathname.endsWith("/c.svg") && u.searchParams.get("raw") === "true", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="#09f"/></svg>' }),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".ghig-name-full")).toHaveText("c.svg");
    const img = page.locator(".ghig-img");
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBe(4000);
    const r = await img.evaluate((i) => {
      const b = i.getBoundingClientRect();
      const s = i.closest(".ghig-stage").getBoundingClientRect();
      return { w: b.width, h: b.height, sw: s.width, sh: s.height };
    });
    expect(r.w).toBeLessThanOrEqual(r.sw);
    expect(r.h).toBeLessThanOrEqual(r.sh);
    expect(Math.abs(r.w / r.h - 2)).toBeLessThan(0.02);
  });
});
