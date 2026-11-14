// E2E: the missing-permission warning above the token list, driven by the
// stored outcome of the last Test and the features that are on.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, CLASSIC } from "./support/tokens.js";

const OFF = { ghdgEnabled: false, ghsmEnabled: false, ghmiEnabled: false, ghhpEnabled: false, ghigEnabled: false, ghprtEnabled: false, ghlpsEnabled: false, ghntModules: { reasonTags: false } };
const base = { githubTokens: [{ id: "d", name: "Work – acme-demo", owner: "", token: CLASSIC }], defaultTokenId: "d" };
const codes = (over) => ({ at: Date.now(), codes: { identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked", ...over } });
const warning = (page) => page.locator("#token-warning");

async function start(context, page, { features = OFF, session = {} } = {}) {
  await seedStorage(context, { ...base, ...features });
  const worker = await openOptions(context, page, "#tokens-section");
  await worker.evaluate((s) => chrome.storage.session.set({ ghrTokenTests: s }), session);
  await page.reload();
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  return worker;
}

test("appears from stored codes: names the feature and the token, details with the installed version, three buttons", async ({ context, page }) => {
  await start(context, page, { features: { ...OFF, ghlpsEnabled: true }, session: { d: codes({ pulls: "denied" }) } });
  await expect(warning(page)).toBeVisible();
  await expect(page.locator("#warning-title")).toHaveText("Linked PR status needs a permission your token doesn't have");
  await expect(page.locator("#warning-body")).toHaveText("Tokens: «Work – acme-demo». Features you already use keep working.");
  await page.locator(".warning-details summary").click();
  const row = page.locator("#warning-details .warning-perm");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Pull requests");
  await expect(row.locator(".wp-tag")).toHaveText("Read-only");
  await expect(row).toContainText("Linked PR status: to show the status of linked pull requests.");
  await expect(page.locator("#warning-details")).toContainText("GH Reloaded never writes to GitHub.");
  await expect(warning(page).getByRole("button", { name: "How to add it" })).toBeVisible();
  await expect(warning(page).getByRole("button", { name: "Test again" })).toBeVisible();
  await expect(warning(page).getByRole("button", { name: "Later" })).toBeVisible();
  await expect(page.locator("#token-list .token-item").first().locator(".state-pill")).toHaveText("Missing permissions");
});

test("turning a feature on shows it without a reload; turning it off removes it", async ({ context, page }) => {
  await start(context, page, { session: { d: codes({ pulls: "denied" }) } });
  await expect(warning(page)).toBeHidden();
  await page.evaluate(() => chrome.storage.local.set({ ghprtEnabled: true }));
  await expect(warning(page)).toBeVisible();
  await expect(page.locator("#warning-title")).toContainText("PR triage needs");
  await page.evaluate(() => chrome.storage.local.set({ ghprtEnabled: false }));
  await expect(warning(page)).toBeHidden();
});

test("a type nobody tested yet reads 'may need', and disappears once it is proven available", async ({ context, page }) => {
  const worker = await start(context, page, { features: { ...OFF, ghlpsEnabled: true }, session: { d: { at: Date.now(), codes: { identity: "available", contents: "available" } } } });
  await expect(page.locator("#warning-title")).toHaveText("Linked PR status may need a permission your token doesn't have");
  await worker.evaluate((c) => chrome.storage.session.set({ ghrTokenTests: { d: c } }), codes({}));
  await page.reload();
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  await expect(warning(page)).toBeHidden();
});

test("Later hides it for this page; How to add it shows the steps in the warning; Test again re-tests and clears it", async ({ context, page }) => {
  let broken = true;
  await mockApi(context, (c) => (broken && c.url.includes("/pulls?") ? { status: 403, body: { message: "Resource not accessible by personal access token" } } : allGood(c)));
  await start(context, page, { features: { ...OFF, ghlpsEnabled: true }, session: { d: codes({ pulls: "denied" }) } });
  await expect(page.locator("#full-guide")).toHaveJSProperty("open", false);
  await warning(page).getByRole("button", { name: "How to add it" }).click();
  await expect(page.locator("#warning-steps li")).toHaveCount(4);
  await expect(page.locator("#warning-steps li").first().getByRole("link")).toHaveAttribute("href", "https://github.com/settings/tokens");
  const ys = await page.evaluate(() => [document.querySelector(".warning-actions").getBoundingClientRect().bottom, document.querySelector("#warning-steps").getBoundingClientRect().top]);
  expect(ys[1], `steps top ${ys[1]} must be below buttons bottom ${ys[0]}`).toBeGreaterThanOrEqual(ys[0]);
  await expect(page.locator("#full-guide")).toHaveJSProperty("open", false);
  broken = false;
  await warning(page).getByRole("button", { name: "Test again" }).click();
  await expect(warning(page)).toBeHidden();
  await expect(page.locator("#token-list .token-item").first().locator(".state-pill")).toHaveText("Works");
  broken = true;
  await page.locator('#token-list [data-act="test"]').first().click();
  await expect(warning(page)).toBeVisible();
  await warning(page).getByRole("button", { name: "Later" }).click();
  await expect(warning(page)).toBeHidden();
});

test("an untested token raises no warning", async ({ context, page }) => {
  await start(context, page, { features: { ...OFF, ghlpsEnabled: true }, session: {} });
  await expect(warning(page)).toBeHidden();
});
