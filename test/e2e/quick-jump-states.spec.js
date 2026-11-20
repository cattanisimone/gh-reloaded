// E2E: Quick jump degraded and empty states: empty lines with the token name, a list the token cannot
// read, rate limit and error lines with cached rows, loading skeletons and no serving token.
import { test, expect } from "./support/extension.js";
import { backgroundWorker } from "./support/extension.js";
import { setup, openPanel, rows, input, MAPPED, issue } from "./support/quick-jump.js";

const NOTIF = { "*": { title: "Notifications", nwo: "" } };
const REPO = { "*": { title: "acme/web", repoHeader: true } };
const line = (page, id) => page.locator(`[data-line="${id}"]`);
const titles = (page) => page.locator(".ghqj-row .ghqj-title").allTextContents();
const workTitles = (page) => page.locator(".ghqj-group:has(#ghqj-g-work) .ghqj-row .ghqj-title").allTextContents();
const EMPTY = { assigned: [], review: { total_count: 0, items: [] }, repos: [] };

async function ageCache(context, ms) {
  const worker = await backgroundWorker(context);
  await worker.evaluate(async (age) => {
    const o = await chrome.storage.session.get("ghqjCache");
    const c = o.ghqjCache || {};
    for (const rec of Object.values(c)) for (const l of Object.values(rec)) { l.at -= age; if (l.retryAt) l.retryAt -= age; }
    await chrome.storage.session.set({ ghqjCache: c });
  }, ms);
}

