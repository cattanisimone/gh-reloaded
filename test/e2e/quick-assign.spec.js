// E2E: Quick assignment (experimental) on an issue page. The fixture stands in
// for GitHub's Assignees section and its own picker (open, filter, toggle,
// Escape saves once). Covers: off by default and teardown, the actions per
// situation, the ✕ per row, confirmation only after a fresh read-back, honest
// failures, the user's own picker, SPA navigation and re-renders, anchors on
// current and previous class naming, no write API, widths and native look.
// All names are invented.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const ISSUE_URL = "https://github.com/acme/web/issues/123";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };
const ON = { ghqaEnabled: true };

// What GitHub "stores": the fixture's save request updates it, the REST read-back reads it.
function makeServer(assignees) {
  return { assignees, saves: [], reads: 0, readHook: null, requests: [] };
}

async function setup(context, page, { server = makeServer(["alex-dev"]), storage = { ...TOKENS, ...ON }, fixture = "issue-assignees-editable.html", query = "", read, transform, go = true } = {}) {
  await seedStorage(context, storage);
  context.on("request", (r) => {
    if (r.url().startsWith("https://api.github.com/")) server.requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await routeApi(context, [
    {
      match: (p) => /^\/repos\/acme\/web\/issues\/\d+$/.test(p),
      status: () => (read ? read(server)?.status || 200 : 200),
      json: () => {
        server.reads++;
        const custom = read?.(server);
        if (custom) return custom.json ?? {};
        return { assignees: server.assignees.map((login) => ({ login })) };
      },
    },
  ]);
  await routeGithub(context, fixture, { transform });
  await context.route("https://github.com/_fixture/save", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    server.saves.push(body.assignees);
    server.assignees = body.assignees;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  if (go) await page.goto(`${ISSUE_URL}${query}`);
  return server;
}

const section = (page) => page.locator('[data-testid="sidebar-assignees-section"]');
const assignBtn = (page) => page.locator("[data-ghqa-btn]");
const status = (page) => page.locator("[data-ghqa-status]");
const xOf = (page, login) => page.locator(`[data-ghqa-x="${login}"]`);
const rowOf = (page, login) => page.locator("li", { has: page.locator(`a[href="/${login}"]`) });
const names = (page) => page.locator('[data-testid="issue-assignees"]').allTextContents();

test("off by default: the section stays exactly as GitHub serves it", async ({ context, page }) => {
  await setup(context, page, { storage: { ...TOKENS } });
  await expect(page.locator("#edit")).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x], [data-ghqa], [data-ghqa-row]")).toHaveCount(0);
});

test("switching off removes every node and attribute again", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toHaveText("Assign me");
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await page.evaluate(() => chrome.storage.local.set({ ghqaEnabled: false }).catch(() => {})).catch(() => {});
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => chrome.storage.local.set({ ghqaEnabled: false }));
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x], [data-ghqa], [data-ghqa-row]")).toHaveCount(0);
});

test("empty editable issue shows no extra Assign me", async ({ context, page }) => {
  await setup(context, page, { query: "?empty" });
  await expect(page.locator('[class*="selfAssignButton"]')).toHaveText("Assign yourself");
  await page.waitForTimeout(600);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(0);
});

test("assign me adds only me, shows Saving… then Assigned once GitHub confirms", async ({ context, page }) => {
  const server = await setup(context, page);
  await expect(assignBtn(page)).toHaveText("Assign me");
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  expect(server.saves).toEqual([["alex-dev", "mira"]]);
  expect(await names(page)).toEqual(["alex-dev", "mira"]);
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
});

test("unassign me keeps the colleague", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "mira"]), query: "?assignees=alex-dev,mira" });
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Unassigned");
  expect(server.saves).toEqual([["alex-dev"]]);
  expect(await names(page)).toEqual(["alex-dev"]);
  await expect(assignBtn(page)).toHaveText("Assign me");
});

