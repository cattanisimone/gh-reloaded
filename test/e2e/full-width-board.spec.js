// E2E: the full-width-board feature on a Projects board. It's a pure
// CSS-class toggle on <body> (on by default), so the main path is "the
// class is applied on a board" and the disabled state is "it isn't".
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";

test("stretches the board to full width by default", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
});

test("leaves the board alone when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghfwEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("body.ghfw-active")).toHaveCount(0);
});

// The feature's CSS (not just its JS measurement) must find the board: the
// container's own right edge sits on the window's right edge. The fixtures
// give the container no width of its own (the test pins it to 400px), so without the rules it falls short.
const expectReachesRightEdge = async (page) => {
  await page.evaluate(() => { document.querySelector('[class*="boardContainer__"], [class*="Board-module__boardContainer"]').style.width = "400px"; });
  await expect
    .poll(() => page.evaluate(() => {
      const r = document.querySelector('[class*="boardContainer__"], [class*="Board-module__boardContainer"]').getBoundingClientRect();
      return Math.abs(window.innerWidth - r.right) <= 2;
    }))
    .toBe(true);
};

test("stretches the board container to the window's right edge", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expectReachesRightEdge(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
});

test("stretches a grouped board (Group by)", async ({ context, page }) => {
  await routeGithub(context, "board-standup-grouped.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expectReachesRightEdge(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
});

test("measures the board offset next to an open slice-by panel", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("0px");
  await page.evaluate(() => {
    const panel = document.createElement("div");
    panel.className = "SlicerPanel__Cj5ISm";
    panel.style.cssText = "float:left;width:200px;height:50px";
    document.querySelector("main").prepend(panel);
    document.querySelector("main").style.paddingLeft = "200px";
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("200px");
  await page.evaluate(() => { document.querySelector('[class*="SlicerPanel__"]').style.width = "300px"; document.querySelector("main").style.paddingLeft = "300px"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("300px");
});

test("still stretches a board on the previous class naming", async ({ context, page }) => {
  await routeGithub(context, "board-legacy-classes.html");
  await page.goto(BOARD_URL);
  await expectReachesRightEdge(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
  // The old column frame class (column-frame-module__Box__) still gets the flexible sizing.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[class*="column-frame-"][class*="Box__"]')).minWidth))
    .toBe("150px");
});

test("re-applies full width after the board re-renders", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--ghfw-board-left");
    const old = document.querySelector('[class*="boardContainer__"]');
    const fresh = old.cloneNode(true);
    old.parentElement.style.paddingLeft = "40px";
    old.replaceWith(fresh);
    history.pushState({}, "", "/orgs/acme/projects/7/views/2");
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).toBe("40px");
});

test("does nothing on a Table view", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('nav[aria-label="Select view"] [aria-selected="true"] svg').setAttribute("class", "octicon octicon-table");
    history.pushState({}, "", "/orgs/acme/projects/7/views/3");
  });
  await expect(page.locator("body.ghfw-active")).toHaveCount(0);
});

// ---- Narrow windows (#59): swimlane board, real-markup fixture ----
const GROUPED_URL = `${BOARD_URL}?groupedBy%5BcolumnId%5D=Assignees`;
const SIZES = [1500, 1100, 800];
const VIEW = '[class*="boardView__"], [class*="Board-module__boardView"]';
const HEADER_ROW = '[class*="horizontalGroupHeader__"], [class*="Board-module__horizontalGroupHeader"]';
const HEADER_COLUMNS = `:is(${HEADER_ROW}) [data-board-column]`;
const AREA = '[class*="horizontalGroupAreaContainer__"], [class*="Board-module__horizontalGroupAreaContainer"]';

// Old naming: Board-module__<name>__<hash> for the layout classes the CSS lists as fallbacks.
const oldNaming = (html) => html.replace(/\b(boardView|boardContainer|horizontalGroupHeader|horizontalGroupAreaContainer|horizontalGroupContainer)__(\w+)/g, "Board-module__$1--$2");

const rects = (page, sel) => page.$$eval(sel, (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; }));

