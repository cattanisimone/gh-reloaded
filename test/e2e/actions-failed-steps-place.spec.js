// E2E: where "Go to failed step" / "Failed steps: N" sits (#134, criteria 12 and 15):
// the first place of the order name line, subtitle line, short labels, bottom edge
// that keeps GitHub's sticky header at 80px and its text unchanged. The fixture's text
// is monospace with a fixed advance, so the places below are deterministic; they follow
// the order and the rules of the issue, not the live widths of its tables.
import { test, expect } from "./support/extension.js";
import { setup, jobPage, fsBtn, fsRoot, fsList, FS_FIXTURE, JOB_URL } from "./support/actions-logs.js";

const one = [{ n: 1, name: "Build", conclusion: "success" }, { n: 2, name: "Tests", conclusion: "failure", log: 800 }];
const two = [...one, { n: 3, name: "Lint", conclusion: "failure", log: 100 }];
const SHORT = "test (race mode)";
const LONG55 = "x".repeat(55);
const LONG61 = "x".repeat(61);
const NAME24 = "x".repeat(24);
const NAME30 = "x".repeat(30);
const LONG79 = "y".repeat(79);
const LONGSUB = { name: "z".repeat(53), sub: "failed 12 days ago in 21m 18s on a runner with a very long description tail" };

async function open(context, page, width, opts = {}, height = 900) {
  await page.setViewportSize({ width, height });
  await setup(context, { fixture: FS_FIXTURE, transform: jobPage({ steps: one, ...opts }) });
  await page.goto(JOB_URL);
  await expect(fsRoot(page)).toHaveAttribute("data-place", /.+/);
  await settle(page);
}
// The first placement can precede the page's final layout by a frame or two; the refit settles it.
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  let last = "";
  let same = 0;
  for (let i = 0; i < 60 && same < 4; i++) {
    const now = `${await fsRoot(page).getAttribute("data-place")}|${JSON.stringify(await box(fsRoot(page)))}`;
    same = now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(150);
  }
}
const place = (page) => fsRoot(page).getAttribute("data-place");

// The visible boxes of the text under a node as the reader sees it: each text node's lines cut by every ancestor that clips them (the h4's css-truncate spans, the two-line clamp) and by the title block; <relative-time> by its own box. Installed in the page before each measurement.
const VISIBLE_RECTS = (node, title) => {
  const clip = title.getBoundingClientRect();
  const out = [];
  const add = (q, from) => {
    if (!q.width || !q.height) return;
    let l = Math.max(q.left, clip.left), r = Math.min(q.right, clip.right), t = q.top, b = q.bottom;
    for (let a = from; a && a !== title; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const bb = a.getBoundingClientRect();
      l = Math.max(l, bb.left); r = Math.min(r, bb.right); t = Math.max(t, bb.top); b = Math.min(b, bb.bottom);
    }
    if (r > l && b > t) out.push({ left: l, right: r, top: t, bottom: b });
  };
  const w = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = node; n; n = w.nextNode()) {
    if (n.nodeType === 3) {
      if (!n.nodeValue.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const q of rg.getClientRects()) add(q, n.parentElement);
    } else if (n.shadowRoot) for (const q of n.getClientRects()) add(q, n);
  }
  return out;
};
const installRects = (page) => page.evaluate(`window.__visibleRects = ${VISIBLE_RECTS.toString()}`);