test("assign then unassign within a minute are both confirmed", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Unassigned");
  expect(server.saves).toEqual([["alex-dev", "mira"], ["alex-dev"]]);
  expect(server.reads).toBeGreaterThanOrEqual(2);
});

test("remove @user via ✕ removes only that person", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "mira", "sam-dev"]), query: "?assignees=alex-dev,mira,sam-dev" });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(3);
  await xOf(page, "sam-dev").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @sam-dev");
  expect(server.saves).toEqual([["alex-dev", "mira"]]);
  expect(await names(page)).toEqual(["alex-dev", "mira"]);
});

test("✕ is reachable by Tab, named, and keeps the profile link intact", async ({ context, page }) => {
  await setup(context, page);
  const x = xOf(page, "alex-dev");
  await expect(x).toHaveAttribute("aria-label", "Remove @alex-dev from assignees");
  await rowOf(page, "alex-dev").locator("a").focus();
  await page.keyboard.press("Tab");
  await expect(x).toBeFocused();
  await expect(x).toHaveCSS("opacity", "1");
  const link = await rowOf(page, "alex-dev").locator("a").boundingBox();
  const box = await x.boundingBox();
  expect(box.x + box.width, "✕ floats over the right end of the row").toBeLessThanOrEqual(link.x + link.width + 0.5);
  expect(box.x + box.width).toBeGreaterThan(link.x + link.width - 8);
  await expect(rowOf(page, "alex-dev").locator("a")).toHaveAttribute("href", "/alex-dev");
});

test("a bot or app row gets no ✕", async ({ context, page }) => {
  await setup(context, page, { query: "?assignees=alex-dev,app:build-bot" });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await expect(assignBtn(page)).toHaveText("Assign me");
});

test("removing the only assignee via ✕ still shows Saving… and Removed in the empty state", async ({ context, page }) => {
  const server = await setup(context, page);
  await xOf(page, "alex-dev").click({ force: true });
  await expect(status(page)).toContainText("Saving…");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @alex-dev");
  expect(server.saves).toEqual([[]]);
  await expect(page.locator('[class*="selfAssignButton"]')).toBeVisible();
  await expect(assignBtn(page)).toHaveCount(0); // the native "Assign yourself" stays the only action
});

test("unassign me as the only assignee confirms, then leaves only the native Assign yourself", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["mira"]), query: "?assignees=mira" });
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await assignBtn(page).focus();
  await page.keyboard.press("Enter");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Unassigned");
  expect(server.saves).toEqual([[]]);
  await expect(assignBtn(page)).toHaveCount(0);
  await expect(page.locator('[class*="selfAssignButton"]')).toBeFocused();
  await expect(status(page)).toHaveCount(0, { timeout: 10000 }); // the success note expires, nothing is left behind
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(0);
});

test("removing the only assignee with an unreadable read-back says so in the empty state", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 403, json: { message: "Resource not accessible" } }) });
  await xOf(page, "alex-dev").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toHaveText("Sent, not confirmed");
  await expect(status(page).locator(".ghqa-detail")).toContainText("Issues: Read");
});

test("an Enterprise Managed User login (with _) is a plain user: ✕, Unassign me and the removal check", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "jo_acme"]), query: "?assignees=alex-dev,jo_acme" });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(2);
  await xOf(page, "jo_acme").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @jo_acme");
  expect(server.saves).toEqual([["alex-dev"]]);
});

