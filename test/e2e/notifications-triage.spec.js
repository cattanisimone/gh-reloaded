// E2E: the Triage view of the notifications inbox (#106), the real module in
// the real extension against the inbox fixture (sidebar, native row markup,
// pagination, 32-row and Group-by-Repository variants; fictional data). The
// mocked GraphQL gives every row of the 32-row set a known category:
//   n % 8 = 1 review requested by me  -> Needs attention   (1, 9, 17, 25)
//   n % 8 = 2 mentioned a day ago     -> Needs attention   (2, 10, 18, 26)
//   n % 8 = 5 my review on the head   -> Waiting           (5, 13, 21, 29)
//   n % 8 = 6 mention, no data        -> Unverifiable      (6, 14, 22, 30)
//   quiet reasons                     -> Informational     (the other 16)
import { test, expect, routeGithub, seedStorage, backgroundWorker } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";

const INBOX = "https://github.com/notifications";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "ghp_secret123", owner: "" }], defaultTokenId: "t" };
const DAY = 86_400_000;

const reviewNode = (over = {}) => ({
  state: "OPEN",
  headRefOid: "h2",
  author: { login: "lee" },
  reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: "User", login: "mira" } }] },
  reviews: { totalCount: 0, nodes: [] },
  timelineItems: { totalCount: 0, nodes: [] },
  ...over,
});
const waitingNode = () => reviewNode({ reviewRequests: { totalCount: 0, nodes: [] }, reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: new Date(Date.now() - DAY).toISOString(), author: { login: "mira", __typename: "User" }, commit: { oid: "h2" } }] } });
const mentionNode = () => ({
  state: "OPEN",
  url: "https://github.com/acme/web/pull/1",
  body: "Change",
  createdAt: new Date(Date.now() - 20 * DAY).toISOString(),
  author: { login: "lee" },
  comments: { totalCount: 1, nodes: [{ url: "https://github.com/acme/web/pull/1#c1", body: "@mira can you look?", createdAt: new Date(Date.now() - 1.5 * DAY).toISOString(), author: { login: "lee" } }] },
  reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0 },
});

// The 32-row set (pull/101..132) and the 6-row / page 2 sets of the fixture.
function graphql(aliases) {
  const repository = {};
  for (const a of aliases) {
    const n = Number(a.slice(1));
    if (n >= 101 && n <= 132) {
      const k = (n - 100) % 8;
      repository[a] = k === 1 ? reviewNode() : k === 5 ? waitingNode() : k === 2 ? mentionNode() : null;
    } else repository[a] = a === "p412" || a === "p300" ? reviewNode() : a === "p409" || a === "i299" ? mentionNode() : null;
  }
  return { data: { viewer: { login: "mira" }, repository } };
}

async function boot(context, page, { storage = {}, url = INBOX, viewport, scheme, tokens = true, delay = 0 } = {}) {
  const requests = [];
  await context.route("https://api.github.com/**", async (route) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const request = route.request();
    const u = new URL(request.url());
    requests.push(u.pathname);
    if (u.pathname === "/graphql") {
      const body = JSON.parse(request.postData());
      const aliases = [...body.query.matchAll(/([pi]\d+): (?:pullRequest|issue)/g)].map((m) => m[1]);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(graphql(aliases)) });
    }
    return route.fulfill({ status: u.pathname === "/notifications" ? 404 : 200, contentType: "application/json", body: u.pathname === "/notifications" ? '{"message":"Not Found"}' : "[]" });
  });
  if (viewport) await page.setViewportSize(viewport);
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  await seedStorage(context, { ...(tokens ? TOKENS : {}), ...storage });
  await routeGithub(context, "notifications.html");
  await page.goto(url);
  const world = await isolatedWorld(context, page);
  await world.ready();
  return { world, requests };
}

