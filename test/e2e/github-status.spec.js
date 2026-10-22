// E2E: GitHub Status. A status badge on the logo's corner on every page, a native
// popover panel with what githubstatus.com reports, an incident pill in the
// header only for an open incident that concerns the page. Covers anchors on
// both header generations (no container fallback), per-update dismissal, SPA
// navigation, stale and unreachable feeds, what is sent, light and dark, and
// the header's size at narrow widths. All names are invented.
import { test, expect, routeGithub, routeStatus, statusFeed, statusIncident, seedStorage, backgroundWorker } from "./support/extension.js";

const ACTIONS = "https://github.com/acme/web/actions";
const PR = "https://github.com/acme/web/pull/7";

const actionsFeed = (over = {}) =>
  statusFeed({
    status: { indicator: "minor", description: "Minor Service Outage" },
    components: statusFeed().components.map((c) => (c.name === "Actions" ? { ...c, status: "degraded_performance" } : c)),
    incidents: [statusIncident()],
    ...over,
  });
const copilotFeed = () =>
  statusFeed({
    status: { indicator: "minor", description: "Minor" },
    components: statusFeed().components.map((c) => (c.name === "Copilot" ? { ...c, status: "degraded_performance" } : c)),
    incidents: [statusIncident({ id: "cp", name: "Incident with Copilot", components: [{ name: "Copilot" }] })],
  });

async function setup(context, page, { feed = statusFeed(), fixture = "header-signed-in.html", storage, url = ACTIONS, status, fail, go = true, transform, delay, init } = {}) {
  const log = [];
  if (storage) await seedStorage(context, storage);
  if (init) await page.addInitScript(init);
  await routeStatus(context, { json: feed, log, status, fail, delay });
  await routeGithub(context, fixture, { transform });
  if (go) await page.goto(url);
  return log;
}

const dot = (page) => page.locator("#ghgs-dot");
const pill = (page) => page.locator("#ghgs-pill");
const panel = (page) => page.locator("#ghgs-panel");

test("the dot sits right after the logo in the same row, and the logo is untouched", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toHaveAttribute("data-state", "ok");
  const logo = page.locator("header a.AppHeader-logo");
  expect(await logo.evaluate((a) => a.nextElementSibling.id)).toBe("ghgs-dot");
  expect(await logo.evaluate((a) => a.parentElement === document.getElementById("ghgs-dot").parentElement)).toBe(true);
  const before = await logo.boundingBox();
  await dot(page).evaluate((d) => d.remove());
  const after = await logo.boundingBox();
  expect(before).toEqual(after);
  await expect(logo).toHaveAttribute("href", "/");
  // The row's own gap spaces the dot: no margin of ours.
  expect(await dot(page).evaluate((d) => getComputedStyle(d).margin)).toBe("0px");
});

const box = (page, sel) => page.locator(sel).evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, right: r.right, bottom: r.bottom }; });
const LOGO = "header a.AppHeader-logo";
const OUT_LOGO = 'header a[aria-label="Homepage"]';

for (const [name, fixture, logo] of [["signed-in", "header-signed-in.html", LOGO], ["signed-out", "header-signed-out.html", OUT_LOGO]]) {
  test(`the badge overlaps the logo's bottom-right corner (${name})`, async ({ page, context }) => {
    await setup(context, page, { fixture });
    await expect(dot(page)).toBeVisible();
    const l = await box(page, logo);
    const m = await box(page, "#ghgs-dot .ghgs-dot-mark");
    const info = JSON.stringify({ l, m });
    expect(m.cx > l.x && m.cx < l.right && m.cy > l.y && m.cy < l.bottom, info).toBe(true);
    expect(Math.hypot(m.cx - l.right, m.cy - l.bottom), info).toBeLessThanOrEqual(6);
    expect(await dot(page).evaluate((d) => getComputedStyle(d).position)).toBe("absolute");
    expect(await page.locator(logo).evaluate((a) => a.nextElementSibling.id)).toBe("ghgs-dot");
    const d = await box(page, "#ghgs-dot");
    expect([d.w, d.h]).toEqual([16, 16]);
  });
}

test("the badge reserves no room in the header row: the breadcrumb does not move when it is removed", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toBeVisible();
  const ctx = ".AppHeader-context";
  const with_ = await box(page, ctx);
  const logoBefore = await box(page, LOGO);
  await dot(page).evaluate((d) => d.remove());
  expect(await box(page, ctx)).toEqual(with_);
  expect(await box(page, LOGO)).toEqual(logoBefore);
  // 8px gap after the logo, as GitHub lays it out (no 24px slot + second gap).
  expect(with_.x - logoBefore.right).toBe(8);
});

for (const [mode, ring] of [["light", "rgb(246, 248, 250)"], ["dark", "rgb(21, 27, 35)"]]) {
  test(`the badge ring takes the header background (${mode})`, async ({ page, context }) => {
    await setup(context, page);
    await page.evaluate((m) => document.documentElement.setAttribute("data-color-mode", m), mode);
    await expect.poll(() => dot(page).evaluate((d) => getComputedStyle(d).getPropertyValue("--ghgs-ring").trim()), { timeout: 8000 }).not.toBe("");
    await expect.poll(() => dot(page).locator(".ghgs-dot-mark").evaluate((m) => getComputedStyle(m).boxShadow), { timeout: 8000 }).toContain(ring);
    expect(await dot(page).locator(".ghgs-dot-mark").evaluate((m) => getComputedStyle(m).boxShadow)).toMatch(/ 0px 0px 0px 2px/);
    expect(await page.locator("header").evaluate((h) => getComputedStyle(h).backgroundColor)).toBe(ring);
  });
}

test("a theme change repaints the ring without waiting for the next tick", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toHaveAttribute("data-state", "ok");
  await page.waitForTimeout(600); // let the first fetch and its scan settle
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("box-shadow", /rgb\(21, 27, 35\)/, { timeout: 2000 });
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "auto"));
  await page.emulateMedia({ colorScheme: "light" });
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("box-shadow", /rgb\(246, 248, 250\)/, { timeout: 2000 });
});

test("the unverified badge darkens on hover too", async ({ page, context }) => {
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  const mark = dot(page).locator(".ghgs-dot-mark");
  expect(await mark.evaluate((m) => getComputedStyle(m).backgroundImage)).toBe("none");
  await dot(page).hover();
  expect(await mark.evaluate((m) => getComputedStyle(m).backgroundImage)).toContain("rgba(0, 0, 0, 0.1)");
});

