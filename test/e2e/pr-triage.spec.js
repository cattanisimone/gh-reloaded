// E2E: PR triage on a repository's Pull requests page. The native list stays
// as it is; each open row gets one label saying whose move it is and a
// two-group "My PR triage" panel above the search box lists them. Covers: labels per role, the bar,
// anchors (the search landmark, no fallback container) on current and previous class naming, no markup when an anchor is
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

for (const status of [403, 429]) {
  test(`a stale ${status} response cannot hide newer page results`, async ({ context, page }) => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    let firstFinished;
    const finished = new Promise((resolve) => { firstFinished = resolve; });
    await setup(context, page, { go: false });
    await context.route("https://api.github.com/graphql", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.query.includes("p412:")) {
        firstStarted();
        await firstGate;
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message: status === 429 ? "API rate limit exceeded" : "Access denied" }) });
        firstFinished();
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { repository: { p501: pr("lee", { reviewRequests: { nodes: [user("mira")] } }) } } }) });
      }
    });
    await page.goto(URL);
    await started;
    await page.evaluate(() => {
      const first = document.querySelector('a[data-testid="listitem-title-link"][href$="/pull/412"]').closest("li");
      for (const li of [...first.parentElement.children]) if (li !== first) li.remove();
      first.querySelector('a[data-testid="listitem-title-link"]').setAttribute("href", "/acme/web/pull/501");
      history.pushState({}, "", "?page=2");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(label(page, 501)).toHaveText("Your turn · Review requested");
    releaseFirst();
    await finished;
    // Observe the settled UI across multiple scans after the stale response.
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(150);
      await expect(label(page, 501)).toHaveText("Your turn · Review requested");
      await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("1 need my action");
    }
  });
}

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

test("the header counts what is on this page and sits right before the search box", async ({ context, page }) => {
  await setup(context, page);
  const bar = page.locator("#ghprt-bar");
  await expect(bar.locator(".ghprt-title")).toHaveText("On this page");
  await expect(bar.locator(".ghprt-pill").nth(0)).toHaveText("2 need my action");
  await expect(bar.locator(".ghprt-pill").nth(1)).toHaveText("2 waiting on others");
  await expect(bar.locator(".ghprt-summary")).toContainText("1 team request · 1 unavailable");
  // Plain counts: the entries are the links, no jump buttons.
  await expect(bar.locator("[data-jump]")).toHaveCount(0);
  await expect(bar.locator(".ghprt-summary button")).toHaveCount(0);
  // Primary anchor on current markup: directly before the page's own search landmark, which is not moved.
  await expect(page.locator('#ghprt-bar + [role="search"][aria-label="Pull requests"]')).toHaveCount(1);
  await expect(page.locator('form[role="search"][aria-label="Site"]')).toHaveCount(1);
  const below = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    return { bar: y("#ghprt-bar"), search: y('[role="search"][aria-label="Pull requests"]'), list: y("ul") };
  });
  expect(below.bar).toBeLessThan(below.search);
  expect(below.search).toBeLessThan(below.list);
});

test("selected panel layout groups compact PR links and reasons above the unchanged native list", async ({ context, page }) => {
  await setup(context, page);
  const panel = page.getByRole("region", { name: "My PR triage" });
  const yours = panel.locator('[data-group="yours"]');
  const waiting = panel.locator('[data-group="waiting"]');
  await expect(yours.getByRole("heading")).toHaveText("Needs my action 2");
  await expect(waiting.getByRole("heading")).toHaveText("Waiting on others 2");
  expect(await yours.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual([
    "https://github.com/acme/web/pull/412", "https://github.com/acme/web/pull/409",
  ]);
  await expect(yours).toContainText("#412 · Review requested");
  await expect(yours).toContainText("#409 · Changes requested by sam");
  await expect(waiting).toContainText("#405 · Waiting on review");
  await expect(waiting).toContainText("#401 · Waiting on author");
  await expect(panel.locator(".ghprt-link")).toHaveCount(4);
  await expect(page.locator("ul[role=list] > li")).toHaveCount(6);
  const boxes = await panel.locator(".ghprt-group").evaluateAll((groups) => groups.map((g) => g.getBoundingClientRect().toJSON()));
  expect(boxes[0].y).toBe(boxes[1].y);
  expect(boxes[0].right).toBeLessThan(boxes[1].left);
});

test("collapse keeps counts and keyboard focus, and expansion does not refetch or change storage", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  const worker = context.serviceWorkers()[0];
  const before = await worker.evaluate(() => chrome.storage.local.get(null));
  const collapse = page.getByRole("button", { name: "Collapse panel" });
  await collapse.focus();
  await page.keyboard.press("Enter");
  const expand = page.getByRole("button", { name: "Expand panel" });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".ghprt-groups")).toBeHidden();
  await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("2 need my action");
  await page.keyboard.press("Space");
  await expect(page.locator(".ghprt-groups")).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
});

