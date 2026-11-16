// E2E: why a notification is limited (#131), on the inbox. The real extension
// against the inbox fixture; api.github.com is mocked per test. Covers the
// Triage panel's Coverage section (status per feature, notes, action lines),
// the one inbox line, their agreement, the engine-off and no-request rules,
// keyboard order and focus, layout at 1280/390/320 in light and dark, and a
// token change followed by a reload. Fictional owners (acme, northwind).
import { test, expect, routeGithub, seedStorage, backgroundWorker } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";

const INBOX = "https://github.com/notifications";
const DEFAULT = { githubTokens: [{ id: "t", name: "d", token: "ghp_secret123", owner: "" }], defaultTokenId: "t" };
const DAY = 86_400_000;

const reviewNode = () => ({ state: "OPEN", headRefOid: "h2", author: { login: "lee" }, reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "User", login: "mira" } }] }, reviews: { totalCount: 0, nodes: [] }, timelineItems: { totalCount: 0, nodes: [] } });
const mentionNode = () => ({ state: "OPEN", url: "https://github.com/acme/web/pull/1", body: "Change", createdAt: new Date(Date.now() - 20 * DAY).toISOString(), author: { login: "lee" }, comments: { totalCount: 1, nodes: [{ url: "https://github.com/acme/web/pull/1#c1", body: "@mira can you look?", createdAt: new Date(Date.now() - 1.5 * DAY).toISOString(), author: { login: "lee" } }] }, reviews: { totalCount: 0, nodes: [] }, reviewThreads: { totalCount: 0 } });
const goodGraphql = (aliases) => ({ data: { viewer: { login: "mira" }, repository: Object.fromEntries(aliases.map((a) => [a, a === "p412" ? reviewNode() : mentionNode()])) } });
const LIST_ITEM = { id: "9", reason: "subscribed", unread: true, updated_at: "2026-10-28T10:00:00Z", subject: { url: "https://api.github.com/repos/acme/web/issues/9", type: "Issue", title: "Plan" }, repository: { full_name: "acme/web" } };

// Mocks. graphql(call) / list(call) return {status, headers, body} or undefined for the good answer.
async function boot(context, page, { storage = {}, url = INBOX, viewport, scheme, graphql, list } = {}) {
  const requests = [];
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const u = new URL(request.url());
    const call = { path: u.pathname, auth: request.headers().authorization || "" };
    requests.push(call);
    const reply = ({ status = 200, headers = {}, body = {} }) => route.fulfill({ status, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    if (u.pathname === "/graphql") {
      const aliases = [...JSON.parse(request.postData()).query.matchAll(/([pi]\d+): (?:pullRequest|issue)/g)].map((m) => m[1]);
      return reply((graphql && graphql({ ...call, aliases })) || { body: goodGraphql(aliases) });
    }
    if (u.pathname === "/notifications") return reply((list && list(call)) || { status: 404, body: { message: "Not Found" } });
    return reply({ body: [] });
  });
  if (viewport) await page.setViewportSize(viewport);
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  await seedStorage(context, storage);
  await routeGithub(context, "notifications.html");
  await page.goto(url);
  const world = await isolatedWorld(context, page);
  await world.ready();
  return { world, requests };
}