test("a change of only the light or dark theme variant repaints the ring", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toHaveAttribute("data-state", "ok");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-color-mode", "dark");
    const st = document.createElement("style");
    st.textContent = 'html[data-dark-theme="dark_dimmed"] header { background-color: rgb(38, 44, 54) !important; }';
    document.head.appendChild(st);
  });
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("box-shadow", /rgb\(21, 27, 35\)/, { timeout: 2000 });
  await page.evaluate(() => document.documentElement.setAttribute("data-dark-theme", "dark_dimmed"));
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("box-shadow", /rgb\(38, 44, 54\)/, { timeout: 2000 });
});

test("the badge ring is black on the signed-out header, read from the page", async ({ page, context }) => {
  await setup(context, page, { fixture: "header-signed-out.html" });
  await expect(dot(page)).toBeVisible();
  expect(await dot(page).locator(".ghgs-dot-mark").evaluate((m) => getComputedStyle(m).boxShadow)).toContain("rgb(0, 0, 0)");
});

test("the badge takes clicks only on its own circle", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toBeVisible();
  const r = await page.evaluate(() => {
    const logo = document.querySelector("header a.AppHeader-logo").getBoundingClientRect();
    const d = document.getElementById("ghgs-dot").getBoundingClientRect();
    const at = (x, y) => { const n = document.elementFromPoint(x, y); return n && (n.closest("#ghgs-dot") ? "dot" : n.closest("a.AppHeader-logo") ? "logo" : n.tagName); };
    return {
      logoCentre: at(logo.x + logo.width / 2, logo.y + logo.height / 2),
      logoTopLeft: at(logo.x + 2, logo.y + 2),
      dotCentre: at(d.x + d.width / 2, d.y + d.height / 2),
      // Inside the 16px box but outside its circle, over the logo.
      boxCorner: at(d.x + 1, d.y + 1),
    };
  });
  expect(r).toEqual({ logoCentre: "logo", logoTopLeft: "logo", dotCentre: "dot", boxCorner: "logo" });
});

test("the badge looks like a native round control: hover darkens, keyboard focus shows a 2px ring", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toBeVisible();
  const mark = dot(page).locator(".ghgs-dot-mark");
  const ringBefore = await mark.evaluate((m) => getComputedStyle(m).boxShadow);
  expect(await mark.evaluate((m) => getComputedStyle(m).backgroundImage)).toBe("none");
  await dot(page).hover();
  expect(await mark.evaluate((m) => getComputedStyle(m).backgroundImage)).toContain("rgba(0, 0, 0, 0.1)");
  // Hover darkens the fill only: the ring keeps matching the header.
  expect(await mark.evaluate((m) => getComputedStyle(m).boxShadow)).toBe(ringBefore);
  await page.mouse.move(5, 400);
  await page.keyboard.press("Tab");
  await dot(page).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(dot(page)).toBeFocused();
  const ring = await dot(page).evaluate((d) => { const c = getComputedStyle(d); return { w: c.outlineWidth, o: c.outlineOffset, style: c.outlineStyle, r: c.borderTopLeftRadius }; });
  expect(ring).toEqual({ w: "2px", o: "1px", style: "solid", r: "50%" });
});

for (const width of [1280, 768, 640, 375, 320]) {
  test(`the badge stays on the logo and inside the window at ${width}px`, async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
    await routeStatus(context, { json: statusFeed() });
    await routeGithub(context, "header-signed-in.html");
    await page.goto(ACTIONS);
    await expect(dot(page)).toBeVisible();
    // layout (anchor positioning, header reflow) can settle a frame after the dot shows: poll, and print the rects on failure
    let info = "";
    await expect.poll(async () => {
      const l = await box(page, LOGO);
      const d = await box(page, "#ghgs-dot");
      info = JSON.stringify({ l, d, width });
      return d.x >= 0 && d.right <= width && d.cx > l.x && d.cx < l.right && d.cy > l.y && d.cy < l.bottom + 2;
    }, { message: () => info }).toBe(true);
  });
}

test("signed-out header at 375px: the logo stays centred in the row", async ({ context }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 375, height: 800 });
  await routeStatus(context, { json: statusFeed() });
  await routeGithub(context, "header-signed-out.html");
  await page.goto(ACTIONS);
  await expect(dot(page)).toBeVisible();
  const row = await box(page, 'header [class*="topRow"]');
  const l = await box(page, OUT_LOGO);
  const d = await box(page, "#ghgs-dot");
  const info = JSON.stringify({ row, l, d });
  expect(Math.abs(l.cx - row.cx), info).toBeLessThanOrEqual(1);
  expect(Math.hypot(d.cx - l.right, d.cy - l.bottom), info).toBeLessThanOrEqual(8);
});

test("a replaced logo gets the badge back with a single anchor; switched off leaves no anchor on the logo", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toBeVisible();
  await expect(page.locator("[data-ghgs-logo]")).toHaveCount(1);
  await page.evaluate(() => { const a = document.querySelector("a.AppHeader-logo"); const c = a.cloneNode(true); c.removeAttribute("data-ghgs-logo"); a.replaceWith(c); });
  await expect.poll(() => page.locator("[data-ghgs-logo]").count()).toBe(1);
  await expect.poll(async () => { const l = await box(page, LOGO); const d = await box(page, "#ghgs-dot"); return Math.hypot(d.cx - l.right, d.cy - l.bottom) <= 6; }).toBe(true);
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghgsEnabled: false }));
  await expect(dot(page)).toHaveCount(0);
  await expect(page.locator("[data-ghgs-logo]")).toHaveCount(0);
});

