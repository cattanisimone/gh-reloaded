// E2E: listing states and image failures of the image gallery. Every notice
// leaves GitHub's preview untouched, never says "empty folder" and never
// claims a permission it cannot prove.
import { test, expect, seedStorage } from "./support/extension.js";
import { setup, dialog, counter, galleryButton, URL_B, file, FOLDER } from "./support/gallery.js";

const LIST = /\/contents(\/|$)/;
const notice = (page) => page.locator(".ghig-notice");

async function expectBlocked(page, text) {
  await expect(galleryButton(page)).toHaveAttribute("aria-disabled", "true");
  await expect(notice(page)).toContainText(text);
  await expect(dialog(page)).toHaveCount(0);
  await galleryButton(page).click({ force: true });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".blobContentSection__g1-z7P img")).toBeVisible(); // GitHub's own preview is untouched
}

test.describe("listing states", () => {
  test("rate limit: no gallery, inactive Gallery, the rate-limit notice, no retry loop", async ({ context, page }) => {
    let calls = 0;
    await setup(context, { embedded: false, api: [{ match: LIST, status: () => (++calls, 403), json: { message: "API rate limit exceeded" } }] });
    await page.goto(URL_B);
    await expectBlocked(page, "Gallery unavailable: GitHub request limit reached. Try again later.");
    await page.waitForTimeout(2000);
    expect(calls).toBe(1);
  });

  test("5xx: the listing-error notice", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: LIST, status: 500, json: {} }] });
    await page.goto(URL_B);
    await expectBlocked(page, "Gallery unavailable: could not read the folder list. Try again later.");
  });

  test("an ambiguous 404 says it cannot tell and names no permission", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: LIST, status: 404, json: { message: "Not Found" } }] });
    await page.goto(URL_B);
    await expectBlocked(page, "GH Reloaded can't tell why.");
    expect(await notice(page).getAttribute("title")).not.toMatch(/permission|scope/i);
  });

  test("a private repository with no token gets the private notice and no request", async ({ context, page }) => {
    let calls = 0;
    await setup(context, {
      api: [{ match: LIST, status: () => (++calls, 200), json: FOLDER }],
      transform: (h) => h.replace('"private":false', '"private":true').replace(/"fileTree":\{"shots"/, '"fileTreeOff":{"shots"'),
    });
    await page.goto(URL_B);
    await expectBlocked(page, "Gallery unavailable: no GH Reloaded token applies to this private repository.");
    expect(calls).toBe(0);
  });

  test("a private repository with a saved token for its owner works fully", async ({ context, page }) => {
    await setup(context, {
      storage: { githubTokens: [{ id: "t", name: "d", token: "tok", owner: "acme" }], defaultTokenId: "t" },
      transform: (h) => h.replace('"private":false', '"private":true').replace(/"fileTree":\{"shots"/, '"fileTreeOff":{"shots"'),
    });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
  });

  test("a file missing from the list: the 'isn't in the folder list' notice, never 'empty'", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: LIST, json: [file("a.png"), file("c.svg")] }] });
    await page.goto(URL_B);
    await expectBlocked(page, "Gallery unavailable: this file isn't in the folder list GitHub returned.");
    await expect(page.locator("body")).not.toContainText(/folder is empty|empty folder/i);
  });

  test("a read listing with no supported image is the same notice", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: LIST, json: [file("README.md")] }] });
    await page.goto(URL_B);
    await expectBlocked(page, "isn't in the folder list");
  });

  test("1000 entries: counter with +, tooltip, incomplete notice, circular navigation", async ({ context, page }) => {
    const big = Array.from({ length: 1000 }, (_, i) => file(i === 1 ? "b.png" : `p${i}.png`));
    await setup(context, { embedded: false, api: [{ match: LIST, json: big }] });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 1000+");
    await expect(counter(page)).toHaveAttribute("title", "Image 2 of at least 1000: the folder list is incomplete");
    await expect(page.locator(".ghig-sr[aria-live]")).toContainText("image 2 of at least 1000, folder list incomplete");
    await page.keyboard.press("Escape");
    await expect(notice(page)).toContainText("Incomplete list");
    await galleryButton(page).click();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("1000 of 1000+");
  });

  test("1000 entries where the current file is outside: no gallery opens on another image", async ({ context, page }) => {
    const big = Array.from({ length: 1000 }, (_, i) => file(`p${i}.png`));
    await setup(context, { embedded: false, api: [{ match: LIST, json: big }] });
    await page.goto(URL_B);
    await expect(notice(page)).toContainText("Incomplete list");
    await expect(galleryButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("a delayed listing: native page usable, nothing declared, then it opens only if the user did nothing", async ({ context, page }) => {
    await setup(context, { embedded: false });
    await context.route("https://api.github.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 1800));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FOLDER) });
    });
    await page.goto(URL_B);
    await expect(galleryButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(".Box_1__1bJV7g")).not.toContainText(/\d+ of \d+/);
    await expect(dialog(page)).toHaveCount(0);
    await expect(counter(page)).toHaveText("2 of 3", { timeout: 8000 });
  });

  test("a delayed listing after the user clicked on the page: Gallery becomes usable but does not open", async ({ context, page }) => {
    await setup(context, { embedded: false });
    await context.route("https://api.github.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FOLDER) });
    });
    await page.goto(URL_B);
    await page.mouse.click(600, 400);
    await galleryButton(page).click({ force: true });
    await expect(dialog(page)).toHaveCount(0); // a click before the set is known declares nothing
    await expect(galleryButton(page)).toHaveAttribute("aria-disabled", "false", { timeout: 8000 });
    await page.waitForTimeout(500);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("a set arriving after leaving the page is discarded", async ({ context, page }) => {
    await setup(context, { embedded: false });
    await context.route("https://api.github.com/**", async (route) => {
      await new Promise((r) => setTimeout(r, 1800));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FOLDER) });
    });
    await page.goto(URL_B);
    await page.evaluate(() => {
      history.pushState({}, "", "/acme/web/tree/main/shots");
      document.dispatchEvent(new Event("turbo:load"));
    });
    await page.waitForTimeout(3000);
    await expect(dialog(page)).toHaveCount(0);
    await expect(galleryButton(page)).toHaveCount(0);
  });
});

