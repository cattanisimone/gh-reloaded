// E2E: how the board dependency arrows are routed, filtered and highlighted
// (#58). The fixture board-arrows.html mirrors the live board's spacing
// (350px columns, 8px gap, 332px cards, per-column scrolling). Scenarios:
//   #2 -> #8 same column (#7 between), #2 -> #3 adjacent, #2 -> #4 three
//   columns apart, #10 -> #9 mixed (closed -> open), #4 -> #5 both closed by
//   icon and #11 -> #12 both closed by API state only (both hidden).
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const web = "https://api.github.com/repos/acme/web";
const dep = (number, state) => ({ number, state, repository_url: web });

const API = [
  { match: (p) => p === "/repos/acme/web/issues/2/dependencies/blocking", json: [dep(8, "open"), dep(3, "open"), dep(4, "closed")] },
  { match: (p) => p === "/repos/acme/web/issues/10/dependencies/blocking", json: [dep(9, "open")] },
  { match: (p) => p === "/repos/acme/web/issues/4/dependencies/blocking", json: [dep(5, "closed")] },
  { match: (p) => p === "/repos/acme/web/issues/11/dependencies/blocking", json: [dep(12, "closed")] },
  { match: (p) => p === "/repos/acme/web/issues/12/dependencies/blocked_by", json: [dep(11, "closed")] },
];

async function openBoard(context, page, { scheme, transform, api = API, count = 4 } = {}) {
  await seedStorage(context, { ghbdEnabled: true });
  await routeApi(context, api);
  await routeGithub(context, "board-arrows.html", { transform });
  await page.setViewportSize({ width: 1500, height: 900 });
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  await page.goto(BOARD_URL);
  await expect(page.locator("#ghbd-root g.ghbd-edge-group")).toHaveCount(count);
}

const edge = (page, from, to) => page.locator(`#ghbd-root g.ghbd-edge-group[data-from="acme/web#${from}"][data-to="acme/web#${to}"]`);

// Points of an edge's visible path, sampled every 2px, in viewport coordinates
// (the overlay is fixed at the viewport origin), plus the rect of every card.
async function sample(page, from, to) {
  return page.evaluate(([f, t]) => {
    const path = document.querySelector(`g.ghbd-edge-group[data-from="acme/web#${f}"][data-to="acme/web#${t}"] path.ghbd-edge`);
    const len = path.getTotalLength();
    const points = [];
    for (let l = 0; l <= len; l += 2) {
      const p = path.getPointAtLength(l);
      points.push({ x: p.x, y: p.y });
    }
    const end = path.getPointAtLength(len);
    const start = path.getPointAtLength(0);
    const rects = {};
    for (const c of document.querySelectorAll(".board-view-column-card")) {
      const r = c.getBoundingClientRect();
      rects[c.dataset.boardCardId] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }
    return { points, start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, rects };
  }, [from, to]);
}

const inside = (p, r, m = 0.5) => p.x > r.left + m && p.x < r.right - m && p.y > r.top + m && p.y < r.bottom - m;

test("hides the arrow between two closed cards, by icon or by API state, and keeps the mixed pair", async ({ context, page }) => {
  await openBoard(context, page);
  await expect(edge(page, 4, 5)).toHaveCount(0);
  await expect(edge(page, 11, 12)).toHaveCount(0);
  await expect(edge(page, 10, 9)).toHaveCount(1);
  await expect(edge(page, 2, 4)).toHaveCount(1);
});

test("a same-column arrow stays in the column's side padding and skips the card between", async ({ context, page }) => {
  await openBoard(context, page);
  const s = await sample(page, 2, 8);
  for (const p of s.points) for (const id of ["2", "7", "8"]) expect(inside(p, s.rects[id]), `point ${p.x},${p.y} inside card ${id}`).toBe(false);
  const bracketX = Math.max(...s.points.map((p) => p.x));
  expect(bracketX).toBeGreaterThan(s.rects[2].right);
  expect(bracketX).toBeLessThan(s.rects[2].right + 9);
});

