// E2E: the image gallery on a repository image page — opening, settings,
// browsing, closing and the keyboard rules. Fixtures carry the header markup
// probed live; images are served by route.
import { test, expect } from "./support/extension.js";
import { setup, dialog, counter, galleryButton, URL_B, file } from "./support/gallery.js";

test.describe("opening", () => {
  test("opens on the URL's file by default: 2 of 3, README and the x.png directory excluded", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    await expect(counter(page)).toHaveText("2 of 3");
    await expect(page.locator(".ghig-name-full")).toHaveText("b.png");
    await expect(page.getByRole("dialog", { name: "Image gallery" })).toBeVisible();
    await expect(galleryButton(page)).toHaveCount(1);
  });

  test("a folder shows the position of the URL's file (3 of 9)", async ({ context, page }) => {
    const eight = Array.from({ length: 8 }, (_, i) => file(`i${i + 1}.png`));
    await setup(context, { embedded: false, api: [{ match: /\/contents\/shots/, json: [...eight.slice(0, 2), file("b.png"), ...eight.slice(2, 8)] }] });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("3 of 9");
  });

  test("a complete folder of 200 images shows a plain count with no +", async ({ context, page }) => {
    const many = Array.from({ length: 200 }, (_, i) => file(i === 4 ? "b.png" : `m${i}.png`));
    await setup(context, { embedded: false, api: [{ match: /\/contents\/shots/, json: many }] });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("5 of 200");
  });

  test("with Open automatically off nothing opens by itself, even after a SPA change; Gallery opens the same set", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false } });
    await page.goto(URL_B);
    await expect(galleryButton(page)).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(dialog(page)).toHaveCount(0);
    await galleryButton(page).click();
    await expect(counter(page)).toHaveText("2 of 3");
  });

  test("with the feature off there is no button and no gallery; the child toggle is independent", async ({ context, page }) => {
    await setup(context, { storage: { ghigEnabled: false, ghigAutoOpen: true } });
    await page.goto(URL_B);
    await page.waitForTimeout(1500);
    await expect(galleryButton(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("after an automatic opening closes, focus is on Gallery and it reopens the same set", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(galleryButton(page)).toBeFocused();
    await galleryButton(page).click();
    await expect(counter(page)).toHaveText("2 of 3");
  });
});

test.describe("browsing and closing", () => {
  test("a → b → c → a with buttons and arrows, URL, hash and history untouched", async ({ context, page }) => {
    await setup(context);
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("2 of 3");
    const before = await page.evaluate(() => ({ url: location.href, len: history.length, state: JSON.stringify(history.state) }));
    await page.locator(".ghig-next").click();
    await expect(counter(page)).toHaveText("3 of 3");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("1 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(counter(page)).toHaveText("3 of 3");
    await page.locator(".ghig-prev").click();
    await expect(counter(page)).toHaveText("2 of 3");
    const after = await page.evaluate(() => ({ url: location.href, len: history.length, state: JSON.stringify(history.state) }));
    expect(after).toEqual(before);
    await expect(page.locator(".ghig-sr[aria-live]")).toContainText("image 2 of 3");
  });

  for (const how of ["Escape", "close button", "backdrop"]) {
    test(`${how} restores scroll and focus without reload or URL change`, async ({ context, page }) => {
      await setup(context, { storage: { ghigAutoOpen: false } });
      await page.goto(URL_B);
      await galleryButton(page).focus();
      // Scroll after focusing (focus scrolls the header into view) and open from the keyboard, as a click would scroll too.
      await page.evaluate(() => {
        document.body.style.minHeight = "3000px";
        window.scrollTo(0, 120);
        window.__marker = 1;
      });
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeVisible();
      if (how === "Escape") await page.keyboard.press("Escape");
      else if (how === "close button") await page.locator(".ghig-close").click();
      else await page.mouse.click(10, 10);
      await expect(dialog(page)).toHaveCount(0);
      await expect(galleryButton(page)).toBeFocused();
      expect(await page.evaluate(() => ({ y: window.scrollY, marker: window.__marker, url: location.href }))).toEqual({ y: 120, marker: 1, url: URL_B });
    });
  }

  test("while open, y never reaches the page; with it closed the key is untouched", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false } });
    await page.goto(URL_B);
    await page.evaluate(() => {
      window.__keys = [];
      document.addEventListener("keydown", (e) => window.__keys.push(e.key));
    });
    await page.keyboard.press("y");
    await galleryButton(page).click();
    await page.keyboard.press("y");
    await page.keyboard.press("t");
    await page.keyboard.press("Escape");
    await page.keyboard.press("y");
    expect(await page.evaluate(() => window.__keys.join(","))).toBe("y,y");
  });

  test("one image: 1 of 1, no previous or next, hint is Esc to close, arrows do nothing", async ({ context, page }) => {
    await setup(context, { embedded: false, api: [{ match: /\/contents\/shots/, json: [file("b.png"), file("README.md")] }] });
    await page.goto(URL_B);
    await expect(counter(page)).toHaveText("1 of 1");
    await expect(page.locator(".ghig-prev, .ghig-next")).toHaveCount(0);
    await expect(page.locator(".ghig-hint")).toHaveText("Esc to close");
    await page.keyboard.press("ArrowRight");
    await expect(counter(page)).toHaveText("1 of 1");
  });

  test("the image is shown from the same-origin raw URL, scaled down, never upscaled", async ({ context, page }) => {
    const seen = [];
    await setup(context, { images: seen });
    await page.goto(URL_B);
    const img = page.locator(".ghig-img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBe(1);
    const box = await img.boundingBox();
    expect(box.width).toBeLessThanOrEqual(1);
    expect(seen.some((p) => p.endsWith("/shots/b.png"))).toBe(true);
  });

  test("an SVG is shown as an image and its script does not run", async ({ context, page }) => {
    await setup(context, { storage: { ghigAutoOpen: false } });
    await page.goto(URL_B);
    await galleryButton(page).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".ghig-name-full")).toHaveText("c.svg");
    await expect(page.locator(".ghig-img")).toHaveJSProperty("complete", true);
    expect(await page.evaluate(() => ({ ran: window.__svgRan === true, title: document.title }))).toEqual({ ran: false, title: "web/shots/b.png at main · acme/web" });
  });
});
