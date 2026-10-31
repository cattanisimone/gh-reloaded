// E2E: per-token "Verify access" panel on the Settings page. api.github.com is
// mocked per test; nothing leaves the machine.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";

const FINE = "github_pat_FINE1234";
const CLASSIC = "ghp_CLASSIC5678";

// handler(url, request) -> {status, headers, body}; every call is recorded.
async function mockApi(context, handler) {
  const calls = [];
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const call = { url: req.url(), method: req.method(), auth: req.headers().authorization, body: req.postData() };
    calls.push(call);
    const { status = 200, headers = {}, body = {} } = (await handler(call)) || {};
    await route.fulfill({
      status,
      headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "*", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  });
  return calls;
}

const ok = (call) => {
  if (call.url.endsWith("/user")) return { body: { login: "sam" } };
  if (call.url.endsWith("/graphql")) return { body: { data: { organization: { projectV2: { id: "P" } } } } };
  return { body: [] };
};

async function openDefault(context, page) {
  await openOptions(context, page, "#tokens-section");
  await page.locator("#token-default .tok-verify").click();
  return page.locator("#token-default");
}

test("Verify access sits beside Test on default and owner cards, no new nav page", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  await page.locator("#add-token").click();
  for (const card of [page.locator("#token-default"), page.locator("#token-list .token-card")]) {
    const test = card.locator(".tok-test");
    const verify = card.locator(".tok-verify");
    await expect(verify).toBeVisible();
    const [a, b] = await Promise.all([test.boundingBox(), verify.boundingBox()]);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(b.x).toBeGreaterThan(a.x);
  }
  await expect(page.locator(".nav a[data-panel]")).toHaveCount(4);
});

test("Verify access matches Test: size, radius, border, padding", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  const read = (sel) => page.locator(sel).evaluate((el) => {
    const c = getComputedStyle(el);
    return [c.height, c.borderTopLeftRadius, c.borderTopWidth, c.borderTopColor, c.paddingLeft, c.paddingRight, c.fontSize, c.fontWeight, c.lineHeight];
  });
  expect(await read("#token-default .tok-verify")).toEqual(await read("#token-default .tok-test"));
  const gap = await page.locator("#token-default .input-row").evaluate((r) => getComputedStyle(r).columnGap);
  expect(gap).toBe("8px");
});

test("no api request on page load or when opening the panel", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await seedStorage(context, { githubTokens: [{ id: "d", name: "Default", owner: "", token: FINE }], defaultTokenId: "d" });
  const card = await openDefault(context, page);
  await expect(card.locator(".diag")).toBeVisible();
  await expect(card.locator(".tok-verify")).toHaveAttribute("aria-expanded", "true");
  expect(calls).toHaveLength(0);
});

test("Test stays authentication-only and says so", async ({ context, page }) => {
  await mockApi(context, ok);
  await openOptions(context, page, "#tokens-section");
  await page.locator("#token-default .tok-secret").fill(FINE);
  await page.locator("#token-default .tok-test").click();
  await expect(page.locator("#token-default .tok-test-status")).toHaveText(/Authenticated as sam\. Feature access not checked/);
});

test("a repository is required: no request, field marked invalid", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
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
  await card.locator(".tok-secret").fill(FINE);
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

test("the unsaved token is used as typed and labelled", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await seedStorage(context, { githubTokens: [{ id: "d", name: "Default", owner: "", token: "ghp_SAVED9999" }], defaultTokenId: "d" });
  const card = await openDefault(context, page);
  await expect(card.locator(".diag-tag")).toHaveText("Saved token …9999");
  await card.locator(".tok-secret").fill(CLASSIC);
  await expect(card.locator(".diag-tag")).toHaveText("Unsaved token");
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-summary")).toContainText("checked");
  expect(calls.every((c) => c.auth === `Bearer ${CLASSIC}`)).toBe(true);
  const stored = await page.evaluate(() => chrome.storage.local.get("githubTokens"));
  expect(stored.githubTokens[0].token).toBe("ghp_SAVED9999");
});

