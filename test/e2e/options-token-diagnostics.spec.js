// E2E: "Check a specific repository" (the former Verify access) from the side
// panel and from a test result. api.github.com is mocked per test; nothing
// leaves the machine.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, FINE, CLASSIC } from "./support/tokens.js";

const ok = (call) => {
  if (call.url.endsWith("/user")) return { body: { login: "sam" } };
  if (call.url.endsWith("/graphql")) return { body: { data: { organization: { projectV2: { id: "P" } } } } };
  return { body: [] };
};

// Opens the default token's panel (no token saved) and the repository check in it.
async function openDefault(context, page) {
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list [data-act="edit"]').first().click();
  await page.locator("#panel-check").click();
  return page.locator("#panel-diag");
}
const secret = (page) => page.locator("#panel-secret");

test("no api request on page load or when opening the check", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await seedStorage(context, { githubTokens: [{ id: "d", name: "Default", owner: "", token: FINE }], defaultTokenId: "d" });
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list [data-act="edit"]').first().click();
  await page.locator("#panel-check").click();
  await expect(page.locator("#panel-diag .diag")).toBeVisible();
  await expect(page.locator("#panel-check")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#panel-diag .diag-repo")).toBeFocused();
  expect(calls).toHaveLength(0);
});

test("the check is reachable from a test result too, with the saved token", async ({ context, page }) => {
  const calls = await mockApi(context, (c) => (c.url.includes("/user/repos") ? { body: [] } : ok(c)));
  await seedStorage(context, { githubTokens: [{ id: "o", name: "Work", owner: "acme", token: CLASSIC }], defaultTokenId: null });
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list .token-item').nth(1).locator('.token-row [data-act="test"]').click();
  const item = page.locator("#token-list .token-item").nth(1);
  await item.getByRole("button", { name: "Check a specific repository" }).click();
  await expect(item.locator(".diag-repo")).toHaveValue("acme/");
  await item.locator(".diag-repo").fill("acme/app");
  calls.length = 0;
  await item.locator(".diag-run").click();
  await expect(item.locator(".diag-summary")).toContainText("checked");
  expect(calls.every((c) => c.auth === `Bearer ${CLASSIC}`)).toBe(true);
  expect(calls.some((c) => c.url.includes("/repos/acme/app/issues"))).toBe(true);
});

test("a repository is required: no request, field marked invalid", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-repo")).toHaveAttribute("aria-invalid", "true");
  await expect(card.locator(".field-error:not([hidden])")).toContainText("Name a repository");
  expect(calls).toHaveLength(0);
});

test("no token in the card: Paste a token first, no request", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  const card = await openDefault(context, page);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toHaveText("Paste a token first.");
  expect(calls).toHaveLength(0);
});

test("success: requests only the named targets, results name target, time and status", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-issue").fill("12");
  await card.locator(".diag-project").fill("https://github.com/orgs/acme/projects/3");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toHaveText("4 checked: 4 available.");
  expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(["https://api.github.com/user", "https://api.github.com/repos/acme/app/issues/12", "https://api.github.com/repos/acme/app/pulls?per_page=1", "https://api.github.com/graphql"]));
  expect(calls).toHaveLength(4);
  expect(calls.every((c) => c.auth === `Bearer ${FINE}`)).toBe(true);
  const rows = card.locator(".diag-result");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText("acme/app, issue #12");
  await expect(rows.nth(2)).toContainText("acme/app, pull requests list");
  await expect(rows.nth(1)).toContainText(/\d{1,2}:\d{2}/);
  await expect(rows.nth(1).locator(".diag-pill")).toHaveText("Available");
  await expect(rows.nth(3).locator(".diag-pill")).toHaveText("Available");
  await expect(rows.nth(4).locator(".diag-pill")).toHaveText("Not checked");
  expect(calls.every((c) => c.method === "GET" || c.url.endsWith("/graphql"))).toBe(true);
  expect(calls.find((c) => c.url.endsWith("/graphql")).body).not.toMatch(/mutation/);
});

