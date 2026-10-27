// E2E: the headless notifications engine, in the real extension, against a
// fixture of the inbox (fictional data, signed in as mira). The engine renders
// nothing, so the tests read its state through the extension's isolated world
// (support/isolated-world.js) and register a dummy module there. Covers: the
// page stays byte-identical (no module, a dummy module, Native inbox), no
// request when nothing is enabled / on other routes / with 0 rows, the
// classification of the fixture rows, the Notifications API states, the rate
// limit, soft navigation (bell link), pagination and the mention window.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";

const INBOX = "https://github.com/notifications";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };
const ENABLE = { ghntModules: { dummy: true } };

const node = (over = {}) => ({
  state: "OPEN",
  headRefOid: "h2",
  author: { login: "lee" },
  reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "User", login: "mira" } }] },
  reviews: { totalCount: 0, nodes: [] },
  timelineItems: { totalCount: 0, nodes: [] },
  ...over,
});
const mentionNode = (daysAgo, over = {}) => ({
  state: "OPEN",
  url: "https://github.com/acme/web/pull/409",
  body: "Flaky spec fix",
  createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  author: { login: "lee" },
  comments: { totalCount: 1, nodes: [{ url: "https://github.com/acme/web/pull/409#c1", body: "@mira can you look?", createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), author: { login: "lee" } }] },
  reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0 },
  ...over,
});

// Records every api.github.com request; `graphql` and `notifications` shape the answers.
async function routeApi(context, log, { graphql, notifications } = {}) {
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    log.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === "/graphql") {
      const repository = {};
      for (const m of body.query.matchAll(/([pi])(\d+): (?:pullRequest|issue)/g)) repository[`${m[1]}${m[2]}`] = null;
      const res = graphql ? graphql(Object.keys(repository), body, log) : { data: { viewer: { login: "mira" }, repository } };
      return route.fulfill({ status: res.status || 200, contentType: "application/json", headers: res.headers || {}, body: JSON.stringify(res.json ?? res) });
    }
    if (url.pathname === "/notifications") {
      const res = notifications ? notifications(url) : { status: 404, json: { message: "Not Found" } };
      return route.fulfill({ status: res.status || 200, contentType: "application/json", headers: res.headers || {}, body: JSON.stringify(res.json ?? []) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

const DEFAULT_GRAPHQL = (aliases) => ({
  data: {
    viewer: { login: "mira" },
    repository: Object.fromEntries(aliases.map((a) => [a, a === "p412" || a === "p300" || a === "p200" ? node() : a === "p409" ? mentionNode(1) : a === "i299" ? mentionNode(1, { url: "u" }) : null])),
  },
});

async function boot(context, page, { storage = TOKENS, graphql = DEFAULT_GRAPHQL, notifications, url = INBOX, register = true, enable = true } = {}) {
  const log = [];
  await seedStorage(context, storage);
  await routeApi(context, log, { graphql, notifications });
  await routeGithub(context, "notifications.html");
  await page.goto(url);
  const world = await isolatedWorld(context, page);
  await world.ready();
  if (register) await world.evaluate(`(() => { globalThis.__dummy = []; GHNotifications.registry.register({ id: "dummy", start() { __dummy.push("start"); }, stop() { __dummy.push("stop"); } }); return true; })()`);
  if (enable) await seedStorage(context, ENABLE);
  return { log, world };
}

const state = (world) => world.evaluate("JSON.parse(JSON.stringify(GHNotifications.engine.getState()))");
async function settled(world, predicate = () => true) {
  let last;
  await expect.poll(async () => {
    last = await state(world);
    return last.phase === "ready" && last.items.length > 0 && predicate(last);
  }).toBe(true);
  return last;
}
const byKey = (s) => Object.fromEntries(s.items.map((i) => [i.key, i]));
const apiCalls = (log) => log.length;

test("no module enabled: the engine never starts, no request, page unchanged", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { enable: false });
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  await page.waitForTimeout(1200);
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(await world.evaluate("__dummy.length")).toBe(0);
  expect(apiCalls(log)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
});

test("a dummy module enabled: the engine classifies the rows and the page stays identical", async ({ context, page }) => {
  const { log, world } = await boot(context, page);
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  const s = await settled(world);
  const k = byKey(s);
  expect(await world.evaluate("__dummy")).toEqual(["start"]);
  expect(k["acme/web#412"]).toMatchObject({ section: "attention", scope: "direct", rule: 3 });
  expect(k["acme/web#409"]).toMatchObject({ section: "attention", scope: "direct", rule: 9 });
  expect(k["acme/web#401"]).toMatchObject({ section: "informational", rule: 13 });
  expect(k["run:/acme/web/actions/runs/99"]).toMatchObject({ section: "informational", rule: 13 });
  expect(k["acme/web#390"]).toMatchObject({ section: "informational", rule: 13 });
  expect(k["acme/web#380"]).toMatchObject({ section: "unverifiable", rule: 12 });
  expect(s.coverage).toEqual({ loaded: 6, total: null, partial: true });
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  // Read-only: only GET /notifications and GraphQL queries.
  expect(log.length).toBeGreaterThan(0);
  expect(log.every((c) => c.method === "GET" || (c.path === "/graphql" && !/mutation/i.test(c.body.query)))).toBe(true);
});

test("Native inbox: modules stopped, no request, page identical", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { enable: false });
  await seedStorage(context, { ...ENABLE, ghntNativeInbox: true });
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  await page.waitForTimeout(1200);
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(await world.evaluate("__dummy.length")).toBe(0);
  expect(apiCalls(log)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(before);
  // Switching it off starts the engine; switching it on again stops it.
  await seedStorage(context, { ghntNativeInbox: false });
  await settled(world);
  await seedStorage(context, { ghntNativeInbox: true });
  await expect.poll(() => world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(await world.evaluate("__dummy")).toEqual(["start", "stop"]);
});

test("/notifications/subscriptions: the engine does not run and makes no request", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { url: "https://github.com/notifications/subscriptions" });
  expect(await page.locator("li.notifications-list-item").count()).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(apiCalls(log)).toBe(0);
});