const stored = async (context, keys) => (await backgroundWorker(context)).evaluate((k) => chrome.storage.local.get(k), keys);
const state = (world) => world.evaluate("JSON.parse(JSON.stringify(GHNotifications.engine.getState()))");
const settled = (world) => expect.poll(async () => { const s = await state(world); return s.phase === "ready" && s.items.length > 0 && s.items.every((i) => !i.pending); }).toBe(true);
const nav = (page) => page.locator('[data-ghnt-triage="nav"]');
const bar = (page) => page.locator('[data-ghnt-triage="quickbar"]');
const compact = (page) => page.locator('[data-ghnt-triage="compact"]');
const secs = (page) => page.locator("li.ghnt-sec");
const cat = (page, id) => page.locator(`[data-ghnt-cat="${id}"]`);
const visibleRows = (page) => page.locator("li.notifications-list-item:visible");
const everything = (page) => page.locator("[data-ghnt-triage]");
const countOf = async (page, id) => (await cat(page, id).locator(".ghnt-count").innerText()).trim();

// Expected categories of the 32-row set (by row number).
const MANY = { attention: [1, 2, 9, 10, 17, 18, 25, 26], waiting: [5, 13, 21, 29], unverifiable: [6, 14, 22, 30] };
MANY.informational = Array.from({ length: 32 }, (_, i) => i + 1).filter((n) => ![...MANY.attention, ...MANY.waiting, ...MANY.unverifiable].includes(n));
const titleOf = (n) => `Change number ${n}`;

test("fresh install renders Integrated navigation: the Triage group is the first child of the native sidebar, counts of the loaded rows", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  await expect(nav(page)).toHaveCount(1);
  const where = await page.evaluate(() => {
    const t = document.querySelector('[data-ghnt-triage="nav"]');
    const side = document.querySelector('nav[aria-label="Notifications"]');
    return { first: side.firstElementChild === t, before: t.nextElementSibling?.getAttribute("aria-label"), label: t.getAttribute("aria-label") };
  });
  expect(where).toEqual({ first: true, before: "Inbox", label: "Triage" });
  for (const id of Object.keys(MANY)) expect(await countOf(page, id)).toBe(String(MANY[id].length));
  await expect(bar(page)).toHaveCount(0);
  await expect(secs(page)).toHaveCount(0);
  await expect(page.locator(".ghnt-coverage")).toHaveText("Counts cover the 32 loaded notifications; more pages not loaded.");
  await expect(cat(page, "attention")).toHaveAttribute("aria-label", "Needs attention, 8 of 32 loaded notifications");
});

test("selecting a category only hides rows (nothing moves), says how many, Clear triage and the same click bring them back", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  const order = () => page.locator("li.notifications-list-item").evaluateAll((els) => els.map((e) => e.querySelector("a.notification-list-item-link").textContent));
  const before = await order();
  await cat(page, "waiting").click();
  await expect(visibleRows(page)).toHaveCount(4);
  expect(await visibleRows(page).evaluateAll((els) => els.map((e) => e.querySelector("a.notification-list-item-link").textContent))).toEqual(MANY.waiting.map(titleOf));
  expect(await order()).toEqual(before);
  await expect(page.locator(".ghnt-status")).toContainText("Waiting · 4 of 32 loaded");
  await expect(cat(page, "waiting")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Clear triage" }).click();
  await expect(visibleRows(page)).toHaveCount(32);
  await cat(page, "unverifiable").click();
  await expect(visibleRows(page)).toHaveCount(4);
  await cat(page, "unverifiable").click();
  await expect(visibleRows(page)).toHaveCount(32);
  await expect(page.locator(".ghnt-status")).toHaveCount(0);
});

test("an empty category says it covers only the loaded rows, never 'all clear'", async ({ context, page }) => {
  const { world } = await boot(context, page); // the 6-row set: nothing is Waiting
  await settled(world);
  await cat(page, "waiting").click();
  await expect(visibleRows(page)).toHaveCount(0);
  const text = await page.locator(".ghnt-status").innerText();
  expect(text).toContain("No match among the loaded notifications.");
  expect(text).not.toMatch(/all clear|nothing to do/i);
  await expect(page.locator(".ghnt-coverage")).toContainText("more pages not loaded");
});

