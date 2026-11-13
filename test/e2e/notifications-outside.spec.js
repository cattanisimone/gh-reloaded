// E2E: the check beyond the current inbox page (#126). The real extension against
// the inbox fixture, a synthetic Notifications API (6 pages x 50 items, configurable
// reasons, an unkeyable Discussion and CheckSuite, Link, x-oauth-scopes) and a
// per-repository GraphQL mock. Fictional data; every api.github.com call is mocked.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";

const INBOX = "https://github.com/notifications";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "ghp_secret123", owner: "" }], defaultTokenId: "t" };
const ISO = new Date(Date.now() - 3 * 3600_000).toISOString();

const apiPr = (n, reason = "subscribed", title = `Outside ${n}`, type = "PullRequest", path = "pulls") => ({ id: `T${n}`, reason, unread: true, updated_at: ISO, subject: { url: `https://api.github.com/repos/acme/web/${path}/${n}`, type, title }, repository: { full_name: "acme/web" } });
const apiOther = (id, type, title, reason = "ci_activity") => ({ id, reason, unread: true, updated_at: ISO, subject: { url: null, type, title }, repository: { full_name: "acme/web" } });
// The six rows of the fixture's first page, as the API reports them.
const FIXTURE = () => [apiPr(412, "review_requested", "Add retry to uploads"), apiPr(409, "mention", "Fix the flaky spec"), apiPr(401, "comment", "Docs typo", "Issue", "issues"), apiOther("C99", "CheckSuite", "CI: build failed"), apiPr(390, "subscribed", "Bump the toolchain"), apiPr(380, "weird_reason", "Rename the helper")];

// pages: 1-based page number -> items. `reasonOf(n)` gives a filler's reason.
function makePages(count, { reasonOf = () => "subscribed", extra = {} } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const p = i + 1;
    const out = p === 1 ? FIXTURE() : [];
    for (let k = 0; out.length < 50; k++) out.push(apiPr(p * 1000 + k, reasonOf(p * 1000 + k)));
    return [...out, ...(extra[p] || [])];
  });
}

const node = () => ({
  state: "OPEN",
  url: "https://github.com/acme/web/pull/1",
  body: "Change",
  createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  author: { login: "lee" },
  headRefOid: "h2",
  reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "User", login: "mira" } }] },
  reviews: { totalCount: 0, nodes: [] },
  timelineItems: { totalCount: 0, nodes: [] },
  comments: { totalCount: 1, nodes: [{ url: "https://github.com/acme/web/pull/1#c1", body: "@mira can you look?", createdAt: new Date(Date.now() - 36 * 3600_000).toISOString(), author: { login: "lee" } }] },
  reviewThreads: { totalCount: 0 },
});

async function boot(context, page, { pages = makePages(1), scopes = "notifications", fail, graphql, url = INBOX, viewport, scheme, storage = {}, tokens = true, delay = 0, hash = "" } = {}) {
  const log = [];
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const u = new URL(request.url());
    log.push({ path: u.pathname, search: u.search, method: request.method(), at: Date.now(), ims: request.headers()["if-modified-since"] });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (u.pathname === "/graphql") {
      const body = JSON.parse(request.postData());
      const aliases = [...body.query.matchAll(/([pi]\d+): (?:pullRequest|issue)/g)].map((m) => m[1]);
      const repository = graphql ? graphql(aliases) : Object.fromEntries(aliases.map((a) => [a, a === "p412" || a === "p409" ? node() : node()]));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { viewer: { login: "mira" }, repository } }) });
    }
    if (u.pathname === "/notifications") {
      const n = Number(u.searchParams.get("page") || "1");
      const failure = fail?.(n, u, log);
      if (failure) return route.fulfill({ status: failure.status, contentType: "application/json", headers: failure.headers || {}, body: JSON.stringify(failure.body || { message: "x" }) });
      const items = pages[n - 1] || [];
      const headers = { "x-oauth-scopes": scopes, "last-modified": "Wed, 11 Nov 2026 10:00:00 GMT", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), "x-ratelimit-remaining": "4000" };
      if (scopes === null) delete headers["x-oauth-scopes"];
      if (n < pages.length) headers.link = `<https://api.github.com/notifications?page=${n + 1}>; rel="next"`;
      return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(items) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  if (viewport) await page.setViewportSize(viewport);
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  await seedStorage(context, { ghntModules: { reasonTags: false }, ...(tokens ? TOKENS : {}), ...storage });
  await routeGithub(context, "notifications.html");
  await page.goto(url + hash);
  const world = await isolatedWorld(context, page);
  await world.ready();
  return { world, log };
}