async function openGrouped(context, page, width, { url = GROUPED_URL, transform, height = 900 } = {}) {
  await routeGithub(context, "board-swimlanes.html", { transform });
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-board-left"))).not.toBe("");
  await page.waitForTimeout(300);
}

for (const w of SIZES) {
  test(`column titles stay on one line at ${w}px and the menu keeps its width`, async ({ context, page }) => {
    await openGrouped(context, page, w);
    const h2 = await rects(page, `${HEADER_COLUMNS} h2`);
    expect(h2).toHaveLength(6);
    for (const r of h2) expect(r.h).toBeLessThanOrEqual(21);
    for (const r of await rects(page, `${HEADER_COLUMNS} [class*="ColumnActions__"]`)) expect(r.w).toBe(28);
    // A title that is cut says so in its tooltip.
    const cut = await page.$$eval(`${HEADER_COLUMNS} h2`, (els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.title));
    for (const t of cut) expect(t).toMatch(/ · \d+$/);
  });

  test(`the count badge gives way before the title at ${w}px`, async ({ context, page }) => {
    await openGrouped(context, page, w);
    const info = await page.$$eval(HEADER_COLUMNS, (cols) => cols.map((c) => {
      const h2 = c.querySelector("h2"), b = c.querySelector('[class*="AggregateLabels__"]');
      return { w: h2.getBoundingClientRect().width, badge: getComputedStyle(b).display !== "none", cut: h2.scrollWidth > h2.clientWidth, title: h2.title };
    }));
    if (w === 1500) expect(info.every((i) => i.badge)).toBe(true);
    else {
      expect(info.some((i) => !i.badge)).toBe(true);
      for (const i of info) if (i.cut) expect(i.w).toBeGreaterThanOrEqual(54);
      expect(info.find((i) => !i.badge).title).toMatch(/ · \d+$/);
    }
  });

  test(`card content stays inside its border at ${w}px`, async ({ context, page }) => {
    await openGrouped(context, page, w);
    const bad = await page.evaluate(() => {
      const out = [];
      let stacks = 0;
      for (const card of document.querySelectorAll(".board-view-column-card")) {
        const cr = card.getBoundingClientRect();
        for (const el of card.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > cr.right + 0.5) out.push(el.className || el.tagName);
        }
        if (card.querySelectorAll("img.avatar").length > 1) stacks++;
      }
      const av = document.querySelector(".board-view-column-card img.avatar").getBoundingClientRect();
      return { out, stacks, av: [av.width, av.height] };
    });
    expect(bad.stacks).toBeGreaterThan(0);
    expect(bad.out).toEqual([]);
    expect(bad.av).toEqual([20, 20]);
  });

  test(`lane headers end where the columns end at ${w}px`, async ({ context, page }) => {
    await openGrouped(context, page, w);
    await expect(page.locator("body.ghfw-lane-scroll")).toHaveCount(0);
    const check = async () => {
      const last = (await rects(page, `[class*="horizontalGroupAreaContainer__"] [data-board-column]:last-child`))[0];
      const lane = (await rects(page, '[class*="styledGroupHeaderWrapper__"]'));
      for (const l of lane) expect(Math.abs(l.r - last.r)).toBeLessThanOrEqual(1);
      const head = (await rects(page, `${HEADER_COLUMNS}:last-child`))[0];
      expect(Math.abs(head.r - last.r)).toBeLessThanOrEqual(1);
    };
    await check();
    await page.evaluate((sel) => { document.querySelector(sel).scrollLeft = 1e6; }, VIEW);
    await check();
    // The board is the only horizontal scroller.
    const scrollers = await page.evaluate(() => [...document.querySelectorAll("main *")].filter((e) => { const o = getComputedStyle(e).overflowX; return (o === "auto" || o === "scroll") && e.scrollWidth > e.clientWidth + 1; }).length);
    expect(scrollers).toBeLessThanOrEqual(1);
  });

  test(`board edges match the filter bar at ${w}px`, async ({ context, page }) => {
    await openGrouped(context, page, w);
    const bar = (await rects(page, ".filterBar"))[0];
    const first = (await rects(page, `${HEADER_COLUMNS}`))[0];
    expect(Math.abs(first.l - bar.l)).toBeLessThanOrEqual(1);
    if (w === 1500) {
      const last = (await rects(page, `${HEADER_COLUMNS}:last-child`))[0];
      expect(Math.abs(last.r - bar.r)).toBeLessThanOrEqual(1);
    }
  });
}