test("while facts load, counts show an ellipsis and the list says 'Classifying N…'; pending rows are in no category", async ({ context, page }) => {
  const { world } = await boot(context, page, { delay: 1500 });
  await expect(page.locator(".ghnt-pending")).toContainText(/Classifying \d+ notifications?…/);
  await cat(page, "attention").click();
  await expect(visibleRows(page)).toHaveCount(0);
  await settled(world);
  await expect(page.locator(".ghnt-pending")).toHaveCount(0);
  await expect(visibleRows(page)).not.toHaveCount(0);
});

test("a native filter keeps working with a category selected: pagination re-counts the new rows and keeps the selection", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await settled(world);
  await cat(page, "attention").click();
  const before = await state(world);
  await page.click("a#next");
  await expect.poll(async () => (await state(world)).items.map((i) => i.key).join()).toContain("acme/web#300");
  await settled(world);
  await expect(cat(page, "attention")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ghnt-coverage")).toHaveText("Counts cover the 2 loaded notifications.");
  const after = await state(world);
  expect(after.items.map((i) => i.key)).not.toEqual(before.items.map((i) => i.key));
  await expect(visibleRows(page)).toHaveCount(after.items.filter((i) => i.section === "attention").length);
});

test("switching layouts in the panel leaves exactly one layout and the rows in their native order", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  const rowsHtml = () => page.locator("li.notifications-list-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-notification-id")).join());
  const native = await rowsHtml();
  const layoutNow = () => page.evaluate(() => ({ nav: document.querySelectorAll('[data-ghnt-triage="nav"]').length, bar: document.querySelectorAll('[data-ghnt-triage="quickbar"]').length, secs: document.querySelectorAll("li.ghnt-sec").length }));
  expect(await layoutNow()).toEqual({ nav: 1, bar: 0, secs: 0 });
  await page.locator(".ghnt-triage-btn").click();
  await page.getByRole("radio", { name: "Quick bar" }).check({ force: true });
  await expect.poll(layoutNow).toEqual({ nav: 0, bar: 1, secs: 0 });
  await page.getByRole("radio", { name: "Grouped sections" }).check({ force: true });
  await expect.poll(layoutNow).toEqual({ nav: 0, bar: 0, secs: 4 });
  await page.getByRole("radio", { name: "Integrated navigation" }).check({ force: true });
  await expect.poll(layoutNow).toEqual({ nav: 1, bar: 0, secs: 0 });
  expect(await rowsHtml()).toBe(native);
  expect((await stored(context, "ghntLayout")).ghntLayout).toBe("integrated");
});

test("Show native inbox and Triage off remove everything and restore the page exactly", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntNativeInbox: true } });
  const region = () => page.evaluate(() => document.querySelector(".layout").outerHTML);
  await page.waitForTimeout(600);
  const native = await region();
  expect(await everything(page).count()).toBe(0);
  await seedStorage(context, { ghntNativeInbox: false, ghntLayout: "grouped" });
  await expect(secs(page)).toHaveCount(4);
  await seedStorage(context, { ghntNativeInbox: true });
  await expect(secs(page)).toHaveCount(0);
  expect(await region()).toBe(native);
  await seedStorage(context, { ghntNativeInbox: false, ghntLayout: "quickbar" });
  await expect(bar(page)).toHaveCount(1);
  await cat(page, "waiting").click();
  await seedStorage(context, { ghntModules: { triage: false } });
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator(".ghnt-off")).toHaveCount(0);
  expect(await region()).toBe(native);
  expect(await world.evaluate("GHNotifications.registry.list().find((m) => m.id === 'triage').started")).toBe(false);
});