const ready = (world) => expect.poll(() => world.evaluate("GHNotifications.engine.getState().phase")).toBe("ready");
const settled = (world) => expect.poll(async () => world.evaluate("(() => { const s = GHNotifications.engine.getState(); return s.phase === 'ready' && s.items.length > 0 && s.items.every((i) => !i.pending); })()")).toBe(true);
const caps = (world) => world.evaluate("JSON.parse(JSON.stringify(GHNotifications.engine.getState().capabilities))");
const button = (page) => page.locator(".ghnt-triage-btn");
const panel = (page) => page.locator("#ghnt-panel");
const open = async (page) => {
  await button(page).click();
  await expect(panel(page)).toBeVisible();
};
const cov = (page) => panel(page).locator("[data-ghnt-coverage]");
const rowOf = (page, id) => cov(page).locator(`[data-ghnt-cov="${id}"]`);
const noteNums = (page) => cov(page).locator("[data-ghnt-note], .ghnt-cov-more").evaluateAll((n) => n.map((x) => x.getAttribute("data-ghnt-note") || "more"));
const limitLine = (page) => page.locator('[data-ghnt-line="limit"]');
const REJECT_ALL = { status: 403, body: { message: "Resource not accessible" } };
const NO_NOTIF_SCOPE = { status: 403, headers: { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" }, body: { message: "Forbidden" } };
const LIST_OK = { status: 200, headers: { "x-oauth-scopes": "notifications" }, body: [LIST_ITEM] };

test("no token and no owner recorded: Full, Not in use, note 5 only, no action line, and no request from opening the panel", async ({ context, page }) => {
  const { world, requests } = await boot(context, page, { url: `${INBOX}#quiet` });
  await ready(world);
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Full");
  await expect(rowOf(page, "triage-tags")).toContainText("Work on every loaded notification.");
  await expect(rowOf(page, "beyond")).toContainText("Not in use");
  expect(await noteNums(page)).toEqual(["5"]);
  await expect(cov(page)).toContainText("No default GitHub token is set, so only the loaded notifications are covered.");
  await expect(cov(page)).not.toContainText("Owners with their own token");
  await expect(cov(page)).not.toContainText("Reload this page");
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a token and a page with no rows: the panel never claims there is no default token", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, url: `${INBOX}#empty`, list: () => LIST_OK });
  await ready(world);
  await open(page);
  await expect(cov(page)).not.toContainText("No default GitHub token");
  expect(await noteNums(page)).toEqual([]);
});

test("no token, rows that need facts: note 2 replaces 3 and 5, one Settings action, and the inbox line follows the coverage line", async ({ context, page }) => {
  const { world, requests } = await boot(context, page);
  await settled(world);
  expect(requests).toEqual([]);
  expect(await caps(world)).toMatchObject({ "pr:acme": "no-token" });
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Limited");
  expect(await noteNums(page)).toEqual(["2", "8"]);
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveText(["Add a token in Settings → GitHub tokens ›"]);
  await expect(cov(page)).not.toContainText("No GitHub token is set");
  const before = requests.length;
  await page.keyboard.press("Escape");
  // The inbox line: shown with nothing selected; gone while the no-token coverage line names the cause.
  await expect(limitLine(page)).toContainText("are Unverifiable: no default GitHub token is set.");
  await expect(limitLine(page)).toHaveCount(1);
  await page.locator('[data-ghnt-cat="attention"]').click();
  await expect(page.locator('[data-ghnt-line="state"]')).toContainText("Without a GitHub token");
  await expect(limitLine(page)).toHaveCount(0);
  expect(requests.length).toBe(before);
});

test("owner unreadable and the list refused: notes 3 and 7 in order, the owner action wins, the inbox line agrees, the link names the owner", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, graphql: () => ({ status: 200, body: { data: { viewer: { login: "mira" }, repository: null } } }), list: () => ({ status: 404, body: { message: "Not Found" } }) });
  await settled(world);
  expect(await caps(world)).toMatchObject({ "api:notifications": "unavailable", "pr:acme": "denied" });
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Some of this owner's review requests can't be confirmed.");
  await expect(rowOf(page, "beyond")).toContainText("Not in use");
  expect(await noteNums(page)).toEqual(["3", "7", "8"]);
  await expect(cov(page)).toContainText("No token that can read acme: its notifications are shown as “Unverifiable”.");
  await expect(cov(page)).toContainText("didn't say why");
  await expect(cov(page)).not.toContainText("doesn't have the notifications permission");
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveText(["acme: can't be read. Add or replace token ›"]);
  await page.keyboard.press("Escape");
  const unverifiable = Number(await page.locator('[data-ghnt-cat="unverifiable"] .ghnt-count').innerText());
  await expect(limitLine(page)).toHaveText(`${unverifiable} from acme are Unverifiable: no token can read acme. How to fix this ›`);
  await expect(limitLine(page)).toHaveCount(1);
  // The line opens the panel with the Coverage heading in view.
  await limitLine(page).getByRole("button").click();
  await expect(panel(page)).toBeVisible();
  const inView = await page.evaluate(() => {
    const p = document.getElementById("ghnt-panel").getBoundingClientRect();
    const h = document.getElementById("ghnt-coverage-h").getBoundingClientRect();
    return { top: h.top - p.top, bottom: p.bottom - h.bottom };
  });
  expect(inView.top).toBeGreaterThanOrEqual(0);
  expect(inView.bottom).toBeGreaterThanOrEqual(0);
  // The owner action opens Settings on the Notifications block, naming the owner.
  const [tab] = await Promise.all([context.waitForEvent("page"), panel(page).getByRole("button", { name: "Add or replace token ›" }).click()]);
  expect(tab.url()).toMatch(/^chrome-extension:\/\/[a-z]+\/options\/options\.html\?owner=acme&state=denied#tokens-more$/);
});