test("columns shrink to 150px before the board scrolls sideways", async ({ context, page }) => {
  await openGrouped(context, page, 1100);
  const noScroll = () => page.$eval(VIEW, (v) => v.scrollWidth <= v.clientWidth + 1);
  expect(await noScroll()).toBe(true);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(async () => (await rects(page, `${HEADER_COLUMNS}`))[0].w).toBe(150);
  expect(await noScroll()).toBe(false);
});

test("the gutter comes from the view tabs, not from the container", async ({ context, page }) => {
  await openGrouped(context, page, 1100);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-gutter"))).toBe("16px");
});

test("board edges follow a scrollbar that appears and disappears after load", async ({ context, page }) => {
  await openGrouped(context, page, 1500, { url: `${GROUPED_URL}&classic` });
  const bar = (await rects(page, ".filterBar"))[0];
  const lastRight = async () => (await rects(page, `${HEADER_COLUMNS}:last-child`))[0].r;
  const view = await page.$eval(VIEW, (v) => v.offsetWidth - v.clientWidth);
  const tall = async (on) => page.evaluate(([sel, on]) => {
    const v = document.querySelector(sel);
    document.querySelector("#ghfw-tall")?.remove();
    if (on) { const d = document.createElement("div"); d.id = "ghfw-tall"; d.style.height = "3000px"; v.append(d); }
  }, [VIEW, on]);
  await tall(true);
  await expect.poll(() => page.$eval(VIEW, (v) => v.offsetWidth - v.clientWidth)).toBe(15);
  await expect.poll(async () => Math.abs((await lastRight()) - bar.r) <= 1).toBe(true);
  await tall(false);
  await expect.poll(() => page.$eval(VIEW, (v) => v.offsetWidth - v.clientWidth)).toBe(view);
  await expect.poll(async () => Math.abs((await lastRight()) - bar.r) <= 1).toBe(true);
});

test("widening the window brings the count badge back", async ({ context, page }) => {
  await openGrouped(context, page, 800);
  const visible = () => page.$$eval(`${HEADER_COLUMNS} [class*="AggregateLabels__"]`, (b) => b.every((x) => getComputedStyle(x).display !== "none"));
  expect(await visible()).toBe(false);
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(visible).toBe(true);
});

test("the same layout holds on the previous class naming", async ({ context, page }) => {
  await openGrouped(context, page, 800, { transform: oldNaming });
  expect(await page.$$eval(`${HEADER_COLUMNS} h2`, (e) => e.map((x) => x.getBoundingClientRect().height <= 21))).toEqual(Array(6).fill(true));
  expect(await page.locator('[class*="Board-module__boardView"]').count()).toBe(1);
  const last = (await rects(page, `:is(${AREA}) [data-board-column]:last-child`))[0];
  for (const l of await rects(page, '[class*="styledGroupHeaderWrapper__"]')) expect(Math.abs(l.r - last.r)).toBeLessThanOrEqual(1);
});

test("with a scroller per lane, headers follow their lane and keep the label visible", async ({ context, page }) => {
  await openGrouped(context, page, 800, { url: `${GROUPED_URL}&lanes=scroll` });
  await expect(page.locator("body.ghfw-lane-scroll")).toHaveCount(1);
  const r = await page.evaluate(() => {
    const sc = document.querySelector(".lane-scroll");
    sc.scrollLeft = 1e6;
    const last = sc.querySelector("[data-board-column]:last-child").getBoundingClientRect();
    const hd = sc.querySelector('[class*="styledGroupHeaderWrapper__"]').getBoundingClientRect();
    const label = sc.querySelector('[class*="groupHeaderContainer__"]').getBoundingClientRect();
    return { last: last.right, hd: hd.right, labelLeft: label.left, scLeft: sc.getBoundingClientRect().left };
  });
  expect(Math.abs(r.last - r.hd)).toBeLessThanOrEqual(1);
  expect(Math.abs(r.labelLeft - r.scLeft)).toBeLessThanOrEqual(1);
});