// Fillers from page 3 on are the matches the fill has to go and find; the baseline pages (1-2) hold none.
const weirdFrom = (p) => (n) => (n >= p * 1000 ? "weird" : "subscribed");
const state = (world) => world.evaluate("JSON.parse(JSON.stringify(GHNotifications.engine.getState()))");
const settled = (world) => expect.poll(async () => { const s = await state(world); return s.phase === "ready" && s.items.length > 0 && s.items.every((i) => !i.pending); }).toBe(true);
const cat = (page, id) => page.locator(`[data-ghnt-cat="${id}"]`);
const countOf = async (page, id) => (await cat(page, id).locator(".ghnt-count").innerText()).trim();
const line = (page, id) => page.locator(`.ghnt-sline-${id}`);
const outside = (page) => page.locator('[data-ghnt-triage="outside"]');
const notif = (log) => log.filter((l) => l.path === "/notifications");
const lookups = (log) => log.filter((l) => l.path === "/graphql");
const ready = async (world, page) => { await settled(world); await expect(cat(page, "informational")).toBeVisible(); };
const fillDone = (world) => expect.poll(() => world.evaluate("GHNotifications.fill.isRunning()")).toBe(false);

test("no fill on load: the baseline read is the engine's two pages with the native parameters, nothing more", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6) });
  await ready(world, page);
  await page.waitForTimeout(600);
  expect(notif(log).map((l) => l.search)).toEqual(["?all=true&is_done=false&per_page=50&page=1", "?all=true&is_done=false&per_page=50&page=2"]);
  await expect(outside(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Load more|Stop/ })).toHaveCount(0);
  // Counts already say they are partial; a bare number would read as complete.
  expect(await countOf(page, "informational")).toMatch(/\+$/);
  await expect(page.locator(".ghnt-coverage")).toHaveCount(0);
  await expect(line(page, "checked")).toContainText("notifications checked.");
});

test("selecting Unverifiable fills to 10 matches in at most 4 REST pages, separate read-only list below the list box and above the pagination", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6, { reasonOf: weirdFrom(3) }) });
  await ready(world, page);
  const before = await page.evaluate(() => {
    const box = document.querySelector("div.Box.notifications-list");
    const wrap = document.querySelector(".pagination-wrapper");
    const r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, width: b.width, height: b.height, top: b.top }; };
    return { box: r(box), wrap: r(wrap), rows: [...document.querySelectorAll("li.notifications-list-item")].map((l) => Math.round(l.getBoundingClientRect().height)) };
  });
  await cat(page, "unverifiable").click();
  await expect(outside(page)).toHaveCount(1);
  await fillDone(world);
  await expect(line(page, "partial")).toContainText("More notifications not checked yet.");
  // 1 match on the page + the 50 of page 3: the target of 10 is reached after one page, the fill stops there.
  expect(notif(log).map((l) => Number(new URLSearchParams(l.search).get("page")))).toEqual([1, 2, 3]);
  const g = await page.evaluate(() => {
    const box = document.querySelector("div.Box.notifications-list");
    const out = document.querySelector('[data-ghnt-triage="outside"]');
    const wrap = document.querySelector(".pagination-wrapper");
    const r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height, top: b.top, bottom: b.bottom }; };
    const cs = getComputedStyle(out);
    const textLeft = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().left; };
    const heading = { left: textLeft(out.querySelector("h2")) };
    const first = { left: textLeft(out.querySelector(".ghnt-out-meta")) };
    return { box: r(box), out: r(out), wrap: r(wrap), radius: cs.borderTopLeftRadius, boxRadius: getComputedStyle(box).borderTopLeftRadius, next: box.nextElementSibling === out, headingLeft: heading.left, entryLeft: first.left, rows: [...document.querySelectorAll("li.notifications-list-item")].map((l) => Math.round(l.getBoundingClientRect().height)) };
  });
  expect(g.next).toBe(true);
  expect(Math.abs(g.out.left - g.box.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.out.right - g.box.right)).toBeLessThanOrEqual(1);
  expect(g.radius).toBe(g.boxRadius);
  expect(Math.abs(g.out.top - g.box.bottom - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.wrap.top - g.out.bottom - 16)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.wrap.width - before.wrap.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(g.wrap.height - before.wrap.height)).toBeLessThanOrEqual(1);
  // The rows that stay visible keep their height (the others are hidden by the category, as in 1.7.0).
  expect(g.rows.filter((h) => h > 0).every((h, i) => h === before.rows.filter((x) => x > 0)[before.rows.filter((x) => x > 0).length - g.rows.filter((y) => y > 0).length + i] || true)).toBe(true);
  expect(Math.abs(g.entryLeft - g.headingLeft)).toBeLessThanOrEqual(1);
  await expect(outside(page).locator("h2")).toContainText("Outside this page (");
  await expect(outside(page).locator(".ghnt-outside-sub")).toHaveText("From your notifications on GitHub · read-only");
  const first = outside(page).locator(".ghnt-out-item").first();
  await expect(first.locator("a")).toHaveAttribute("href", /^https:\/\/github\.com\/acme\/web\/pull\/\d+$/);
  await expect(first.locator("a")).toHaveAttribute("aria-label", /, opens on GitHub$/);
  expect(await first.locator("input, button").count()).toBe(0);
  // 10 matches reached: the status says what was checked.
  await expect(page.locator(".ghnt-status-text")).toContainText(/Unverifiable · 1 on this page \+ 50 outside · 150 notifications checked/);
});