test("an adjacent-column arrow touches no card but its own ends", async ({ context, page }) => {
  await openBoard(context, page);
  const s = await sample(page, 2, 3);
  for (const p of s.points) for (const [id, r] of Object.entries(s.rects)) expect(inside(p, r), `point ${p.x},${p.y} inside card ${id}`).toBe(false);
});

test("arrows start and end on the card's side, inside its height", async ({ context, page }) => {
  await openBoard(context, page);
  const s = await sample(page, 2, 3);
  expect(Math.abs(s.start.x - s.rects[2].right)).toBeLessThan(1);
  expect(Math.abs(s.end.x - s.rects[3].left)).toBeLessThan(1);
  expect(s.start.y).toBeGreaterThanOrEqual(s.rects[2].top);
  expect(s.start.y).toBeLessThanOrEqual(s.rects[2].bottom);
  expect(s.end.y).toBeGreaterThanOrEqual(s.rects[3].top);
  expect(s.end.y).toBeLessThanOrEqual(s.rects[3].bottom);
  const up = await sample(page, 10, 9);
  expect(Math.abs(up.start.x - up.rects[10].left)).toBeLessThan(1);
  expect(Math.abs(up.end.x - up.rects[9].right)).toBeLessThan(1);
});

test("a route across columns is masked under every rendered card", async ({ context, page }) => {
  await openBoard(context, page);
  const far = await sample(page, 2, 4);
  // It does run through cards of the columns in between...
  expect(far.points.some((p) => inside(p, far.rects[3]))).toBe(true);
  // ...so the mask cuts every rendered card out of the line.
  const masked = await page.evaluate(() =>
    [...document.querySelectorAll("#ghbd-root mask rect")].filter((r) => r.getAttribute("fill") === "black").map((r) => ({
      x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height"),
    }))
  );
  expect(masked).toHaveLength(Object.keys(far.rects).length);
  for (const r of Object.values(far.rects)) {
    expect(masked.some((m) => Math.abs(m.x - r.left) < 1 && Math.abs(m.y - r.top) < 1 && Math.abs(m.w - (r.right - r.left)) < 1 && Math.abs(m.h - (r.bottom - r.top)) < 1)).toBe(true);
  }
  // The vertical run sits in the gap before the target column.
  const gapX = far.rects[4].left - 13; // column padding 9 + half the 8px gap
  expect(far.points.some((p) => Math.abs(p.x - gapX) < 1.5)).toBe(true);
});

function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const hex = (rgb) => "#" + rgb.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("");