test("a hidden view tabs bar is not a gutter", async ({ context, page }) => {
  await openGrouped(context, page, 1100);
  await expect(page.locator("body.ghfw-gutter")).toHaveCount(1);
  await page.evaluate(() => { document.querySelector('nav[aria-label="Select view"]').style.display = "none"; });
  await expect(page.locator("body.ghfw-gutter")).toHaveCount(0);
});

test("a lane sheds its stale width once its columns shrink", async ({ context, page }) => {
  await openGrouped(context, page, 800, { url: `${GROUPED_URL}&lanes=scroll` });
  await expect(page.locator("body.ghfw-lane-scroll")).toHaveCount(1);
  await page.evaluate(() => {
    for (const sc of document.querySelectorAll(".lane-scroll")) {
      for (const c of [...sc.querySelectorAll("[data-board-column]")].slice(1)) c.remove();
    }
  });
  await expect(page.locator("body.ghfw-lane-scroll")).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('[class*="styledGroupHeaderWrapper__"]').style.getPropertyValue("--ghfw-lane-width"))).toBe("");
});

test("a long count hides the badge sooner than a short one", async ({ context, page }) => {
  await openGrouped(context, page, 1100);
  const badge = page.locator(`${HEADER_COLUMNS} [class*="AggregateLabels__"]`).nth(0);
  await expect(badge).toBeVisible();
  await page.evaluate(() => { document.querySelectorAll('[data-board-column] [class*="AggregateLabels__"]')[0].textContent = "1234567"; document.querySelectorAll('[data-board-column] h2 span')[0].textContent = "A rather long column title"; });
  await expect(badge).toBeHidden();
});

test("the gutter is the view tabs' offset, not a constant", async ({ context, page }) => {
  await routeGithub(context, "board-swimlanes.html", { transform: (h) => h.replace(".tabsContainer__UXpA4w { flex: 1; padding: 0 16px; }", ".tabsContainer__UXpA4w { flex: 1; padding: 0 40px; }").replace(".filterBar { margin: 8px 16px;", ".filterBar { margin: 8px 40px;") });
  await page.goto(GROUPED_URL);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghfw-gutter"))).toBe("40px");
  await expect.poll(async () => (await rects(page, HEADER_COLUMNS))[0].l).toBe(40);
});

test("dragging across a scrolled board reaches the column under the pointer", async ({ context, page }) => {
  await openGrouped(context, page, 800);
  await page.evaluate((sel) => { document.querySelector(sel).scrollLeft = 200; }, VIEW);
  const card = (await rects(page, ".board-view-column-card"))[0];
  await page.mouse.move(card.l + 20, card.l * 0 + (await page.$eval(".board-view-column-card", (c) => c.getBoundingClientRect().top)) + 30);
  await page.mouse.down();
  const targetBox = await page.$eval('[class*="horizontalGroupAreaContainer__"] [data-board-column]:nth-child(4) .column-drop-zone', (z) => { const r = z.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; });
  for (const f of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(card.l + (targetBox.x - card.l) * f, targetBox.y);
    const inZone = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-board-column="Waiting Review"] .column-drop-zone'), [card.l + (targetBox.x - card.l) * f, targetBox.y]).catch(() => false);
    if (f === 1) expect(inZone).toBe(true);
  }
  await page.mouse.up();
  await expect(page.locator('[class*="horizontalGroupAreaContainer__"] [data-board-column="Waiting Review"] .column-drop-zone[data-dropped]').first()).toHaveCount(1);
});

test("a non-grouped board gets the same title and edge rules", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  // Container padding no longer adds 8px in front of the board.
  await expect.poll(() => page.$eval('[class*="boardContainer__"]', (c) => getComputedStyle(c).paddingLeft)).toBe("0px");
});