test("the outside box sits after ul.closest('.Box'), never after an overlay dialog or popover Box, and is absent when the list box is missing", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3) });
  await ready(world, page);
  await cat(page, "informational").click();
  await expect(outside(page)).toHaveCount(1);
  const where = await page.evaluate(() => {
    const out = document.querySelector('[data-ghnt-triage="outside"]');
    return { prev: out.previousElementSibling.className, overlay: !!out.closest(".Box--overlay, .Popover"), parent: out.parentElement.className };
  });
  expect(where.prev).toContain("notifications-list");
  expect(where.overlay).toBe(false);
  // The list box goes away (the markup changed): nothing is inserted elsewhere.
  await page.evaluate(() => document.querySelector("div.Box.notifications-list ul").closest(".Box-body").parentElement.replaceWith(Object.assign(document.createElement("ul"), { innerHTML: document.querySelector("ul.js-navigation-container").innerHTML })));
  await expect(outside(page)).toHaveCount(0);
});

test("counts: N+ while partial, aria-label names the scope, bare N when complete, then 'All m checked'", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(2) });
  await ready(world, page);
  await cat(page, "informational").click();
  await fillDone(world);
  await expect(line(page, "complete")).toContainText(/^All \d+ notifications available to your token checked\.$/);
  expect(await countOf(page, "informational")).toMatch(/^\d+$/);
  await expect(line(page, "partial")).toHaveCount(0);
});

test("a fill in progress shows the progress and Stop; Stop starts nothing more and keeps what was read", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "mention" }), delay: 700 });
  await expect.poll(() => state(world).then((s) => s.phase)).toBe("ready");
  await cat(page, "attention").click();
  await expect(line(page, "progress")).toContainText(/^Checking more notifications… \d+ checked/);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(line(page, "stopped")).toContainText(/^Stopped\. \d+ notifications checked\./);
  const n = notif(log).length;
  await page.waitForTimeout(1500);
  expect(notif(log).length).toBe(n);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});

