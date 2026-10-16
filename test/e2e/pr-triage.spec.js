// E2E: PR triage on a repository's Pull requests page. The native list stays
// as it is; each open row gets one label saying whose move it is and a one-
// line "On this page" bar counts them. Covers: labels per role, the bar,
// anchors on current and previous class naming, no markup when an anchor is
// missing, degradation (no token, refusal, rate limit, slow response),
// rescans (filters, pages, SPA navigation, repository switch), hide and
// disable, keyboard, themes, narrow widths and native look. All names are invented.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const URL = "https://github.com/acme/web/pulls";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };

const BASE = { ok: true, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", headOid: "h2", checks: "SUCCESS", users: [], teams: [], reviews: [] };
const pr = (author, over = {}) => ({
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: "h2",
  author: { login: author },
  reviewRequests: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});
const user = (login) => ({ requestedReviewer: { __typename: "User", login } });
const team = (org, slug) => ({ requestedReviewer: { __typename: "Team", slug, organization: { login: org } } });
const rev = (login, state, oid) => ({ author: { login }, state, submittedAt: "2026-10-02T10:00:00Z", commit: { oid } });

// Signed in as mira. #412 review requested; #409 mine, sam asked for changes;
// #405 mine, waiting on sam and a team; #401 I asked for changes, new
// commits since; #398 only a team asked; #390 cannot be read.
const DATA = {
  412: pr("lee", { reviewRequests: { nodes: [user("mira")] } }),
  409: pr("mira", { latestOpinionatedReviews: { nodes: [rev("sam", "CHANGES_REQUESTED", "h1")] } }),
  405: pr("mira", { reviewRequests: { nodes: [user("sam"), team("acme", "design")] } }),
  401: pr("ana", { latestOpinionatedReviews: { nodes: [rev("mira", "CHANGES_REQUESTED", "h1")] } }),
  398: pr("ana", { reviewRequests: { nodes: [team("acme", "web-core")] } }),
  390: null,
};

function graphqlHandler(bodies = [], { data = DATA, delay } = {}) {
  return {
    match: (p) => p === "/graphql",
    json: (_u, request) => {
      const body = JSON.parse(request.postData() || "{}");
      bodies.push(body);
      const repository = {};
      for (const m of body.query.matchAll(/p(\d+): pullRequest/g)) repository[`p${m[1]}`] = data[m[1]] ?? null;
      return { data: { repository } };
    },
  };
}

async function setup(context, page, { storage = {}, tokens = TOKENS, handlers, fixture = "repo-pulls.html", transform, bodies, go = true } = {}) {
  await seedStorage(context, { ...tokens, ...storage });
  await routeApi(context, handlers || [graphqlHandler(bodies)]);
  await routeGithub(context, fixture, { transform });
  if (go) await page.goto(URL);
}

const row = (page, n) => page.locator("li", { has: page.locator(`a[href$="/pull/${n}"]`) });
const label = (page, n) => row(page, n).locator("[data-ghprt]");

test("labels each role on the native rows, rows and links unchanged", async ({ context, page }) => {
  await setup(context, page);
  await expect(label(page, 412)).toHaveText("Your turn · Review requested");
  await expect(label(page, 409)).toHaveText("Your turn · Changes requested by sam");
  await expect(label(page, 405)).toHaveText("Waiting on review · sam, @acme/design");
  await expect(label(page, 401)).toHaveText("Waiting on author · new commits since your review");
  await expect(label(page, 398)).toHaveText("Team review requested · @acme/web-core");
  await expect(label(page, 390)).toHaveText("Triage unavailable");

  const links = page.locator('a[data-testid="listitem-title-link"]');
  await expect(links).toHaveCount(6);
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual([412, 409, 405, 401, 398, 390].map((n) => `/acme/web/pull/${n}`));
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  // The label sits in the row's metadata line, next to the timestamp.
  await expect(row(page, 412).locator('[data-testid="timestamp-container"]').locator("xpath=..").locator("> [data-ghprt]")).toHaveCount(1);
  await expect(label(page, 412)).toHaveAttribute("title", "Your review was requested");
  const text = (await page.locator("main").innerText()).toLowerCase();
  expect(text).not.toMatch(/ready to merge|merge ready|unread/);
});

test("the bar counts what is on this page and each count jumps to its rows", async ({ context, page }) => {
  await setup(context, page);
  const bar = page.locator("#ghprt-bar");
  await expect(bar.locator(".ghprt-title")).toHaveText("On this page");
  await expect(bar.locator('[data-jump="yours"]')).toHaveText("2 your turn");
  await expect(bar.locator('[data-jump="waiting"]')).toHaveText("2 waiting on others");
  await expect(bar).toContainText("1 unavailable");
  // Directly before the native list, which is not moved.
  await expect(page.locator("#ghprt-bar + ul")).toHaveCount(1);

  await bar.locator('[data-jump="yours"]').click();
  await expect(row(page, 412).locator("a[data-testid=listitem-title-link]")).toBeFocused();
  await bar.locator('[data-jump="yours"]').click();
  await expect(row(page, 409).locator("a[data-testid=listitem-title-link]")).toBeFocused();
  await bar.locator('[data-jump="yours"]').click();
  await expect(row(page, 412).locator("a[data-testid=listitem-title-link]")).toBeFocused();
});

test("keyboard: Tab reaches the count buttons and Enter moves focus to the row", async ({ context, page }) => {
  await setup(context, page);
  const yours = page.locator('#ghprt-bar [data-jump="yours"]');
  await expect(yours).toBeVisible();
  await yours.focus();
  await page.keyboard.press("Enter");
  await expect(row(page, 412).locator("a[data-testid=listitem-title-link]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  // Focus ring: 2px solid #0969da at offset -2px.
  await yours.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const ring = await yours.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.outlineWidth, s.outlineStyle, s.outlineColor, s.outlineOffset];
  });
  expect(ring).toEqual(["2px", "solid", "rgb(9, 105, 218)", "-2px"]);
});