// GitHub's own header, as the reader sees it: its height, the covered stack, and each text's lines and visible rects.
const github = async (page) => {
  await installRects(page);
  return page.evaluate(() => {
    const h = document.querySelector('[class*="CheckRun-header"]');
    const title = h.querySelector('[class*="CheckRun-log-title"]');
    const name = [...title.querySelectorAll("#check-step-header-title, h4")].find((n) => n.getClientRects().length);
    const sub = title.querySelector("span.js-updatable-content");
    const rects = (n) => window.__visibleRects(n, title).map((q) => [Math.round(q.left), Math.round(q.top), Math.round(q.right), Math.round(q.bottom)]);
    const lines = (rs) => new Set(rs.map((q) => q[1])).size;
    const nr = rects(name), sr = rects(sub);
    return { height: h.getBoundingClientRect().height, covered: h.getBoundingClientRect().height + parseFloat(getComputedStyle(h).marginBottom), lines: [lines(nr), lines(sr)], name: JSON.stringify(nr), sub: JSON.stringify(sr) };
  });
};
// The same measurements with the control taken out of the page.
async function withoutControl(page) {
  const tag = await page.addStyleTag({ content: ".ghals-fs{display:none!important}" });
  const g = await github(page);
  await tag.evaluate((s) => s.remove());
  return g;
}
// Clearance from the control to GitHub's visible name and subtitle text, on any line: the larger of the horizontal and the vertical gap between the control and each glyph box (the text rect inset by 3px above and below), the smallest over all texts (Infinity: none). Same measure as the model's.
const nearestText = async (page) => {
  await installRects(page);
  return page.evaluate(() => {
    const c = document.querySelector(".ghals-fs").getBoundingClientRect();
    const title = document.querySelector('[class*="CheckRun-header"] [class*="CheckRun-log-title"]');
    let best = Infinity;
    const name = [...title.querySelectorAll("#check-step-header-title, h4")].find((n) => n.getClientRects().length);
    for (const n of [name, title.querySelector("span.js-updatable-content")]) {
      for (const q of window.__visibleRects(n, title)) {
        const gx = Math.max(0, c.left - q.right, q.left - c.right);
        const gy = Math.max(0, c.top - (q.bottom - 3), q.top + 3 - c.bottom);
        best = Math.min(best, Math.max(gx, gy));
      }
    }
    return best;
  });
};
const box = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });

const CASES = [
  // [title, width, options, expected place]
  ["short names at 1280 take the name line", 1280, { name: SHORT }, "name"],
  ["a 55 character name at 1280 would overflow on its own line: the subtitle line, clear of the name's end", 1280, { name: LONG55 }, "subtitle"],
  ["a 61 character name at 1280: the subtitle slot is under the name's tail, the control moves on to the edge", 1280, { name: LONG61 }, "edge"],
  ["a 79 character name at 1280 (wrapped): the subtitle slot is under the second line, the bottom edge", 1280, { name: LONG79, steps: two }, "edge"],
  ["a 24 character name at 390 takes the short label on the subtitle line", 390, { name: NAME24 }, "subtitle-short"],
  ["a 30 character name at 390: the subtitle ends 5.6px left of the slot, the control moves on to the edge", 390, { name: NAME30 }, "edge"],
  ["short names at 390: subtitle line is too tight, the short label on the name line", 390, { name: SHORT }, "name-short"],
  ["a long subtitle at 1280: the short label on the name line", 1280, LONGSUB, "name-short"],
  ["short names at 500: the name line", 500, { name: SHORT }, "name"],
  ["short names at 900: the short label on the name line", 900, { name: SHORT }, "name-short"],
  ["320: no header place fits, the bottom edge", 320, { name: SHORT }, "edge"],
  ["768 with a long subtitle: the bottom edge", 768, LONGSUB, "edge"],
];
for (const [title, width, opts, expected] of CASES) {
  test(`placement: ${title}`, async ({ context, page }) => {
    await open(context, page, width, opts);
    expect(await place(page)).toBe(expected);
    const g = await github(page);
    const r = await box(fsRoot(page));
    const base = await withoutControl(page);
    if (expected === "edge") {
      const vp = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: window.innerHeight }));
      expect(vp.w - r.right).toBeCloseTo(16, 0);
      expect(vp.h - r.bottom).toBeCloseTo(8, 0);
      expect(r.height).toBeCloseTo(28, 0);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const r2 = await box(fsRoot(page));
      expect(r2.bottom).toBeLessThanOrEqual(vp.h);
      await fsBtn(page).click();
      const lr = await box(fsList(page));
      expect(lr.bottom).toBeLessThanOrEqual(r2.top + 1);
      expect(lr.top).toBeGreaterThanOrEqual(0);
      expect(lr.left).toBeGreaterThanOrEqual(0);
      expect(lr.right).toBeLessThanOrEqual(vp.w);
      return;
    }
    // inside the sticky header, GitHub's header and text are as without the control
    expect(g.height).toBe(80);
    expect(g.covered).toBe(88);
    expect(g).toEqual(base);
    const hb = await box(page.locator('[class*="CheckRun-header"]'));
    expect(r.top).toBeGreaterThanOrEqual(hb.top);
    expect(r.bottom).toBeLessThanOrEqual(hb.bottom);
    expect(r.right).toBeLessThanOrEqual(width);
    // at least 8px from GitHub's text, on any line
    expect(await nearestText(page)).toBeGreaterThanOrEqual(7.5);
    // the label shown keeps its full accessible name
    const label = await fsBtn(page).textContent();
    if (/Go to failure|Failed: \d/.test(label)) expect(await fsBtn(page).getAttribute("aria-label")).toMatch(/^(Go to failed step|Failed steps: \d)$/);
  });
}

