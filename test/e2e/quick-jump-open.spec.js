// E2E: Quick jump opens and closes from the browser command, keeps focus rules, and the footer.
import { test, expect } from "./support/extension.js";
import { setup, toggle, openPanel, panel, input, EDITABLES, TOKENS } from "./support/quick-jump.js";

const PAGES = { "*": { body: EDITABLES, repoHeader: true } };

test("opens with focus in the input; the command again closes and returns focus", async ({ context, page }) => {
  await setup(context, { pages: PAGES });
  await page.goto("https://github.com/acme/web");
  await page.locator("#btn").focus();
  await openPanel(context, page, null);
  await expect(panel(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Quick jump" })).toBeVisible();
  await toggle(context, page);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("#btn")).toBeFocused();
});

test("Esc closes and returns focus where it was; the command inside the input closes too", async ({ context, page }) => {
  await setup(context, { pages: PAGES });
  await page.goto("https://github.com/acme/web");
  await page.locator("#btn").focus();
  await openPanel(context, page, null);
  await input(page).fill("x");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("#btn")).toBeFocused();
  await toggle(context, page);
  await expect(input(page)).toBeFocused();
  await toggle(context, page);
  await expect(panel(page)).toHaveCount(0);
});

test("editable: with focus in an input, a textarea or a contenteditable the view does not open and the field is unchanged", async ({ context, page }) => {
  await setup(context, { pages: PAGES });
  await page.goto("https://github.com/acme/web");
  await openPanel(context, page, null); // makes sure the state is loaded, then close
  await page.keyboard.press("Escape");
  for (const sel of ["#field", "#comment", "#editor"]) {
    await page.locator(sel).focus();
    await page.keyboard.type("ab");
    await toggle(context, page);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator(sel)).toBeFocused();
  }
  await expect(page.locator("#field")).toHaveValue("ab");
  await expect(page.locator("#comment")).toHaveValue("ab");
});

test("clicking the backdrop closes the panel", async ({ context, page }) => {
  await setup(context, { pages: PAGES });
  await openPanel(context, page);
  await page.mouse.click(5, 600);
  await expect(panel(page)).toHaveCount(0);
});

test("the footer shows the browser shortcut and Change opens the Quick jump row of Settings", async ({ context, page }) => {
  await setup(context, { pages: PAGES });
  await openPanel(context, page);
  await expect(page.locator(".ghqj-sc-keys")).toHaveText(/Alt\+Shift\+K|Ctrl\+Shift\+K|⌃⇧K|Not set/);
  const [tab] = await Promise.all([context.waitForEvent("page"), page.locator(".ghqj-change").click()]);
  expect(tab.url()).toMatch(/chrome-extension:\/\/[a-z]+\/options\/options\.html#quick-jump$/);
});

test("no token: the shortcut does nothing, no panel and no request", async ({ context, page }) => {
  const { reqs } = await setup(context, { storage: {}, pages: PAGES });
  await page.goto("https://github.com/acme/web");
  await page.waitForTimeout(800);
  await toggle(context, page);
  await page.waitForTimeout(300);
  await expect(panel(page)).toHaveCount(0);
  expect(reqs).toEqual([]);
  void TOKENS;
});

test("switched off: no panel", async ({ context, page }) => {
  await setup(context, { storage: { ...TOKENS, ghqjEnabled: false }, pages: PAGES });
  await page.goto("https://github.com/acme/web");
  await page.waitForTimeout(800);
  await toggle(context, page);
  await expect(panel(page)).toHaveCount(0);
});
