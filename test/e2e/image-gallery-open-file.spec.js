// E2E: "Open file on GitHub" and its one-navigation suppression, which must
// not save anything anywhere.
import { test, expect, backgroundWorker } from "./support/extension.js";
import { setup, dialog, counter, galleryButton, URL_B, file, FOLDER } from "./support/gallery.js";

const A = "https://github.com/acme/web/blob/main/shots/a.png";

async function savedState(context, page) {
  const worker = await backgroundWorker(context);
  return {
    storage: await worker.evaluate(() => chrome.storage.local.get(null)),
    local: await page.evaluate(() => JSON.stringify(localStorage)),
    session: await page.evaluate(() => JSON.stringify(sessionStorage)),
    cookie: await page.evaluate(() => document.cookie),
    state: await page.evaluate(() => JSON.stringify(history.state)),
    url: await page.evaluate(() => location.search + location.hash),
  };
}

test.describe("Open file on GitHub", () => {
  test("a plain click navigates in the same tab with one history entry, and the gallery does not reopen once", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("1 of 3");
    const len = await page.evaluate(() => history.length);
    await page.locator(".ghig-open").click();
    await expect(page).toHaveURL(A);
    await expect(galleryButton(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBe(len + 1);
    // Back is an ordinary visit again: automatic opening follows the setting.
    await page.goBack();
    await expect(page).toHaveURL(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
  });

  test("reload right after the click is an ordinary visit and opens", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowLeft");
    await page.locator(".ghig-open").click();
    await expect(page).toHaveURL(A);
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(counter(page)).toHaveText("1 of 3");
  });

  test("nothing is saved anywhere for the suppression", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    const before = await savedState(context, page);
    await page.keyboard.press("ArrowLeft");
    await page.locator(".ghig-open").click();
    await expect(page).toHaveURL(A);
    const after = await savedState(context, page);
    expect(after.storage).toEqual(before.storage);
    expect(after).toMatchObject({ local: "{}", session: "{}", cookie: "", state: "null", url: "" });
  });

  test("the link encodes spaces, #, %, non-ASCII and slashes in refs", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: /\/contents\//, json: [file("b.png"), file("a b#c%d é.png")] }] });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("1 of 2");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("2 of 2");
    await expect(page.locator(".ghig-open")).toHaveAttribute("href", "/acme/web/blob/main/shots/a%20b%23c%25d%20%C3%A9.png");
  });

  test("on the file already shown it only closes: no reload, no history entry", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    const len = await page.evaluate(() => history.length);
    await page.evaluate(() => (window.__marker = 7));
    await page.locator(".ghig-open").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => ({ len: history.length, marker: window.__marker, url: location.href }))).toEqual({ len, marker: 7, url: URL_B });
  });

  test("a modifier click leaves the original tab as it is", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowLeft");
    const popup = context.waitForEvent("page");
    await page.locator(".ghig-open").click({ modifiers: ["Control"] });
    await popup;
    await expect(page).toHaveURL(URL_B);
    await expect(dialog(page)).toBeVisible();
    await expect(counter(page)).toHaveText("1 of 3");
  });
});