test("the panel check uses the token as typed in the panel, and the saved one is untouched", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await seedStorage(context, { githubTokens: [{ id: "d", name: "Default", owner: "", token: "ghp_SAVED9999" }], defaultTokenId: "d" });
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list [data-act="edit"]').first().click();
  await page.locator("#panel-check").click();
  const card = page.locator("#panel-diag");
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toContainText("checked");
  expect(calls.every((c) => c.auth === "Bearer ghp_SAVED9999")).toBe(true);
  await page.locator("#panel-replace").click();
  await secret(page).fill(CLASSIC);
  await expect(card.locator(".diag-summary")).toHaveText("Token or owner changed: run the checks again.");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toContainText("checked");
  expect(calls.slice(-3).every((c) => c.auth === `Bearer ${CLASSIC}`)).toBe(true);
  const stored = await page.evaluate(() => chrome.storage.local.get("githubTokens"));
  expect(stored.githubTokens[0].token).toBe("ghp_SAVED9999");
});

test("two owner tokens send their own tokens", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await seedStorage(context, { githubTokens: [{ id: "a", name: "", owner: "one", token: "ghp_ONEONE11" }, { id: "b", name: "", owner: "two", token: "ghp_TWOTWO22" }], defaultTokenId: null });
  await openOptions(context, page, "#tokens-section");
  for (const [i, owner] of [[1, "one"], [2, "two"]]) {
    await page.locator('#token-list [data-act="edit"]').nth(i).click();
    await page.locator("#panel-check").click();
    await expect(page.locator("#panel-diag .diag-repo")).toHaveValue(`${owner}/`);
    await page.locator("#panel-diag .diag-repo").fill(`${owner}/app`);
    await page.locator("#panel-diag .diag-run").click();
    await expect(page.locator("#panel-diag .diag-summary")).toContainText("checked");
    await page.locator("#panel-discard").click();
  }
  expect(calls.filter((c) => c.url.includes("/repos/one/")).every((c) => c.auth === "Bearer ghp_ONEONE11")).toBe(true);
  expect(calls.filter((c) => c.url.includes("/repos/two/")).every((c) => c.auth === "Bearer ghp_TWOTWO22")).toBe(true);
});

test("401: authentication denied, the other checks not checked", async ({ context, page }) => {
  const calls = await mockApi(context, () => ({ status: 401, body: { message: "Bad credentials" } }));
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  const pills = card.locator(".diag-pill");
  await expect(pills.first()).toHaveText("Access denied");
  await expect(pills.nth(1)).toHaveText("Not checked");
  expect(calls).toHaveLength(1);
});

test("rate limit and network errors are temporary, never denied", async ({ context, page }) => {
  await mockApi(context, (c) => c.url.endsWith("/user")
    ? { body: { login: "sam" } }
    : { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" }, body: { message: "API rate limit exceeded" } });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").nth(1)).toHaveText("Temporary error");
  await expect(card.locator(".diag-result").nth(1)).toContainText(/rate limit/i);
});

test("network failure is a temporary error", async ({ context, page }) => {
  await context.route("https://api.github.com/**", (route) => route.abort());
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").first()).toHaveText("Temporary error");
});

test("an ambiguous 404 stays Not verified", async ({ context, page }) => {
  await mockApi(context, (c) => c.url.endsWith("/user") ? { body: { login: "sam" } } : { status: 404, body: { message: "Not Found" } });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").nth(1)).toHaveText("Not verified");
});

test("a user-owned project with a fine-grained token shows the classic read:project remedy", async ({ context, page }) => {
  await mockApi(context, (c) => c.url.endsWith("/user")
    ? { body: { login: "sam" } }
    : c.url.endsWith("/graphql") ? { body: { data: { user: null }, errors: [{ type: "NOT_FOUND" }] } } : { body: [] });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("sam/app");
  await card.locator(".diag-project").fill("https://github.com/users/sam/projects/2");
  await card.locator(".diag-run").click();
  const row = card.locator(".diag-result").nth(3);
  await expect(row.locator(".diag-pill")).toHaveText("Not verified");
  await expect(row).toContainText("read:project");
  await expect(row).toContainText("classic token");
  await expect(row).not.toContainText("Organization");
});