test("one label per row after rescans", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      document.querySelector("ul").append(document.createElement("li"));
      document.querySelector("ul").lastChild.remove();
    });
    await page.waitForTimeout(400);
  }
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
  expect(bodies).toHaveLength(1);
});

test("a re-render that drops the injected nodes gets them back without refetching", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await page.evaluate(() => {
    document.querySelectorAll("[data-ghprt]").forEach((e) => e.remove());
    document.getElementById("ghprt-bar").remove();
  });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
  expect(bodies).toHaveLength(1);
});

test("a filter change rescans: labels follow the new rows, counts are recomputed", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator('#ghprt-bar [data-jump="yours"]')).toHaveText("2 your turn");
  await page.evaluate(() => {
    for (const n of [409, 405, 401, 398, 390]) document.querySelector(`a[href$="/pull/${n}"]`).closest("li").remove();
  });
  await expect(page.locator('#ghprt-bar [data-jump="yours"]')).toHaveText("1 your turn");
  await expect(page.locator('#ghprt-bar [data-jump="waiting"]')).toHaveCount(0);
  expect(bodies).toHaveLength(1);
});

test("page 2 queries and counts only its own rows", async ({ context, page }) => {
  const bodies = [];
  const data = { ...DATA, 501: pr("mira", { reviewRequests: { nodes: [user("lee")] } }) };
  await setup(context, page, { handlers: [graphqlHandler(bodies, { data })] });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await page.evaluate(() => {
    const ul = document.querySelector("ul");
    const first = ul.firstElementChild.cloneNode(true);
    first.querySelector("a[data-testid=listitem-title-link]").setAttribute("href", "/acme/web/pull/501");
    first.querySelector("[data-ghprt]")?.remove();
    ul.replaceChildren(first);
    history.pushState({}, "", "/acme/web/pulls?page=2");
  });
  await expect(label(page, 501)).toHaveText("Waiting on review · lee");
  await expect(page.locator("#ghprt-bar")).toContainText("1 waiting on others");
  await expect(page.locator('#ghprt-bar [data-jump="yours"]')).toHaveCount(0);
  expect(bodies.at(-1).query).toMatch(/p501:/);
  expect(bodies.at(-1).query).not.toMatch(/p412:/);
});