test("the dot is a labelled button that opens with Enter and Space, closes with Esc and gives the focus back", async ({ page, context }) => {
  await setup(context, page);
  await expect(dot(page)).toHaveAttribute("aria-label", "GitHub Status: No incident reported. Open details");
  expect(await dot(page).evaluate((d) => d.tagName)).toBe("BUTTON");
  await dot(page).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  await expect(dot(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(dot(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(5, 400);
  await expect(panel(page)).toBeHidden();
});

test("the operational panel says no incident is reported, not that everything works", async ({ page, context }) => {
  await setup(context, page);
  await dot(page).click();
  await expect(panel(page)).toContainText("No incident reported on githubstatus.com — this is not a guarantee that everything works.");
  await expect(panel(page)).toContainText("GitHub Status · via GH Reloaded");
  await expect(panel(page).locator('a[href="https://www.githubstatus.com/"]')).toBeVisible();
  await expect(panel(page)).not.toContainText("Affected components");
});

test("the panel lists affected components, incidents, checked-at and the attribution", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await dot(page).click();
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await expect(panel(page)).toContainText("Minor incident");
  await expect(panel(page)).toContainText("Checked just now");
  await expect(panel(page).locator(".ghgs-list li")).toHaveCount(1);
  await expect(panel(page).locator(".ghgs-list li")).toContainText("Actions");
  await expect(panel(page).locator(".ghgs-list li")).toContainText("Degraded performance");
  await expect(panel(page)).toContainText("Incident with Actions");
  await expect(panel(page)).toContainText("Some workflow runs may be delayed.");
  await expect(panel(page).locator('a[href="https://www.githubstatus.com/incidents/inc1"]')).toBeVisible();
  await expect(panel(page)).toContainText("GitHub Status · via GH Reloaded");
});

test("a major outage turns the dot red", async ({ page, context }) => {
  await setup(context, page, { feed: statusFeed({ status: { indicator: "major", description: "x" } }) });
  await expect(dot(page)).toHaveAttribute("data-state", "major");
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("background-color", "rgb(207, 34, 46)");
});

test("an in-progress maintenance is amber and listed; it never gets a pill", async ({ page, context }) => {
  const maintenance = statusIncident({ id: "m", name: "Database maintenance", status: "in_progress", impact: "maintenance", components: [{ name: "Actions" }] });
  await setup(context, page, { feed: statusFeed({ scheduled_maintenances: [maintenance] }) });
  await expect(dot(page)).toHaveAttribute("data-state", "maintenance");
  await page.waitForTimeout(300);
  await expect(pill(page)).toHaveCount(0);
  await dot(page).click();
  await expect(panel(page)).toContainText("Maintenance in progress");
  await expect(panel(page)).toContainText("Database maintenance");
});

test("an unreachable feed: gray dot, Unverified, no pill", async ({ page, context }) => {
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  await expect(pill(page)).toHaveCount(0);
  await dot(page).click();
  await expect(panel(page)).toContainText("Unverified");
  await expect(panel(page)).toContainText("githubstatus.com could not be reached.");
  await expect(panel(page).getByRole("button", { name: "Retry" })).toBeVisible();
  const mark = await dot(page).locator(".ghgs-dot-mark").evaluate((m) => { const c = getComputedStyle(m); return { bg: c.backgroundColor, w: c.borderTopWidth }; });
  // A solid gray fill, no border, like the other states.
  expect(mark).toEqual({ bg: "rgb(110, 119, 129)", w: "0px" });
});

test("after a failed check the next ticks retry on the background backoff, not after five minutes", async ({ page, context }) => {
  // The content script's timers live in the isolated world, which a fake clock does not reach: this waits one real 30 s tick.
  test.setTimeout(90_000);
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  // The feed recovers and the background backoff has elapsed.
  await routeStatus(context, { json: statusFeed() });
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    const { ghgsCache } = await chrome.storage.session.get("ghgsCache");
    await chrome.storage.session.set({ ghgsCache: { ...ghgsCache, retryAt: 0 } });
  });
  await expect(dot(page)).toHaveAttribute("data-state", "ok", { timeout: 45_000 });
});

test("a malformed feed is treated as unreachable, never as green", async ({ page, context }) => {
  await setup(context, page, { feed: { hello: "world" } });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
});

test("a snapshot older than 15 minutes is gray, labelled with its age", async ({ page, context }) => {
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ ghgsCache: { snapshot: { indicator: "none", description: "", updatedAt: "", components: [], incidents: [], maintenances: [] }, fetchedAt: Date.now() - 22 * 60_000, failures: 0, retryAt: 0 } });
  });
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  await dot(page).click();
  await expect(panel(page)).toContainText("Last verified 22 min ago");
});

test("a Copilot incident on a PR page: amber dot, no pill", async ({ page, context }) => {
  await setup(context, page, { feed: copilotFeed(), url: PR });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await page.waitForTimeout(400);
  await expect(pill(page)).toHaveCount(0);
  await dot(page).click();
  await expect(panel(page)).toContainText("Incident with Copilot");
});

test("an Actions incident on an Actions page shows the pill before the search control", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toContainText("Actions");
  await expect(pill(page)).toContainText("degraded performance");
  expect(await pill(page).evaluate((p) => p.nextElementSibling.tagName.toLowerCase())).toBe("qbsearch-input");
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
  await expect(pill(page).getByRole("button", { name: "GitHub Status: Actions, degraded performance. Open details" })).toBeVisible();
  await pill(page).locator(".ghgs-pill-main").click();
  await expect(panel(page)).toContainText("Incident with Actions");
});

test("dismiss hides the pill, keeps the incident in the panel and returns the focus to the dot", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  const close = pill(page).getByRole("button", { name: /^Dismiss notice/ });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(pill(page)).toHaveCount(0);
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
  await expect(dot(page)).toBeFocused();
  await dot(page).click();
  await expect(panel(page)).toContainText("Incident with Actions");
  const stored = await (await backgroundWorker(context)).evaluate(() => chrome.storage.local.get("ghgsDismissed"));
  expect(stored.ghgsDismissed).toEqual({ inc1: "2026-10-20T06:38:00Z" });
});

test("a dismissed incident stays dismissed on reload, and comes back with a newer update", async ({ page, context }) => {
  let feed = actionsFeed();
  await setup(context, page, { feed: () => feed, storage: { ghgsDismissed: { inc1: "2026-10-20T06:38:00Z" } } });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await page.waitForTimeout(300);
  await expect(pill(page)).toHaveCount(0);
  feed = actionsFeed({ incidents: [statusIncident({ updated_at: "2026-10-20T06:55:00Z" })] });
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.session.remove("ghgsCache"));
  await page.reload();
  await expect(pill(page)).toBeVisible();
});

test("a resolved incident removes the pill and its dismissal", async ({ page, context }) => {
  let feed = actionsFeed();
  await setup(context, page, { feed: () => feed, storage: { ghgsDismissed: { inc1: "old", gone: "x" } } });
  await expect(pill(page)).toBeVisible();
  feed = statusFeed();
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.session.remove("ghgsCache"));
  await page.reload();
  await expect(dot(page)).toHaveAttribute("data-state", "ok");
  await expect(pill(page)).toHaveCount(0);
  await expect.poll(async () => (await worker.evaluate(() => chrome.storage.local.get("ghgsDismissed"))).ghgsDismissed).toEqual({});
});

test("SPA navigation: /actions adds the pill, a PR page removes it, back brings it again, never duplicated", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), url: "https://github.com/acme/web/issues/3" });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await expect(pill(page)).toHaveCount(0);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/actions"));
  await expect(pill(page)).toBeVisible();
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7"));
  await expect(pill(page)).toHaveCount(0);
  await page.goBack();
  await expect(pill(page)).toBeVisible();
  await page.goForward();
  await expect(pill(page)).toHaveCount(0);
  await expect(page.locator("#ghgs-dot")).toHaveCount(1);
  await expect(page.locator("#ghgs-panel")).toHaveCount(1);
});

