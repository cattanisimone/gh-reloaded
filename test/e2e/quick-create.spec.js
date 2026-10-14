// E2E: the quick-create feature on a Projects board. User-defined
// shortcut buttons are injected into the project's top bar, between its
// Insights/Workflows and Project details/"..." groups, or float at the
// bottom-right when that bar can't be found. Main path (a configured
// shortcut renders, in the right place, on current and previous markup),
// the floating fallback, plus the disabled state.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const SHORTCUTS = [
  { label: "New bug", url: "https://github.com/acme/web/issues/new?template=bug", icon: "issue", color: "#cf222e" },
];

// Visible text of the root's neighbours in the top bar, so a test can
// assert it sits between the two button groups.
async function neighbours(page) {
  return page.locator("#ghqc-root").evaluate((root) => ({
    parentIsBody: root.parentElement === document.body,
    before: root.previousElementSibling?.textContent.trim(),
    after: root.nextElementSibling?.textContent.trim(),
  }));
}

test("injects a configured quick-create shortcut button", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const btn = page.locator("#ghqc-root .ghqc-btn");
  await expect(btn).toHaveCount(1);
  await expect(btn).toContainText("New bug");
  await expect(btn).toHaveAttribute("href", SHORTCUTS[0].url);
});

test("places the buttons between the Insights and Project details groups", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("places the buttons in the top bar on the previous class naming", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board-legacy-classes.html");
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("finds the top bar by the Insights text when the groups are unrecognisable", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html", {
    transform: (html) => html.replaceAll('class="ButtonGroup__Mn78Op"', 'class="Group__Zz99"'),
  });
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveCount(1);
  await expect(root).not.toHaveClass(/is-floating/);
  expect(await neighbours(page)).toEqual({ parentIsBody: false, before: "InsightsWorkflows", after: "Project details⋯" });
});

test("falls back to a floating button when the top bar is missing", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html", {
    transform: (html) => html.replace(/<div class="topBarActions__[\s\S]*?\n      <\/div>/, ""),
  });
  await page.goto(BOARD_URL);

  const root = page.locator("#ghqc-root");
  await expect(root).toHaveClass(/is-floating/, { timeout: 10000 });
  await expect(root.locator(".ghqc-btn")).toContainText("New bug");
  expect((await neighbours(page)).parentIsBody).toBe(true);
  await expect(page.getByRole("button", { name: "Insights" })).toHaveCount(0);
});

test("injects nothing when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS, quickCreateEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghqc-root")).toHaveCount(0);
});

// The buttons must look like the native ones next to them: same height,
// corner radius and border width, and the top bar's own gap as the only
// spacing (an extra margin on the root doubles it).
test("matches the native buttons' size, shape and spacing", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const geo = await page.evaluate(() => {
    const root = document.getElementById("ghqc-root");
    const btn = root.querySelector(".ghqc-btn");
    const bs = getComputedStyle(btn);
    const rs = getComputedStyle(root);
    const gap = parseFloat(getComputedStyle(root.parentElement).columnGap) || 0;
    const prev = root.previousElementSibling.getBoundingClientRect();
    const next = root.nextElementSibling.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    return {
      height: btn.getBoundingClientRect().height,
      radius: bs.borderTopLeftRadius,
      border: bs.borderTopWidth,
      margins: [rs.marginLeft, rs.marginRight],
      gapBefore: Math.round(r.left - prev.right),
      gapAfter: Math.round(next.left - r.right),
      barGap: gap,
    };
  });
  expect(geo.height).toBe(32);
  expect(geo.radius).toBe("6px");
  expect(geo.border).toBe("1px");
  expect(geo.margins).toEqual(["0px", "0px"]);
  expect(geo.gapBefore).toBe(geo.barGap);
  expect(geo.gapAfter).toBe(geo.barGap);
});

// A coloured native button darkens on hover and shows Primer's focus ring on
// keyboard focus; brightening on hover looks disabled next to it.
test("darkens on hover and shows a focus ring like native coloured buttons", async ({ context, page }) => {
  await seedStorage(context, { quickCreateShortcuts: SHORTCUTS });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  const btn = page.locator("#ghqc-root .ghqc-btn");
  const brightness = () => btn.evaluate((e) => parseFloat(getComputedStyle(e).filter.replace(/[^0-9.]/g, "")) || 1);
  expect(await brightness()).toBe(1);
  await btn.hover();
  await expect.poll(brightness).toBeLessThan(1);

  await page.mouse.move(0, 0);
  await page.keyboard.press("Tab"); // first tab stop in the fixture may not be ours
  await btn.evaluate((e) => e.focus({ focusVisible: true }));
  const ring = await btn.evaluate((e) => {
    const s = getComputedStyle(e);
    return { width: s.outlineWidth, style: s.outlineStyle, offset: s.outlineOffset };
  });
  expect(ring).toEqual({ width: "2px", style: "solid", offset: "-2px" });
});