test("anchors: no sidebar at a wide viewport inserts nothing anywhere; it appears when the sidebar does", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await settled(world);
  await expect(nav(page)).toHaveCount(1);
  await page.evaluate(() => {
    window.__side = document.querySelector('nav[aria-label="Notifications"]');
    window.__side.remove();
  });
  await expect(nav(page)).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.locator('[data-ghnt-triage]:not([data-ghnt-triage="status"]):not([data-ghnt-triage="coverage"])')).toHaveCount(0);
  await expect(compact(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => document.querySelector(".layout").prepend(window.__side));
  await expect(nav(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelector('nav[aria-label="Notifications"]').firstElementChild.getAttribute("aria-label"))).toBe("Triage");
});

test("GitHub re-rendering the sidebar: the group is rebuilt once, no duplicate", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await settled(world);
  await page.evaluate(() => {
    const side = document.querySelector('nav[aria-label="Notifications"]');
    const clone = side.cloneNode(true); // carries a dead copy of our group
    window.__dead = clone.querySelector('[data-ghnt-triage="nav"]');
    side.replaceWith(clone);
  });
  await expect.poll(() => page.evaluate(() => { const all = document.querySelectorAll('[data-ghnt-triage="nav"]'); return all.length === 1 && all[0] !== window.__dead; })).toBe(true);
  await cat(page, "informational").click();
  await expect(cat(page, "informational")).toHaveAttribute("aria-pressed", "true");
});

test("Grouped sections live inside GitHub's one native list: no new ul, headers are inert, the row order is the visual order", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  await expect(secs(page)).toHaveCount(4);
  const shape = await page.evaluate(() => {
    const lists = [...document.querySelectorAll("ul.js-navigation-container")];
    const ul = lists[0];
    return {
      lists: lists.length,
      uls: document.querySelectorAll(".js-check-all-container ul.js-navigation-container, .js-check-all-container > .Box ul.ghnt-x").length,
      headersInside: [...document.querySelectorAll("li.ghnt-sec")].every((h) => h.parentElement === ul),
      rowsInside: [...document.querySelectorAll("li.notifications-list-item")].every((r) => r.parentElement === ul),
      headerNav: [...document.querySelectorAll("li.ghnt-sec")].some((h) => h.classList.contains("js-navigation-item")),
      cls: ul.className,
      unreadBg: getComputedStyle(document.querySelector("li.notification-unread")).backgroundColor,
      seq: [...ul.children].filter((c) => c.matches("li.ghnt-sec, li.js-navigation-item")).map((c) => (c.matches(".ghnt-sec") ? "H:" + c.getAttribute("data-ghnt-sec") : +c.querySelector("a.notification-list-item-link").textContent.replace(/\D/g, ""))),
    };
  });
  expect(shape.lists).toBe(1);
  expect(shape.headersInside && shape.rowsInside && !shape.headerNav).toBe(true);
  expect(shape.cls).toContain("color-bg-subtle");
  expect(shape.unreadBg).not.toBe("rgba(0, 0, 0, 0)");
  const expected = ["attention", "waiting", "informational", "unverifiable"].flatMap((id) => ["H:" + id, ...MANY[id]]);
  expect(shape.seq).toEqual(expected);
  // Within a section the rows keep their native relative order.
  await expect(secs(page).first().locator(".ghnt-count")).toHaveText("8");
});

test("Grouped: a moved row's checkbox and own action buttons still respond; check-all selects every visible row", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  await page.evaluate(() => {
    window.__done = [];
    document.addEventListener("click", (e) => { const b = e.target.closest("[data-action]"); if (b) window.__done.push(b.dataset.action + ":" + b.closest("li.notifications-list-item").dataset.notificationId); });
  });
  const row9 = page.locator('li[data-notification-id="NT_9"]');
  await row9.locator('[data-action="done"]').click();
  await row9.locator(".js-notifications-list-item-check").check();
  expect(await page.evaluate(() => window.__done)).toEqual(["done:NT_9"]);
  await expect(row9.locator(".js-notifications-list-item-check")).toBeChecked();
  await page.locator(".js-check-all").check();
  expect(await page.locator("li.notifications-list-item .js-notifications-list-item-check:checked").count()).toBe(32);
});