test("the dot and pill are not duplicated when GitHub re-renders the header", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  await page.evaluate(() => { const h = document.querySelector("header"); h.replaceWith(h.cloneNode(true)); });
  await expect(page.locator("#ghgs-dot")).toHaveCount(1);
  await expect(page.locator("#ghgs-pill")).toHaveCount(1);
});

test("the dismiss button still works after GitHub replaces the header with a copy", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  await page.evaluate(() => { const h = document.querySelector("header"); document.getElementById("ghgs-pill").dataset.copy = "1"; h.replaceWith(h.cloneNode(true)); });
  await expect(page.locator("#ghgs-pill:not([data-copy])")).toBeVisible();
  await page.locator("#ghgs-pill .ghgs-pill-close").click();
  await expect(pill(page)).toHaveCount(0);
});

test("an open panel stays inside the viewport when the window is narrowed", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await dot(page).click();
  await expect(page.locator("#ghgs-panel")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => page.locator("#ghgs-panel").evaluate((p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
});

test("signed-out header: the dot is the next sibling of the logo in topRow, and no pill is invented", async ({ page, context }) => {
  await setup(context, page, { fixture: "header-signed-out.html", feed: actionsFeed() });
  await expect(dot(page)).toBeVisible();
  const info = await page.locator('header a[aria-label="Homepage"]').evaluate((a) => ({ next: a.nextElementSibling.id, parent: a.parentElement.className }));
  expect(info.next).toBe("ghgs-dot");
  expect(info.parent).toContain("topRow__");
  await page.waitForTimeout(300);
  await expect(pill(page)).toHaveCount(0);
});

test("no logo: nothing is inserted, and the dot appears once the logo does", async ({ page, context }) => {
  await setup(context, page, { transform: (h) => h.replace(/<a class="AppHeader-logo"[\s\S]*?<\/a>/, '<span id="slot"></span>') });
  await page.waitForTimeout(500);
  await expect(dot(page)).toHaveCount(0);
  await page.evaluate(() => document.getElementById("slot").outerHTML = '<a class="AppHeader-logo" href="/" aria-labelledby="x"><svg class="octicon octicon-mark-github" width="32" height="32"></svg></a>');
  await expect(dot(page)).toBeVisible();
});

test("the logo is found by its octicon when the link is not /", async ({ page, context }) => {
  await setup(context, page, { transform: (h) => h.replace('href="/" aria-labelledby', 'href="/home" aria-labelledby') });
  await expect(dot(page)).toBeVisible();
});

test("current header markup (no role, appHeader__hash class, aria-labelledby logo, quick search button): dot after the logo, pill before the search", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  expect(await page.locator("header").evaluate((h) => [h.getAttribute("role"), /appHeader__/.test(h.className)])).toEqual([null, true]);
  await expect(pill(page)).toBeVisible();
  expect(await pill(page).evaluate((p) => p.nextElementSibling.tagName.toLowerCase())).toBe("qbsearch-input");
});

test("old header naming (role=banner, AppHeader, aria-label=Homepage logo) still works", async ({ page, context }) => {
  await setup(context, page, {
    feed: actionsFeed(),
    transform: (h) => h.replace(/<header class="[^"]*">/, '<header class="AppHeader" role="banner">').replace(/<a class="AppHeader-logo" href="\/" aria-labelledby="gh-logo-label"[^>]*>/, '<a class="AppHeader-logo" href="https://github.com/" aria-label="Homepage">'),
  });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  expect(await page.locator('header a[aria-label="Homepage"]').evaluate((a) => a.nextElementSibling.id)).toBe("ghgs-dot");
  const l = await box(page, 'header a[aria-label="Homepage"]');
  const m = await box(page, "#ghgs-dot .ghgs-dot-mark");
  expect(Math.hypot(m.cx - l.right, m.cy - l.bottom), JSON.stringify({ l, m })).toBeLessThanOrEqual(6);
  expect(await dot(page).evaluate((d) => getComputedStyle(d).position)).toBe("absolute");
  await expect(pill(page)).toBeVisible();
});

test("no search control: the pill is not placed anywhere else", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), transform: (h) => h.replace(/<qbsearch-input[\s\S]*?<\/qbsearch-input>/, "") });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await page.waitForTimeout(400);
  await expect(pill(page)).toHaveCount(0);
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
});

test("switched off: nothing is injected and no request is made", async ({ page, context }) => {
  const log = await setup(context, page, { feed: actionsFeed(), storage: { ghgsEnabled: false } });
  await page.waitForTimeout(600);
  await expect(dot(page)).toHaveCount(0);
  await expect(pill(page)).toHaveCount(0);
  expect(log).toHaveLength(0);
});

test("switching it off at runtime removes everything; switching on brings it back", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghgsEnabled: false }));
  await expect(dot(page)).toHaveCount(0);
  await expect(pill(page)).toHaveCount(0);
  await worker.evaluate(() => chrome.storage.local.set({ ghgsEnabled: true }));
  await expect(dot(page)).toBeVisible();
});

test("Show incident notice off: the dot stays, the pill goes", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), storage: { ghgsNotice: false } });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await page.waitForTimeout(300);
  await expect(pill(page)).toHaveCount(0);
});

test("two tabs, one request; the request carries nothing about the user", async ({ page, context }) => {
  const log = await setup(context, page);
  const second = await context.newPage();
  await second.goto(PR);
  await expect(second.locator("#ghgs-dot")).toBeVisible();
  await expect(dot(page)).toBeVisible();
  expect(log).toHaveLength(1);
  const u = new URL(log[0].url);
  expect(u.origin + u.pathname).toBe("https://www.githubstatus.com/api/v2/summary.json");
  expect(u.search).toBe("");
  expect(log[0].method).toBe("GET");
  expect(log[0].headers.authorization).toBeUndefined();
  expect(log[0].headers.cookie).toBeUndefined();
  expect(log[0].headers.referer).toBeUndefined();
});

test("the extension's manifest asks for no host permission for the status feed", async () => {
  const fs = await import("node:fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  expect(m.host_permissions).toEqual(["https://api.github.com/*"]);
});

test("dark mode: GitHub's data-color-mode and the system setting both switch the colors", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  const bg = () => pill(page).evaluate((p) => getComputedStyle(p).backgroundColor);
  const light = await bg();
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
  const dark = await bg();
  expect(dark).not.toBe(light);
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "auto"));
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg()).toBe(dark);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await bg()).toBe(light);
});

