// E2E: the token help box on the Settings page offers both token types.
import { test, expect, backgroundWorker } from "./support/extension.js";

async function openOptions(context, page) {
  const worker = await backgroundWorker(context);
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/options/options.html`);
}

test("the token box documents fine-grained and classic tokens", async ({ context, page }) => {
  await openOptions(context, page);
  const intro = page.locator("#tokens-section .section-intro");
  const boxes = intro.locator(".permission-box");
  await expect(boxes).toHaveCount(2);

  const fine = boxes.nth(0);
  await expect(fine.locator(".permission-row")).toHaveCount(3);
  await expect(fine).toContainText("Fine-grained");
  await expect(intro.getByRole("link", { name: /Create a fine-grained token/ }))
    .toHaveAttribute("href", "https://github.com/settings/personal-access-tokens/new");

  const classic = boxes.nth(1);
  await expect(classic).toContainText("repo");
  await expect(classic).toContainText("read:project");
  const link = intro.getByRole("link", { name: /Create a classic token/ });
  const href = new URL((await link.getAttribute("href")));
  expect(href.origin + href.pathname).toBe("https://github.com/settings/tokens/new");
  expect(href.searchParams.get("scopes")).toBe("repo,read:project");

  await expect(intro).not.toContainText(/not classic/i);
});

test("the classic box looks like the fine-grained box", async ({ context, page }) => {
  await openOptions(context, page);
  const boxes = page.locator("#tokens-section .permission-box");
  const style = (b) => b.evaluate((el) => {
    const c = getComputedStyle(el);
    const row = getComputedStyle(el.querySelector(".permission-row"));
    return [c.borderTopWidth, c.borderTopColor, c.borderRadius, row.paddingTop, row.paddingLeft];
  });
  expect(await style(boxes.nth(1))).toEqual(await style(boxes.nth(0)));
});

test("the token placeholder does not imply a token type", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(page.locator("#token-default input").first()).toHaveAttribute("placeholder", "github_pat_… or ghp_…");
});