test("arriving on an issue by SPA navigation from a top-level page (github.com/issues) renders the controls", async ({ context, page }) => {
  await setup(context, page, { go: false });
  await page.goto("https://github.com/issues");
  await page.waitForTimeout(400);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(0);
  await page.evaluate(() => { history.pushState({}, "", "/acme/web/issues/123"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
});

test("an option the picker does not list fails honestly and closes the picker", async ({ context, page }) => {
  const server = await setup(context, page);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await page.evaluate(() => { window.__fx.users = window.__fx.users.filter((u) => u.login !== "alex-dev"); });
  await xOf(page, "alex-dev").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✕ Couldn't remove @alex-dev");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  expect(server.saves).toEqual([]);
  expect(await names(page)).toEqual(["alex-dev"]);
});

test("a picker that opens too late is reported and then closed untouched", async ({ context, page }) => {
  test.setTimeout(60000);
  const server = await setup(context, page);
  await page.evaluate(() => { window.__fx.openDelay = 9000; });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✕ Couldn't assign you", { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.__fx.openCount), { timeout: 15000 }).toBe(1);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 10000 });
  expect(server.saves).toEqual([]);
  expect(await names(page)).toEqual(["alex-dev"]);
});

test("a user click after a late-picker failure keeps the user's own picker open", async ({ context, page }) => {
  test.setTimeout(60000);
  const server = await setup(context, page);
  await expect(assignBtn(page)).toBeVisible();
  // Our click on the edit button is swallowed (e.g. not hydrated yet), so the picker never opens for us.
  await page.evaluate(() => { let n = 0; document.getElementById("edit").addEventListener("click", (e) => { if (n++ === 0) e.stopImmediatePropagation(); }, true); });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("Couldn't assign you", { timeout: 15000 });
  // The user follows the advice and opens the ⚙ picker within the late-close window.
  await page.locator("#edit").click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await page.waitForTimeout(1500);
  await expect(page.locator('[role="dialog"]'), "the user's own picker must not be closed by us").toHaveCount(1);
  expect(server.saves).toEqual([]);
});

test("a picker the user opens while ours is still loading is left alone and saves nothing", async ({ context, page }) => {
  test.setTimeout(60000);
  const server = await setup(context, page);
  await expect(assignBtn(page)).toBeVisible();
  await page.evaluate(() => { let n = 0; document.getElementById("edit").addEventListener("click", (e) => { if (n++ === 0) e.stopImmediatePropagation(); }, true); });
  await assignBtn(page).click();
  await page.waitForTimeout(300);
  await page.locator("#edit").click(); // the user opens the ⚙ picker before our wait is over
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(status(page).locator(".ghqa-line")).toContainText("Couldn't assign you", { timeout: 15000 });
  await page.waitForTimeout(500);
  await expect(page.locator('[role="dialog"]'), "the user's own picker must stay open").toHaveCount(1);
  await expect(page.locator('[role="dialog"] [role="combobox"]')).toHaveValue("");
  expect(server.saves).toEqual([]);
});

test("a picker the user opens on another issue while ours is loading is never driven", async ({ context, page }) => {
  test.setTimeout(60000);
  const server = await setup(context, page);
  await expect(assignBtn(page)).toBeVisible();
  await page.evaluate(() => { let n = 0; document.getElementById("edit").addEventListener("click", (e) => { if (n++ === 0) e.stopImmediatePropagation(); }, true); });
  await assignBtn(page).click();
  await page.evaluate(() => { history.pushState({}, "", "/acme/web/issues/124"); window.__fx.issue = 124; window.__fx.state = [{ login: "sam-dev" }]; window.__fx.render(); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(xOf(page, "sam-dev")).toHaveCount(1);
  await page.locator("#edit").click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await page.waitForTimeout(2000);
  await expect(page.locator('[role="dialog"]'), "the user's picker on issue 124 must stay open").toHaveCount(1);
  expect(server.saves, "nothing may be saved on issue 124").toEqual([]);
});

test("an exact login is matched, never a prefix (alex vs alex-dev)", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "alex"]), query: "?assignees=alex-dev,alex" });
  await xOf(page, "alex").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @alex");
  expect(server.saves).toEqual([["alex-dev"]]);
});

