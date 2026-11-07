// E2E: the Gallery button's anchor and look, and the header behaviour by width.
// The fixtures mirror the live header probed on github.com (see fixtures/README.md);
// the signed-in Copilot / Add to space buttons come from the plan review's
// measurements, not from a live page.
import { test, expect, seedStorage } from "./support/extension.js";
import { setup, galleryButton, file } from "./support/gallery.js";

const FIXTURES = [
  { name: "PNG anonymous", fixture: "blob-image.html", url: "https://github.com/acme/web/blob/main/shots/b.png", file: "b.png" },
  { name: "PNG signed-in", fixture: "blob-image-signed.html", url: "https://github.com/acme/web/blob/main/shots/b.png", file: "b.png" },
  { name: "SVG anonymous", fixture: "blob-image-svg.html", url: "https://github.com/acme/web/blob/main/shots/c.svg", file: "c.svg" },
  { name: "SVG signed-in", fixture: "blob-image-svg-signed.html", url: "https://github.com/acme/web/blob/main/shots/c.svg", file: "c.svg" },
];
const NAMINGS = [
  ["current Box_3__hash", (h) => h],
  ["previous Box-module__Box_3--hash", (h) => h.replaceAll("Box_3__OE5Y7F", "Box-module__Box_3--s1")],
];
const WIDTHS = [1500, 1100, 800, 390];

const LIST_ERR = (re) => [{ match: re, status: 403, json: { message: "API rate limit exceeded" } }];
const BIG = Array.from({ length: 1000 }, (_, i) => file(`p${i}.png`));

// Every visible native control of the header row, plus Gallery and the notice.
function measure(page) {
  return page.evaluate(() => {
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const row = document.querySelector(".Box_1__1bJV7g");
    const g = document.querySelector('[class*="react-blob-header-edit-and-raw-actions"]').parentElement;
    const btn = document.querySelector(".ghig-btn");
    const notice = document.querySelector(".ghig-notice");
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.closest(".ghig-btn, .ghig-notice, .ghig-line, .ghig-sr") && getComputedStyle(e).visibility !== "hidden";
    };
    const found = [...row.querySelectorAll("button, a, ul[aria-label='File view'], .react-code-size-details-in-header")].filter(visible);
    // Outermost boxes only: a segmented control and its own buttons are one native block.
    const natives = found.filter((e) => !found.some((o) => o !== e && o.contains(e))).map(rect);
    const text = notice?.querySelector(".ghig-notice-text");
    return {
      natives,
      left: rect(row.querySelector(".Box_2__Is-e-Y")),
      group: rect(g),
      gallery: btn ? rect(btn) : null,
      notice: notice ? rect(notice) : null,
      noticeText: text?.textContent ?? null,
      noticeTitle: notice?.title ?? null,
      noticeTruncated: text ? text.scrollWidth > text.clientWidth : null,
      galleryInline: btn ? btn.parentElement === g : null,
      noticeInline: notice ? notice.parentElement === g : null,
      lineRight: btn?.closest(".ghig-line") ? rect(btn.closest(".ghig-line")).r : null,
      rowSW: row.scrollWidth,
      rowCW: row.clientWidth,
      pageSW: document.documentElement.scrollWidth,
      pageCW: document.documentElement.clientWidth,
    };
  });
}

const LONG = {
  "rate-limit": "Gallery unavailable: GitHub request limit reached. Try again later.",
  incomplete: "Incomplete list: GitHub returned only part of this very large folder. Some images may not appear.",
};
const overlap = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
const same = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1;