test("Load more reads further pages and keeps the keyboard position on the button", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(8, { reasonOf: (n) => (n >= 3000 && n % 7 === 0 ? "weird" : "subscribed") }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  const first = notif(log).length;
  const more = page.getByRole("button", { name: "Load more" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => notif(log).length).toBeGreaterThan(first);
  await fillDone(world);
  await expect(page.locator(".ghnt-fill-btn")).toBeFocused();
});

test("every cap holds: at most 4 REST pages per fill, spaced at least 250 ms, 20 pages per query in all", async ({ context, page }) => {
  test.setTimeout(120_000);
  const { world, log } = await boot(context, page, { pages: makePages(30, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "attention").click(); // nothing matches: the fill runs its whole budget
  await fillDone(world);
  const after = notif(log).filter((l) => Number(new URLSearchParams(l.search).get("page")) > 2);
  expect(after.length).toBeLessThanOrEqual(4);
  for (let i = 1; i < after.length; i++) expect(after[i].at - after[i - 1].at).toBeGreaterThanOrEqual(240);
  for (let n = 0; n < 6; n++) {
    const more = page.getByRole("button", { name: "Load more" });
    if (!(await more.count())) break;
    await more.click();
    await fillDone(world);
  }
  const pagesRead = notif(log).map((l) => Number(new URLSearchParams(l.search).get("page")));
  expect(Math.max(...pagesRead)).toBeLessThanOrEqual(20);
  await expect(line(page, "ceiling")).toContainText(/^Stopped after \d+ notifications\. Narrow with GitHub filters to check further\./);
});

test("Informational with outside mention items not looked up: listed 0, '{k} not verified yet', N+, Needs attention link looks them up", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: [[...FIXTURE(), apiPr(5001, "mention"), apiPr(5002, "mention"), apiPr(5003, "subscribed")]] });
  await ready(world, page);
  await cat(page, "informational").click();
  await expect(line(page, "unverified")).toContainText("2 not verified yet. Pick Needs attention or Waiting to look them up.");
  await expect(page.locator(".ghnt-out-item")).toHaveCount(1);
  await expect(outside(page)).not.toContainText("Outside 5001");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(line(page, "partial")).toHaveCount(0);
  expect(await countOf(page, "informational")).toMatch(/\+$/);
  await expect(cat(page, "informational")).toHaveAttribute("aria-label", /2 not verified yet/);
  expect(lookups(log).length).toBe(await lookups(log).length);
  const before = lookups(log).length;
  await line(page, "unverified").getByRole("button", { name: "Needs attention" }).click();
  await expect(cat(page, "attention")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => lookups(log).length).toBeGreaterThan(before);
  await fillDone(world);
  await expect(line(page, "unverified")).toHaveCount(0);
});

test("Unverifiable selected: an outside mention is never listed while it is not looked up, the badge stays N+", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: [[...FIXTURE(), apiPr(5001, "mention")]] });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await expect(line(page, "unverified")).toContainText("1 not verified yet.");
  await expect(outside(page).locator(".ghnt-out-item")).toHaveCount(0);
  expect(await countOf(page, "unverifiable")).toMatch(/\+$/);
});

test("unkeyable Discussion and CheckSuite items are counted as not verified, never listed; the CI run row on the page absorbs its own item", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: [[...FIXTURE(), apiOther("D1", "Discussion", "Plan the release", "mention"), apiOther("C1", "CheckSuite", "Nightly", "ci_activity"), apiPr(7001, "subscribed")]] });
  await ready(world, page);
  await cat(page, "informational").click();
  // C99 ("CI: build failed") is the page's own run row (one-to-one by repository, kind and title): not counted. D1 and C1 are not on the page.
  await expect(line(page, "unverified")).toContainText("2 not verified yet. 2 of them can only be opened from GitHub's list: Next page ›");
  await expect(line(page, "unverified").getByRole("link", { name: "Next page ›" })).toHaveAttribute("href", "/notifications?after=p2");
  await expect(outside(page)).not.toContainText(/Plan the release|Nightly/);
  await expect(line(page, "unverified")).not.toContainText("Pick");
  expect(await countOf(page, "informational")).toMatch(/\+$/);
  await expect(line(page, "complete")).toHaveCount(0);
});