test("a stale read-back is not a confirmation: Saving… until a fresh read agrees", async ({ context, page }) => {
  const server = makeServer(["alex-dev"]);
  const stale = { assignees: [{ login: "alex-dev" }] };
  const reads = [];
  await setup(context, page, { server, read: (s) => { reads.push(s.reads); return s.reads <= 1 ? { json: stale } : null; } });
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned", { timeout: 15000 });
  expect(server.reads).toBeGreaterThanOrEqual(2);
});

test("a read-back that shows no change is a failure, not green", async ({ context, page }) => {
  const server = makeServer(["alex-dev"]);
  await setup(context, page, { server, read: () => ({ json: { assignees: [{ login: "alex-dev" }] } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✕ Couldn't assign you", { timeout: 15000 });
  await expect(status(page)).toHaveAttribute("data-tone", "bad");
  await expect(status(page)).toContainText("Use the ⚙ picker");
});

test("another assignee going missing is reported, not hidden", async ({ context, page }) => {
  const server = makeServer(["alex-dev"]);
  await setup(context, page, { server, read: () => ({ json: { assignees: [{ login: "mira" }] } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("⚠ Assignees changed unexpectedly", { timeout: 15000 });
  await expect(status(page)).toContainText("@alex-dev is no longer assigned");
});

test("read-back failure is not green: 403 names Issues: Read and links the token settings", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 403, json: { message: "Resource not accessible" } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toHaveText("Sent, not confirmed");
  await expect(status(page)).toHaveAttribute("data-tone", "muted");
  await expect(status(page)).toContainText("The token for acme can't read issues (Issues: Read).");
  await expect(status(page).getByRole("button", { name: "Settings → GitHub tokens" })).toBeVisible();
});

test("404 with a token reads as a permission problem too", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 404, json: { message: "Not Found" } }) });
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Issues: Read");
});

test("no token on a private repository: sent, a token is needed only to confirm, worded for every action", async ({ context, page }) => {
  const server = await setup(context, page, { storage: { ...ON }, read: () => ({ status: 404, json: { message: "Not Found" } }) });
  const sent = async () => {
    await expect(status(page).locator(".ghqa-line")).toHaveText("Sent, not confirmed");
    await expect(status(page)).toContainText("The change was sent; a token is needed only to confirm it.");
    await expect(status(page)).not.toContainText("assignment");
  };
  await assignBtn(page).click();
  await sent();
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await assignBtn(page).click();
  await expect(assignBtn(page)).toHaveText("Assign me");
  await sent();
  await xOf(page, "alex-dev").click({ force: true });
  await expect.poll(() => server.assignees).toEqual([]);
  await sent();
});

test("GitHub replaces the edit button when its picker opens: Assign me, Unassign me and ✕ still complete", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "sam-dev"]), query: "?assignees=alex-dev,sam-dev" });
  const first = await page.locator("#edit").elementHandle();
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  expect(await first.evaluate((el) => el.isConnected)).toBe(false); // the fixture re-renders the button, as GitHub does
  expect(server.assignees).toEqual(["alex-dev", "sam-dev", "mira"]);
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Unassigned");
  expect(server.assignees).toEqual(["alex-dev", "sam-dev"]);
  await xOf(page, "sam-dev").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @sam-dev");
  expect(server.assignees).toEqual(["alex-dev"]);
});

test("a rate limit shows when it resets", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 429, json: { message: "API rate limit exceeded" } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toHaveText("Sent, not confirmed");
  await expect(status(page)).toContainText("GitHub rate limit reached");
});

test("no write API: every api.github.com request is a GET", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "sam-dev"]), query: "?assignees=alex-dev,sam-dev" });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  await xOf(page, "sam-dev").click({ force: true });
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed");
  expect(server.requests.length).toBeGreaterThan(0);
  for (const r of server.requests) expect(r).toMatch(/^GET /);
});

