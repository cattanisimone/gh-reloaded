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


test("ADV repo grouping placement", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(3), hash: "#repo" });
  await expect.poll(() => state(world).then((s) => s.phase)).toBe("ready");
  await cat(page, "informational").click();
  await fillDone(world);
  await expect(outside(page)).toHaveCount(1);
  const where = await page.evaluate(() => {
    const out = document.querySelector('[data-ghnt-triage="outside"]');
    const boxes = [...document.querySelectorAll(".Box:not(.Box--overlay)")].filter((b) => b.querySelector("li.notifications-list-item"));
    return { vis: boxes.map((b)=>b.getClientRects().length>0), nBoxes: boxes.length, idx: boxes.indexOf(out.previousElementSibling), nextIsBox: !!out.nextElementSibling?.matches(".Box"), next: out.nextElementSibling?.className, html: out.nextElementSibling?.outerHTML.slice(0, 120) };
  });
  console.log(JSON.stringify(where));
});

test("ADV clear triage during fill keeps requesting", async ({ context, page }) => {
  const { world, log } = await boot(context, page, { pages: makePages(8, { reasonOf: () => "weird" }), delay: 400 });
  await expect.poll(() => state(world).then((s) => s.phase)).toBe("ready");
  await cat(page, "attention").click();
  await expect(line(page, "progress")).toBeVisible();
  await cat(page, "attention").click(); // deselect
  const n = log.length;
  const running = await world.evaluate("GHNotifications.fill.isRunning()");
  await page.waitForTimeout(5000);
  console.log(JSON.stringify(log.slice(n).map((l)=>l.path+l.search)));
  console.log(JSON.stringify({ runningAfterDeselect: running, before: n, after: log.length, progressVisible: await line(page, "progress").count() }));
});

test("ADV focus on outside entry during a fill", async ({ context, page }) => {
  const { world } = await boot(context, page, { pages: makePages(8, { reasonOf: (n) => (n % 9 === 0 ? "weird" : "subscribed") }), delay: 300 });
  await ready(world, page);
  await cat(page, "unverifiable").click();
  await fillDone(world);
  await expect(outside(page)).toHaveCount(1);
  await page.locator(".ghnt-out-link").first().focus();
  const before = await page.evaluate(() => document.activeElement.className);
  await world.evaluate("GHNotifications.fill.start({ category: 'unverifiable', force: true })");
  await fillDone(world);
  const after = await page.evaluate(() => document.activeElement.tagName + "." + document.activeElement.className);
  console.log(JSON.stringify({ before, after }));
});