test("closed and merged rows are not triaged and the bar does not appear", async ({ context, page }) => {
  await setup(context, page, {
    transform: (h) => h.replace(/aria-label="(Open|Draft) pull request"/g, 'aria-label="Closed pull request"'),
  });
  await page.waitForTimeout(800);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
});

test("Hide triage removes everything and the choice persists", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await page.getByRole("button", { name: "Hide triage" }).click();
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  await expect(page.locator("[data-ghprt-placement]")).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(800);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
});

test("disabled in Settings: no bar, no labels, no request", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { storage: { ghprtEnabled: false }, bodies });
  await page.waitForTimeout(800);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  expect(bodies).toHaveLength(0);
  // Switching it on at runtime brings it in at once; off removes it again.
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => chrome.storage.local.set({ ghprtEnabled: true }));
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await worker.evaluate(() => chrome.storage.local.set({ ghprtEnabled: false }));
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
});

test("no token: the bar says what is needed, rows get no labels, nothing is requested", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { tokens: {}, bodies });
  await expect(page.locator("#ghprt-bar")).toContainText("needs a GitHub token");
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  expect(bodies).toHaveLength(0);
  await expect(page.locator("a[data-testid=listitem-title-link]")).toHaveCount(6);
});

test("a static page rescans when the cached facts expire", async ({ context, page }) => {
  // Real time: the content script and the background each keep a 60 s cache
  // that no page clock reaches.
  test.setTimeout(120_000);
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  expect(bodies).toHaveLength(1);
  await expect.poll(() => bodies.length, { timeout: 75_000 }).toBe(2);
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
});

test("a refused request (403) is explained in the bar, no guessing on the rows", async ({ context, page }) => {
  await setup(context, page, { handlers: [{ match: (p) => p === "/graphql", status: 403, json: { message: "Resource not accessible" } }] });
  await expect(page.locator("#ghprt-bar")).toContainText("Pull requests: Read");
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
});

test("a rate limit is explained in the bar", async ({ context, page }) => {
  await setup(context, page, {
    handlers: [{ match: (p) => p === "/graphql", json: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user" }] } }],
  });
  await expect(page.locator("#ghprt-bar")).toContainText("rate limit");
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
});

test("a server error labels the rows unavailable", async ({ context, page }) => {
  await setup(context, page, { handlers: [{ match: (p) => p === "/graphql", status: 502, json: {} }] });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await expect(page.locator("[data-ghprt]").first()).toHaveText("Triage unavailable");
});

test("the list is there before the data: the bar shows Loading, then the labels arrive", async ({ context, page }) => {
  let release;
  const gate = new Promise((r) => (release = r));
  await seedStorage(context, TOKENS);
  await context.route("https://api.github.com/graphql", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    await gate;
    const repository = {};
    for (const m of body.query.matchAll(/p(\d+): pullRequest/g)) repository[`p${m[1]}`] = DATA[m[1]] ?? null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { repository } }) });
  });
  await routeGithub(context, "repo-pulls.html");
  await page.goto(URL);
  await expect(page.locator("#ghprt-bar")).toContainText("Loading review data");
  await expect(page.locator("a[data-testid=listitem-title-link]")).toHaveCount(6);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  release();
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
});

test("previous CSS-module class names work the same", async ({ context, page }) => {
  await setup(context, page, {
    transform: (h) => h.replace(/class="([^"]*)"/g, (_m, c) => `class="${c.replace(/\b([A-Za-z-]+)__[\w-]{6,}\b/g, "$1-module__$1--h4sh")}"`),
  });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
});

test("without the title-link anchor nothing is rendered, and it comes back when the anchor does", async ({ context, page }) => {
  await setup(context, page, { transform: (h) => h.replace(/data-testid="listitem-title-link"/g, 'data-x="gone"') });
  await page.waitForTimeout(1000);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  await page.evaluate(() => document.querySelectorAll("[data-x=gone]").forEach((a) => a.setAttribute("data-testid", "listitem-title-link")));
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
});