test("the user's own picker open: controls are disabled and do nothing", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toBeVisible();
  await page.locator("#edit").click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(assignBtn(page)).toHaveAttribute("aria-disabled", "true");
  await expect(xOf(page, "alex-dev")).toHaveAttribute("aria-disabled", "true");
  // Dispatched on our controls, not clicked at their coordinates: the open
  // picker overlays the rows, and a pointer click would toggle one of its
  // options instead of testing our handlers.
  await assignBtn(page).dispatchEvent("click");
  await xOf(page, "alex-dev").dispatchEvent("click");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__fx.openCount)).toBe(1);
  expect(await page.evaluate(() => window.__fx.saves.length)).toBe(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__fx.saves), "closing the user's picker must save nothing").toEqual([]);
  await expect(assignBtn(page)).toHaveAttribute("aria-disabled", "false");
});

test("opening the native picker during the read-back does not interrupt it", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await page.locator("#edit").click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned", { timeout: 15000 });
  await expect(page.locator('[role="dialog"]')).toHaveCount(1); // the user's picker is left alone
  expect(server.saves).toHaveLength(1);
});

test("focus lands on the replacement control after Assign, and next ✕ after remove", async ({ context, page }) => {
  await setup(context, page);
  await assignBtn(page).focus();
  await page.keyboard.press("Enter");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await expect(assignBtn(page)).toBeFocused();
  await xOf(page, "alex-dev").focus();
  await page.keyboard.press("Enter");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @alex-dev");
  await expect(xOf(page, "mira")).toBeFocused();
});

test("a click elsewhere during the read-back is not undone by moving focus back", async ({ context, page }) => {
  await setup(context, page, { read: (s) => (s.reads < 3 ? { json: { assignees: [{ login: "alex-dev" }] } } : null) });
  await assignBtn(page).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(status(page)).toContainText("Saving…");
  await page.mouse.click(5, 5); // the user clicks plain page content: focus goes to body
  await page.evaluate(() => window.__fx.render());
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned", { timeout: 15000 });
  await page.evaluate(() => window.__fx.render());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement === document.body), "focus must stay where the user left it").toBe(true);
});