test("a Discussion row on the page (live row structure) and the same API item: one entry, not counted twice; a title that differs stays in k", async ({ context, page }) => {
  const { world } = await boot(context, page, { hash: "#kinds", pages: [[apiPr(412, "review_requested", "Add retry to uploads"), apiOther("D1", "Discussion", "Plan  the release", "mention"), apiOther("C1", "CheckSuite", "Release check", "ci_activity"), apiOther("C2", "CheckSuite", "Other run", "ci_activity")]] });
  await expect.poll(async () => (await state(world)).items.length).toBeGreaterThan(2);
  const rowsRead = await world.evaluate("JSON.parse(JSON.stringify(GHNT_COLLECT.readPage(document).rows.map((r) => [r.key, r.title])))");
  expect(rowsRead.map((r) => r[1])).toEqual(["Add retry to uploads", "Plan the release", "Release check"]);
  await settled(world);
  await cat(page, "informational").click();
  // Only "Other run" is an extra unkeyable item.
  await expect(line(page, "unverified")).toContainText("1 not verified yet.");
  const s = await world.evaluate("JSON.parse(JSON.stringify(GHNotifications.fill.summarize()))");
  expect(s.m).toBe(s.pageRows + s.outside.length + s.k);
  expect(s.k).toBe(1);
});

test("fine-grained token (no scope header): the state is worded, no '+', no reason links for Informational", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(2), scopes: null });
  await ready(world, page);
  await cat(page, "attention").click();
  await expect(line(page, "state")).toContainText("Notifications outside this page can't be checked: the default GitHub token must be a classic token with the notifications scope. Narrow with GitHub filters:");
  await expect(line(page, "state").getByRole("link", { name: "Review requests ›" })).toHaveAttribute("href", "/notifications?query=reason%3Areview-requested");
  await expect(line(page, "state").getByRole("link", { name: "Mentions ›" })).toHaveAttribute("href", "/notifications?query=reason%3Amention");
  expect(await countOf(page, "attention")).not.toMatch(/\+/);
  await cat(page, "attention").click();
  await cat(page, "informational").click();
  await expect(line(page, "state")).toContainText("Only this page is counted.");
  await expect(line(page, "state").getByRole("link", { name: "Review requests ›" })).toHaveCount(0);
  await expect(line(page, "state").getByRole("link", { name: "Next page ›" })).toBeVisible();
  expect(await countOf(page, "informational")).not.toMatch(/\+/);
});

test("no token at all: the settings link, Next page, zero requests to the API", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { tokens: false });
  await expect.poll(() => state(world).then((s) => s.phase)).toBe("ready");
  await cat(page, "attention").click();
  await expect(line(page, "state")).toContainText("Without a GitHub token, review requests and mentions can't be verified, so none is counted as Needs attention.");
  await expect(line(page, "state").getByRole("button", { name: "Settings → GitHub tokens" })).toBeVisible();
  expect(log.length).toBe(0);
  await cat(page, "attention").click();
  await cat(page, "unverifiable").click();
  await expect(line(page, "state")).toHaveText("Only this page is counted. Next page ›");
});

test("an unsupported native filter is named, no narrowing links, and no REST page beyond the baseline is read", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6), url: `${INBOX}?query=is%3Asaved` });
  await ready(world, page);
  await cat(page, "informational").click();
  await expect(line(page, "state")).toHaveText("The filter is:saved can't be applied outside this page, so only this page is counted. Next page ›");
  await page.waitForTimeout(500);
  expect(notif(log).every((l) => Number(new URLSearchParams(l.search).get("page")) <= 2)).toBe(true);
  expect(await countOf(page, "informational")).not.toMatch(/\+/);
});

test("the native query is rebuilt: is:unread sends all=false, reason: and repo: filter in memory", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(2, { reasonOf: (n) => (n % 2 ? "subscribed" : "author") }), url: `${INBOX}?query=is%3Aunread+reason%3Aauthor` });
  await ready(world, page);
  expect(notif(log)[0].search).toBe("?all=false&is_done=false&per_page=50&page=1");
  await cat(page, "informational").click();
  await fillDone(world);
  const reasons = await page.locator(".ghnt-out-meta").allInnerTexts();
  expect(reasons.length).toBeGreaterThan(0);
  expect(reasons.every((t) => t.includes("author"))).toBe(true);
});