test.describe("image failures", () => {
  const goToC = async (page) => {
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".ghig-name-full")).toHaveText("c.svg");
  };

  test("a bare load error stays neutral; counter, previous and next stay active", async ({ context, page }) => {
    await setup(context, { broken: ["c.svg"], api: [{ match: /\/contents\/shots\/c.svg/, status: 403, json: { message: "Forbidden" } }, { match: LIST, json: FOLDER }] });
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    await goToC(page);
    await expect(page.locator(".ghig-fail-title")).toHaveText("Can't show this image");
    await expect(counter(page)).toHaveText("3 of 3");
    await expect(page.locator(".ghig-next")).toBeEnabled();
    await expect(page.locator(".ghig-open")).toBeVisible();
  });

  test("removed is shown only when the repository proves the file is gone", async ({ context, page }) => {
    let dirCalls = 0;
    await setup(context, {
      embedded: false,
      broken: ["c.svg"],
      api: [
        { match: /\/contents\/shots\/c\.svg/, status: 404, json: { message: "Not Found" } },
        { match: LIST, json: () => (++dirCalls === 1 ? FOLDER : FOLDER.filter((f) => f.name !== "c.svg")) },
      ],
    });
    await page.goto(URL_B);
    await goToC(page);
    await expect(page.locator(".ghig-fail-title")).toHaveText("File no longer available");
    await expect(page.locator(".ghig-fail-text")).toContainText("c.svg is no longer on main");
  });

  test("damaged is shown only when bytes arrived and still do not decode", async ({ context, page }) => {
    await setup(context, {
      broken: ["c.svg"],
      api: [{ match: /\/contents\/shots\/c\.svg/, json: { content: Buffer.from("not an image").toString("base64"), size: 12 } }, { match: LIST, json: FOLDER }],
    });
    await page.goto(URL_B);
    await goToC(page);
    await expect(page.locator(".ghig-fail-title")).toHaveText("Can't display this image");
  });

  test("received bytes are shown as an image instead of failing", async ({ context, page }) => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await setup(context, {
      broken: ["a.png"],
      api: [{ match: /\/contents\/shots\/a\.png/, json: { content: png, size: 70 } }, { match: LIST, json: FOLDER }],
    });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".ghig-img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(page.locator(".ghig-fail")).toBeHidden();
  });
});