test("navigating to another issue drops a pending state and re-renders", async ({ context, page }) => {
  const server = makeServer(["alex-dev"]);
  await setup(context, page, { server, read: (s) => (s.reads <= 99 ? null : null) });
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await expect.poll(() => page.evaluate(() => window.__fx.saves.length)).toBe(1); // the late save of issue 123 must not land on 124
  await page.evaluate(() => { history.pushState({}, "", "/acme/web/issues/124"); window.__fx.issue = 124; window.__fx.state = [{ login: "sam-dev" }]; window.__fx.render(); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(xOf(page, "sam-dev")).toHaveCount(1);
  await expect(status(page)).toHaveCount(0);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
});

test("A → list → A and back/forward leave no duplicates", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await page.evaluate(() => { history.pushState({}, "", "/acme/web/issues"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x]")).toHaveCount(0);
  await page.evaluate(() => { history.pushState({}, "", "/acme/web/issues/123"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
  await page.evaluate(() => history.back());
  await page.evaluate(() => history.forward());
  await page.waitForTimeout(600);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
});

test("a re-render of the list by the page re-asserts the controls once", async ({ context, page }) => {
  await setup(context, page, { query: "?assignees=alex-dev,sam-dev" });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(2);
  await page.evaluate(() => { window.__fx.state = [{ login: "lee" }, { login: "zed-user" }, { login: "mira" }]; window.__fx.render(); });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(3);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(assignBtn(page)).toHaveText("Unassign me");
});

test("the ✕ stays at the right end when the page re-inserts the link after it", async ({ context, page }) => {
  await setup(context, page);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await page.evaluate(() => { const li = document.querySelector('[data-ghqa-row]'); li.append(li.querySelector(":scope > a")); }); // as React does live
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-ghqa-row]').lastElementChild.hasAttribute("data-ghqa-x"))).toBe(true);
  const link = await rowOf(page, "alex-dev").locator("a").boundingBox();
  const box = await xOf(page, "alex-dev").boundingBox();
  const li = await rowOf(page, "alex-dev").boundingBox();
  expect(box.x + box.width, "✕ must sit at the right end of the row").toBeGreaterThan(li.x + li.width - 8);
  expect(box.x + box.width).toBeLessThanOrEqual(li.x + li.width + 0.5);
  expect(link.width, "the link keeps the native full width").toBeGreaterThanOrEqual(li.width - 1);
});

for (const [vw, sectionW] of [[1100, 296], [800, 256]]) {
  test(`a 29-char login that fits natively keeps the row at 32px (${vw}px)`, async ({ context, page }) => {
    await page.setViewportSize({ width: vw, height: 900 });
    const login = "simone3cattanighrfactory-sudo";
    await setup(context, page, { query: `?assignees=${login}` });
    await expect(xOf(page, login)).toHaveCount(1);
    const link = rowOf(page, login).locator("a");
    const measure = async () => ({ li: await rowOf(page, login).boundingBox(), a: await link.boundingBox(), over: await link.evaluate((el) => el.scrollWidth - el.clientWidth) });
    const rest = await measure();
    expect(Math.round((await section(page).boundingBox()).width)).toBe(sectionW);
    expect(rest.li.height, `row ${rest.li.height}px at ${vw}px`).toBe(32);
    expect(rest.over).toBeLessThanOrEqual(0);
    expect(rest.a.width).toBeGreaterThanOrEqual(rest.li.width - 1);
    await rowOf(page, login).hover();
    await expect(xOf(page, login)).toHaveCSS("opacity", "1");
    expect((await measure()).li.height).toBe(32);
  });
}

test("a row reused for another assignee removes whoever it shows, as its label says", async ({ context, page }) => {
  const server = await setup(context, page, { server: makeServer(["alex-dev", "sam-dev"]), query: "?assignees=alex-dev,sam-dev" });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(2);
  // As React does with index keys: the rows are updated in place to [lee, alex-dev], and a new row takes sam-dev.
  await page.evaluate(() => {
    window.__fx.state = [{ login: "lee" }, { login: "alex-dev" }, { login: "sam-dev" }];
    const ul = document.querySelector('ul[class*="assigneesList"]');
    const lis = [...ul.children];
    const set = (li, l) => { const a = li.querySelector("a"); a.setAttribute("href", "/" + l); a.querySelector("[data-testid=issue-assignees]").textContent = l; };
    set(lis[0], "lee");
    set(lis[1], "alex-dev");
    const li = lis[1].cloneNode(true);
    li.querySelector("[data-ghqa-x]")?.remove();
    set(li, "sam-dev");
    ul.append(li);
  });
  server.assignees = ["lee", "alex-dev", "sam-dev"];
  const first = page.locator('[data-ghqa-row]').first().locator("[data-ghqa-x]");
  await first.click(); // before or after our next scan, the target follows the row
  await expect(status(page).locator(".ghqa-line")).toContainText("Removed @lee", { timeout: 15000 });
  expect(server.saves).toEqual([["alex-dev", "sam-dev"]]);
  await expect(first).toHaveAttribute("aria-label", "Remove @alex-dev from assignees");
  await expect(first).toHaveAttribute("data-ghqa-x", "alex-dev");
});

test("the actions box spans the section even when the section does not stretch its children", async ({ context, page }) => {
  await setup(context, page);
  await page.addStyleTag({ content: '[data-testid="sidebar-assignees-section"] { align-items: flex-start; }' }); // live: a flex column that does not stretch
  const sec = await section(page).boundingBox();
  await expect.poll(async () => Math.round((await assignBtn(page).boundingBox()).width)).toBe(Math.round(sec.width));
});

test("ten assignees get one ✕ each", async ({ context, page }) => {
  const logins = Array.from({ length: 10 }, (_, i) => `dev${i + 1}`);
  await setup(context, page, { query: `?assignees=${logins.join(",")}` });
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(10);
  await page.waitForTimeout(500);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(10);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
});

test("not an issue page: a pull request gets nothing", async ({ context, page }) => {
  await setup(context, page, { go: false });
  await page.goto("https://github.com/acme/web/pull/123");
  await expect(page.locator("#edit")).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x]")).toHaveCount(0);
});

for (const [name, query] of [["with assignees", ""], ["empty", "?empty"], ["previous class naming", "?old"]]) {
  test(`read-only section (${name}) gets no controls`, async ({ context, page }) => {
    await setup(context, page, { fixture: "issue-assignees-readonly.html", query });
    await expect(section(page)).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page.locator("[data-ghqa-actions], [data-ghqa-x], [data-ghqa]")).toHaveCount(0);
  });
}

test("anchors: the stable middle of the class matches both namings; a missing section renders nothing", async ({ context, page }) => {
  await setup(context, page, { query: "?old" });
  await expect(page.locator('ul[class*="Sidebar-module__assigneesList--b1"]')).toHaveCount(1); // previous naming served
  await expect(assignBtn(page)).toHaveText("Assign me");
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
});

test("anchors: current hashed naming is the primary anchor and nothing renders without the testid section", async ({ context, page }) => {
  await setup(context, page);
  await expect(page.locator('ul[class*="assigneesList__x8"]')).toHaveCount(1);
  await expect(assignBtn(page)).toHaveText("Assign me");
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await other.close();
  await page.evaluate(() => document.querySelector('[data-testid="sidebar-assignees-section"]').removeAttribute("data-testid"));
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x]")).toHaveCount(0);
  await page.evaluate(() => document.getElementById("sec").setAttribute("data-testid", "sidebar-assignees-section"));
  await expect(assignBtn(page)).toHaveText("Assign me"); // an anchor coming back is picked up
});

test("no edit button, no controls (locked or no write access)", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toBeVisible();
  await page.evaluate(() => document.getElementById("edit").remove());
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x]")).toHaveCount(0);
});