test.describe("anchor and native look", () => {
  for (const f of FIXTURES) {
    for (const [naming, transform] of NAMINGS) {
      test(`${f.name}, ${naming}: first child of the group, 8px before the first visible control, 28px high`, async ({ context, page }) => {
        await setup(context, { fixture: f.fixture, storage: { ghigAutoOpen: false }, transform });
        await page.setViewportSize({ width: 1500, height: 900 });
        await page.goto(f.url);
        await expect(galleryButton(page)).toBeVisible();
        const r = await page.evaluate(() => {
          const btn = document.querySelector(".ghig-btn");
          const group = btn.parentElement;
          const actions = group.querySelector('[class*="react-blob-header-edit-and-raw-actions"]');
          const nativeVisible = [...group.querySelectorAll("button, a")].filter((e) => e !== btn && e.getBoundingClientRect().width > 0);
          const first = nativeVisible.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
          const b = btn.getBoundingClientRect();
          const n = first.getBoundingClientRect();
          const cs = (e) => {
            const c = getComputedStyle(e);
            return { bg: c.backgroundColor, border: c.borderTopColor + c.borderTopWidth, radiusFirst: c.borderTopLeftRadius, shadow: c.boxShadow, fs: c.fontSize, fw: c.fontWeight };
          };
          const ref = group.querySelector(".prc-Button-IconButton-fyge7") || first;
          return {
            firstChild: group.firstElementChild === btn || group.firstElementChild?.id === "ghig-btn-desc",
            actionsLast: actions.parentElement === group,
            gap: n.left - b.right,
            height: b.height,
            topDelta: b.top - n.top,
            bottomDelta: b.bottom - n.bottom,
            gallery: cs(btn),
            native: cs(ref),
            width: b.width,
          };
        });
        expect(r.firstChild).toBe(true);
        expect(r.actionsLast).toBe(true);
        expect(Math.abs(r.gap - 8)).toBeLessThanOrEqual(1);
        expect(r.height).toBe(28);
        expect(Math.abs(r.topDelta)).toBeLessThanOrEqual(1);
        expect(Math.abs(r.bottomDelta)).toBeLessThanOrEqual(1);
        expect(r.gallery.bg).toBe(r.native.bg);
        expect(r.gallery.border).toBe(r.native.border);
        expect(r.gallery.shadow).toBe(r.native.shadow);
        expect(r.width).toBeGreaterThan(60); // keeps its text label
      });
    }
  }

  test("hover darkens, keyboard focus shows a 2px accent ring, and it matches in the dark theme", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false } });
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto("https://github.com/acme/web/blob/main/shots/b.png");
    const btn = galleryButton(page);
    await expect(btn).toBeVisible();
    const rest = await btn.evaluate((e) => getComputedStyle(e).backgroundColor);
    await btn.hover();
    await expect.poll(() => btn.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(rest); // after the 80ms transition
    await page.mouse.move(5, 5);
    await page.keyboard.press("Shift");
    await btn.focus();
    const ring = await btn.evaluate((e) => {
      const c = getComputedStyle(e);
      return { w: c.outlineWidth, s: c.outlineStyle, c: c.outlineColor, o: c.outlineOffset };
    });
    expect(ring).toEqual({ w: "2px", s: "solid", c: "rgb(9, 105, 218)", o: "-2px" });
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
    await page.mouse.move(5, 5);
    await btn.blur();
    await page.waitForTimeout(300); // the 80ms transition
    const dark = await page.evaluate(() => {
      const c = (e) => getComputedStyle(e);
      const b = document.querySelector(".ghig-btn");
      const n = document.querySelector(".prc-Button-IconButton-fyge7");
      return { g: c(b).backgroundColor, n: c(n).backgroundColor, gb: c(b).borderTopColor, nb: c(n).borderTopColor };
    });
    expect(dark.g).toBe(dark.n);
    expect(dark.gb).toBe(dark.nb);
  });
});