test("an inbox with 0 rows makes no request", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { url: `${INBOX}#empty` });
  await expect.poll(() => world.evaluate("GHNotifications.engine.isActive()")).toBe(true);
  await page.waitForTimeout(1200);
  expect(apiCalls(log)).toBe(0);
  expect((await state(world)).items).toEqual([]);
});

test("no token: rows that need facts are Unverifiable, quiet rows stay Informational, no api.github.com request", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { storage: {} });
  const s = await settled(world);
  const k = byKey(s);
  expect(k["acme/web#412"]).toMatchObject({ section: "unverifiable", rule: 1 });
  expect(k["acme/web#409"]).toMatchObject({ section: "unverifiable", rule: 1 });
  expect(k["acme/web#390"].section).toBe("informational");
  expect(s.capabilities["pr:acme"]).toBe("no-token");
  expect(apiCalls(log)).toBe(0);
});

test("a token that cannot read the repository: Unverifiable, capability denied, no error shown", async ({ context, page }) => {
  const { world } = await boot(context, page, { graphql: () => ({ status: 403, json: { message: "Resource not accessible by personal access token" } }) });
  const s = await settled(world);
  expect(byKey(s)["acme/web#412"].section).toBe("unverifiable");
  expect(s.capabilities["pr:acme"]).toBe("denied");
  expect(s.rateLimited).toBe(false);
  expect(await page.locator("body").innerText()).not.toMatch(/error|denied/i);
});

test("a token of another account never gives Needs attention", async ({ context, page }) => {
  const { world } = await boot(context, page, { graphql: (aliases) => ({ data: { viewer: { login: "someone-else" }, repository: Object.fromEntries(aliases.map((a) => [a, node()])) } }) });
  const k = byKey(await settled(world));
  expect(k["acme/web#412"]).toMatchObject({ section: "unverifiable", rule: 1 });
  expect(k["acme/web#412"].evidence[0]).toMatch(/another account/);
});

test("relative subject hrefs are read like absolute ones", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#relative` });
  const k = byKey(await settled(world));
  expect(k["acme/web#412"].section).toBe("attention");
  expect(k["run:/acme/web/actions/runs/99"].section).toBe("informational");
});

test("Notifications API working: the union adds API-only items, total stays null", async ({ context, page }) => {
  const item = { id: "9", reason: "review_requested", unread: true, subject: { url: "https://api.github.com/repos/acme/web/pulls/200", type: "PullRequest", title: "x" }, repository: { full_name: "acme/web" } };
  const { world } = await boot(context, page, { notifications: () => ({ json: [item], headers: { "x-oauth-scopes": "notifications" } }) });
  const s = await settled(world, (st) => st.items.length === 7);
  expect(s.capabilities["api:notifications"]).toBe("ok");
  expect(s.coverage).toEqual({ loaded: 7, total: null, partial: true });
  const extra = byKey(s)["acme/web#200"];
  expect(extra).toMatchObject({ inPage: false, section: "attention", scope: "direct" });
  expect(await page.locator("li.notifications-list-item").count()).toBe(6);
});