for (const [vw, sectionW] of [[1500, 296], [1100, 296], [800, 256], [500, 468]]) {
  test(`widths: ${vw}px viewport, section ${sectionW}px, nothing wider, status on one line`, async ({ context, page }) => {
    await page.setViewportSize({ width: vw, height: 900 });
    await setup(context, page, { read: () => ({ json: { assignees: [{ login: "alex-dev" }, { login: "mira" }] } }) });
    await expect(assignBtn(page)).toBeVisible();
    const sec = await section(page).boundingBox();
    expect(Math.round(sec.width)).toBe(sectionW);
    const li = await rowOf(page, "alex-dev").boundingBox();
    expect(li.height).toBe(32);
    const x = await xOf(page, "alex-dev").boundingBox();
    expect(x.x + x.width).toBeLessThanOrEqual(li.x + li.width + 0.5);
    await assignBtn(page).click();
    await expect(status(page).locator(".ghqa-line")).toContainText("Saving");
    const line = await status(page).locator(".ghqa-line").boundingBox();
    expect(line.height, `status line ${line.height}px high at ${vw}px`).toBeLessThanOrEqual(18.5);
    const box = await status(page).boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(sec.x + sec.width + 0.5);
    const bw = await assignBtn(page).boundingBox();
    expect(bw.width).toBeLessThanOrEqual(sectionW);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scrollW).toBeLessThanOrEqual(0);
  });
}

test("a long login truncates without pushing the ✕ out", async ({ context, page }) => {
  await setup(context, page, { query: "?assignees=a-very-long-login-name-that-will-not-fit-in-the-column-at-all" });
  const li = await page.locator("li", { has: page.locator("[data-ghqa-x]") }).boundingBox();
  const x = await page.locator("[data-ghqa-x]").boundingBox();
  expect(x.x + x.width).toBeLessThanOrEqual(li.x + li.width + 0.5);
  expect(x.width).toBe(24);
});

