// E2E: where the image gallery exists and where it must not — exclusions,
// SPA navigation, ref changes, Back / Forward and cleanup.
import { test, expect } from "./support/extension.js";
import { setup, dialog, counter, galleryButton, URL_B, file, FOLDER } from "./support/gallery.js";

const GITHUB = "https://github.com/acme/web";
const spa = (page, path) =>
  page.evaluate((p) => {
    history.pushState({}, "", p);
    document.dispatchEvent(new Event("turbo:load"));
  }, path);

test.describe("exclusions", () => {
  for (const [label, url] of [
    ["folder page", `${GITHUB}/tree/main/shots`],
    ["blame page", `${GITHUB}/blame/main/shots/b.png`],
    ["raw URL", `${GITHUB}/raw/main/shots/b.png`],
    ["README blob", `${GITHUB}/blob/main/shots/README.md`],
    ["PDF blob", `${GITHUB}/blob/main/shots/spec.pdf`],
    ["BMP blob", `${GITHUB}/blob/main/shots/old.bmp`],
    ["PR files changed", `${GITHUB}/pull/5/files`],
    ["commit diff", `${GITHUB}/commit/abc123`],
    ["issue", `${GITHUB}/issues/5`],
  ]) {
    test(`adds nothing on ${label}`, async ({ context, page }) => {
      await setup(context);
      await page.goto(url);
      await page.waitForTimeout(1500);
      await expect(galleryButton(page)).toHaveCount(0);
      await expect(dialog(page)).toHaveCount(0);
    });
  }

  test("an SVG in Code view has nothing; back to Preview is an ordinary visit that adds Gallery again", async ({ context, page }) => {
    await setup(context, { fixture: "blob-image-svg.html", storage: { ghigAutoOpen: false } });
    await page.goto(`${GITHUB}/blob/main/shots/c.svg`);
    await expect(galleryButton(page)).toBeVisible();
    await page.getByRole("button", { name: "Code" }).click();
    await expect(galleryButton(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(galleryButton(page)).toHaveCount(1);
  });

  test("a blob page without GitHub's file header (404) adds nothing", async ({ context, page }) => {
    await setup(context, { transform: (h) => h.replace(/class="react-blob-header-edit-and-raw-actions/g, 'class="gone') });
    await page.goto(URL_B);
    await page.waitForTimeout(1500);
    await expect(galleryButton(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe("navigation", () => {
  test("SPA file → file: the new visit uses the new file, no duplicate button", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    await page.keyboard.press("Escape");
    await spa(page, "/acme/web/blob/main/shots/a.png");
    await expect(counter(page)).toHaveText("1 of 3"); // embedded data is stale: the API list is used
    await expect(galleryButton(page)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await spa(page, "/acme/web/blob/main/shots/b.png");
    await expect(counter(page)).toHaveText("2 of 3");
    await expect(galleryButton(page)).toHaveCount(1);
  });

  test("moving to an excluded page closes an open gallery and removes everything", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    await spa(page, "/acme/web/tree/main/shots");
    await expect(dialog(page)).toHaveCount(0);
    await expect(galleryButton(page)).toHaveCount(0);
  });

  test("a branch with slashes gives the set of that ref; the ref is not counted from the URL", async ({ context, page }) => {
    const refs = [];
    await setup(context, {
      api: [
        {
          match: (p) => p.includes("/contents"),
          status: (u) => (u.searchParams.get("ref") === "feature/foo/bar" ? 200 : 404),
          json: (u) => {
            refs.push(u.searchParams.get("ref"));
            return u.searchParams.get("ref") === "feature/foo/bar" ? FOLDER : { message: "Not Found" };
          },
        },
      ],
      embedded: false,
    });
    await page.goto(`${GITHUB}/blob/feature/foo/bar/shots/b.png`);
    await expect(counter(page)).toHaveText("2 of 3");
    expect(refs).toContain("feature/foo/bar");
    await expect(page.locator(".ghig-open")).toHaveAttribute("href", "/acme/web/blob/feature/foo/bar/shots/b.png");
  });

  test("Back and Forward are ordinary visits: an open gallery closes and the arrival page starts from the URL's file", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await page.keyboard.press("Escape");
    await spa(page, "/acme/web/blob/main/shots/a.png");
    await expect(counter(page)).toHaveText("1 of 3");
    await page.locator(".ghig-next").click(); // browsing never changes the URL
    await expect(counter(page)).toHaveText("2 of 3");
    expect(new URL(page.url()).pathname).toBe("/acme/web/blob/main/shots/a.png");
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(URL_B);
    await expect(counter(page)).toHaveText("2 of 3"); // b.png, the URL's file, not the last browsed image
    await page.evaluate(() => history.forward());
    await expect(counter(page)).toHaveText("1 of 3"); // a.png
    await expect(dialog(page)).toHaveCount(1);
  });

  test("reload starts from the URL's file; the last browsed image is not remembered", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await page.locator(".ghig-next").click();
    await expect(counter(page)).toHaveText("3 of 3");
    await page.reload();
    await expect(counter(page)).toHaveText("2 of 3");
  });

  test("the toggle set stays and survives Auto-open off after an SPA change", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false } });
    await page.goto(URL_B);
    await expect(galleryButton(page)).toBeVisible();
    await spa(page, "/acme/web/blob/main/shots/a.png");
    await page.waitForTimeout(1500);
    await expect(dialog(page)).toHaveCount(0);
    await expect(galleryButton(page)).toHaveCount(1);
  });

  test("anchor missing: nothing is inserted elsewhere, and it appears when the header arrives", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false }, transform: (h) => h.replace(/class="react-blob-header-edit-and-raw-actions/g, 'class="pending-actions') });
    await page.goto(URL_B);
    await page.waitForTimeout(1500);
    await expect(galleryButton(page)).toHaveCount(0);
    await page.evaluate(() => document.querySelectorAll('[class*="pending-actions"]').forEach((e) => (e.className = e.className.replace(/pending-actions/, "react-blob-header-edit-and-raw-actions"))));
    await expect(galleryButton(page)).toHaveCount(1, { timeout: 6000 });
    expect(await galleryButton(page).evaluate((b) => b.parentElement.className + "|" + b.nextElementSibling?.className)).toMatch(/Box_3/);
  });
});