test("Notifications scope proven missing vs ambiguous: distinct states, partial coverage, nothing rendered", async ({ context, page }) => {
  const missing = await boot(context, page, { notifications: () => ({ status: 403, json: { message: "x" }, headers: { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" } }) });
  const s1 = await settled(missing.world);
  expect(s1.capabilities["api:notifications"]).toBe("missing-scope");
  expect(s1.coverage).toEqual({ loaded: 6, total: null, partial: true });
  expect(await page.locator("body").innerText()).not.toMatch(/scope/i);
});

test("Notifications API ambiguous 404 (or a fine-grained token): unavailable, no cause named", async ({ context, page }) => {
  const { world } = await boot(context, page, { notifications: () => ({ status: 404, json: { message: "Not Found" } }) });
  const s = await settled(world);
  expect(s.capabilities["api:notifications"]).toBe("unavailable");
  expect(s.coverage.partial).toBe(true);
});

test("rate limit: state exposed, rows Unverifiable, the engine retries at retryAt and recovers", async ({ context, page }) => {
  let limited = true;
  const { world } = await boot(context, page, { graphql: (aliases) => (limited ? { status: 429, json: { message: "API rate limit exceeded" }, headers: { "retry-after": "2" } } : DEFAULT_GRAPHQL(aliases)) });
  const s = await settled(world, (st) => st.rateLimited);
  expect(s.retryAt).toBeGreaterThan(Date.now());
  expect(byKey(s)["acme/web#412"].section).toBe("unverifiable");
  expect(byKey(s)["acme/web#390"].section).toBe("informational");
  expect(s.items.length).toBe(6);
  limited = false;
  const done = await settled(world, (st) => !st.rateLimited && byKey(st)["acme/web#412"].section === "attention");
  expect(done.rateLimited).toBe(false);
});

test("soft navigation: the bell link from a repository page starts the engine, back stops it", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { url: "https://github.com/acme/web" });
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(apiCalls(log)).toBe(0);
  await page.locator("#bell").click();
  const s = await settled(world);
  expect(byKey(s)["acme/web#412"].section).toBe("attention");
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(true);
  await page.goBack();
  await expect.poll(() => world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  await page.goForward();
  await expect.poll(() => world.evaluate("GHNotifications.engine.isActive()")).toBe(true);
  expect(await world.evaluate("__dummy")).toEqual(["start", "stop", "start"]);
});

test("pagination: Next re-scans and classifies the new rows, Previous returns", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await settled(world);
  await page.locator("#next").click();
  const s = await settled(world, (st) => st.items.some((i) => i.key === "acme/web#300"));
  expect(s.items.map((i) => i.key).sort()).toEqual(["acme/web#299", "acme/web#300"]);
  expect(byKey(s)["acme/web#300"].section).toBe("attention");
  await page.locator("#prev").click();
  await settled(world, (st) => st.items.some((i) => i.key === "acme/web#412"));
});

test("the mention window is configurable and applies without a new request", async ({ context, page }) => {
  const { log, world } = await boot(context, page, { graphql: (aliases) => ({ data: { viewer: { login: "mira" }, repository: Object.fromEntries(aliases.map((a) => [a, a === "p409" ? mentionNode(3) : a === "p412" ? node() : null])) } }) });
  let s = await settled(world);
  expect(byKey(s)["acme/web#409"].section).toBe("attention");
  const calls = log.length;
  await seedStorage(context, { ghntMentionWindowDays: 1 });
  await expect.poll(async () => byKey(await state(world))["acme/web#409"].section).toBe("informational");
  await seedStorage(context, { ghntMentionWindowDays: "bad" });
  await expect.poll(async () => byKey(await state(world))["acme/web#409"].section).toBe("attention");
  expect(log.length).toBe(calls);
});

test("narrow viewport and dark theme classify the same", async ({ context, page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  const { world } = await boot(context, page);
  const k = byKey(await settled(world));
  expect(k["acme/web#412"].section).toBe("attention");
  expect(k["acme/web#390"].section).toBe("informational");
});