test("Grouped: collapsing hides the rows of a section, survives a reload, and the headers answer arrow keys", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  const head = (id) => page.locator(`.ghnt-sec-btn[data-ghnt-sec="${id}"]`);
  await head("informational").click();
  await expect(head("informational")).toHaveAttribute("aria-expanded", "false");
  await expect(visibleRows(page)).toHaveCount(32 - 16);
  expect((await stored(context, "ghntTriageCollapsed")).ghntTriageCollapsed).toEqual({ informational: true });
  await page.reload();
  await settled(await isolatedWorld(context, page));
  await expect(head("informational")).toHaveAttribute("aria-expanded", "false");
  await expect(visibleRows(page)).toHaveCount(16);
  await expect(head("attention")).toHaveAttribute("aria-expanded", "true");
  await head("attention").focus();
  await page.keyboard.press("ArrowDown");
  await expect(head("waiting")).toBeFocused();
  await page.keyboard.press("End");
  await expect(head("unverifiable")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(head("attention")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(head("unverifiable")).toBeFocused();
  await head("informational").click();
  await expect(visibleRows(page)).toHaveCount(32);
  expect((await stored(context, "ghntTriageCollapsed")).ghntTriageCollapsed).toEqual({ informational: false });
});

test("Grouped: a reclassified row moves without a scroll jump and is highlighted; leaving Grouped restores the native order exactly", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  const native = Array.from({ length: 32 }, (_, i) => `NT_${i + 1}`);
  await page.locator('li[data-notification-id="NT_20"]').scrollIntoViewIfNeeded();
  // The first visible row that keeps its section (the quiet ones: n % 8 in 3, 4, 7, 0).
  const stayId = await page.evaluate(() => [...document.querySelectorAll("li.notifications-list-item")].filter((li) => [3, 4, 7, 0].includes(Number(li.dataset.notificationId.slice(3)) % 8)).find((li) => li.getBoundingClientRect().bottom > 0).dataset.notificationId);
  const viewportTop = () => page.evaluate((id) => Math.round(document.querySelector(`li[data-notification-id="${id}"]`).getBoundingClientRect().top), stayId);
  const before = await viewportTop();
  expect(before).toBeLessThan(700);
  // The mention window shrinks to one day: the mentions leave Needs attention.
  await seedStorage(context, { ghntMentionWindowDays: 1 });
  await expect.poll(async () => (await countOfSec(page, "attention"))).toBe("4");
  await expect(page.locator("li.ghnt-moved").first()).toBeVisible();
  expect(Math.abs((await viewportTop()) - before), `${stayId} stays where it is on screen`).toBeLessThanOrEqual(1);
  await expect(page.locator("li.ghnt-moved")).toHaveCount(0, { timeout: 6000 });
  await seedStorage(context, { ghntLayout: "integrated" });
  await expect(secs(page)).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("li.notifications-list-item")].map((e) => e.dataset.notificationId))).toEqual(native);
  expect(await page.evaluate(() => document.createNodeIterator(document.querySelector("ul.js-navigation-container"), NodeFilter.SHOW_COMMENT).nextNode())).toBeNull();
});
const countOfSec = async (page, id) => (await page.locator(`.ghnt-sec-btn[data-ghnt-sec="${id}"] .ghnt-count`).innerText()).trim();

test("Grouped with Group by Repository: sections are built in the first list, emptied boxes are hidden and come back", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#repo`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  await expect(secs(page)).toHaveCount(4);
  const boxes = () => page.locator(".js-check-all-container > .Box").evaluateAll((els) => els.map((e) => e.classList.contains("ghnt-off")));
  await expect.poll(boxes).toEqual([false, true]);
  await seedStorage(context, { ghntLayout: "quickbar" });
  await expect(secs(page)).toHaveCount(0);
  await expect(page.locator("li.notifications-list-item")).toHaveCount(32);
  expect(await boxes()).toEqual([false, false]);
  expect(await page.locator(".js-check-all-container > .Box").evaluateAll((els) => els.map((e) => e.querySelectorAll("li.notifications-list-item").length))).toEqual([16, 16]);
  // Filter modes hide a box with no visible row.
  await cat(page, "waiting").click();
  expect(await boxes()).toEqual([false, false]); // waiting rows 5,13 in the first box; 21,29 in the second
  await cat(page, "unverifiable").click();
  await cat(page, "attention").click();
  await expect(visibleRows(page)).toHaveCount(8);
});

