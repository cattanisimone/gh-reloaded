// E2E: where the Standup button and the dependency-arrows button mount on a
// Projects board (#57). They live in the filter row, left of GitHub's own
// "View" button, as native Primer buttons, and never in the view-tabs bar
// where they used to cover tabs. The filter row is found by role and
// visible text, so none of these tests depends on a CSS-module class.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const ROW = '[role="region"][aria-label="View filters"]';

async function open(context, page, opts = {}) {
  await routeApi(context, []);
  await routeGithub(context, opts.fixture || "board.html", { transform: opts.transform });
  await page.goto(BOARD_URL);
}

// Left-to-right ids of the row's visible children that matter.
const order = (page) =>
  page.evaluate((sel) => Array.from(document.querySelector(sel).children).map((c) => c.id || (c.querySelector("button")?.textContent || "").trim()), ROW);

for (const width of [800, 1100, 1500]) {
  test(`places both controls left of View without overlap at ${width}px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(context, page, {
      transform: (html) =>
        html.replace("<span>Board</span>", "<span>Board</span></div>" + Array.from({ length: 8 }, (_, i) => `<div role="tab"><span>Tab number ${i}</span></div>`).join("")),
    });
    await expect(page.locator(`${ROW} > #ghsm-enter`)).toHaveCount(1);
    await expect(page.locator(`${ROW} > #ghbd-toggle`)).toHaveCount(1);

    const r = await page.evaluate((sel) => {
      const box = (el) => el.getBoundingClientRect().toJSON();
      const row = document.querySelector(sel);
      return {
        input: box(row.querySelector("input")),
        standup: box(document.getElementById("ghsm-enter")),
        arrows: box(document.getElementById("ghbd-toggle")),
        view: box(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "View")),
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    }, ROW);
    expect(r.input.right).toBeLessThanOrEqual(r.standup.left + 0.5);
    expect(r.standup.right).toBeLessThanOrEqual(r.arrows.left + 0.5);
    expect(r.arrows.right).toBeLessThanOrEqual(r.view.left + 0.5);
    expect(r.scrollW).toBeLessThanOrEqual(r.innerW);
    // Nothing of ours is left in the view-tabs bar.
    await expect(page.locator('[class*="ViewNavigationContainer__"] #ghsm-enter, [class*="ViewNavigationContainer__"] #ghbd-toggle')).toHaveCount(0);
  });
}

test("matches the native View button: size, radius, border, fill and 8px gaps, no margins", async ({ context, page }) => {
  await open(context, page);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  const m = await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const view = Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "View");
    const st = (el) => {
      const c = getComputedStyle(el);
      return { h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width, radius: c.borderTopLeftRadius, border: c.borderTopWidth + " " + c.borderTopColor, bg: c.backgroundColor, margin: c.margin, font: c.fontFamily, size: c.fontSize, weight: c.fontWeight, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right };
    };
    return { view: st(view), standup: st(document.getElementById("ghsm-enter")), arrows: st(document.getElementById("ghbd-toggle")), rowGap: getComputedStyle(row).columnGap };
  }, ROW);
  for (const k of ["standup", "arrows"]) {
    expect(m[k].h).toBe(32);
    expect(m[k].radius).toBe(m.view.radius);
    expect(m[k].border).toBe(m.view.border);
    expect(m[k].bg).toBe(m.view.bg);
    expect(m[k].margin).toBe("0px");
  }
  expect(m.arrows.w).toBe(32);
  expect(m.standup.size).toBe("14px");
  expect(m.standup.weight).toBe("500");
  // The row's own gap spaces them: standup → arrows → View.
  expect(m.rowGap).toBe("8px");
  expect(Math.round(m.arrows.left - m.standup.right)).toBe(8);
  expect(Math.round(m.view.left - m.arrows.right)).toBe(8);
});

test("hover and pressed darken, keyboard focus draws the 2px blue ring at -2px", async ({ context, page }) => {
  await open(context, page);
  for (const id of ["#ghsm-enter", "#ghbd-toggle"]) {
    const btn = page.locator(id);
    const bg = () => btn.evaluate((e) => getComputedStyle(e).backgroundColor);
    const rest = await bg();
    await btn.hover();
    await expect.poll(bg).toBe("rgb(239, 242, 245)");
    await page.mouse.down();
    await expect.poll(bg).toBe("rgb(230, 234, 239)");
    expect(await btn.evaluate((e) => getComputedStyle(e).boxShadow)).toBe("none");
    // Release away from the button so the press is not a click (Standup would start presenting).
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await expect.poll(bg).toBe(rest);
  }
  await page.locator(`${ROW} input`).focus();
  await page.keyboard.press("Tab"); // → clear
  await page.locator("#ghsm-enter").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ring = await page.locator("#ghsm-enter").evaluate((e) => {
    const c = getComputedStyle(e);
    return [c.outlineWidth, c.outlineStyle, c.outlineColor, c.outlineOffset];
  });
  expect(ring).toEqual(["2px", "solid", "rgb(9, 105, 218)", "-2px"]);
});

test("arrows control is a pressed-state icon button with a tooltip and a label", async ({ context, page }) => {
  await open(context, page);
  const t = page.locator("#ghbd-toggle");
  await expect(t).toHaveAttribute("aria-pressed", "false");
  await expect(t).toHaveAttribute("aria-label", "Dependency arrows (experimental)");
  await expect(t).toHaveAttribute("title", /Dependency arrows \(experimental\)/);
  await expect(t).not.toHaveAttribute("role", "switch");
  await t.click();
  await expect(t).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(t).toHaveCSS("background-color", "rgb(230, 234, 239)");
  await expect(t).toHaveCSS("color", "rgb(9, 105, 218)");
  await t.hover();
  await expect(t).toHaveCSS("background-color", "rgb(239, 242, 245)");
  await t.click();
  await expect(t).toHaveAttribute("aria-pressed", "false");
});