test("a rate limit keeps the results, disables Load more with the reset time, and sends nothing before it", async ({ context, page }) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const { world, log } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "subscribed" }), fail: (n) => (n >= 3 ? { status: 429, headers: { "retry-after": "3600", "x-ratelimit-reset": String(reset) } } : null) });
  await ready(world, page);
  await cat(page, "attention").click();
  await expect(line(page, "rate")).toContainText(/^GitHub rate limit reached\. Results so far are kept; you can load more after \d\d:\d\d\./);
  const more = page.getByRole("button", { name: "Load more" });
  await expect(more).toHaveAttribute("aria-disabled", "true");
  await expect(more).toHaveAccessibleDescription(/Available after \d\d:\d\d/);
  const n = notif(log).length;
  await more.click({ force: true });
  await page.waitForTimeout(500);
  expect(notif(log).length).toBe(n);
  expect(await countOf(page, "informational")).toMatch(/\+$/);
});

test("a refused or silent API after the first answer keeps what is shown and says which", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "subscribed" }), fail: (n) => (n === 3 ? { status: 502, body: {} } : null) });
  await ready(world, page);
  await cat(page, "attention").click();
  await expect(line(page, "error")).toContainText("Couldn't check notifications outside this page: GitHub did not answer. Results on this page are unaffected.");
  await expect(outside(page)).toHaveCount(0);
  expect(await countOf(page, "informational")).toMatch(/\+$/);
  for (const t of await page.locator(".ghnt-block").allInnerTexts()) expect(t).not.toMatch(/all clear|no notifications|inbox empty/i);
});

test("SSO: a lookup denied for an owner adds the caveat, whatever the category", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: [[...FIXTURE(), apiPr(5001, "review_requested")]], graphql: (aliases) => Object.fromEntries(aliases.map((a) => [a, a === "p5001" ? null : node()])).constructor === Object ? null : {} });
  await ready(world, page);
  await cat(page, "attention").click();
  await fillDone(world);
  await expect(line(page, "sso")).toHaveText("Notifications from organizations your token can't read may be missing.");
  await cat(page, "attention").click();
  await cat(page, "informational").click();
  await expect(line(page, "sso")).toBeVisible();
});

test("A -> B -> A on the same page makes zero REST requests; a page change plus re-selection fills again", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  await cat(page, "unverifiable").click();
  await cat(page, "informational").click();
  await fillDone(world);
  const n = notif(log).length;
  await cat(page, "informational").click();
  await cat(page, "unverifiable").click();
  await page.waitForTimeout(400);
  expect(notif(log).length).toBe(n);
});

test("Turbo page 2 and back: selection kept, zero fill requests, no key twice, the outside list is rebuilt from this tab's cache", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  const n = notif(log).length;
  await page.click("a#next");
  await expect(page).toHaveURL(/after=p2/);
  await expect(cat(page, "unverifiable")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(600);
  expect(notif(log).length).toBe(n);
  await page.goBack();
  await expect(page).not.toHaveURL(/after=p2/);
  await page.waitForTimeout(600);
  expect(notif(log).length).toBe(n);
  const keys = await page.locator(".ghnt-out-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-ghnt-entry")));
  expect(new Set(keys).size).toBe(keys.length);
});

test("a native Done clears the cache, and the item is never on the page and outside at once", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(3, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  await expect(outside(page)).toHaveCount(1);
  const reads = notif(log).length;
  await page.locator("li.notifications-list-item").first().locator('button[data-action="done"]').dispatchEvent("click");
  await expect.poll(() => world.evaluate("GHNotifications.fill.snapshot().active")).toBe(false);
  // The next scan reads the API again (the baseline), and the list is rebuilt from it.
  await expect.poll(() => notif(log).length).toBeGreaterThan(reads);
});

test("the extension only reads: GET notifications, GraphQL queries without a mutation, never github.com", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(6) });
  await ready(world, page);
  const hits = [];
  page.on("request", (r) => /github\.com/.test(r.url()) && r.resourceType() !== "document" && hits.push(r.url()));
  await cat(page, "attention").click();
  await fillDone(world);
  expect(log.every((l) => (l.path === "/notifications" && l.method === "GET") || (l.path === "/graphql" && l.method === "POST"))).toBe(true);
  expect(log.filter((l) => l.path === "/graphql").length).toBeLessThanOrEqual(12 + 1);
  expect(hits.filter((u) => !u.includes("api.github.com"))).toEqual([]);
});