test("keyboard on all three layouts: Tab reaches the controls, Enter and Space select, no GitHub shortcut key is bound", async ({ context, page }) => {
  for (const layout of ["integrated", "quickbar"]) {
    const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: layout } });
    await settled(world);
    await cat(page, "waiting").focus();
    await page.keyboard.press("Enter");
    await expect(visibleRows(page)).toHaveCount(4);
    await expect(cat(page, "waiting")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(visibleRows(page)).toHaveCount(32);
    await expect(cat(page, "waiting")).toBeFocused();
    await page.goto("about:blank");
    await context.unroute("https://api.github.com/**");
  }
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped" } });
  await settled(world);
  const keys = await page.evaluate(() => { window.__keys = []; document.addEventListener("keydown", (e) => window.__keys.push(e.defaultPrevented), true); document.addEventListener("keydown", (e) => window.__keys.push(e.defaultPrevented)); return true; });
  expect(keys).toBe(true);
  for (const k of ["j", "k", "x", "e", "Enter"]) await page.keyboard.press(k);
  expect((await page.evaluate(() => window.__keys)).some(Boolean)).toBe(false);
});

test("no token: rows land in Unverifiable, the coverage line is shown, nothing claims complete coverage", async ({ context, page }) => {
  const { world, requests } = await boot(context, page, { url: `${INBOX}#many`, tokens: false });
  await settled(world);
  expect(requests).toEqual([]);
  expect(await countOf(page, "attention")).toBe("0");
  expect(await countOf(page, "unverifiable")).toBe("16");
  await expect(page.locator(".ghnt-coverage")).toContainText("more pages not loaded");
});

test("soft navigation: inbox -> repository -> back/forward keeps exactly one Triage UI, and leaving removes it", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: "https://github.com/acme/web" });
  await expect(everything(page)).toHaveCount(0);
  await page.click("a#bell");
  await settled(world);
  await expect(nav(page)).toHaveCount(1);
  await cat(page, "informational").click();
  await page.goBack();
  await expect(everything(page)).toHaveCount(0);
  await page.goForward();
  await settled(world);
  await expect(nav(page)).toHaveCount(1);
  await expect(cat(page, "informational")).toHaveAttribute("aria-pressed", "false"); // the selection resets on leaving the inbox
  await page.goto("https://github.com/notifications/subscriptions");
  await page.waitForTimeout(500);
  await expect(everything(page)).toHaveCount(0);
});

test("native look: the Triage items match the native ActionList item (33px, radius, font); pills match a medium button (32px, 6px, 1px)", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  const m = (loc) => loc.evaluate((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { h: r.height, radius: c.borderTopLeftRadius, font: c.fontSize + " " + c.lineHeight, family: c.fontFamily, pad: c.paddingLeft }; });
  const native = await m(page.locator('nav[aria-label="Inbox"] a').first());
  const mine = await m(cat(page, "attention"));
  expect(mine).toMatchObject({ h: native.h, radius: native.radius, font: native.font, pad: native.pad });
  expect(mine.family).toBe(native.family);
  await seedStorage(context, { ghntLayout: "quickbar" });
  await expect(bar(page)).toHaveCount(1);
  const btn = await m(page.locator(".filters-row .Button").last());
  const pill = await m(cat(page, "attention"));
  expect(pill).toMatchObject({ h: btn.h, radius: btn.radius, font: btn.font });
  expect(await cat(page, "attention").evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("1px");
  // Hover darkens and keyboard focus shows a 2px ring.
  const rest = await cat(page, "waiting").evaluate((e) => getComputedStyle(e).backgroundColor);
  await cat(page, "waiting").hover();
  await expect.poll(() => cat(page, "waiting").evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(rest);
  await cat(page, "waiting").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await cat(page, "waiting").evaluate((e) => getComputedStyle(e).outlineWidth)).toBe("2px");
});