function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
const contrast = (a, b) => { const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [mode, impact] of [["light", "minor"], ["dark", "minor"], ["light", "major"], ["dark", "major"]]) {
  test(`contrast ${mode} ${impact}: pill text 4.5:1, border and dot 3:1`, async ({ page, context }) => {
    const feed = impact === "major" ? actionsFeed({ status: { indicator: "major", description: "x" }, incidents: [statusIncident({ impact: "major" })] }) : actionsFeed();
    await setup(context, page, { feed });
    await page.evaluate((m) => document.documentElement.setAttribute("data-color-mode", m), mode);
    const c = await pill(page).evaluate((p) => { const s = getComputedStyle(p); return { fg: s.color, bg: s.backgroundColor, bd: s.borderTopColor, header: getComputedStyle(document.querySelector("header")).backgroundColor, dot: getComputedStyle(document.querySelector("#ghgs-dot .ghgs-dot-mark")).backgroundColor }; });
    expect(contrast(c.fg, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.dot, c.header)).toBeGreaterThanOrEqual(3);
  });
}

test("the pill looks like a native control: 32px high, 6px radius, 1px border; hover darkens, focus shows a 2px ring", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  const s = await pill(page).evaluate((p) => { const c = getComputedStyle(p); return { h: p.getBoundingClientRect().height, r: c.borderTopLeftRadius, b: c.borderTopWidth, m: c.margin }; });
  expect(s).toEqual({ h: 32, r: "6px", b: "1px", m: "0px" });
  const main = pill(page).locator(".ghgs-pill-main");
  await main.hover();
  // The coloured surface belongs to the pill: hovering a half must darken it (an overlay on the button), not just its text.
  expect(await main.evaluate((m) => getComputedStyle(m).backgroundColor)).toBe("rgba(31, 35, 40, 0.07)");
  expect(await main.evaluate((m) => getComputedStyle(m).filter)).toBe("none");
  await main.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ring = await main.evaluate((m) => { const c = getComputedStyle(m); return { w: c.outlineWidth, o: c.outlineOffset, style: c.outlineStyle }; });
  expect(ring).toEqual({ w: "2px", o: "-2px", style: "solid" });
});

for (const width of [1280, 768, 640, 375, 320]) {
  test(`header height, overflow and overlaps at ${width}px`, async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
    // Without the incident, then with it: the header must not change height.
    let feed = statusFeed();
    await routeStatus(context, { json: () => feed });
    await routeGithub(context, "header-signed-in.html");
    await page.goto(ACTIONS);
    await expect(dot(page)).toBeVisible();
    const h0 = await page.locator("header").evaluate((h) => h.getBoundingClientRect().height);
    const worker = await backgroundWorker(context);
    feed = actionsFeed();
    await worker.evaluate(() => chrome.storage.session.remove("ghgsCache"));
    await page.reload();
    await expect(pill(page)).toBeVisible();
    const m = await page.evaluate(() => {
      const h = document.querySelector("header");
      const rect = (n) => n.getBoundingClientRect();
      const hr = rect(h);
      const p = rect(document.getElementById("ghgs-pill"));
      const kids = [...document.querySelector(".AppHeader-globalBar-end").children].map(rect);
      const search = rect(document.querySelector(".header-search-button"));
      const avatar = rect(document.querySelector('[aria-label="Open user navigation menu"]'));
      const at = (r) => document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        header: hr.height,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        pillInside: p.left >= 0 && p.right <= window.innerWidth,
        searchHit: !!at(search)?.closest(".header-search-button"),
        avatarHit: at(avatar)?.getAttribute("aria-label"),
        overlap: kids.some((a, i) => kids.some((b, j) => j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom && b.top < a.bottom)),
      };
    });
    expect(m.header, JSON.stringify(m)).toBe(h0);
    expect(m.scrollW, JSON.stringify(m)).toBeLessThanOrEqual(m.clientW);
    expect(m.pillInside, JSON.stringify(m)).toBe(true);
    expect(m.overlap, JSON.stringify(m)).toBe(false);
    expect(m.avatarHit, JSON.stringify(m)).toBe("Open user navigation menu");
  });
}

const parts = (page) => page.evaluate(() => {
  const p = document.getElementById("ghgs-pill");
  const vis = (c) => { const n = p.querySelector(c); return !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().width > 0; };
  const name = p.querySelector(".ghgs-pill-name");
  const r = p.getBoundingClientRect();
  return { link: vis(".ghgs-pill-link"), detail: vis(".ghgs-pill-detail"), name: vis(".ghgs-pill-name"), truncated: name.scrollWidth > name.clientWidth, inside: r.left >= 0 && r.right <= window.innerWidth, w: window.innerWidth };
});

