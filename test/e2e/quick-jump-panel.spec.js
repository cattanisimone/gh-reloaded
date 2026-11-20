// E2E: the Quick jump panel's content: sections, scope, keyboard, typing and accessibility.
import { test, expect } from "./support/extension.js";
import { setup, openPanel, panel, input, rows, selected, issue, repoRow, MAPPED } from "./support/quick-jump.js";

const REPO_PAGES = { "*": { title: "Retry · Issue #9 · acme/web", repoHeader: true } };
const titles = (page) => page.locator(".ghqj-row .ghqj-title").allTextContents();

test("first open on a repository page: Your work and its two fixed rows, scope This repository, first row selected", async ({ context, page }) => {
  const { reqs } = await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(page.locator(".ghqj-seg-btn.ghqj-on")).toHaveText("This repository", { useInnerText: true });
  await expect(rows(page).first()).toContainText("Retry the upload when the worker times out");
  await expect(selected(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveClass(/ghqj-sel/);
  expect(await titles(page)).toEqual(["Retry the upload when the worker times out", "Sort by oldest ignores saved items", "All assigned issues on GitHub", "All review requests on GitHub", "Retry"]); // the last is Recent: this very page
  await expect(page.locator("#ghqj-g-repos")).toHaveCount(0);
  await expect(rows(page).first().locator(".ghqj-ctx")).toContainText("acme/web #61");
  await expect(rows(page).first().locator(".ghqj-ctx")).toContainText("Review requested");
  expect(reqs.sort()).toEqual(["GET /issues", "GET /search/issues", "GET /user/repos"]);
});

test("Tab switches to Everywhere, shows all three sections, and announces the scope", async ({ context, page }) => {
  await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".ghqj-seg-btn.ghqj-on")).toHaveText("Everywhere", { useInnerText: true });
  await expect(page.locator(".ghqj-sr[role=status], .ghqj-sr").filter({ hasText: "Scope: Everywhere" })).toHaveCount(1);
  await expect(page.locator("#ghqj-g-work")).toBeVisible();
  await expect(page.locator("#ghqj-g-repos")).toBeVisible();
  await expect(page.locator("#ghqj-g-repos")).toContainText("Recent pushes");
  expect(await titles(page)).toEqual(expect.arrayContaining(["Fix rounding in invoice totals", "acme/web", "acme/billing-api", "octo-fixture/dotfiles"]));
  await page.keyboard.press("Tab");
  await expect(page.locator(".ghqj-seg-btn.ghqj-on")).toHaveText("This repository", { useInnerText: true });
});

test("pages outside a repository open on Everywhere and show only that value", async ({ context, page }) => {
  await setup(context, { pages: { "*": { title: "Notifications", nwo: "" } } });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(page.locator(".ghqj-seg-btn")).toHaveCount(1);
  await expect(page.locator(".ghqj-seg-btn")).toHaveText("Everywhere", { useInnerText: true });
  await expect(page.locator(".ghqj-tabhint")).toHaveCount(0);
});

test("an owner page offers This owner and Everywhere", async ({ context, page }) => {
  await setup(context, { pages: { "*": { title: "acme", nwo: "" } } });
  await openPanel(context, page, "https://github.com/acme");
  await expect(page.locator(".ghqj-seg-btn")).toHaveText(["This owner", "Everywhere"], { useInnerText: true });
  await expect(page.locator("#ghqj-g-repos")).toBeVisible();
  expect(await titles(page)).toEqual(expect.arrayContaining(["acme/web", "acme/billing-api"]));
  expect(await titles(page)).not.toContain("octo-fixture/dotfiles");
});

test("keyboard: arrows move, Enter opens in the same tab, Ctrl+Enter in a new tab", async ({ context, page }) => {
  await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(rows(page).first()).toContainText("Retry the upload"); // the lists have arrived
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveClass(/ghqj-sel/);
  await expect(input(page)).toHaveAttribute("aria-activedescendant", (await rows(page).nth(1).getAttribute("id")));
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).first()).toHaveClass(/ghqj-sel/);
  const [tab] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Control+Enter")]);
  await tab.waitForURL("https://github.com/acme/web/pull/61");
  await page.bringToFront(); // the new tab took the focus; the panel stays open in this one
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL("https://github.com/acme/web/pull/61");
});

test("typing filters everything fetched locally with no request per keystroke; the last row searches GitHub", async ({ context, page }) => {
  const { reqs } = await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(rows(page).first()).toContainText("Retry the upload");
  const before = reqs.length;
  await input(page).pressSequentially("upload", { delay: 20 });
  await expect(page.locator("#ghqj-g-matches")).toContainText("Matches in your work and recent items");
  expect(await titles(page)).toEqual(["Retry the upload when the worker times out", "Search GitHub for “upload”"]);
  await expect(rows(page).first().locator("mark")).toHaveText("upload");
  const last = rows(page).last();
  // one line: the title, the scope on the right; no second line with the query
  await expect(last.locator(".ghqj-ctx")).toHaveCount(0);
  await expect(last.locator(".ghqj-type")).toHaveText("in this repository");
  await expect(last).toHaveAttribute("href", "https://github.com/search?q=repo%3Aacme%2Fweb+upload");
  expect(reqs.length).toBe(before);
  await input(page).fill("zzz");
  await expect(page.locator(".ghqj-none")).toContainText("No matches in your work or recent items.");
  await expect(page.locator(".ghqj-none")).toContainText("Search GitHub to look beyond them.");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveClass(/ghqj-sel/);
  await input(page).fill("");
  await expect(page.locator("#ghqj-g-work")).toBeVisible();
});

test("typing in Everywhere: the search has no qualifier; matches reach repositories beyond the 5 shown", async ({ context, page }) => {
  const repos = ["a", "b", "c", "d", "e", "f", "g"].map((n, i) => repoRow(`acme/${n}`, 10 + i));
  await setup(context, { pages: { "*": { title: "Notifications", nwo: "" } }, data: { repos } });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(page.locator("#ghqj-g-repos")).toBeVisible();
  expect((await titles(page)).filter((t) => t.startsWith("acme/")).length).toBe(5);
  await input(page).fill("acme/g");
  await expect(rows(page).first()).toContainText("acme/g");
  await expect(rows(page).last()).toHaveAttribute("href", "https://github.com/search?q=acme%2Fg");
});

test("Everywhere with a token mapped to an owner: the owner line and the default token for the lists", async ({ context, page }) => {
  await setup(context, { storage: MAPPED, pages: { "*": { title: "Notifications", nwo: "" } } });
  await openPanel(context, page, "https://github.com/notifications");
  await expect(page.locator('[data-line="owner-line"]')).toHaveText("Listed with your default GitHub token. Work in acme shows when you open this view on their pages.");
});

test("a11y: dialog, labelled combobox, listbox with groups and the selected option announced", async ({ context, page }) => {
  await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Quick jump" })).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("combobox", { name: "Filter your work, or search GitHub" })).toBeFocused();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("group", { name: "Your work" })).toBeVisible();
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: "Scope" })).toBeVisible();
  const name = await page.getByRole("option").first().evaluate((n) => n.textContent);
  expect(name).toContain("Pull request");
});

test("only the three GETs to api.github.com are sent, no write", async ({ context, page }) => {
  const { reqs } = await setup(context, { pages: REPO_PAGES });
  await openPanel(context, page, "https://github.com/acme/web/issues/9");
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(reqs.every((r) => r.startsWith("GET "))).toBe(true);
  expect(new Set(reqs).size).toBeLessThanOrEqual(3);
  void issue;
});