for (const scheme of ["light", "dark"]) {
  test(`layout matrix (${scheme}): no page scroll, nothing clipped, compact row exactly where GitHub hides its sidebar`, async ({ context, page }) => {
    const { world } = await boot(context, page, { url: `${INBOX}#many`, scheme, viewport: { width: 1280, height: 800 } });
    await settled(world);
    const sidebarWidth = { 768: 184, 1011: 245, 1012: 163, 1280: 208 };
    for (const width of [320, 600, 767, 768, 900, 1011, 1012, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const layout of ["integrated", "quickbar", "grouped"]) {
        await seedStorage(context, { ghntLayout: layout });
        if (layout === "grouped") await expect(secs(page)).toHaveCount(4);
        else await expect(layout === "integrated" ? (width < 768 ? compact(page) : nav(page)) : bar(page)).toHaveCount(1);
        const why = `${scheme} ${width} ${layout}`;
        const geo = await page.evaluate(() => {
          const de = document.documentElement;
          const outside = [...document.querySelectorAll("[data-ghnt-triage] button")].filter((b) => b.getClientRects().length && !b.closest(".ghnt-compact")).some((b) => { const r = b.getBoundingClientRect(); return r.right > de.clientWidth + 0.5 || r.left < -0.5; });
          const side = document.querySelector('nav[aria-label="Notifications"]');
          const counts = [...document.querySelectorAll("[data-ghnt-triage] .ghnt-count")].filter((c) => c.getClientRects().length);
          const clipped = counts.some((c) => { const p = c.parentElement.getBoundingClientRect(); const r = c.getBoundingClientRect(); return r.right > p.right + 0.5 || r.width < 18; });
          return { scrollW: de.scrollWidth, clientW: de.clientWidth, outside, sideW: side && side.getClientRects().length ? Math.round(side.getBoundingClientRect().width) : 0, navCount: document.querySelectorAll('[data-ghnt-triage="nav"]').length, compactCount: document.querySelectorAll('[data-ghnt-triage="compact"]').length, clipped };
        });
        expect(geo.scrollW, why + JSON.stringify(geo)).toBeLessThanOrEqual(geo.clientW);
        expect(geo.outside, why).toBe(false);
        expect(geo.clipped, why).toBe(false);
        if (layout === "integrated") {
          expect({ nav: geo.navCount, compact: geo.compactCount }, why).toEqual(width < 768 ? { nav: 0, compact: 1 } : { nav: 1, compact: 0 });
          if (sidebarWidth[width]) expect(geo.sideW, why).toBe(sidebarWidth[width]);
        }
      }
    }
  });
}

test("the narrowest sidebar (163px at 1012): the label ellipsizes, the counter stays whole", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, viewport: { width: 1012, height: 800 } });
  await settled(world);
  const item = cat(page, "attention");
  const geo = await item.evaluate((e) => { const l = e.querySelector(".ghnt-label"); const c = e.querySelector(".ghnt-count"); const r = e.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return { sideW: Math.round(e.closest('nav[aria-label="Notifications"]').getBoundingClientRect().width), label: getComputedStyle(l).textOverflow, countFits: cr.right <= r.right + 0.5 && cr.width >= 20, countFlex: getComputedStyle(c).flexShrink }; });
  expect(geo).toEqual({ sideW: 163, label: "ellipsis", countFits: true, countFlex: "0" });
  // A 3-digit count shows as 99+, whole.
  await page.evaluate(() => { const c = document.querySelector('[data-ghnt-cat="attention"] .ghnt-count'); c.textContent = "99+"; });
  expect(await item.evaluate((e) => { const c = e.querySelector(".ghnt-count").getBoundingClientRect(); return c.right <= e.getBoundingClientRect().right + 0.5; })).toBe(true);
});