test("the header place is on the primary anchor on current markup, in the old and the hashed class naming", async ({ context, page }) => {
  await open(context, page, 1280, { name: SHORT });
  expect(await place(page)).toBe("name");
  expect(await fsRoot(page).evaluate((e) => e.parentElement.matches('[class*="CheckRun-header"]'))).toBe(true);
  await open(context, page, 1280, { name: SHORT, hashed: true });
  expect(await place(page)).toBe("name");
  expect(await fsRoot(page).evaluate((e) => e.parentElement.className)).toContain("CheckRun-header__x1Ab2");
});

test("a header that is not found: the start of the shortcut row, nothing else changes", async ({ context, page }) => {
  await open(context, page, 1280, { noHeader: true });
  expect(await place(page)).toBe("row");
  expect(await fsRoot(page).evaluate((e) => e.parentElement.classList.contains("ghals-row") && e.parentElement.firstElementChild === e)).toBe(true);
  await expect(fsRoot(page).locator("xpath=..")).toHaveClass(/ghals-row/);
});

test("a header with no room never falls back to the shortcut row", async ({ context, page }) => {
  await open(context, page, 320, { name: SHORT });
  expect(await place(page)).toBe("edge");
  expect(await page.locator(".ghals-row .ghals-fs").count()).toBe(0);
});

test("resize from 1280 to 768: the control leaves the name line and GitHub's text keeps its characters", async ({ context, page }) => {
  await open(context, page, 1280, LONGSUB);
  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(() => place(page)).toBe("edge");
  const g = await github(page);
  expect(g).toEqual(await withoutControl(page));
  expect(g.height).toBe(80);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => place(page)).toBe("name-short");
});

test("resize from 1280 to 390 on a short-name job: name line to the short label", async ({ context, page }) => {
  await open(context, page, 1280, { name: SHORT });
  expect(await place(page)).toBe("name");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => place(page)).toBe("name-short");
  expect((await github(page)).height).toBe(80);
});

test("the label changes: Go to failed step to Failed steps: 2 refits, never into GitHub's text", async ({ context, page }) => {
  // a job name that leaves just enough room for the short label's width on the subtitle line
  await open(context, page, 390, { name: NAME24 });
  expect(await place(page)).toBe("subtitle-short");
  await expect(fsBtn(page)).toHaveText("Go to failure");
  await page.evaluate(() => {
    const s = document.querySelector("check-step[data-number='1']");
    const c = s.cloneNode(true);
    c.dataset.number = "9"; c.dataset.name = "Late"; c.dataset.conclusion = "failure";
    c.querySelector("details").dataset.conclusion = "failure";
    c.querySelector(".CheckStep-titleName").textContent = "Late";
    s.parentElement.appendChild(c);
  });
  await expect(fsBtn(page)).toHaveText(/Failed: 2|Failed steps: 2/);
  expect((await github(page)).height).toBe(80);
  expect(await github(page)).toEqual(await withoutControl(page));
});