test("two owner cards send their own tokens", async ({ context, page }) => {
  const calls = await mockApi(context, ok);
  await openOptions(context, page, "#tokens-section");
  await page.locator("#add-token").click();
  await page.locator("#add-token").click();
  const cards = page.locator("#token-list .token-card");
  for (const [i, tok, owner] of [[0, "ghp_ONEONE11", "one"], [1, "ghp_TWOTWO22", "two"]]) {
    await cards.nth(i).locator(".tok-owner").fill(owner);
    await cards.nth(i).locator(".tok-secret").fill(tok);
    await cards.nth(i).locator(".tok-verify").click();
    await expect(cards.nth(i).locator(".diag-repo")).toHaveValue(`${owner}/`);
    await cards.nth(i).locator(".diag-repo").fill(`${owner}/app`);
    await cards.nth(i).locator(".diag-run").click();
    await expect(cards.nth(i).locator(".diag-summary")).toContainText("checked");
  }
  expect(calls.filter((c) => c.url.includes("/repos/one/")).every((c) => c.auth === "Bearer ghp_ONEONE11")).toBe(true);
  expect(calls.filter((c) => c.url.includes("/repos/two/")).every((c) => c.auth === "Bearer ghp_TWOTWO22")).toBe(true);
});

test("401: authentication denied, the other checks not checked", async ({ context, page }) => {
  const calls = await mockApi(context, () => ({ status: 401, body: { message: "Bad credentials" } }));
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
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
  await card.locator(".tok-secret").fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").nth(1)).toHaveText("Temporary error");
  await expect(card.locator(".diag-result").nth(1)).toContainText(/rate limit/i);
});

test("network failure is a temporary error", async ({ context, page }) => {
  await context.route("https://api.github.com/**", (route) => route.abort());
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").first()).toHaveText("Temporary error");
});

test("an ambiguous 404 stays Not verified", async ({ context, page }) => {
  await mockApi(context, (c) => c.url.endsWith("/user") ? { body: { login: "sam" } } : { status: 404, body: { message: "Not Found" } });
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-pill").nth(1)).toHaveText("Not verified");
});

test("a user-owned project with a fine-grained token shows the classic read:project remedy", async ({ context, page }) => {
  await mockApi(context, (c) => c.url.endsWith("/user")
    ? { body: { login: "sam" } }
    : c.url.endsWith("/graphql") ? { body: { data: { user: null }, errors: [{ type: "NOT_FOUND" }] } } : { body: [] });
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
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
  await card.locator(".tok-secret").fill(FINE);
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
  await card.locator(".tok-secret").fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").click();
  await expect(card.locator(".diag-run")).toBeDisabled();
  await expect(card.locator(".diag-run")).toHaveText("Checking…");
  await card.locator(".tok-secret").fill(FINE + "x");
  await expect(card.locator(".diag-run")).toBeEnabled();
  await expect(card.locator(".diag-summary")).toHaveText("Token changed: run the checks again.");
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
  await card.locator(".tok-secret").fill(FINE);
  await card.locator(".diag-repo").fill("acme/app");
  await card.locator(".diag-run").dblclick();
  await expect(card.locator(".diag-summary")).toContainText("checked");
  expect(calls.filter((c) => c.url.endsWith("/user"))).toHaveLength(1);
});

test("keyboard, ARIA, responsive and dark", async ({ context, page }) => {
  await mockApi(context, ok);
  await page.setViewportSize({ width: 400, height: 900 });
  await openOptions(context, page, "#tokens-section");
  const verify = page.locator("#token-default .tok-verify");
  await verify.focus();
  await expect(verify).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(verify).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#token-default .diag-repo")).toBeFocused();
  await page.locator("#token-default .tok-secret").fill(FINE);
  await page.locator("#token-default .diag-repo").fill("acme/app");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  await expect(page.locator("#token-default .diag-run")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#token-default .diag-summary")).toHaveAttribute("role", "status");
  await expect(page.locator("#token-default .diag-summary")).toContainText("checked");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await verify.click();
  await expect(page.locator("#token-default .diag")).toBeHidden();

  await page.emulateMedia({ colorScheme: "dark" });
  await verify.click();
  const bg = await page.locator("#token-default .diag").evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect(r + g + b).toBeLessThan(150);
});

test("Pull requests row: Available on 200, Access denied naming Pull requests: read on 403, Not verified on 404", async ({ context, page }) => {
  let pulls = { body: [] };
  await mockApi(context, (call) => (call.url.includes("/pulls") ? pulls : ok(call)));
  const card = await openDefault(context, page);
  await card.locator(".tok-secret").fill(FINE);
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