test.describe("header behaviour by width", () => {
  const log = [];
  test.afterAll(() => {
    if (process.env.GHIG_LOG_CELLS) console.log(log.join("\n"));
  });

  for (const f of FIXTURES) {
    for (const kind of ["rate-limit", "incomplete"]) {
      test(`${f.name} · ${kind}: no overlap, no scroll, native controls unmoved at 1500 / 1100 / 800 / 390`, async ({ context, page }) => {
        const api = kind === "rate-limit" ? LIST_ERR(/\/contents\//) : [{ match: /\/contents\//, json: BIG }];
        await setup(context, { fixture: f.fixture, embedded: false, api });
        for (const width of WIDTHS) {
          // Baseline with the feature off.
          await seedStorage(context, { ghigEnabled: false, ghigAutoOpen: false });
          await page.setViewportSize({ width, height: 900 });
          await page.goto(f.url);
          await page.waitForTimeout(600);
          const off = await measure(page);
          await seedStorage(context, { ghigEnabled: true });
          await expect(galleryButton(page)).toBeVisible();
          await expect(page.locator(".ghig-notice-text")).not.toHaveText("");
          await page.waitForTimeout(400);
          const on = await measure(page);

          log.push(`${f.name} · ${kind} · ${width}: gallery=${on.galleryInline ? "inline" : "line"} notice=${on.noticeInline ? "inline" : "line"} text=${on.noticeText === null ? "-" : on.noticeText === LONG[kind] ? "long" : "short"}${on.noticeTruncated ? "+ellipsis" : ""}`);

          expect(on.pageSW, `page scroll at ${width}`).toBeLessThanOrEqual(on.pageCW);
          expect(on.rowSW, `row scroll at ${width}`).toBeLessThanOrEqual(on.rowCW);
          expect(on.natives.length).toBe(off.natives.length);
          on.natives.forEach((n, i) => expect(same(n, off.natives[i]), `native ${i} moved at ${width}: ${JSON.stringify(off.natives[i])} → ${JSON.stringify(n)}`).toBe(true));
          // Gallery and the notice overlap nothing (native buttons of a button group share a border pixel by design).
          for (const ours of [on.gallery, on.notice].filter(Boolean)) {
            for (const other of [...on.natives, ...[on.gallery, on.notice].filter((b) => b && b !== ours)]) {
              expect(overlap(ours, other), `overlap at ${width}: ${JSON.stringify([ours, other])}`).toBe(false);
            }
          }
          // The drop order: a notice inline implies Gallery inline; an ellipsis only after the short text on the own line.
          if (on.noticeInline) expect(on.galleryInline).toBe(true);
          if (on.noticeTruncated) {
            expect(on.noticeInline).toBe(false);
            expect(on.noticeText).not.toBe(LONG[kind]);
          }
          if (width === 1500 && f.name.startsWith("PNG")) {
            expect(on.galleryInline && on.noticeInline && on.noticeText === LONG[kind], "PNG at 1500: inline, long text").toBe(true);
          }
          expect(on.noticeTitle).toBeTruthy();
          expect(on.gallery.w).toBeGreaterThan(60); // never icon-only
          if (width <= 767) {
            expect(on.galleryInline, "kebab shown: Gallery on its own line").toBe(false);
            expect(Math.abs(on.lineRight - on.group.r)).toBeLessThanOrEqual(1);
          }
        }
      });
    }
  }

  test("resizing 1100 → 390 → 1100 moves Gallery back inline", async ({ context, page }) => {
    await setup(context, { fixture: "blob-image.html", storage: { ghigAutoOpen: false } });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("https://github.com/acme/web/blob/main/shots/b.png");
    await expect(galleryButton(page)).toBeVisible();
    expect((await measure(page)).galleryInline).toBe(true);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect.poll(async () => (await measure(page)).galleryInline).toBe(false);
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(async () => (await measure(page)).galleryInline).toBe(true);
  });

  test("a truncated notice keeps its full text as title and as Gallery's description", async ({ context, page }) => {
    await setup(context, { fixture: "blob-image-svg-signed.html", embedded: false, api: [{ match: /\/contents\//, json: BIG }], storage: { ghigAutoOpen: false } });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("https://github.com/acme/web/blob/main/shots/c.svg");
    await expect(page.locator(".ghig-notice")).toBeVisible();
    const t = await page.evaluate(() => ({ title: document.querySelector(".ghig-notice").title, desc: document.getElementById("ghig-btn-desc").textContent }));
    expect(t.title).toContain("Incomplete list: GitHub returned only part of this very large folder");
    expect(t.desc).toBe(t.title);
  });
});