test("the inbox line is absent when the list alone is the problem, and never shows twice", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, list: () => NO_NOTIF_SCOPE });
  await settled(world);
  expect(await caps(world)).toMatchObject({ "api:notifications": "missing-scope", "pr:acme": "ok" });
  await expect(limitLine(page)).toHaveCount(0);
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Full");
  expect(await noteNums(page)).toEqual(["6", "8"]);
  await expect(cov(page).locator(".ghnt-warn")).toHaveCount(0);
  const actions = cov(page).locator("[data-ghnt-action]");
  await expect(actions).toHaveText(["How to add it: Settings → GitHub tokens › · Permissions in the README ›"]);
  const readme = actions.getByRole("link", { name: "Permissions in the README ›" });
  await expect(readme).toHaveAttribute("href", /gh-reloaded#optional-the-notifications-permission-classic-token$/);
  await expect(readme).toHaveAttribute("target", "_blank");
  const [tab] = await Promise.all([context.waitForEvent("page"), actions.getByRole("button", { name: "Settings → GitHub tokens ›" }).click()]);
  expect(tab.url()).toMatch(/options\/options\.html#tokens-more$/);
});

test("classic token that reads the list: Full everywhere, no note, no line", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, list: () => LIST_OK });
  await settled(world);
  expect(await caps(world)).toMatchObject({ "api:notifications": "ok", "pr:acme": "ok" });
  await open(page);
  await expect(rowOf(page, "beyond")).toContainText("Full");
  await expect(rowOf(page, "beyond")).toContainText("Counts also cover notifications outside this page.");
  expect(await noteNums(page)).toEqual([]);
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveCount(0);
  await expect(limitLine(page)).toHaveCount(0);
});

test("a rate limit gives one note, with the reset time when known, and the previous result is kept", async ({ context, page }) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const { world } = await boot(context, page, { storage: DEFAULT, list: () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: { message: "API rate limit exceeded" } }) });
  await expect.poll(() => world.evaluate("GHNotifications.engine.getState().rateLimited")).toBe(true);
  await open(page);
  expect(await noteNums(page)).toEqual(["1", "8"]);
  const at = new Date(reset * 1000);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  await expect(cov(page)).toContainText(`GitHub's rate limit was reached: classifications update at ${hhmm}.`);
  await expect(rowOf(page, "beyond")).toContainText("Limited");
  await expect(rowOf(page, "triage-tags")).toContainText("Some review requests wait for GitHub's rate limit.");
  await expect(cov(page).getByText("rate limit was reached")).toHaveCount(1);
});

test("owner tokens and no default token: owners are read, Beyond this page is Not in use, note 5 with its second sentence, never Limited", async ({ context, page }) => {
  const storage = { githubTokens: [{ id: "a", name: "acme bot", token: "ghp_acme", owner: "acme" }] };
  const { world } = await boot(context, page, { storage });
  await settled(world);
  expect(await caps(world)).toMatchObject({ "api:notifications": "not-tried", "pr:acme": "ok" });
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Full");
  await expect(rowOf(page, "beyond")).toContainText("Not in use");
  expect(await noteNums(page)).toEqual(["5", "8"]);
  await expect(cov(page)).toContainText("No default GitHub token is set, so only the loaded notifications are covered. Owners with their own token are read normally.");
  await expect(cov(page)).not.toContainText("No GitHub token is set");
  await expect(limitLine(page)).toHaveCount(0);
});