test("read but empty: the line names the token the user chose and the two fixed rows follow; the first is selected", async ({ context, page }) => {
  await setup(context, { pages: REPO, data: EMPTY });
  await openPanel(context, page, "https://github.com/acme/web");
  await expect(line(page, "empty-work")).toHaveText("GH Reloaded's GitHub token “Work laptop” sees nothing assigned to you or waiting for your review in this repository.");
  expect(await workTitles(page)).toEqual(["All assigned issues on GitHub", "All review requests on GitHub"]);
  await expect(rows(page).first()).toHaveClass(/ghqj-sel/);
  await input(page).fill("x");
  await expect(page.locator(".ghqj-none")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Search GitHub for “x”");
});

test("read but empty in Everywhere and for an owner", async ({ context, page }) => {
  await setup(context, { pages: NOTIF, data: EMPTY });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(line(page, "empty-work")).toHaveText(/in the repositories it can reach\.$/);
  await expect(line(page, "empty-recent")).toHaveText("Issues, pull requests and repositories you open on GitHub will appear here.");
});

test("a list the token cannot read: its fixed row and line replace it, the other list stays, repositories are hidden, no other token is tried", async ({ context, page }) => {
  const reqs = [];
  await setup(context, { storage: MAPPED, pages: REPO, data: { assigned: { status: 404 }, repos: { status: 404 } } });
  await context.route("https://api.github.com/**", (r) => (reqs.push(r.request().headers().authorization), r.fallback()));
  await openPanel(context, page, "https://github.com/acme/web");
  await expect(line(page, "cannot-assigned")).toContainText("GH Reloaded's GitHub token “Acme org” can't read your assigned issues here. This opens GitHub's page instead; check the token in GH Reloaded settings.");
  await expect(rows(page).filter({ hasText: "Issues assigned to you" })).toHaveAttribute("href", "https://github.com/issues/assigned");
  await expect(rows(page).first()).toContainText("Retry the upload");
  await expect(page.locator("#ghqj-g-repos")).toHaveCount(0);
  await expect(page.locator(".ghqj-panel")).not.toContainText(/token is missing/i);
  expect([...new Set(reqs)]).toEqual(["Bearer ghp_org"]);
  const [tab] = await Promise.all([context.waitForEvent("page"), line(page, "cannot-assigned").getByRole("button", { name: "GH Reloaded settings" }).click()]);
  expect(tab.url()).toMatch(/options\/options\.html#tokens-section$/);
});

test("rate limit without cached rows names only the affected list, and recent items stay", async ({ context, page }) => {
  await setup(context, { pages: NOTIF, data: { review: { status: 429 } } });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(line(page, "limited")).toHaveText("GitHub is limiting requests right now, so your review requests are not shown. Recent items stay available; they refresh in about a minute.");
  expect(await titles(page)).toEqual(expect.arrayContaining(["Sort by oldest ignores saved items", "acme/web"]));
});

test("rate limit with cached rows keeps them and says they may be out of date; an error is worded apart", async ({ context, page }) => {
  const state = { mode: "ok" };
  const handlers = [
    { match: /^\/issues$/, status: () => (state.mode === "limit" ? 429 : 200), json: () => (state.mode === "limit" ? { message: "x" } : [issue(54, "acme/web", 60, "Sort by oldest")]) },
    { match: /^\/search\/issues$/, status: () => (state.mode === "limit" ? 502 : 200), json: () => ({ total_count: 0, items: [] }) },
    { match: /^\/user\/repos$/, json: () => [] },
  ];
  await setup(context, { pages: NOTIF, handlers });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(rows(page).first()).toContainText("Sort by oldest");
  await page.keyboard.press("Escape");
  await ageCache(context, 61_000);
  state.mode = "limit";
  await openPanel(context, page, null);
  await expect(line(page, "limited-cached")).toHaveText("GitHub is limiting requests right now, so your assigned issues may be out of date. Recent items stay available; they refresh in about a minute.");
  await expect(line(page, "error")).toHaveText("GitHub can't be reached right now, so your review requests are not shown. Recent items stay available; they refresh in about a minute.");
  await expect(rows(page).first()).toContainText("Sort by oldest");
});

test("loading without a cache: skeleton rows only in Your work; cached rows render at once on the next open", async ({ context, page }) => {
  await setup(context, { pages: NOTIF });
  await context.route("https://api.github.com/**", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    route.fallback();
  });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(page.locator(".ghqj-skeletons")).toHaveCount(1);
  await expect(page.locator(".ghqj-group:has(#ghqj-g-work) .ghqj-skeletons")).toHaveCount(1);
  await expect(page.locator(".ghqj-group:has(#ghqj-g-recent) .ghqj-skeletons, .ghqj-group:has(#ghqj-g-repos) .ghqj-skeletons")).toHaveCount(0);
  await expect(rows(page).first()).toContainText("Retry the upload", { timeout: 8000 });
  await expect(page.locator(".ghqj-skeletons")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openPanel(context, page, null);
  await expect(rows(page).first()).toContainText("Retry the upload", { timeout: 800 });
});

test("tokens saved but none serves the scope: no request, three fixed rows and the line; recent stays", async ({ context, page }) => {
  const { reqs } = await setup(context, { storage: { githubTokens: [{ id: "o", name: "Acme org", token: "ghp_org", owner: "acme" }], defaultTokenId: null }, pages: NOTIF });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(line(page, "no-serving")).toHaveText("None of the GitHub tokens saved in GH Reloaded applies to Everywhere: none is the default. These open GitHub's own pages; map a token or choose a default in GH Reloaded settings.");
  expect(await workTitles(page)).toEqual(["Issues assigned to you", "Review requests", "Your pull requests"]);
  await expect(page.locator("#ghqj-g-repos")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(reqs).toEqual([]);
});

test("truncated and empty: never says what the token sees", async ({ context, page }) => {
  await setup(context, { pages: REPO, data: { assigned: [issue(1, "other/x", 1)], review: { total_count: 300, items: [issue(2, "other/y", 1)] }, repos: [] } });
  await openPanel(context, page, "https://github.com/acme/web");
  await expect(line(page, "empty-work")).toHaveText("Nothing assigned to you or waiting for your review in this repository among the most recently updated items GH Reloaded's GitHub token “Work laptop” read.");
});
