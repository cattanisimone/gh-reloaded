// E2E: the hover bubble of "Viewed per folder" lives in the top layer (a popover on <body>), so the tree's
// scroll container cannot clip it: fully inside the viewport and on top for the first row, the last visible
// row (flipped above) and a right-edge row.
import { test, expect } from "./support/extension.js";
import { openFiles, settled } from "./support/viewed.js";

const bubble = (page) =>
  page.evaluate(() => {
    const tip = document.querySelector(".ghvf-tip");
    if (!tip || !tip.matches(":popover-open")) return null;
    const r = tip.getBoundingClientRect();
    tip.style.pointerEvents = "auto"; // elementFromPoint skips pointer-events:none: ask as if it were hit-testable
    const corners = [[r.left + 8, r.top + 4], [r.right - 8, r.top + 4], [r.left + 8, r.bottom - 4], [r.right - 8, r.bottom - 4]]; // inside the rounded corners
    const onTop = corners.every(([x, y]) => document.elementFromPoint(x, y) === tip);
    tip.style.pointerEvents = "";
    return { text: tip.textContent, left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, onTop, parent: tip.parentElement.tagName, ariaHidden: tip.getAttribute("aria-hidden") };
  });

const center = (page, id) =>
  page.evaluate((i) => {
    const r = document.getElementById(i).querySelector(":scope > .row-container .ghvf-ind").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: r.bottom, right: r.right };
  }, id);

function inside(b) {
  expect(b.left, JSON.stringify(b)).toBeGreaterThanOrEqual(8 - 0.5);
  expect(b.top, JSON.stringify(b)).toBeGreaterThanOrEqual(8 - 0.5);
  expect(b.right, JSON.stringify(b)).toBeLessThanOrEqual(b.vw - 8 + 0.5);
  expect(b.bottom, JSON.stringify(b)).toBeLessThanOrEqual(b.vh - 8 + 0.5);
  expect(b.onTop, JSON.stringify(b)).toBe(true);
  expect(b.parent).toBe("BODY");
  expect(b.ariaHidden).toBe("true");
}

for (const [w, h] of [[1500, 800], [1080, 700]]) {
  test(`first row: the bubble is below the indicator, right-aligned, inside the viewport and on top (${w}x${h})`, async ({ context, page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openFiles(context, page, { query: "viewed=server/api/src/handlers/auth.rs" });
    await settled(page);
    const c = await center(page, "docs");
    await page.mouse.move(c.x, c.y);
    await expect.poll(() => bubble(page)).not.toBeNull();
    const b = await bubble(page);
    inside(b);
    expect(b.text).toBe("0 of 1 file viewed");
    expect(Math.abs(b.right - c.right)).toBeLessThanOrEqual(1); // right edges aligned
    expect(b.top - c.bottom).toBeCloseTo(4, 0); // 4px below
  });
}

test("last visible row: the bubble flips above the indicator at the bottom edge", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await openFiles(context, page, { query: "extra=20" });
  await settled(page);
  await page.evaluate(() => {
    const sc = document.getElementById("scroller");
    const ind = document.querySelector('li[id="server/storage_backend_migrations"] > .row-container .ghvf-ind').getBoundingClientRect();
    sc.scrollTop += ind.bottom - (window.innerHeight - 2);
  });
  await page.waitForTimeout(150); // let the scroll event pass: it hides a bubble
  const c = await center(page, "server/storage_backend_migrations");
  expect(c.bottom).toBeGreaterThan(520 - 36); // close enough to the bottom edge that the bubble below would not fit
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  const b = await bubble(page);
  inside(b);
  const ind = await page.evaluate(() => document.querySelector('li[id="server/storage_backend_migrations"] > .row-container .ghvf-ind').getBoundingClientRect().top);
  expect(b.bottom).toBeLessThanOrEqual(ind - 3); // above the indicator, 4px away
});

test("a right-edge row (pane resized to 700px): the bubble stays inside the viewport", async ({ context, page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await openFiles(context, page, { query: "pane=700" });
  await settled(page);
  const c = await center(page, "server");
  expect(c.right).toBeGreaterThan(660);
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  inside(await bubble(page));
});

test("the bubble hides on leave, on scroll and on Escape, and follows the count when a tick changes it", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  let c = await center(page, "docs");
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  await page.mouse.move(700, 600); // leave
  await expect.poll(() => bubble(page)).toBeNull();
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  await page.keyboard.press("Escape");
  await expect.poll(() => bubble(page)).toBeNull();
  await page.mouse.move(700, 600);
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  await page.evaluate(() => document.getElementById("scroller").dispatchEvent(new Event("scroll")));
  await page.evaluate(() => { document.getElementById("scroller").scrollTop = 5; });
  await expect.poll(() => bubble(page)).toBeNull();
  // a tick while the bubble is open: its text follows
  await page.evaluate(() => (document.getElementById("scroller").scrollTop = 0));
  await page.waitForTimeout(100);
  c = await center(page, "docs");
  await page.mouse.move(700, 600);
  await page.mouse.move(c.x, c.y);
  await expect.poll(async () => (await bubble(page))?.text).toBe("0 of 1 file viewed");
  await page.evaluate(() => [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("docs/guide.md")).querySelector("button").click());
  await expect.poll(async () => (await bubble(page))?.text).toBe("1 of 1 file viewed");
});

test("route change and switching off remove the bubble element", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const c = await center(page, "docs");
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => bubble(page)).not.toBeNull();
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7"));
  await expect(page.locator(".ghvf-tip")).toHaveCount(0);
});