test("show more expands only the current-page shortcuts and leaves native rows untouched", async ({ context, page }) => {
  const bodies = [];
  const data = { ...DATA };
  for (let n = 501; n <= 507; n++) data[n] = pr("mira", { reviewRequests: { nodes: [user("lee")] } });
  await setup(context, page, { handlers: [graphqlHandler(bodies, { data })] });
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => {
    const ul = document.querySelector("ul");
    const source = ul.firstElementChild;
    for (let n = 501; n <= 507; n++) {
      const item = source.cloneNode(true);
      const link = item.querySelector('a[data-testid="listitem-title-link"]');
      link.href = `/acme/web/pull/${n}`;
      link.textContent = `Additional PR ${n}`;
      item.querySelector("[data-ghprt]")?.remove();
      ul.append(item);
    }
  });
  const group = page.locator('[data-group="waiting"]');
  await expect(group.locator(".ghprt-total")).toHaveText("9");
  await expect(group.locator("a")).toHaveCount(5);
  const requests = bodies.length;
  await group.getByRole("button", { name: "Show 4 more" }).click();
  await expect(group.locator("a")).toHaveCount(9);
  await expect(group.getByRole("button", { name: "Show fewer" })).toBeFocused();
  await group.getByRole("button", { name: "Show fewer" }).click();
  await expect(group.locator("a")).toHaveCount(5);
  await expect(page.locator('a[data-testid="listitem-title-link"]')).toHaveCount(13);
  expect(bodies).toHaveLength(requests);
});

test("panel updates titles and removes filtered entries without duplicate links", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => {
    document.querySelector('a[data-testid="listitem-title-link"][href$="/pull/412"]').textContent = "Renamed native title";
    document.querySelector('a[data-testid="listitem-title-link"][href$="/pull/409"]').closest("li").remove();
  });
  const group = page.locator('[data-group="yours"]');
  await expect(group.locator(".ghprt-total")).toHaveText("1");
  await expect(group.locator(".ghprt-link")).toHaveText("Renamed native title");
  await expect(page.locator(".ghprt-link")).toHaveCount(3);
});

test("unavailable data is not described as a verified empty panel", async ({ context, page }) => {
  await setup(context, page, { handlers: [graphqlHandler([], { data: {} })] });
  const panel = page.locator("#ghprt-bar");
  await expect(panel).toContainText("6 unavailable");
  await expect(panel.locator(".ghprt-empty").first()).toHaveText("None among the PRs that could be read (6 could not).");
  await expect(panel).not.toContainText("Nothing needs your action");
  await expect(panel.locator(".ghprt-link")).toHaveCount(0);
});

test("400px panel stacks groups and wraps long titles while preserving native access", async ({ context, page }) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await setup(context, page);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => {
    document.querySelector('a[data-testid="listitem-title-link"]').textContent = "A".repeat(160);
  });
  await expect(page.locator(".ghprt-link").first()).toHaveText("A".repeat(160));
  const boxes = await page.locator(".ghprt-group").evaluateAll((groups) => groups.map((g) => g.getBoundingClientRect().toJSON()));
  expect(boxes[0].bottom).toBeLessThan(boxes[1].top);
  const fits = await page.locator("#ghprt-bar").evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits).toBe(true);
  await expect(page.locator('a[data-testid="listitem-title-link"]')).toHaveCount(6);
});