test("no secret in the UI, console or storage even when GitHub echoes the token", async ({ context, page }) => {
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await mockApi(context, (c) => c.url.endsWith("/user")
    ? { status: 401, body: { message: `Bad credentials for ${FINE}` } }
    : { body: [] });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").first()).toBeVisible();
  expect(await card.locator(".diag").innerText()).not.toContain(FINE);
  expect(await card.locator(".diag").innerHTML()).not.toContain(FINE);
  expect(logs.join("\n")).not.toContain(FINE);
  const stored = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
  expect(stored).not.toContain(FINE);
});

test("editing the token clears results and aborts the run", async ({ context, page }) => {
  const calls = await mockApi(context, async (c) => {
    await new Promise((r) => setTimeout(r, 400));
    return ok(c);
  });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-run")).toBeDisabled();
  await expect(card.locator(".diag-run")).toHaveText("Checking…");
  await secret(page).fill(FINE + "x");
  await expect(card.locator(".diag-run")).toBeEnabled();
  await expect(card.locator(".diag-summary")).toHaveText("Token or owner changed: run the checks again.");
  await page.waitForTimeout(900);
  await expect(card.locator(".diag-result")).toHaveCount(0);
  expect(calls.length).toBeLessThanOrEqual(1);

  // finished results are cleared by a target edit too
  await mockApi(context, ok);
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-result").first()).toBeVisible({ timeout: 5000 });
  await card.locator(".diag-repo").fill("acme/other");
  await expect(card.locator(".diag-result")).toHaveCount(0);
});

test("a double click starts one run", async ({ context, page }) => {
  const calls = await mockApi(context, async (c) => {
    await new Promise((r) => setTimeout(r, 200));
    return ok(c);
  });
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").dblclick();
  await expect(card.locator(".diag-summary")).toContainText("checked");
  expect(calls.filter((c) => c.url.endsWith("/user"))).toHaveLength(1);
});

test("keyboard, ARIA, responsive and dark", async ({ context, page }) => {
  await mockApi(context, ok);
  await page.setViewportSize({ width: 400, height: 900 });
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list [data-act="edit"]').first().click();
  const check = page.locator("#panel-check");
  await check.focus();
  await expect(check).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(check).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#panel-diag .diag-repo")).toBeFocused();
  await secret(page).fill(FINE);
  await page.locator("#panel-diag .diag-repo").fill("acme/app");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(page.locator("#panel-diag .diag-run")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel-diag .diag-summary")).toHaveAttribute("role", "status");
  await expect(page.locator("#panel-diag .diag-summary")).toContainText("checked");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await check.click();
  await expect(page.locator("#panel-diag")).toBeHidden();

  await page.emulateMedia({ colorScheme: "dark" });
  await check.click();
  const bg = await page.locator("#panel-diag .diag").evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect(r + g + b).toBeLessThan(150);
});

test("Pull requests row: Available on 200, Access denied naming Pull requests: read on 403, Not verified on 404", async ({ context, page }) => {
  let pulls = { body: [] };
  await mockApi(context, (call) => (call.url.includes("/pulls") ? pulls : ok(call)));
  const card = await openDefault(context, page);
  await secret(page).fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  const row = card.locator(".diag-result").nth(2);
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toHaveText("3 checked: 3 available.");
  await expect(row).toContainText("Pull requests");
  await expect(row.locator(".diag-pill")).toHaveText("Available");

  pulls = { status: 403, body: { message: "Resource not accessible by personal access token" } };
  await card.locator(".diag-run").click();
  await expect(row.locator(".diag-pill")).toHaveText("Access denied");
  await expect(row).toContainText("Pull requests: read (and Metadata)");
  await expect(row).toContainText("repository in the token's selection");

  pulls = { status: 404, body: { message: "Not Found" } };
  await card.locator(".diag-run").click();
  await expect(row.locator(".diag-pill")).toHaveText("Not verified");
});