for (const [fixture, widths] of [["header-signed-in.html", [1280, 1012, 768, 640]], ["header-signed-in-globalnav.html", [1280, 1012, 768, 640]]]) {
  for (const width of widths) {
    test(`pill shows everything while its row has room: ${fixture} at ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 800 });
      await setup(context, page, { feed: actionsFeed(), fixture });
      await expect(pill(page)).toBeVisible();
      const m = await parts(page);
      const roomy = await page.evaluate(() => {
        const p = document.getElementById("ghgs-pill");
        const kept = ["ghgs-nolink", "ghgs-nodetail"].filter((c) => p.classList.contains(c));
        p.classList.remove(...kept);
        const room = p.getBoundingClientRect().width;
        p.classList.add("ghgs-measure");
        const need = p.getBoundingClientRect().width;
        p.classList.remove("ghgs-measure");
        p.classList.add(...kept);
        return room >= need - 0.5;
      });
      // the room decides, never the viewport: with room all parts show, otherwise they leave in order
      if (roomy) expect(m, JSON.stringify(m)).toMatchObject({ link: true, detail: true, name: true, truncated: false, inside: true });
      else { expect(m.inside, JSON.stringify(m)).toBe(true); if (m.link) expect(m.detail, JSON.stringify(m)).toBe(true); }
    });
  }
}

test("with room at 640px the pill keeps Details even though the old breakpoint hid it", async ({ page, context }) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await setup(context, page, { feed: actionsFeed(), fixture: "header-signed-in-globalnav.html" });
  await expect(pill(page)).toBeVisible();
  const m = await parts(page);
  expect(m, JSON.stringify(m)).toMatchObject({ link: true, detail: true, name: true, truncated: false });
});

test("a narrow row drops Details, then the detail word, and the pill stays inside the window", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  let m = await parts(page);
  expect(m.link, JSON.stringify(m)).toBe(false);
  expect(m.inside, JSON.stringify(m)).toBe(true);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(async () => (await parts(page)).detail).toBe(false);
  m = await parts(page);
  expect(m.link, JSON.stringify(m)).toBe(false);
  expect(m.inside, JSON.stringify(m)).toBe(true);
  await expect(pill(page).getByRole("button", { name: "GitHub Status: Actions, degraded performance. Open details" })).toBeVisible();
});

test("an open panel is not redrawn behind the user's back: focus inside it stays", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await dot(page).click();
  const link = panel(page).locator("a").first();
  await link.focus();
  await page.waitForTimeout(600);
  await expect(link).toBeFocused();
});

test("when the minute changes the open panel updates its age in place and keeps the focus", async ({ page, context }) => {
  // The content script's timers live in the isolated world, which a fake clock does not reach: this waits real 30 s ticks.
  test.setTimeout(120_000);
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ ghgsCache: { snapshot: { indicator: "none", description: "", updatedAt: "", components: [], incidents: [], maintenances: [] }, fetchedAt: Date.now() - 135_000, failures: 0, retryAt: 0 } });
  });
  await setup(context, page);
  await dot(page).click();
  await expect(panel(page)).toContainText("Checked 2 min ago");
  const link = panel(page).locator(".ghgs-foot a");
  await link.focus();
  await expect(panel(page)).toContainText("Checked 3 min ago", { timeout: 90_000 });
  await expect(link).toBeFocused();
});

test("a successful refresh with unchanged data keeps the focus inside the open panel", async ({ page, context }) => {
  // Real 30 s tick, see the test above: the cache is about to expire, so the next tick fetches again.
  test.setTimeout(120_000);
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ ghgsCache: { snapshot: { indicator: "none", description: "All Systems Operational", updatedAt: "2026-10-20T06:41:00Z", components: [], incidents: [], maintenances: [] }, fetchedAt: Date.now() - 295_000, failures: 0, retryAt: 0 } });
  });
  await setup(context, page, { feed: statusFeed({ components: [] }) });
  await dot(page).click();
  await expect(panel(page)).toContainText("Checked 4 min ago");
  const link = panel(page).locator(".ghgs-foot a");
  await link.focus();
  await expect(panel(page)).toContainText("Checked just now", { timeout: 90_000 });
  await expect(link).toBeFocused();
});

test("a failed refresh over an older green snapshot is Unverified, with the last verification as context", async ({ page, context }) => {
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ ghgsCache: { snapshot: { indicator: "none", description: "", updatedAt: "", components: [], incidents: [], maintenances: [] }, fetchedAt: Date.now() - 6 * 60_000, failures: 0, retryAt: 0 } });
  });
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  await dot(page).click();
  await expect(panel(page)).toContainText("Unverified");
  await expect(panel(page)).toContainText("Last verified 6 min ago");
});

test("a tab opened on an almost-expired cached snapshot refreshes at the next tick, not five minutes later", async ({ page, context }) => {
  // Real 30 s tick, see the test above.
  test.setTimeout(120_000);
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    await chrome.storage.session.set({ ghgsCache: { snapshot: { indicator: "none", description: "", updatedAt: "", components: [], incidents: [], maintenances: [] }, fetchedAt: Date.now() - 290_000, failures: 0, retryAt: 0 } });
  });
  await setup(context, page);
  await dot(page).click();
  await expect(panel(page)).toContainText("Checked 4 min ago");
  await expect(panel(page)).not.toContainText(/Checked [4-9] min ago/, { timeout: 60_000 });
});

test("a second click on the dot closes the panel; clicking a page field keeps the focus there", async ({ page, context }) => {
  await setup(context, page, { transform: (h) => h.replace("<h1>", '<input id="q" style="position:absolute;right:20px;top:300px"><h1>') });
  await dot(page).click();
  await expect(panel(page)).toBeVisible();
  await dot(page).click();
  await expect(panel(page)).toBeHidden();
  await dot(page).click();
  await expect(panel(page)).toBeVisible();
  await page.locator("#q").click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("#q")).toBeFocused();
});

test("the pill's Details opens the panel and a second click closes it", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await pill(page).locator(".ghgs-pill-main").click();
  await expect(panel(page)).toBeVisible();
  await pill(page).locator(".ghgs-pill-main").click();
  await expect(panel(page)).toBeHidden();
});

test("a repository called research does not take the search anchor", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), url: "https://github.com/acme/research/actions", transform: (h) => h.replace(">web</strong>", ">research</strong>").replace('href="/acme/web"', 'href="/acme/research"') });
  await expect(pill(page)).toBeVisible();
  expect(await pill(page).evaluate((p) => p.nextElementSibling.tagName.toLowerCase())).toBe("qbsearch-input");
});

test("an owner named like an Object property still gets a critical notice", async ({ page, context }) => {
  const feed = actionsFeed({ status: { indicator: "critical", description: "x" }, incidents: [statusIncident({ impact: "critical", components: [{ name: "Copilot" }] })] });
  await setup(context, page, { feed, url: "https://github.com/constructor/web/actions" });
  await expect(pill(page)).toBeVisible();
});

test("the panel stays inside a narrow window", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await setup(context, page, { feed: actionsFeed() });
  await dot(page).click();
  const r = await panel(page).boundingBox();
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(320);
});

const LOCAL_BAR = '<div class="AppHeader-localBar" style="height:48px;border-top:1px solid #d1d9e0"><nav class="AppHeader-nav"><a href="/acme/web/actions" aria-current="page" style="border-bottom:2px solid #fd8c73">Actions</a></nav></div></header>';

test("an incident adds no line and leaves the header's position alone, on the two-row header", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), fixture: "header-signed-in-globalnav.html" });
  await expect(pill(page)).toBeVisible();
  await expect(page.locator("#ghgs-line, .ghgs-line")).toHaveCount(0);
  expect(await page.locator("header").evaluate((h) => [h.style.position, getComputedStyle(h).position, h.dataset.ghgsPositioned || ""])).toEqual(["", "static", ""]);
});

test("a running maintenance reported by the page indicator is amber, not Unverified", async ({ page, context }) => {
  const maintenance = statusIncident({ id: "m", name: "Database maintenance", status: "in_progress", impact: "maintenance", components: [{ name: "Actions" }] });
  await setup(context, page, { feed: statusFeed({ status: { indicator: "maintenance", description: "Service Under Maintenance" }, scheduled_maintenances: [maintenance] }) });
  await expect(dot(page)).toHaveAttribute("data-state", "maintenance");
});

test("Retry follows the system dark theme when GitHub syncs with the system", async ({ page, context }) => {
  await setup(context, page, { fail: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "auto"));
  await page.emulateMedia({ colorScheme: "dark" });
  await dot(page).click();
  await expect(panel(page).getByRole("button", { name: "Retry" })).toHaveCSS("background-color", "rgb(33, 40, 48)");
});

// GitHub hides a ButtonGroup that holds a search button at narrow widths; the pill must not end up inside it.
const HIDDEN_SEARCH = '<div class="searchButtonGroup__x1" style="display:none"><button type="button" aria-label="Open quick search dialog">Search</button></div>';

test("a search control that is not rendered is skipped: the pill goes next to a visible one", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), transform: (html) => html.replace("<qbsearch-input", HIDDEN_SEARCH + "<qbsearch-input") });
  await expect(pill(page)).toBeVisible();
  const box = await pill(page).boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(await pill(page).evaluate((p) => !p.closest(".searchButtonGroup__x1"))).toBe(true);
});

test("with no rendered search control nothing is inserted: no pill and no line", async ({ page, context }) => {
  await setup(context, page, {
    feed: actionsFeed(),
    transform: (html) => html.replace(/<qbsearch-input[\s\S]*?<\/qbsearch-input>/, HIDDEN_SEARCH),
  });
  await expect(dot(page)).toHaveAttribute("data-state", "minor");
  await expect(pill(page)).toHaveCount(0);
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
});

test("the panel opened before the first answer says it is checking, with no Retry", async ({ page, context }) => {
  await setup(context, page, { delay: 2500 });
  await dot(page).click();
  await expect(panel(page)).toContainText("Checking githubstatus.com");
  await expect(panel(page)).not.toContainText("could not be reached");
  await expect(panel(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(panel(page)).toContainText("No incident reported", { timeout: 10_000 });
});

// The content script lives in an isolated world: page.evaluate cannot reach its
// `document` or `Date`, so these tests evaluate in the extension's own context.
async function extensionWorld(page) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context));
  await cdp.send("Runtime.enable");
  const ctx = contexts.find((c) => c.origin.startsWith("chrome-extension://") && c.auxData?.type === "isolated");
  if (!ctx) throw new Error("no extension isolated world on the page");
  return (expression) => cdp.send("Runtime.evaluate", { expression, contextId: ctx.id, awaitPromise: true });
}

test("enabling the feature from Settings does not fetch while the tab is hidden", async ({ page, context }) => {
  const log = await setup(context, page, { storage: { ghgsEnabled: false } });
  await page.waitForTimeout(300);
  const run = await extensionWorld(page);
  await run("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })");
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghgsEnabled: true }));
  await page.waitForTimeout(800);
  expect(log).toHaveLength(0);
});

test("a tab that becomes visible on a stale snapshot repaints gray before the refresh answers", async ({ page, context }) => {
  const log = await setup(context, page, { delay: (n) => (n >= 1 ? 4000 : 0) });
  await expect(dot(page)).toHaveAttribute("data-state", "ok");
  const run = await extensionWorld(page);
  const worker = await backgroundWorker(context);
  await worker.evaluate(async () => {
    const { ghgsCache } = await chrome.storage.session.get("ghgsCache");
    await chrome.storage.session.set({ ghgsCache: { ...ghgsCache, fetchedAt: Date.now() - 16 * 60_000 } });
  });
  await run("const real = Date.now.bind(Date); Date.now = () => real() + 16 * 60000; document.dispatchEvent(new Event('visibilitychange'))");
  await expect(dot(page)).toHaveAttribute("data-state", "unknown", { timeout: 1500 });
  // The refresh is still out (answers after 4 s): gray came from the repaint, not from the answer.
  expect(log).toHaveLength(2);
});

test("a header transparent all the way up gets no ring instead of a wrong colour", async ({ page, context }) => {
  await setup(context, page, { fixture: "header-signed-out.html", transform: (h) => h.replace("</head>", "<style>header, header * { background-color: transparent !important; } body, html { background: transparent !important; }</style></head>") });
  await expect(dot(page)).toBeVisible();
  await expect.poll(() => dot(page).locator(".ghgs-dot-mark").evaluate((m) => getComputedStyle(m).boxShadow), { timeout: 8000 }).toMatch(/rgba\(0, 0, 0, 0\)|none/);
});

// --- #96: the dot follows the worst open incident; the pill keeps the row's gap -----------------------

const GLOBALNAV = "header-signed-in-globalnav.html";
// The live summary on 2026-10-21: the page indicator said "none" while a critical incident was open.
const criticalFeed = () =>
  statusFeed({
    status: { indicator: "none", description: "All Systems Operational" },
    incidents: [statusIncident({ id: "crit", name: "Delays for Pull Requests and Webhook deliveries", impact: "critical", components: [{ name: "Pull Requests" }, { name: "Webhooks" }] })],
  });

test("indicator none with a critical incident open: the dot is red and named Critical incident, like the pill", async ({ page, context }) => {
  await setup(context, page, { feed: criticalFeed(), fixture: GLOBALNAV });
  await expect(pill(page)).toBeVisible();
  await expect(pill(page)).toContainText("critical incident");
  await expect(dot(page)).toHaveAttribute("data-state", "critical");
  await expect(dot(page).locator(".ghgs-dot-mark")).toHaveCSS("background-color", "rgb(207, 34, 46)");
  await expect(dot(page)).toHaveAttribute("aria-label", "GitHub Status: Critical incident. Open details");
  await dot(page).click();
  await expect(panel(page).locator(".ghgs-state")).toHaveText("Critical incident");
});

const rects = (page) =>
  page.evaluate(() => {
    const r = (n) => n && n.getBoundingClientRect();
    const pillEl = document.getElementById("ghgs-pill");
    const p = r(pillEl);
    const group = pillEl.nextElementSibling;
    const g = r(group);
    const row = pillEl.parentElement;
    const cs = getComputedStyle(row);
    return {
      pill: { left: p.left, right: p.right, width: p.width },
      next: { left: g.left, tag: group.tagName, cls: group.className },
      gap: g.left - p.right,
      rowGap: cs.columnGap,
      rowCls: row.className,
      margin: pillEl.style.marginInlineEnd || getComputedStyle(pillEl).marginInlineEnd,
      header: r(document.querySelector("header")).height,
      bar: r(document.querySelector("header > div, header > *")).height,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      innerW: window.innerWidth,
    };
  });

for (const width of [1280, 1012, 768, 375]) {
  test(`two-row header at ${width}px: the pill sits before the search group with the row's 8px gap and changes no height`, async ({ context }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
    let feed = statusFeed();
    await routeStatus(context, { json: () => feed });
    await routeGithub(context, GLOBALNAV);
    await page.goto(ACTIONS);
    await expect(dot(page)).toBeVisible();
    const h0 = await page.locator("header").evaluate((h) => [h.getBoundingClientRect().height, h.firstElementChild.getBoundingClientRect().height]);
    const worker = await backgroundWorker(context);
    feed = criticalFeed();
    await worker.evaluate(() => chrome.storage.session.remove("ghgsCache"));
    await page.reload();
    await expect(pill(page)).toBeVisible();
    const m = await rects(page);
    const hs = await page.locator("header").evaluate((h) => [h.getBoundingClientRect().height, h.firstElementChild.getBoundingClientRect().height]);
    const info = JSON.stringify({ width, ...m });
    expect(m.rowGap, info).toBe("8px");
    expect(m.rowCls, info).toContain("topBarActions__");
    expect(m.next.cls, info).toContain("searchGroup__");
    expect(m.gap, info).toBeCloseTo(8, 0);
    expect(m.margin, info).toMatch(/^0(px)?$/);
    expect(m.pill.right, info).toBeLessThanOrEqual(m.innerW);
    expect(m.pill.left, info).toBeGreaterThanOrEqual(0);
    expect(m.scrollW, info).toBeLessThanOrEqual(m.clientW);
    expect(hs, info).toEqual(h0);
  });
}