// GitHub's own surfaces: card border, column fill and page background.
const SURFACES = {
  light: ["#d1d9e0", "#f6f8fa", "#ffffff"],
  dark: ["#3d444d", "#151b23", "#0d1117"],
};
for (const scheme of ["light", "dark"]) {
  test(`arrow colours meet 3:1 against the card border, column and page (${scheme})`, async ({ context, page }) => {
    // GitHub always defines its own variables; the dark danger red it ships
    // (#f85149) is below 3:1 on the dark card border, so the fixture defines it.
    const transform = (html) =>
      html
        .replace('data-color-mode="light"', `data-color-mode="${scheme}"`)
        .replace("</style>", ":root { --fgColor-danger: " + (scheme === "dark" ? "#f85149" : "#d1242f") + "; --fgColor-muted: " + (scheme === "dark" ? "#9198a1" : "#59636e") + "; }</style>");
    await openBoard(context, page, { scheme, transform });
    const strokes = await page.evaluate(() => ({
      grey: getComputedStyle(document.querySelector("g[data-from='acme/web#10'] path.ghbd-edge")).stroke,
      red: getComputedStyle(document.querySelector("g[data-from='acme/web#2'][data-to='acme/web#3'] path.ghbd-edge")).stroke,
      head: getComputedStyle(document.querySelector("#ghbd-root .ghbd-arrowhead")).fill,
    }));
    for (const color of [strokes.grey, strokes.red, strokes.head]) {
      for (const surface of SURFACES[scheme]) expect(ratio(hex(color), surface), `${color} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
}

test("hovering a card highlights its arrows and fades the rest; leaving restores", async ({ context, page }) => {
  await openBoard(context, page);
  const card = page.locator('[data-board-card-id="2"]');
  await card.hover();
  await expect(edge(page, 2, 3)).toHaveClass(/is-active/);
  await expect(edge(page, 2, 8)).toHaveClass(/is-active/);
  await expect(edge(page, 10, 9)).toHaveClass(/is-faded/);
  await page.mouse.move(5, 5);
  await expect(page.locator("#ghbd-root .is-active, #ghbd-root .is-faded")).toHaveCount(0);
});

test("keyboard focus on a card highlights its arrows and blur restores", async ({ context, page }) => {
  await openBoard(context, page);
  await page.locator('[data-board-card-id="10"]').focus();
  await expect(edge(page, 10, 9)).toHaveClass(/is-active/);
  await expect(edge(page, 2, 3)).toHaveClass(/is-faded/);
  await page.locator('[data-board-card-id="10"]').blur();
  await expect(page.locator("#ghbd-root .is-active, #ghbd-root .is-faded")).toHaveCount(0);
});

test("redraws after a column scroll and skips an end scrolled out of its column", async ({ context, page }) => {
  await openBoard(context, page);
  await page.evaluate(() => {
    const z = document.querySelector('[data-board-column="Todo"] .column-drop-zone');
    z.style.height = "80px";
    window.dispatchEvent(new Event("resize"));
  });
  await expect(edge(page, 2, 8)).toHaveCount(0); // #8 is below the shortened viewport
  await expect(edge(page, 2, 3)).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('[data-board-column="Todo"] .column-drop-zone').scrollTop = 400;
  });
  await expect(edge(page, 2, 3)).toHaveCount(0); // #2 scrolled out: every arrow of #2 goes
  await expect(edge(page, 2, 8)).toHaveCount(0);
  await expect(edge(page, 10, 9)).toHaveCount(1); // the others stay
  await page.evaluate(() => {
    document.querySelector('[data-board-column="Todo"] .column-drop-zone').scrollTop = 0;
  });
  await expect(edge(page, 2, 3)).toHaveCount(1); // and come back on scroll
});

test("never draws to a card that is not rendered", async ({ context, page }) => {
  await openBoard(context, page);
  await page.evaluate(() => document.querySelector('[data-board-card-id="9"]').remove());
  await expect(edge(page, 10, 9)).toHaveCount(0);
});

test("anchors on the card box and sits under GitHub's overlays", async ({ context, page }) => {
  await openBoard(context, page);
  const z = await page.evaluate(() => +getComputedStyle(document.getElementById("ghbd-root")).zIndex);
  expect(z).toBeLessThan(1000);
  const s = await sample(page, 2, 3);
  expect(Math.abs(s.start.x - s.rects[2].right)).toBeLessThan(1);
});

test("a route also passes behind cards that are not linked issues", async ({ context, page }) => {
  // #3 becomes a draft item: no issue link, so it is not part of any lookup.
  const transform = (html) => html.replace('<a href="/acme/web/issues/3">', "<a>");
  await openBoard(context, page, { transform, count: 3 });
  const masked = await page.evaluate(() => {
    const c = document.querySelector('[data-board-card-id="3"]').getBoundingClientRect();
    return [...document.querySelectorAll("#ghbd-root mask rect")].some((r) => r.getAttribute("fill") === "black" && Math.abs(+r.getAttribute("x") - c.left) < 1 && Math.abs(+r.getAttribute("y") - c.top) < 1);
  });
  expect(masked).toBe(true);
});

test("opposite-direction routes in the same gap do not share a lane", async ({ context, page }) => {
  const api = [
    { match: (p) => p === "/repos/acme/web/issues/2/dependencies/blocking", json: [dep(9, "open")] },
    { match: (p) => p === "/repos/acme/web/issues/3/dependencies/blocking", json: [dep(8, "open")] },
  ];
  await openBoard(context, page, { api, count: 2 });
  const xs = await page.evaluate(() => [...document.querySelectorAll("path.ghbd-edge")].map((p) => {
    const m = p.getAttribute("d").match(/L ([\d.]+) [\d.]+ Q/);
    return m ? +m[1] : null;
  }));
  expect(xs).toHaveLength(2);
  expect(Math.abs(xs[0] - xs[1])).toBeGreaterThanOrEqual(2);
});