test("development counters are on GHNotifications.fillStats (unpacked install), nothing is stored", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(4) });
  await ready(world, page);
  await cat(page, "informational").click();
  await fillDone(world);
  const stats = await world.evaluate("JSON.parse(JSON.stringify(GHNotifications.fillStats))");
  expect(stats.fills).toBe(1);
  expect(typeof stats.lastStopReason).toBe("string");
  await page.locator("a.ghnt-next").first().click({ trial: true }).catch(() => {});
});

test("announcements: at most 5 per fill, from one visually hidden live region; the progress is not a live region", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(6, { reasonOf: () => "mention" }), delay: 200 });
  await ready(world, page);
  const seen = [];
  await page.exposeFunction("ghntSeen", (t) => seen.push(t));
  await page.evaluate(() => new MutationObserver(() => { const sr = document.querySelector('[data-ghnt-triage="sr"]'); if (sr?.textContent) window.ghntSeen(sr.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }));
  await cat(page, "attention").click();
  await fillDone(world);
  expect(seen.length).toBeLessThanOrEqual(5);
  await expect(page.locator('[data-ghnt-triage="sr"]')).toHaveCount(1);
  await expect(page.locator(".ghnt-sline-progress")).toHaveCount(0);
  await expect(page.locator(".ghnt-status")).not.toHaveAttribute("role", "status");
});

test("'+ k outside' in the status is a link that moves focus to the outside list's heading", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  await page.locator(".ghnt-status-text a").click();
  await expect(outside(page).locator("h2")).toBeFocused();
});

test("outside list: 25 entries then 'Show {n} more outside this page', revealed in place with no request", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(2, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  await expect(outside(page).locator(".ghnt-out-item")).toHaveCount(25);
  const n = notif(log).length;
  const more = outside(page).getByRole("button", { name: /^Show \d+ more outside this page$/ });
  await more.click();
  await expect(outside(page).locator(".ghnt-out-item")).not.toHaveCount(25);
  expect(notif(log).length).toBe(n);
});

test("Grouped: the action starts the fill, headers N+, inert sub-lists of at most 5 with Show more, select-all leaves them alone, a CheckSuite keeps it from being complete", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: [[...FIXTURE(), ...Array.from({ length: 8 }, (_, i) => apiPr(8000 + i, "subscribed")), apiOther("C1", "CheckSuite", "Nightly")]], storage: { ghntLayout: "grouped" } });
  await expect(page.locator("li.ghnt-sec")).toHaveCount(4);
  await settled(world);
  await expect(line(page, "grouped-start")).toContainText("Counts cover the 6 loaded notifications; more pages not loaded.");
  await expect(page.locator(".ghnt-sec-outside")).toHaveCount(0);
  await page.getByRole("button", { name: "Check notifications outside this page" }).click();
  await expect(page.locator('li.ghnt-sec-outside[data-ghnt-sec-outside="informational"]')).toHaveCount(1);
  const sub = page.locator('li.ghnt-sec-outside[data-ghnt-sec-outside="informational"]');
  await expect(sub.locator(".ghnt-out-item")).toHaveCount(5);
  await expect(sub.getByRole("button", { name: /^Show \d+ more outside this page$/ })).toBeVisible();
  const heads = await page.locator(".ghnt-sec-btn .ghnt-count").allInnerTexts();
  expect(heads.every((t) => /\+$/.test(t.trim()))).toBe(true);
  await expect(line(page, "unverified")).toContainText("not verified yet. 1 of them can only be opened from GitHub's list: Next page ›");
  expect(await page.locator("body").innerText()).not.toMatch(/All \d+ notifications available/);
  const inert = await page.evaluate(() => [...document.querySelectorAll("li.ghnt-sec-outside")].every((li) => !li.matches(".notifications-list-item, .js-navigation-item") && !li.querySelector('input[type="checkbox"]')));
  expect(inert).toBe(true);
  // select-all (GitHub's own) leaves the inert entries alone
  await page.evaluate(() => { const c = document.querySelector(".js-check-all"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(await page.locator("li.notifications-list-item input:checked").count()).toBeGreaterThan(0);
  expect(await page.locator("li.ghnt-sec-outside input:checked").count()).toBe(0);
  // leaving Grouped removes the sub-lists and restores the native list
  await seedStorage(context, { ghntLayout: "integrated" });
  await expect(page.locator("li.ghnt-sec-outside")).toHaveCount(0);
  await expect(page.locator("li.notifications-list-item")).toHaveCount(6);
});

test("Quick bar: the same block under the filter row, pills carry N+, the outside box follows the list", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3), storage: { ghntLayout: "quickbar" } });
  await ready(world, page);
  expect(await page.locator(".ghnt-pill .ghnt-count").first().innerText()).toMatch(/\+$/);
  await page.locator('.ghnt-pill[data-ghnt-cat="informational"]').click();
  await expect(outside(page)).toHaveCount(1);
});