test("the margin safety net is not used on current markup, and covers only the shortfall of a row with no gap", async ({ page, context }) => {
  await setup(context, page, { feed: criticalFeed(), fixture: GLOBALNAV });
  await expect(pill(page)).toBeVisible();
  expect(await pill(page).evaluate((p) => p.style.marginInlineEnd)).toBe("");
  // The row and the group both have no gap: the pill stays next to the search control and the missing space is added to it, to 8px.
  const p2 = await context.newPage();
  await routeGithub(context, GLOBALNAV, { transform: (h) => h.replace(".topBarActions__h9k2 { display: flex; align-items: center; gap: 8px;", ".topBarActions__h9k2 { display: flex; align-items: center; gap: 0;") });
  await p2.goto(ACTIONS);
  await expect(pill(p2)).toBeVisible();
  const m = await rects(p2);
  expect(m.gap, JSON.stringify(m)).toBeCloseTo(8, 0);
  expect(await pill(p2).evaluate((p) => p.style.marginInlineEnd)).toBe("8px");
});

test("a gap-less actions row of margin-spaced controls does not pull the pill away from the search", async ({ page, context }) => {
  // No searchGroup wrapper, no row gap, controls spaced by margins: the row sits in a space-between bar. The pill must stay next to the search control.
  await setup(context, page, {
    feed: criticalFeed(),
    fixture: GLOBALNAV,
    transform: (h) => h
      .replace(".topBarActions__h9k2 { display: flex; align-items: center; gap: 8px;", ".topBarActions__h9k2 { display: flex; align-items: center; gap: 0;")
      .replace("</style>", ".topBarActions__h9k2 > * + * { margin-left: 8px; }</style>")
      .replace('<div class="searchGroup__a1b2c">', "").replace(/(<button type="button" class="iconButton__d4e5f joined"[^>]*>✦<\/button>\s*)<\/div>/, "$1"),
  });
  await expect(pill(page)).toBeVisible();
  const m = await rects(page);
  // The pill stays in the actions row, right before the search control, not between the bar's two groups.
  expect(await pill(page).evaluate((p) => ({ inActions: !!p.closest("[class*=topBarActions]"), next: p.nextElementSibling.tagName }))).toEqual({ inActions: true, next: "QBSEARCH-INPUT" });
  expect(m.pill.right, JSON.stringify(m)).toBeLessThanOrEqual(m.next.left + 0.5);
});