test("keyboard: the panel is a named region, buttons and links show the native focus ring", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.getByRole("region", { name: "My PR triage" })).toBeVisible();
  const collapse = page.getByRole("button", { name: "Collapse panel" });
  await collapse.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hide triage" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(collapse).toBeFocused();
  // Focus ring: 2px solid #0969da at offset -2px.
  for (const target of [collapse, page.locator(".ghprt-link").first()]) {
    await target.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const ring = await target.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.outlineWidth, s.outlineStyle, s.outlineColor, s.outlineOffset];
    });
    expect(ring).toEqual(["2px", "solid", "rgb(9, 105, 218)", "-2px"]);
  }
  await page.locator(".ghprt-link").first().focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pull\/412$/);
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
  await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("2 need my action");
  await page.evaluate(() => {
    for (const n of [409, 405, 401, 398, 390]) document.querySelector(`a[data-testid="listitem-title-link"][href$="/pull/${n}"]`).closest("li").remove();
  });
  await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("1 need my action");
  await expect(page.locator("#ghprt-bar .ghprt-pill").nth(1)).toHaveText("0 waiting on others");
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
  await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("0 need my action");
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
  await expect(page.locator('#ghprt-bar + [role="search"]')).toHaveCount(1);
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
  const btn = await page.locator("#ghprt-bar .ghprt-collapse").evaluate((el) => {
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

test("the panel is built before the search landmark; without it there is no panel and no other container", async ({ context, page }) => {
  await setup(context, page, { transform: (h) => h.replace('role="search" aria-label="Pull requests"', 'aria-label="Pull requests" data-x="gone"') });
  await expect(label(page, 412)).toHaveText("Your turn · Review requested");
  await page.waitForTimeout(800);
  await expect(page.locator("#ghprt-bar")).toHaveCount(0);
  await expect(page.locator(".ghprt-group")).toHaveCount(0);
  // Not even the site search (the only other landmark) is used as a place.
  await expect(page.locator('form[role="search"] ~ #ghprt-bar, header #ghprt-bar')).toHaveCount(0);
  await page.evaluate(() => document.querySelector("[data-x=gone]").setAttribute("role", "search"));
  await expect(page.locator('#ghprt-bar + [role="search"]')).toHaveCount(1);
});

test("the native list is untouched except for our label nodes", async ({ context, page }) => {
  await setup(context, page, { storage: { ghprtEnabled: false } });
  await page.waitForTimeout(500);
  const strip = () => page.evaluate(() => {
    const clone = document.querySelector("ul[role=list]").cloneNode(true);
    clone.querySelectorAll("[data-ghprt]").forEach((e) => e.remove());
    clone.querySelectorAll("[data-ghprt-placement]").forEach((e) => e.removeAttribute("data-ghprt-placement"));
    return clone.outerHTML;
  });
  const before = await strip();
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ ghprtEnabled: true }));
  await expect(page.locator("[data-ghprt]")).toHaveCount(6);
  expect(await strip()).toBe(before);
});

test("a verified empty group says nothing needs action; an incomplete one says so", async ({ context, page }) => {
  await setup(context, page, { handlers: [graphqlHandler([], { data: { 405: pr("ana") } })], transform: (h) => h.replace(/<li class="listItem__X41oTe[\s\S]*?<\/li>/g, (m) => (/pull\/405"/.test(m) ? m : "")) });
  const panel = page.locator("#ghprt-bar");
  await expect(panel.locator('[data-group="yours"] .ghprt-empty')).toHaveText("Nothing needs your action on this page.");
  await expect(panel.locator('[data-group="waiting"] .ghprt-empty')).toHaveText("Nothing is waiting on others on this page.");
  await expect(panel).not.toContainText("could not");
});

test("collapse survives a filter change and resets in another repository", async ({ context, page }) => {
  await setup(context, page);
  await page.getByRole("button", { name: "Collapse panel" }).click();
  await expect(page.locator(".ghprt-groups")).toBeHidden();
  await page.evaluate(() => {
    document.querySelector('a[data-testid="listitem-title-link"][href$="/pull/409"]').closest("li").remove();
    history.pushState({}, "", "/acme/web/pulls?q=is%3Apr+author%3Alee");
  });
  await expect(page.locator("#ghprt-bar .ghprt-pill").first()).toHaveText("1 need my action");
  await expect(page.locator(".ghprt-groups")).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand panel" })).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => history.pushState({}, "", "/acme/api/pulls"));
  await expect(page.locator(".ghprt-groups")).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse panel" })).toHaveAttribute("aria-expanded", "true");
});

test("A to B to A: each repository gets its panel from its own cache, back and forward included", async ({ context, page }) => {
  const bodies = [];
  await setup(context, page, { bodies });
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => history.pushState({}, "", "/acme/api/pulls"));
  await expect.poll(() => bodies.length).toBe(2);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pulls"));
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  await page.evaluate(() => history.back());
  await page.evaluate(() => history.forward());
  await expect(page.locator("#ghprt-bar")).toHaveCount(1);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  expect(bodies).toHaveLength(2);
});

test("desktop: the two groups sit side by side and the buttons look native", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(context, page);
  await expect(page.locator(".ghprt-link")).toHaveCount(4);
  const hide = await page.locator(".ghprt-hide").evaluate((el) => {
    const s = getComputedStyle(el);
    return { h: Math.round(el.getBoundingClientRect().height), r: s.borderTopLeftRadius, b: s.borderTopWidth };
  });
  expect(hide).toEqual({ h: 28, r: "6px", b: "1px" });
  const box = await page.locator("#ghprt-bar").evaluate((el) => el.getBoundingClientRect().toJSON());
  const search = await page.locator('[role="search"][aria-label="Pull requests"]').evaluate((el) => el.getBoundingClientRect().toJSON());
  expect(Math.round(search.top - box.bottom), `panel ${JSON.stringify(box)} search ${JSON.stringify(search)}`).toBe(16);
});