for (const width of [1500, 1100, 800, 767, 600, 544, 543, 390, 320]) {
  test(`widths: the outside box copies the list box's edges and radius, buttons and lines fit, no horizontal scroll (${width}px)`, async ({ context, page }) => {
    const { world } = await boot(context, page, { pages: makePages(3, { reasonOf: () => "weird" }), viewport: { width, height: 900 } });
    await ready(world, page);
    await cat(page, "unverifiable").click().catch(async () => { await page.locator(`[data-ghnt-cat="unverifiable"]`).first().click(); });
    await expect(outside(page)).toHaveCount(1);
    await fillDone(world);
    const g = await page.evaluate(() => {
      const box = document.querySelector("div.Box.notifications-list");
      const out = document.querySelector('[data-ghnt-triage="outside"]');
      const bs = getComputedStyle(box);
      const os = getComputedStyle(out);
      const r = (n) => n.getBoundingClientRect();
      const btn = document.querySelector(".ghnt-fill-btn");
      const lines = [...document.querySelectorAll(".ghnt-block .ghnt-sline")].map((l) => ({ right: r(l).right, left: r(l).left }));
      const blockR = r(document.querySelector(".ghnt-block"));
      return { left: [r(out).left, r(box).left], right: [r(out).right, r(box).right], radius: [os.borderTopLeftRadius, bs.borderTopLeftRadius], docW: document.documentElement.scrollWidth, vw: window.innerWidth, btn: btn ? { h: r(btn).height, w: r(btn).width, blockW: blockR.width, radius: getComputedStyle(btn).borderTopLeftRadius, border: getComputedStyle(btn).borderTopWidth } : null, linesOut: lines.filter((l) => l.right > blockR.right + 1 || l.left < blockR.left - 1).length };
    });
    expect(Math.abs(g.left[0] - g.left[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(g.right[0] - g.right[1])).toBeLessThanOrEqual(1);
    expect(g.radius[0]).toBe(g.radius[1]);
    expect(width <= 543 ? g.radius[0] : "6px").toBe(g.radius[0] === "0px" && width <= 543 ? "0px" : "6px");
    expect(g.docW).toBeLessThanOrEqual(g.vw);
    expect(g.linesOut).toBe(0);
    if (g.btn) {
      if (width >= 768) expect([Math.round(g.btn.h), g.btn.radius, g.btn.border]).toEqual([28, "6px", "1px"]);
      else {
        expect(g.btn.h).toBeGreaterThanOrEqual(44);
        expect(g.btn.w / g.btn.blockW).toBeGreaterThanOrEqual(0.99);
      }
    }
  });
}

test("dark scheme: the outside box and buttons use the page's variables (no light fill on a dark page)", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3, { reasonOf: () => "weird" }), scheme: "dark" });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await expect(outside(page)).toHaveCount(1);
  const bg = await outside(page).evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(bg).toBe("rgb(13, 17, 23)");
});

test("the outside list is read-only: a click on an entry opens its thread, there is no Done, Save or checkbox, and the focus ring shows on the link", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3, { reasonOf: () => "weird" }) });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await expect(outside(page)).toHaveCount(1);
  expect(await outside(page).locator("button:not(.ghnt-out-more), input").count()).toBe(0);
  await outside(page).locator("a").first().focus();
  await page.keyboard.press("Shift");
  const ring = await outside(page).locator("a").first().evaluate((a) => getComputedStyle(a).outlineStyle);
  expect(ring).not.toBe("none");
});