test("GitHub's subtitle grows by one word: the control moves on and the text keeps its line", async ({ context, page }) => {
  await open(context, page, 1280, { name: SHORT });
  expect(await place(page)).toBe("name");
  await page.evaluate(() => { const s = document.querySelector("span.js-updatable-content"); s.firstChild.textContent += " after a very long wait for a runner on the queue "; });
  await expect.poll(async () => (await github(page)).height).toBe(80);
  await page.waitForTimeout(300);
  const g = await github(page);
  expect(g).toEqual(await withoutControl(page));
  const r = await box(fsRoot(page));
  expect(r.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
});

test("light and dark give the same place", async ({ context, page }) => {
  await open(context, page, 390, { name: NAME24 });
  const light = await place(page);
  await open(context, page, 390, { name: NAME24, dark: true });
  expect(await place(page)).toBe(light);
});

test("the control stays in the window at every scroll position and does not make the header taller", async ({ context, page }) => {
  await open(context, page, 1280, { name: SHORT });
  for (const y of [0, 500, 99999]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    const r = await box(fsRoot(page));
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(900);
    expect((await github(page)).height).toBe(80);
  }
});

test("320 and 390: the open list fits the window with no horizontal scroll", async ({ context, page }) => {
  for (const width of [320, 390]) {
    await open(context, page, width, { name: SHORT, steps: [{ n: 1, name: "A very long step name that goes on and on and on for a while", conclusion: "failure", log: 100 }, { n: 2, name: "Second failed step", conclusion: "failure", log: 100 }] }, 800);
    await fsBtn(page).click();
    await expect(fsList(page)).toBeVisible();
    const lr = await box(fsList(page));
    expect(lr.left).toBeGreaterThanOrEqual(0);
    expect(lr.right).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("a relative time that grows inside its shadow root: the control refits and never meets GitHub's text", async ({ context, page }) => {
  await open(context, page, 390, { name: NAME24 });
  expect(await place(page)).toBe("subtitle-short");
  await page.evaluate(() => {
    class RT extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).textContent = "now"; } }
    customElements.define("relative-time", RT);
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector("relative-time").shadowRoot.textContent = "12 minutes ago on a long queue"; });
  await expect.poll(async () => (await place(page)) === "subtitle-short" ? await nearestText(page) : 99, { timeout: 8000 }).toBeGreaterThanOrEqual(7.5);
  expect((await github(page)).height).toBe(80);
});

// GitHub below 768px draws the name as "workflow / job" in three clipped spans of one flex h4. The job part shrinks and ends in an ellipsis: the visible text is what the reader sees, and only that counts. A control placed on a line next to it, or in the title's row, must neither touch it nor cut a character of it (#134, review of 28bd2ce).
const SPLIT_JOBS = {
  clamped: "Sqlite tests: core / DB-core:Sqlite:3.11:Core...Serialization and a long tail of job parts",
  medium: "Unit tests / linux node 20",
  short: "CI / lint",
};
for (const [kind, name] of Object.entries(SPLIT_JOBS)) {
  test(`clipped name (${kind}): at every width the control is 8px from the visible text and GitHub's text is untouched`, async ({ context, page }) => {
    test.setTimeout(90_000);
    await open(context, page, 1280, { name, split: true });
    for (const width of [320, 390, 420, 450, 500, 600, 700, 767, 768, 900, 1000, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      await settle(page);
      const p = await place(page);
      const base = await withoutControl(page);
      const g = await github(page);
      const where = `${kind} at ${width}: place ${p}`;
      if (p !== "edge") {
        expect(g.height, where).toBe(80);
        expect(g, where).toEqual(base);
        const gap = await nearestText(page);
        expect(gap, `${where}, nearest text ${gap}px`).toBeGreaterThanOrEqual(7.5);
      }
    }
  });
}

test("a clamped name wider than the title block never takes the subtitle line or the name line next to it", async ({ context, page }) => {
  // 500: the h4 is one line, its job span fills the title block up to the ellipsis, so the subtitle slot sits right under it
  await open(context, page, 500, { name: SPLIT_JOBS.clamped, split: true });
  expect(await place(page)).toBe("edge");
  await open(context, page, 450, { name: SPLIT_JOBS.clamped, split: true });
  expect(await place(page)).toBe("edge");
});

test("1024: the open list ends at its button's right edge and keeps a name that fits on one line", async ({ context, page }) => {
  const steps = [{ n: 1, name: "Print baseline diff on failure", conclusion: "failure", log: 100 }, { n: 2, name: "Tests", conclusion: "failure", log: 100 }];
  await open(context, page, 1024, { ...LONGSUB, steps });
  expect(await place(page)).toBe("edge");
  await fsBtn(page).click();
  await expect(fsList(page)).toBeVisible();
  const b = await box(fsBtn(page));
  const lr = await box(fsList(page));
  expect(lr.right, `list ${JSON.stringify(lr)} button ${JSON.stringify(b)}`).toBeCloseTo(b.right, 0);
  expect(lr.left).toBeGreaterThanOrEqual(8);
  const item = await box(fsList(page).locator('[role="menuitem"]').first());
  expect(item.height, "one line is 30px").toBeLessThan(40);
});
