// E2E: the GitHub tokens list on the Settings page: one row per token, no
// secret in the page, the guide, and the save round-trip.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, storageOf } from "./support/tokens.js";

const DEF = "ghp_defaultAAAA";
const OWN = "ghp_ownerBBBB";
const two = {
  githubTokens: [
    { id: "d", name: "Personal", owner: "", token: DEF },
    { id: "o", name: "Work", owner: "acme-org", token: OWN },
  ],
  defaultTokenId: "d",
};

test("list shows default and owner rows without secrets", async ({ context, page }) => {
  await seedStorage(context, two);
  await openOptions(context, page, "#tokens-section");
  const rows = page.locator("#token-list .token-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Personal");
  await expect(rows.nth(0)).toContainText("Used for: all repositories");
  await expect(rows.nth(0)).toContainText("Not tested");
  await expect(rows.nth(0)).toContainText("Never tested");
  await expect(rows.nth(1)).toContainText("Work");
  await expect(rows.nth(1)).toContainText("Used for: acme-org");
  const html = await page.content();
  for (const secret of [DEF, OWN, "AAAA", "BBBB"]) expect(html).not.toContain(secret);
});

test("empty state opens the guide and sends nothing; with a token the guide is closed", async ({ context, page }) => {
  const calls = await mockApi(context, allGood);
  await openOptions(context, page, "#tokens-section");
  await expect(page.locator("#token-list .token-item")).toHaveCount(1);
  await expect(page.locator("#token-list")).toContainText("Not set");
  await expect(page.locator("#full-guide")).toHaveJSProperty("open", true);
  await expect(page.locator("#token-guide")).toContainText("New token? Three steps");
  expect(calls).toHaveLength(0);

  const second = await context.newPage();
  await seedStorage(context, two);
  await openOptions(context, second, "#tokens-section");
  await expect(second.locator("#full-guide")).toHaveJSProperty("open", false);
});

test("technical words only inside the Full guide", async ({ context, page }) => {
  await seedStorage(context, two);
  await openOptions(context, page, "#tokens-section");
  const outside = await page.locator("#tokens-section").evaluate((section) => {
    const clone = section.cloneNode(true);
    clone.querySelector("#full-guide").remove();
    clone.querySelectorAll("[hidden]").forEach((el) => el.remove());
    return clone.innerText;
  });
  expect(outside).not.toMatch(/capabilit|scope|fine-grained/i);
  const guide = page.locator("#full-guide");
  await guide.locator("summary").click();
  await expect(guide).toContainText("Fine-grained token");
  await expect(guide).toContainText("read:project");
  await expect(guide.getByRole("link", { name: /Create a fine-grained token/ })).toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");
  const href = new URL(await guide.getByRole("link", { name: /Create a classic token/ }).getAttribute("href"));
  expect(href.origin + href.pathname).toBe("https://github.com/settings/tokens/new");
  expect(href.searchParams.get("scopes")).toBe("read:project,public_repo");
  await expect(guide.locator(".permission-box")).toHaveCount(2);
  await expect(guide.locator(".permission-box").first().locator(".permission-row")).toHaveCount(4);
});

test("the classic box looks like the fine-grained box", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  const boxes = page.locator("#full-guide .permission-box");
  const style = (b) => b.evaluate((el) => {
    const c = getComputedStyle(el);
    const row = getComputedStyle(el.querySelector(".permission-row"));
    return [c.borderTopWidth, c.borderTopColor, c.borderRadius, row.paddingTop, row.paddingLeft];
  });
  expect(await style(boxes.nth(1))).toEqual(await style(boxes.nth(0)));
});

test("the token placeholder does not imply a token type", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  await page.locator("#token-list [data-act=edit]").first().click();
  await expect(page.locator("#panel-secret")).toHaveAttribute("placeholder", "github_pat_… or ghp_…");
});

test("a default and an owner token save from the panel, storage keys unchanged", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  await page.locator('#token-list [data-act="edit"]').first().click();
  await page.locator("#panel-secret").fill(DEF);
  await page.locator("#panel-save").click();
  await expect(page.locator("#tokens-status")).toContainText("Saved");
  await page.locator("#add-token").click();
  await page.locator("#panel-name").fill("Work");
  await page.locator("#panel-owner").fill("@acme-org");
  await page.locator("#panel-secret").fill(OWN);
  await page.locator("#panel-save").click();
  await expect(page.locator("#token-list .token-item")).toHaveCount(2);
  const stored = await storageOf(page, "local", ["githubTokens", "defaultTokenId"]);
  expect(stored.githubTokens.map(({ name, owner, token }) => ({ name, owner, token }))).toEqual([
    { name: "Default", owner: "", token: DEF },
    { name: "Work", owner: "acme-org", token: OWN },
  ]);
  expect(stored.defaultTokenId).toBe(stored.githubTokens[0].id);
  await page.reload();
  await expect(page.locator("#token-list .token-item")).toHaveCount(2);
  await expect(page.locator("#token-list .token-item").nth(1)).toContainText("Used for: acme-org");
});