test("engine off shows only the hint and sends no request; Triage on with Tags off shows two rows", async ({ context, page }) => {
  const off = await boot(context, page, { storage: { ...DEFAULT, ghntModules: { triage: false, reasonTags: false, reasonWhy: false } } });
  await expect(button(page)).toBeVisible();
  await open(page);
  await expect(cov(page)).toContainText("Tokens and permissions: Settings → GitHub tokens");
  await expect(cov(page).locator("[data-ghnt-cov], .ghnt-warn, [data-ghnt-note]")).toHaveCount(0);
  expect(off.requests).toEqual([]);
  const [tab] = await Promise.all([context.waitForEvent("page"), cov(page).getByRole("button", { name: "Settings → GitHub tokens" }).click()]);
  expect(tab.url()).toMatch(/options\/options\.html#tokens-more$/);
});

test("Triage on with Tags off: two rows, no merged row", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: { ...DEFAULT, ghntModules: { reasonTags: false } }, list: () => LIST_OK });
  await settled(world);
  await open(page);
  await expect(cov(page).locator("[data-ghnt-cov]")).toHaveCount(3);
  await expect(rowOf(page, "triage")).toContainText("Full");
  await expect(rowOf(page, "tags")).toContainText("Off");
  await expect(rowOf(page, "triage-tags")).toHaveCount(0);
});

test("token added, then a reload: the first completed scan removes the notes, the action and the line that no longer apply", async ({ context, page }) => {
  const graphql = ({ auth }) => (auth === "Bearer ghp_acme" ? undefined : { status: 200, body: { data: { viewer: { login: "mira" }, repository: null } } });
  const { world } = await boot(context, page, { storage: DEFAULT, graphql, list: () => LIST_OK });
  await settled(world);
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Limited");
  expect(await noteNums(page)).toEqual(["3", "8"]);
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(limitLine(page)).toHaveCount(1);
  await seedStorage(context, { githubTokens: [...DEFAULT.githubTokens, { id: "a", name: "acme", token: "ghp_acme", owner: "acme" }] });
  const started = Date.now();
  await page.reload();
  const world2 = await isolatedWorld(context, page);
  await world2.ready();
  await expect(limitLine(page)).toHaveCount(0, { timeout: 30_000 });
  console.log(`token added: new state shown ${Date.now() - started} ms after the reload`);
  await open(page);
  await expect(rowOf(page, "triage-tags")).toContainText("Full");
  expect(await noteNums(page)).toEqual([]);
  await expect(cov(page).locator("[data-ghnt-action]")).toHaveCount(0);
});

test("default token added, then a reload: Beyond this page becomes Full and note 5 is gone", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#quiet`, list: () => LIST_OK });
  await ready(world);
  await open(page);
  await expect(rowOf(page, "beyond")).toContainText("Not in use");
  expect(await noteNums(page)).toEqual(["5"]);
  await seedStorage(context, DEFAULT);
  const started = Date.now();
  await page.reload();
  const world2 = await isolatedWorld(context, page);
  await world2.ready();
  await open(page);
  await expect(rowOf(page, "beyond")).toContainText("Full", { timeout: 30_000 });
  console.log(`default token added: new state shown ${Date.now() - started} ms after the reload`);
  expect(await noteNums(page)).toEqual([]);
});

test("owner ok, then its token gets a 403: a reload shows the note, the Unverifiable rows and the line", async ({ context, page }) => {
  let denied = false;
  const { world } = await boot(context, page, { storage: DEFAULT, list: () => LIST_OK, graphql: () => (denied ? { status: 403, body: { message: "Forbidden" } } : undefined) });
  await settled(world);
  await expect(limitLine(page)).toHaveCount(0);
  denied = true;
  // The background keeps an answer for 60 s: move its clock past that instead of waiting.
  await (await backgroundWorker(context)).evaluate(() => { const real = Date.now; Date.now = () => real() + 61_000; });
  await page.reload();
  const world2 = await isolatedWorld(context, page);
  await world2.ready();
  await expect.poll(() => caps(world2), { timeout: 30_000 }).toMatchObject({ "pr:acme": "denied" });
  await expect(limitLine(page)).toHaveCount(1, { timeout: 30_000 });
  await open(page);
  expect(await noteNums(page)).toContain("3");
});

