// E2E: the Test button of a token row and of the side panel. api.github.com is
// mocked: every request is recorded and nothing leaves the machine.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, storageOf, FINE, CLASSIC } from "./support/tokens.js";

const seed = (extra = {}) => ({
  githubTokens: [
    { id: "d", name: "Personal", owner: "", token: CLASSIC },
    { id: "o", name: "Work", owner: "acme", token: "ghp_OWNER9999" },
  ],
  defaultTokenId: "d",
  ...extra,
});
const row = (page, i) => page.locator("#token-list .token-item").nth(i);
const testBtn = (page, i) => row(page, i).locator('.token-row [data-act="test"]');
const line = (page, i, type) => row(page, i).locator(`[data-type="${type}"]`);

async function start(context, page, handler = allGood, data = seed()) {
  const calls = await mockApi(context, handler);
  await seedStorage(context, data);
  await openOptions(context, page, "#tokens-section");
  return calls;
}

test("nothing is requested on load; one Test is one request per type, GET plus one read-only query", async ({ context, page }) => {
  const calls = await start(context, page);
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(0);
  await testBtn(page, 0).click();
  await expect(row(page, 0)).toContainText("Works");
  await expect(row(page, 0)).toContainText("5 of 5 OK");
  expect(calls.length).toBeLessThanOrEqual(7);
  expect(calls.every((c) => c.url.startsWith("https://api.github.com/"))).toBe(true);
  expect(calls.every((c) => c.auth === `Bearer ${CLASSIC}`)).toBe(true);
  expect(calls.every((c) => c.method === "GET" || (c.url.endsWith("/graphql") && !/mutation/.test(c.body)))).toBe(true);
  expect(calls.map((c) => c.url).some((u) => u.endsWith("/actions/runs?per_page=1"))).toBe(true);
  await expect(line(page, 0, "pulls")).toContainText("Available");
});

test("a denied required type: Missing permissions with the summary; an optional denial only lowers the count", async ({ context, page }) => {
  await start(context, page, (c) => c.url.includes("/pulls?") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : allGood(c));
  await testBtn(page, 0).click();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Missing permissions");
  await expect(line(page, 0, "pulls")).toContainText("Access denied");
  await expect(row(page, 0)).toContainText("4 of 5 OK. Missing permissions: Pull requests.");
});

test("optional denial lowers the count only", async ({ context, page }) => {
  await start(context, page, (c) => c.url.includes("/actions/runs") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : allGood(c));
  await testBtn(page, 0).click();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  await expect(row(page, 0)).toContainText("4 of 5 OK");
  await expect(line(page, 0, "actions")).toContainText("optional");
  await expect(line(page, 0, "actions")).toContainText("doesn't make the token Missing permissions");
});

test("no private repository: repository types Not verified, never Works from them", async ({ context, page }) => {
  await start(context, page, (c) => (c.url.includes("/user/repos") ? { body: [{ full_name: "acme/open", private: false }] } : allGood(c)),
    seed({ ghdgEnabled: false, ghsmEnabled: false, ghmiEnabled: false }));
  // only repository types and Projects are required; Projects stays provable
  await testBtn(page, 0).click();
  await expect(line(page, 0, "contents")).toContainText("Not verified");
  await expect(line(page, 0, "contents")).toContainText("We can't tell why.");
  await expect(line(page, 0, "issues")).toContainText("Not verified");
});

test("nothing provable (no private repository, personal Projects with a fine-grained token): Can't verify", async ({ context, page }) => {
  await start(context, page, (c) => (c.url.includes("/user/repos") ? { body: [] } : c.url.endsWith("/user") ? { body: { login: "sam" } } : allGood(c)),
    { githubTokens: [{ id: "o", name: "Me", owner: "sam", token: FINE }], defaultTokenId: null });
  await testBtn(page, 1).click();
  await expect(row(page, 1).locator(".state-pill")).toHaveText("Can't verify");
  await expect(line(page, 1, "pulls")).toContainText("Not verified");
  await expect(line(page, 1, "projects")).toContainText("classic token with read:project");
});

test("401: Not working", async ({ context, page }) => {
  await start(context, page, () => ({ status: 401, body: { message: "Bad credentials" } }));
  await testBtn(page, 0).click();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Not working");
});

test("temporary failures keep the previous result and say Not checked", async ({ context, page }) => {
  let fail = false;
  await start(context, page, (c) => (fail && c.url.includes("/pulls?") ? { status: 502, body: {} } : allGood(c)));
  await testBtn(page, 0).click();
  await expect(row(page, 0)).toContainText("5 of 5 OK");
  fail = true;
  await row(page, 0).locator('.tr-result [data-act="test"]').click();
  await expect(row(page, 0).locator(".tr-result")).toContainText("Not checked");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  await expect(row(page, 0)).toContainText("5 of 5 OK");
});