test("without the timestamp anchor a row gets no label in another container", async ({ context, page }) => {
  await setup(context, page, { transform: (h) => h.replace(/data-testid="timestamp-container"/g, 'data-x="gone"') });
  await page.waitForTimeout(1000);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
});

test("navigation: pull request and back to the list, no duplicates; another repository is fresh", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/412"));
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
  await page.evaluate(() => history.back());
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
  expect(bodies).toHaveLength(1);

  await page.evaluate(() => history.pushState({}, "", "/acme/api/pulls"));
  await expect.poll(() => bodies.length).toBe(2);
  expect(JSON.stringify(bodies[1].variables)).toContain('"repo":"api"');
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
});

test("the global pull requests page is out of scope", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies, go: false });
  await page.goto("https://github.com/pulls");
  await page.waitForTimeout(800);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  expect(bodies).toHaveLength(0);
});

test("dark theme keeps the bar and labels on dark surfaces", async ({ context, page }) => {
  await setup(context, page, { transform: (h) => h.replace('data-color-mode="light"', 'data-color-mode="dark"') });
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  const bg = await page.locator("#ghprt-bar").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(21, 27, 35)");
  const color = await label(page, 405).evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe("rgb(145, 152, 161)");
});

test("400px: no horizontal scroll", async ({ context, page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await setup(context, page);
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `scrollWidth ${sw} vs clientWidth ${cw}`).toBeLessThanOrEqual(cw);
});

test("native look: label, bar buttons, and the row's metadata line is not resized", async ({ context, page }) => {
  await setup(context, page, { storage: { ghprtEnabled: false } });
  const meta = row(page, 412).locator('[data-testid="timestamp-container"]').locator("xpath=..");
  await page.waitForTimeout(500);
  const before = await meta.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => chrome.storage.local.set({ ghprtEnabled: true }));
  await expect(label(page, 412)).toBeVisible();
  const after = await meta.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(after, `metadata line ${before}px before, ${after}px after`).toBe(before);

  const l = await label(page, 412).evaluate((el) => {
    const s = getComputedStyle(el);
    return { h: Math.round(el.getBoundingClientRect().height), r: parseFloat(s.borderTopLeftRadius), b: s.borderTopWidth, m: s.marginLeft };
  });
  expect(l.h).toBe(20);
  expect(l.r).toBeGreaterThanOrEqual(10);
  expect(l.b).toBe("1px");
  expect(l.m).toBe("4px");
  // Same spacing as the native items: 4px from the previous item, not flush.
  const gap = await label(page, 412).evaluate((el) => Math.round(el.getBoundingClientRect().left - el.previousElementSibling.getBoundingClientRect().right));
  expect(gap).toBe(4);
  const btn = await page.locator('#ghprt-bar [data-jump="yours"]').evaluate((el) => {
    const s = getComputedStyle(el);
    return { h: Math.round(el.getBoundingClientRect().height), r: s.borderTopLeftRadius, b: s.borderTopWidth, f: s.fontFamily };
  });
  expect(btn).toMatchObject({ h: 28, r: "6px", b: "1px" });
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(btn.f).toBe(bodyFont);
});

test("a token that cannot see the repository is explained in the bar, not as unavailable rows", async ({ context, page }) => {
  await setup(context, page, {
    handlers: [{ match: (p) => p === "/graphql", json: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] } }],
  });
  await expect(page.locator("#ghprt-bar")).toContainText("Pull requests: Read");
  await expect(page.locator("[data-ghprt]")).toHaveCount(0);
});

test("a token mapped only to another owner is reported as missing, not as lacking permission", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { tokens: { githubTokens: [{ id: "o", name: "o", token: "x", owner: "other-org" }] }, bodies });
  await expect(page.locator("#ghprt-bar")).toContainText("needs a GitHub token for this repository owner");
  expect(bodies).toHaveLength(0);
});