test("keyboard: the panel's notes and actions are reached by Tab in reading order with a 2px focus ring, light and dark, at 1280, 390 and 320", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, graphql: () => ({ status: 200, body: { data: { viewer: { login: "mira" }, repository: null } } }), list: () => NO_NOTIF_SCOPE });
  await settled(world);
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await panel(page).locator('[data-ghnt-focus="reasonWhy"]').focus();
      const order = [];
      const seen = [];
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const a = document.activeElement;
          const s = getComputedStyle(a);
          const p = document.getElementById("ghnt-panel").getBoundingClientRect();
          const r = a.getBoundingClientRect();
          const inside = r.left >= p.left && r.right <= p.right && r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
          return { text: (a.textContent || a.getAttribute("aria-label") || a.value || "").trim(), ring: `${s.outlineStyle} ${s.outlineWidth}`, inside, inPanel: !!a.closest("#ghnt-panel") };
        });
        if (!info.inPanel) break;
        order.push(info.text);
        seen.push(info);
        if (info.text === "Restore defaults") break;
      }
      const label = `${scheme} ${width}`;
      // the layout radio, then Reload, then the foot actions, then Restore defaults
      const names = order.filter((t) => ["Reload this page", "Add or replace token ›", "Restore defaults"].includes(t));
      expect(names, label).toEqual(["Reload this page", "Add or replace token ›", "Restore defaults"]);
      for (const s of seen.filter((x) => ["Reload this page", "Add or replace token ›"].includes(x.text))) {
        expect(s.ring, label).toBe("solid 2px");
        expect(s.inside, label).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
    }
  }
});

test("keyboard: the inbox line's link is reached by Tab after the coverage controls, with a 2px ring and an underline on hover", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, graphql: () => ({ status: 200, body: { data: { viewer: { login: "mira" }, repository: null } } }), list: () => LIST_OK });
  await settled(world);
  const link = limitLine(page).getByRole("button");
  await link.focus();
  const ring = await link.evaluate((e) => { const s = getComputedStyle(e); return `${s.outlineStyle} ${s.outlineWidth}`; });
  expect(ring).toBe("solid 2px");
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement.textContent.trim())).not.toBe("How to fix this ›");
  await link.hover();
  expect(await link.evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe("underline");
});

test("layout: rows align with the section, labels with the switches, the line with the coverage line, no horizontal scroll (light and dark, 1280, 390, 320)", async ({ context, page }) => {
  const { world } = await boot(context, page, { storage: DEFAULT, graphql: () => ({ status: 200, body: { data: { viewer: { login: "mira" }, repository: null } } }), list: () => NO_NOTIF_SCOPE });
  await settled(world);
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      await open(page);
      const m = await page.evaluate(() => {
        const p = document.getElementById("ghnt-panel");
        const heading = document.getElementById("ghnt-coverage-h");
        const rows = [...p.querySelectorAll(".ghnt-cov-row")];
        const sw = p.querySelector(".ghnt-switch").getBoundingClientRect();
        const left = (n) => n.getBoundingClientRect().left;
        return {
          titleOffsets: rows.map((r) => Math.abs(left(r.querySelector(".ghnt-row-title")) - left(heading))),
          labelOffsets: rows.map((r) => Math.abs(r.querySelector(".ghnt-cov-status").getBoundingClientRect().right - sw.right)),
          scroll: [p.scrollWidth, p.clientWidth],
          page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        };
      });
      const label = `${scheme} ${width}`;
      for (const d of m.titleOffsets) expect(d, label).toBeLessThanOrEqual(1);
      for (const d of m.labelOffsets) expect(d, label).toBeLessThanOrEqual(1);
      expect(m.scroll[0], label).toBe(m.scroll[1]);
      expect(m.page[0], label).toBeLessThanOrEqual(m.page[1]);
      await page.keyboard.press("Escape");
      const line = await page.evaluate(() => {
        const l = document.querySelector('[data-ghnt-line="limit"]');
        const c = document.querySelector(".ghnt-coverage");
        const b = document.querySelector(".ghnt-block");
        return l && c ? { dx: Math.abs(l.getBoundingClientRect().left - c.getBoundingClientRect().left), share: l.getBoundingClientRect().width / b.getBoundingClientRect().width, lastChild: b.lastElementChild === l, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth } : null;
      });
      expect(line, label).not.toBeNull();
      expect(line.dx, label).toBeLessThanOrEqual(1);
      expect(line.share, label).toBeGreaterThanOrEqual(0.95);
      expect(line.lastChild, label).toBe(true);
      expect(line.scroll, label).toBe(true);
    }
  }
});