test("the compact row below 768px scrolls inside itself, never the page", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, viewport: { width: 320, height: 700 } });
  await settled(world);
  await expect(compact(page)).toHaveCount(1);
  const g = await compact(page).evaluate((e) => ({ canScroll: e.scrollWidth > e.clientWidth, overflowX: getComputedStyle(e).overflowX, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
  expect(g).toEqual({ canScroll: true, overflowX: "auto", page: true });
});

test("select-all never selects rows the view hides (filtered or collapsed), so a bulk action cannot reach them", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  await cat(page, "waiting").click();
  await expect(visibleRows(page)).toHaveCount(4);
  await page.locator(".js-check-all").check();
  await expect.poll(() => page.locator("li.notifications-list-item .js-notifications-list-item-check:checked").count()).toBe(4);
  await page.locator(".js-check-all").uncheck();
  await seedStorage(context, { ghntLayout: "grouped" });
  await expect(secs(page)).toHaveCount(4);
  await page.locator('.ghnt-sec-btn[data-ghnt-sec="informational"]').click();
  await expect(visibleRows(page)).toHaveCount(16);
  await page.locator(".js-check-all").check();
  await expect.poll(() => page.locator("li.notifications-list-item .js-notifications-list-item-check:checked").count()).toBe(16);
});

test("a restored Turbo snapshot carries no hidden rows and no grouped order", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many` });
  await settled(world);
  await cat(page, "informational").click();
  await expect(visibleRows(page)).toHaveCount(16);
  // Turbo caches the page before leaving it.
  await page.evaluate(() => { document.dispatchEvent(new Event("turbo:before-cache")); window.__snap = document.getElementById("main").innerHTML; });
  await expect(page.locator(".ghnt-off")).toHaveCount(0);
  await expect(everything(page)).toHaveCount(0);
  await seedStorage(context, { ghntLayout: "grouped" });
  await expect(secs(page)).toHaveCount(4);
  await page.evaluate(() => document.dispatchEvent(new Event("turbo:before-cache")));
  expect(await page.evaluate(() => [...document.querySelectorAll("li.notifications-list-item")].map((e) => e.dataset.notificationId))).toEqual(Array.from({ length: 32 }, (_, i) => `NT_${i + 1}`));
  await expect(secs(page)).toHaveCount(0);
  await expect(page.locator("ul.js-navigation-container").evaluate((ul) => document.createNodeIterator(ul, NodeFilter.SHOW_COMMENT).nextNode())).resolves.toBeNull();
  await expect(secs(page)).toHaveCount(4); // and the view comes back
});

test("Grouped: rows still being classified are hidden, not shown under a collapsed Unverifiable header", async ({ context, page }) => {
  const { world } = await boot(context, page, { url: `${INBOX}#many`, storage: { ghntLayout: "grouped", ghntTriageCollapsed: { unverifiable: true } }, delay: 2500 });
  await expect(page.locator(".ghnt-pending")).toBeVisible();
  const pendingVisible = await page.locator("li.notifications-list-item:visible").evaluateAll((els) => els.length);
  const classified = await page.locator("li.ghnt-sec ~ li.notifications-list-item:visible").count();
  expect(pendingVisible).toBe(classified);
  await settled(world);
  await expect(page.locator(".ghnt-pending")).toHaveCount(0);
  await expect(visibleRows(page)).toHaveCount(32 - 4);
});

test("Clear triage by keyboard keeps focus on the category that was selected", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await settled(world);
  await cat(page, "attention").click();
  await page.getByRole("button", { name: "Clear triage" }).focus();
  await page.keyboard.press("Enter");
  await expect(cat(page, "attention")).toBeFocused();
});