test("orders Standup · Arrows · View, and Arrows next to View when Standup is off", async ({ context, page }) => {
  await open(context, page);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  const ids = (await order(page)).slice(-3);
  expect(ids).toEqual(["ghsm-enter", "ghbd-toggle", "View"]);
});

test("without Standup, Arrows sits directly left of View", async ({ context, page }) => {
  await seedStorage(context, { ghsmEnabled: false });
  await open(context, page);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
  expect((await order(page)).slice(-2)).toEqual(["ghbd-toggle", "View"]);
});

test("a dirty view (Discard and a divider) keeps both controls between the divider and View", async ({ context, page }) => {
  await open(context, page, {
    transform: (html) =>
      html.replace('<div class="view-options', '<div class="Box__Dd1"><button type="button">Discard</button></div><div class="Divider__Dv1" style="width:1px;background:#d1d9e0"></div><div class="view-options'),
  });
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  expect((await order(page)).slice(-5)).toEqual(["Discard", "", "ghsm-enter", "ghbd-toggle", "View"]);
});

test("moves back in front of View when the view becomes dirty after mounting", async ({ context, page }) => {
  await open(context, page);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const view = Array.from(row.children).find((c) => c.querySelector("button")?.textContent.trim() === "View");
    const d = document.createElement("div");
    d.className = "Box__Dd1";
    d.innerHTML = "<button type=button>Discard</button>";
    const v = document.createElement("div");
    v.className = "Divider__Dv1";
    row.insertBefore(d, view);
    row.insertBefore(v, view);
  }, ROW);
  await expect.poll(async () => (await order(page)).slice(-5), { timeout: 5000 }).toEqual(["Discard", "", "ghsm-enter", "ghbd-toggle", "View"]);
});

test("restores the order when Standup is placed right before View first", async ({ context, page }) => {
  await open(context, page);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  await page.evaluate(() => {
    const t = document.getElementById("ghbd-toggle");
    const s = document.getElementById("ghsm-enter");
    t.parentElement.insertBefore(t, s);
  });
  await expect.poll(async () => (await order(page)).slice(-3), { timeout: 5000 }).toEqual(["ghsm-enter", "ghbd-toggle", "View"]);
});

test("re-mounts once, with its state, after the filter row re-renders", async ({ context, page }) => {
  await seedStorage(context, { ghbdEnabled: true });
  await open(context, page);
  await expect(page.locator("#ghbd-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const fresh = row.cloneNode(true);
    fresh.querySelectorAll("#ghsm-enter, #ghbd-toggle").forEach((n) => n.remove());
    row.replaceWith(fresh);
  }, ROW);
  await expect(page.locator(`${ROW} > #ghbd-toggle`)).toHaveCount(1);
  await expect(page.locator(`${ROW} > #ghsm-enter`)).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#ghbd-toggle")).toHaveAttribute("title", /on/);
  expect((await order(page)).slice(-3)).toEqual(["ghsm-enter", "ghbd-toggle", "View"]);
});

test("Board → Table → Board removes then re-mounts one copy of each", async ({ context, page }) => {
  await open(context, page);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  const setIcon = (cls) =>
    page.evaluate((c) => {
      document.querySelector('nav[aria-label="Select view"] [aria-selected="true"] svg').setAttribute("class", c);
    }, cls);
  await setIcon("octicon octicon-table");
  await page.evaluate(() => history.pushState({}, "", "/orgs/acme/projects/7/views/2"));
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(0);
  await setIcon("octicon octicon-project");
  await page.evaluate(() => history.pushState({}, "", "/orgs/acme/projects/7"));
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
  expect((await order(page)).slice(-3)).toEqual(["ghsm-enter", "ghbd-toggle", "View"]);
  // browser back: the history entry of the Table view comes back, then forward to Board
  await setIcon("octicon octicon-table");
  await page.goBack();
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
  await setIcon("octicon octicon-project");
  await page.goForward();
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toHaveCount(1);
});

test("hides both controls while presenting and restores them on exit", async ({ context, page }) => {
  await open(context, page, { fixture: "board-standup.html" });
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("body.ghsm-active")).toHaveCount(1);
  await expect(page.locator("#ghbd-toggle")).toBeHidden();
  await expect(page.locator("#ghsm-enter")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#ghbd-toggle")).toBeVisible();
  await expect(page.locator("#ghsm-enter")).toBeVisible();
});

test("mounts nothing anywhere when the filter row is missing", async ({ context, page }) => {
  await open(context, page, { transform: (html) => html.replace(/aria-label="View filters"/g, 'aria-label="Something else"') });
  await page.waitForTimeout(1800);
  await expect(page.locator("#ghsm-enter, #ghbd-toggle")).toHaveCount(0);
});

test("mounts nothing when the View button is missing from the row", async ({ context, page }) => {
  await open(context, page, { transform: (html) => html.replace(">View</button>", ">Layout</button>") });
  await page.waitForTimeout(1800);
  await expect(page.locator("#ghsm-enter, #ghbd-toggle")).toHaveCount(0);
});

test("finds the filter row with every class renamed or stripped", async ({ context, page }) => {
  await open(context, page, { transform: (html) => html.replace(/(<div role="region"[\s\S]*?<\/div>\s*<\/div>)/, (m) => m.replace(/ class="[^"]*"/g, "")) });
  await expect(page.locator(`${ROW} > #ghbd-toggle`)).toHaveCount(1);
  await expect(page.locator(`${ROW} > #ghsm-enter`)).toHaveCount(1);
});