test("a component-only problem names the dot as degraded service, not as an incident", async ({ page, context }) => {
  const feed = statusFeed();
  feed.components = [{ name: "Actions", status: "degraded_performance" }];
  await setup(context, page, { feed, fixture: GLOBALNAV });
  await expect(dot(page)).toHaveAttribute("aria-label", /Degraded service/);
});

test("both class namings of the two-row header give the same placement", async ({ page, context }) => {
  await setup(context, page, {
    feed: criticalFeed(),
    fixture: GLOBALNAV,
    transform: (h) => h.replace(/(\w+)__(?:k3j9a|m2p4q|r5t6u|h9k2|a1b2c|d4e5f|g7h8i|j1k2l|n3o4p)/g, (_, n) => `GlobalNav-module__${n}--x1y2z`).replace(/GlobalNav-module__root__x1y2z/, "GlobalNav-module__root--x"),
  });
  await expect(pill(page)).toBeVisible();
  const m = await rects(page);
  expect(m.rowCls, JSON.stringify(m)).toContain("topBarActions");
  expect(m.next.cls, JSON.stringify(m)).toContain("searchGroup");
  expect(m.gap, JSON.stringify(m)).toBeCloseTo(8, 0);
});

test("the signed-out header: a hidden sibling next to the search is ignored and the pill stays outside the search slot", async ({ page, context }) => {
  await setup(context, page, {
    feed: criticalFeed(),
    fixture: "header-signed-out.html",
    transform: (h) => h.replace('<div class="mobileActions__8F9jkX">', '<div class="searchSlot__x9" style="display:flex;gap:0"><button type="button" aria-label="Search or jump to…">Search</button><div class="d-none" style="display:none">more</div></div><div class="mobileActions__8F9jkX">'),
  });
  await expect(pill(page)).toBeVisible();
  expect(await pill(page).evaluate((p) => ({ inside: !!p.closest(".searchSlot__x9"), next: p.nextElementSibling.className }))).toEqual({ inside: false, next: "searchSlot__x9" });
});

test("SPA /pull/1 -> /actions -> back -> forward: one pill in the same place, no line", async ({ page, context }) => {
  await setup(context, page, { feed: criticalFeed(), fixture: GLOBALNAV, url: ACTIONS });
  await expect(pill(page)).toHaveCount(1);
  const where = async () => { const m = await rects(page); return [Math.round(m.pill.left), Math.round(m.gap)]; };
  const first = await where();
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/1"));
  await page.evaluate(() => history.pushState({}, "", "/acme/web/actions"));
  await page.goBack();
  await page.goForward();
  await expect(pill(page)).toHaveCount(1);
  expect(await where()).toEqual(first);
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
  expect(await page.locator("header").evaluate((h) => h.style.position)).toBe("");
});

test("a rule and a position override left by an older version are cleaned up", async ({ page, context }) => {
  await setup(context, page, { feed: criticalFeed(), fixture: GLOBALNAV });
  await expect(pill(page)).toBeVisible();
  await page.evaluate(() => {
    const h = document.querySelector("header");
    h.dataset.ghgsPositioned = "1";
    h.style.position = "relative";
    const l = document.createElement("div");
    l.id = "ghgs-line";
    h.append(l);
  });
  await expect(page.locator("#ghgs-line")).toHaveCount(0);
  expect(await page.locator("header").evaluate((h) => h.style.position)).toBe("");
});