test("an owner token is used alone, never replaced by the default one", async ({ context, page }) => {
  const calls = await start(context, page, (c) => (c.auth === "Bearer ghp_OWNER9999" && c.url.includes("/issues?") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : allGood(c)));
  await testBtn(page, 1).click();
  await expect(row(page, 1).locator(".state-pill")).toHaveText("Missing permissions");
  expect(calls.every((c) => c.auth === "Bearer ghp_OWNER9999")).toBe(true);
  expect(calls.some((c) => c.url.includes("/orgs/acme/repos?type=private"))).toBe(true);
  await expect(row(page, 1)).toContainText("Work");
});

test("default fine-grained token: Projects from the viewer's organizations, or Not verified without a classic-token hint", async ({ context, page }) => {
  const fine = (body) => (c) => (c.url.endsWith("/user") ? { body: { login: "sam" } } : c.url.endsWith("/graphql") ? { body } : allGood(c));
  const data = { githubTokens: [{ id: "d", name: "Default", owner: "", token: FINE }], defaultTokenId: "d" };
  await start(context, page, fine({ data: { viewer: { organizations: { nodes: [{ login: "acme", projectsV2: { totalCount: 1 } }] } } } }), data);
  await testBtn(page, 0).click();
  await expect(line(page, 0, "projects")).toContainText("Available");

  const second = await context.newPage();
  await context.unroute("https://api.github.com/**");
  await mockApi(context, fine({ data: { viewer: { organizations: { nodes: [] } } } }));
  await openOptions(context, second, "#tokens-section");
  await second.locator('.token-row [data-act="test"]').first().click();
  const projects = second.locator('[data-type="projects"]');
  await expect(projects).toContainText("Not verified");
  await expect(projects).toContainText("doesn't know which owner this token is for");
  await expect(projects).not.toContainText("classic");
  await expect(projects).not.toContainText("Access denied");
});

test("SSO and the policy are Not verified; all required types SSO: Can't verify", async ({ context, page }) => {
  await start(context, page, (c) => (/\/(contents|pulls|issues)\b/.test(c.url) ? { status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=1" }, body: { message: "SAML" } } : c.url.endsWith("/graphql") ? { body: { data: { viewer: { projectsV2: null } } } } : allGood(c)));
  await testBtn(page, 0).click();
  await expect(line(page, 0, "pulls")).toContainText("Not verified");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Can't verify");
});

test("running state: Testing…, the page stays usable", async ({ context, page }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await mockApi(context, async (c) => { if (c.url.endsWith("/user")) await gate; return allGood(c); });
  await seedStorage(context, seed());
  await openOptions(context, page, "#tokens-section");
  await testBtn(page, 0).click();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Testing…");
  await expect(testBtn(page, 0)).toBeDisabled();
  await row(page, 1).locator('[data-act="edit"]').click();
  await expect(page.locator("#token-panel")).toBeVisible();
  release();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
});

test("storage footprint: only codes in the session, local keys untouched, no answer text", async ({ context, page }) => {
  await start(context, page);
  const before = await storageOf(page, "local", ["githubTokens", "defaultTokenId"]);
  await testBtn(page, 0).click();
  await expect(row(page, 0)).toContainText("5 of 5 OK");
  expect(await storageOf(page, "local", ["githubTokens", "defaultTokenId"])).toEqual(before);
  const session = (await storageOf(page, "session", "ghrTokenTests")).ghrTokenTests;
  expect(Object.keys(session)).toEqual(["d"]);
  expect(Object.keys(session.d).sort()).toEqual(["at", "codes"]);
  expect(JSON.stringify(session)).not.toMatch(/ghp_|acme|sam/);
  await page.evaluate(() => chrome.storage.session.clear());
  await page.reload();
  await expect(page.locator("#token-list .token-item").first()).toContainText("Not tested");
  const reloaded = await storageOf(page, "session", "ghrTokenTests");
  expect(reloaded.ghrTokenTests).toBeUndefined();
});

test("the stored result is shown again after a reload within the session", async ({ context, page }) => {
  await start(context, page);
  await testBtn(page, 0).click();
  await expect(row(page, 0)).toContainText("5 of 5 OK");
  await page.reload();
  await expect(row(page, 0)).toContainText("Works");
  await expect(row(page, 0)).toContainText("5 of 5 OK");
});