for (const mode of ["light", "dark"]) {
  test(`✕ look (${mode}): muted at rest, danger on hover and focus, 2px ring`, async ({ context, page }) => {
    await setup(context, page);
    await page.evaluate((m) => document.documentElement.setAttribute("data-color-mode", m), mode);
    const x = xOf(page, "alex-dev");
    await expect(x).toHaveCount(1);
    const css = (el) => el.evaluate((e) => { const s = getComputedStyle(e); return { color: s.color, bg: s.backgroundColor, opacity: s.opacity, radius: s.borderRadius, w: s.width, h: s.height, outline: s.outlineWidth + " " + s.outlineStyle + " " + s.outlineColor }; });
    const rest = await css(x);
    expect(rest.opacity).toBe("0");
    expect([rest.w, rest.h, rest.radius]).toEqual(["24px", "24px", "6px"]);
    await rowOf(page, "alex-dev").hover();
    await expect(x).toHaveCSS("opacity", "1");
    const muted = (await css(x)).color;
    await x.hover();
    const hover = await css(x);
    expect(hover.color).not.toBe(muted);
    expect(hover.bg).not.toBe("rgba(0, 0, 0, 0)");
    await rowOf(page, "alex-dev").locator("a").focus();
    await page.keyboard.press("Tab");
    await expect(x).toBeFocused();
    const focus = await css(x);
    expect(focus.outline).toContain("2px solid");
    if (mode === "dark") expect(hover.color).toBe("rgb(248, 81, 73)");
    else expect(hover.color).toBe("rgb(209, 36, 47)");
  });
}

test("buttons look native: 32px, 6px radius, 1px border, darker on hover, 2px focus ring", async ({ context, page }) => {
  await setup(context, page);
  const btn = assignBtn(page);
  await expect(btn).toBeVisible();
  const m = () => btn.evaluate((e) => { const s = getComputedStyle(e); return { h: e.getBoundingClientRect().height, radius: s.borderRadius, bw: s.borderTopWidth, border: s.borderTopColor, pad: s.paddingLeft + " " + s.paddingRight, size: s.fontSize, weight: s.fontWeight, filter: s.filter, outline: s.outlineWidth + " " + s.outlineStyle + " " + s.outlineColor + " " + s.outlineOffset, family: s.fontFamily }; });
  const rest = await m();
  expect(rest).toMatchObject({ h: 32, radius: "6px", bw: "1px", border: "rgba(31, 35, 40, 0.15)", pad: "12px 12px", size: "14px", weight: "500" });
  await btn.hover();
  await expect.poll(async () => (await m()).filter).toBe("brightness(0.95)");
  await page.mouse.move(0, 0);
  await page.locator("body").press("Tab");
  await btn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(btn).toBeFocused();
  expect((await m()).outline).toBe("2px solid rgb(9, 105, 218) -2px");
  // the Unassign button is a default one
  await page.evaluate(() => { window.__fx.state = [{ login: "mira" }]; window.__fx.render(); });
  await expect(btn).toHaveText("Unassign me");
  const d = await m();
  expect(d).toMatchObject({ h: 32, radius: "6px", border: "rgb(209, 217, 224)" });
});

test("row height and name position do not change when the ✕ appears", async ({ context, page }) => {
  await setup(context, page);
  const link = rowOf(page, "alex-dev").locator("a");
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  const rest = { li: await rowOf(page, "alex-dev").boundingBox(), a: await link.boundingBox() };
  await rowOf(page, "alex-dev").hover();
  await expect(xOf(page, "alex-dev")).toHaveCSS("opacity", "1");
  const hov = { li: await rowOf(page, "alex-dev").boundingBox(), a: await link.boundingBox() };
  expect(hov).toEqual(rest);
  expect(rest.li.height).toBe(32);
});
