// E2E: GitHub Status. A dot right after the logo on every page, a native
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

async function setup(context, page, { feed = statusFeed(), fixture = "header-signed-in.html", storage, url = ACTIONS, status, fail, go = true, transform } = {}) {
  const log = [];
  if (storage) await seedStorage(context, storage);
  await routeStatus(context, { json: feed, log, status, fail });
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
  const logo = page.locator('header a[aria-label="Homepage"]');
  expect(await logo.evaluate((a) => a.nextElementSibling.id)).toBe("ghgs-dot");
  expect(await logo.evaluate((a) => a.parentElement === document.getElementById("ghgs-dot").parentElement)).toBe(true);
  const before = await logo.boundingBox();
  await dot(page).evaluate((d) => d.remove());
  const after = await logo.boundingBox();
  expect(before).toEqual(after);
  await expect(logo).toHaveAttribute("href", "https://github.com/");
  // The row's own gap spaces the dot: no margin of ours.
  expect(await dot(page).evaluate((d) => getComputedStyle(d).margin)).toBe("0px");
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

test("an unreachable feed: gray ring, Unverified, no pill", async ({ page, context }) => {
  await setup(context, page, { fail: true });
  await expect(dot(page)).toHaveAttribute("data-state", "unknown");
  await expect(pill(page)).toHaveCount(0);
  await dot(page).click();
  await expect(panel(page)).toContainText("Unverified");
  await expect(panel(page)).toContainText("githubstatus.com could not be reached.");
  await expect(panel(page).getByRole("button", { name: "Retry" })).toBeVisible();
  const mark = await dot(page).locator(".ghgs-dot-mark").evaluate((m) => { const c = getComputedStyle(m); return { bg: c.backgroundColor, w: c.borderTopWidth }; });
  expect(mark).toEqual({ bg: "rgba(0, 0, 0, 0)", w: "2px" });
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
  await expect(page.locator("#ghgs-line")).toHaveCount(1);
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
  await page.evaluate(() => document.getElementById("slot").outerHTML = '<a class="AppHeader-logo" href="/" aria-label="Homepage"><svg class="octicon octicon-mark-github" width="32" height="32"></svg></a>');
  await expect(dot(page)).toBeVisible();
});

test("the logo is found by its octicon when the label is gone", async ({ page, context }) => {
  await setup(context, page, { transform: (h) => h.replace('aria-label="Homepage"', "") });
  await expect(dot(page)).toBeVisible();
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
  expect(await main.evaluate((m) => getComputedStyle(m).filter)).toBe("brightness(0.95)");
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

test("below 400px the pill keeps the icon and the dismiss button; its accessible name keeps the full text", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await setup(context, page, { feed: actionsFeed() });
  await expect(pill(page)).toBeVisible();
  await expect(pill(page).locator(".ghgs-pill-link")).toBeHidden();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(pill(page).locator(".ghgs-pill-name")).toBeHidden();
  await expect(pill(page).getByRole("button", { name: "GitHub Status: Actions, degraded performance. Open details" })).toBeVisible();
});

test("an open panel is not redrawn behind the user's back: focus inside it stays", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed() });
  await dot(page).click();
  const link = panel(page).locator("a").first();
  await link.focus();
  await page.waitForTimeout(600);
  await expect(link).toBeFocused();
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

test("the severity line closes the global bar and leaves the repository tab bar alone", async ({ page, context }) => {
  await setup(context, page, { feed: actionsFeed(), transform: (h) => h.replace("</header>", LOCAL_BAR) });
  await expect(page.locator("#ghgs-line")).toHaveCount(1);
  const r = await page.evaluate(() => {
    const line = document.getElementById("ghgs-line").getBoundingClientRect();
    const bar = document.querySelector(".AppHeader-globalBar").getBoundingClientRect();
    const local = document.querySelector(".AppHeader-localBar").getBoundingClientRect();
    return { lineBottom: line.bottom, barBottom: bar.bottom, localTop: local.top, localBottom: local.bottom };
  });
  expect(r.lineBottom, JSON.stringify(r)).toBeCloseTo(r.barBottom, 0);
  expect(r.lineBottom).toBeLessThanOrEqual(r.localTop + 1);
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
