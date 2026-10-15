// E2E: the dependency graph's layout and routing on the real renderer:
// edges stay out of cards, embedded and full screen agree, a refresh keeps
// the cards in place, cycles are drawn.
import { test, expect, routeGithub, routeApi } from "./support/extension.js";

const mk = (number, title) => ({
  number,
  title,
  state: "open",
  html_url: `https://github.com/acme/web/issues/${number}`,
  repository_url: "https://api.github.com/repos/acme/web",
});

// `deps`: { blocked: [blockers] }. A card with blockers answers blocked_by.
function api(children, deps, subIssues = () => children) {
  const rules = [{ match: /\/repos\/acme\/web\/issues\/1\/sub_issues/, json: subIssues }];
  for (const [n, blockers] of Object.entries(deps)) {
    rules.push({
      match: (p) => p === `/repos/acme/web/issues/${n}/dependencies/blocked_by`,
      json: () => blockers.map((b) => children.find((c) => c.number === b) || mk(b, `Task ${b}`)),
    });
  }
  return rules;
}

// 2 → 3 → 4 → 5 → 6 as a chain, plus 2 → 6 and 3 → 5 skipping columns, and 7 → 6.
const KIDS = [2, 3, 4, 5, 6, 7].map((n) => mk(n, `Task ${n}`));
const DEPS = { 3: [2], 4: [3], 5: [4, 3], 6: [5, 2, 7] };

async function geometry(scope) {
  return scope.evaluate((root) => {
    const stage = root.querySelector(".ghdg-graph-stage");
    const cards = [...stage.querySelectorAll(".ghdg-node")].map((n) => ({
      id: n.dataset.id,
      x: n.offsetLeft,
      y: n.offsetTop,
      w: n.offsetWidth,
      h: n.offsetHeight,
    }));
    const edges = [...stage.querySelectorAll("path.ghdg-edge")].map((p) => {
      const len = p.getTotalLength();
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const q = p.getPointAtLength((len * i) / 60);
        pts.push({ x: q.x, y: q.y });
      }
      return { from: p.dataset.from, to: p.dataset.to, cycle: p.classList.contains("is-cycle"), pts };
    });
    return { cards, edges, w: stage.offsetWidth, h: stage.offsetHeight };
  });
}

const columns = (cards) => {
  const cols = new Map();
  for (const c of cards) (cols.get(c.x) || cols.set(c.x, []).get(c.x)).push(c);
  return [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.sort((a, b) => a.y - b.y).map((c) => c.id));
};

test("no edge path enters a card that is not one of its ends", async ({ context, page }) => {
  await routeApi(context, api(KIDS, DEPS));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  await root.locator(".ghdg-transitive-check").uncheck(); // show the long edges too

  const g = await geometry(root);
  expect(g.edges.length).toBe(7);
  for (const e of g.edges) {
    for (const c of g.cards) {
      if (c.id === e.from || c.id === e.to) continue;
      const hit = e.pts.find((p) => p.x > c.x + 1 && p.x < c.x + c.w - 1 && p.y > c.y + 1 && p.y < c.y + c.h - 1);
      expect(hit, `edge ${e.from}->${e.to} enters card ${c.id}`).toBeUndefined();
    }
    // Nothing leaves the stage, and nothing climbs into a corridor above it.
    for (const p of e.pts) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(g.h);
    }
  }
});

test("critical cards and edges keep is-critical, laid out on one row", async ({ context, page }) => {
  await routeApi(context, api(KIDS, DEPS));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  const critical = root.locator("path.ghdg-edge.is-critical");
  const n = await critical.count();
  expect(n).toBeGreaterThan(0);
  const g = await geometry(root);
  const ids = new Set();
  for (const el of await critical.all()) {
    ids.add(await el.getAttribute("data-from"));
    ids.add(await el.getAttribute("data-to"));
  }
  const ys = g.cards.filter((c) => ids.has(c.id)).map((c) => c.y);
  expect(new Set(ys).size, `critical rows ${ys}`).toBe(1);
});

test("full screen keeps the card order of the embedded view", async ({ context, page }) => {
  await routeApi(context, api(KIDS, DEPS));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  const embedded = columns((await geometry(root)).cards);
  await root.locator(".ghdg-fs-btn").click();
  const fs = page.locator("#ghdg-fs");
  await expect(fs.locator(".ghdg-node")).toHaveCount(6);
  expect(columns((await geometry(fs)).cards)).toEqual(embedded);
});

test("a refresh with one new sub-issue leaves the other cards in place", async ({ context, page }) => {
  const extra = mk(8, "Added after load");
  let calls = 0;
  await routeApi(context, api([...KIDS, extra], { ...DEPS, 8: [4] }, () => (++calls === 1 ? KIDS : [...KIDS, extra])));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  const before = columns((await geometry(root)).cards);
  await root.locator(".ghdg-refresh-btn").click();
  await expect(root.locator(".ghdg-node")).toHaveCount(7);
  const after = columns((await geometry(root)).cards).map((c) => c.filter((id) => id !== "8"));
  expect(after).toEqual(before);
});

test("a two-card cycle renders both edges, one of them marked as a cycle", async ({ context, page }) => {
  const kids = [mk(2, "Task 2"), mk(3, "Task 3")];
  await routeApi(context, api(kids, { 3: [2], 2: [3] }));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(2);
  await expect(root.locator("path.ghdg-edge")).toHaveCount(2);
  const cycle = root.locator("path.ghdg-edge.is-cycle");
  await expect(cycle).toHaveCount(1);
  await expect(cycle.locator("title")).toHaveText("cycle");
  const g = await geometry(root);
  expect(g.edges.find((e) => e.cycle).pts.every((p) => p.y <= g.h)).toBe(true);
});

test("the alignment dropdown still changes the columns", async ({ context, page }) => {
  await routeApi(context, api(KIDS, DEPS));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  const right = columns((await geometry(root)).cards);
  await root.locator(".ghdg-align-select").first().selectOption("left");
  const left = columns((await geometry(root)).cards);
  expect(left).not.toEqual(right);
});

test("toggling alignment and back restores the same layout", async ({ context, page }) => {
  await routeApi(context, api(KIDS, DEPS));
  await routeGithub(context, "issue.html");
  await page.goto("https://github.com/acme/web/issues/1");
  const root = page.locator("#ghdg-root");
  await expect(root.locator(".ghdg-node")).toHaveCount(6);
  const first = (await geometry(root)).cards;
  await root.locator(".ghdg-align-select").first().selectOption("left");
  await root.locator(".ghdg-align-select").first().selectOption("right");
  expect((await geometry(root)).cards).toEqual(first);
});
