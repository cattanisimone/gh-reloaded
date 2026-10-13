// E2E: the html-preview feature. Two entry points — a globe button on a
// PR "Files changed" page, and a "Preview" tab on a single-file blob page
// — each with its disabled state.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

// A tiny HTML file for the blob preview's own fetch, so the background's
// Contents call resolves rather than erroring inside the iframe.
const FILE_B64 = Buffer.from("<!doctype html><h1>Hello</h1>", "utf-8").toString("base64");
const CONTENTS_API = [
  {
    match: /\/repos\/acme\/web\/contents\//,
    json: { content: FILE_B64, encoding: "base64", sha: "abc" },
  },
];

test.describe("PR Files changed", () => {
  test("adds a Preview button next to an HTML file", async ({ context, page }) => {
    await routeApi(context, []);
    await routeGithub(context, "pr-files.html");
    await page.goto("https://github.com/acme/web/pull/5/files");

    const btn = page.locator(".ghhp-preview-btn");
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveAttribute("aria-label", "Preview rendered HTML");
  });

  test("adds no button when the feature is disabled", async ({ context, page }) => {
    await seedStorage(context, { ghhpEnabled: false });
    await routeApi(context, []);
    await routeGithub(context, "pr-files.html");
    await page.goto("https://github.com/acme/web/pull/5/files");

    await page.waitForTimeout(1500);
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(0);
  });
});

test.describe("blob page", () => {
  test("adds a Preview tab next to Code / Blame", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");

    const tab = page.locator("#ghhp-blob-tab");
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("Preview");
    // Preview is the default landing tab for an HTML file, same as GitHub
    // does for Markdown — the panel is shown, not hidden.
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(1);
    await expect(tab).toHaveAttribute("aria-pressed", "true");
  });

  test("adds no Preview tab when the feature is disabled", async ({ context, page }) => {
    await seedStorage(context, { ghhpEnabled: false });
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");

    await page.waitForTimeout(1500);
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0);
  });
});

// #16: the controls must appear without a reload when GitHub renders their
// anchors late, when the page is reached through client-side navigation,
// and when GitHub re-renders and wipes them.
const SCAN_MS = 1200; // initial sync + at least one 800ms poll tick

test.describe("late anchors (#16)", () => {
  test("PR diff: button appears once the head branch links arrive", async ({ context, page }) => {
    await routeApi(context, []);
    await routeGithub(context, "pr-files.html", {
      transform: (html) => html.replace(/<a href="\/acme\/web\/tree\/[^"]*">[^<]*<\/a>/g, ""),
    });
    await page.goto("https://github.com/acme/web/pull/5/files");
    await page.waitForTimeout(SCAN_MS);
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(0);

    await page.evaluate(() => {
      const header = document.createElement("div");
      header.innerHTML =
        '<a href="/acme/web/tree/main">acme:main</a><a href="/acme/web/tree/feature-x">c:feature-x</a>';
      document.querySelector("main").prepend(header);
    });
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(1, { timeout: 6000 });
  });

  test("blob: Preview tab appears once Code / Blame are rendered", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html", {
      transform: (html) => html.replace(/<ul class="segmented"[\s\S]*?<\/ul>/, '<div id="toolbar-slot"></div>'),
    });
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await page.waitForTimeout(SCAN_MS);
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0);

    await page.evaluate(() => {
      document.getElementById("toolbar-slot").innerHTML =
        '<ul class="segmented" aria-label="File view">' +
        '<li data-selected=""><a role="tab" aria-pressed="true" href="/acme/web/blob/main/docs/index.html">Code</a></li>' +
        '<li><a role="tab" aria-pressed="false" href="/acme/web/blame/main/docs/index.html">Blame</a></li></ul>';
    });
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible({ timeout: 6000 });
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(1);
  });
});

test.describe("client-side navigation (#16)", () => {
  test("PR diff: button appears after navigating to Files changed", async ({ context, page }) => {
    await routeApi(context, []);
    await routeGithub(context, "pr-files.html");
    await page.goto("https://github.com/acme/web/pull/5");
    await page.waitForTimeout(SCAN_MS);
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(0);

    await page.evaluate(() => {
      history.pushState({}, "", "/acme/web/pull/5/files");
      document.dispatchEvent(new Event("turbo:load"));
    });
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(1, { timeout: 6000 });
  });

  test("blob: Preview tab appears after navigating to an HTML file", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/README.md");
    await page.waitForTimeout(SCAN_MS);
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0);

    await page.evaluate(() => {
      history.pushState({}, "", "/acme/web/blob/main/docs/index.html");
      document.dispatchEvent(new Event("turbo:load"));
    });
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible({ timeout: 6000 });
  });

  test("blob: Preview tab is removed again when leaving the HTML file", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();

    await page.evaluate(() => history.pushState({}, "", "/acme/web/blob/main/README.md"));
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0, { timeout: 6000 });
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(0);
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(0);
  });
});

test.describe("re-render restores controls (#16)", () => {
  test("PR diff: a wiped button is injected again", async ({ context, page }) => {
    await routeApi(context, []);
    await routeGithub(context, "pr-files.html");
    await page.goto("https://github.com/acme/web/pull/5/files");
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(1);

    await page.evaluate(() => document.querySelector(".ghhp-preview-btn").remove());
    await expect(page.locator(".ghhp-preview-btn")).toHaveCount(1, { timeout: 6000 });
  });

  test("blob: a wiped tab and panel are rebuilt without duplicates", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();

    await page.evaluate(() => document.getElementById("ghhp-blob-panel").remove());
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(1, { timeout: 6000 });

    await page.evaluate(() => document.getElementById("ghhp-blob-tab").remove());
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible({ timeout: 6000 });
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(1);
  });

  test("blob: replacing GitHub's Code / Blame list rebinds the Preview tab", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();

    await page.evaluate(() => {
      document.getElementById("ghhp-blob-panel").dataset.stale = "1";
      const old = document.querySelector("ul.segmented:not(.ghhp-tab-list)");
      old.replaceWith(old.cloneNode(true));
    });
    await expect(page.locator("#ghhp-blob-panel:not([data-stale])")).toHaveCount(1, { timeout: 6000 });
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(1);

    // Clicking the fresh Code tab must switch back to the native view,
    // which only works if our handlers were rebound to the new element.
    await page.evaluate(() => document.addEventListener("click", (e) => e.preventDefault()));
    await page.locator('ul.segmented:not(.ghhp-tab-list) [role="tab"]', { hasText: "Code" }).click();
    await expect(page.locator("#ghhp-blob-panel")).toBeHidden();
  });

  test("blob: disabling the feature removes the tab list and restores the code", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();

    await seedStorage(context, { ghhpEnabled: false });
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0, { timeout: 6000 });
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(0);
    await expect(page.locator('[class*="BlobContent-module__blobContentSection"]')).toBeVisible();
  });
});

// Layout regression: the panel takes the code section's slot, and in GitHub's
// markup that slot can sit in a flex row or a grid whose items size to their
// content. A panel left to auto-size there collapses into a thin strip.
test.describe("blob preview layout", () => {
  const WRAPPERS = {
    "flex row": ["display:flex;flex-direction:row;align-items:flex-start", "section"],
    "grid": ["display:grid;grid-template-columns:auto 1fr", "section"],
  };
  for (const [name, [style]] of Object.entries(WRAPPERS)) {
    for (const width of [1280, 600]) {
      test(`blob: Preview panel spans the file view in a ${name} at ${width}px`, async ({ context, page }) => {
        await page.setViewportSize({ width, height: 800 });
        await routeApi(context, CONTENTS_API);
        await routeGithub(context, "blob.html", {
          transform: (html) =>
            html
              .replace('<section class="BlobContent', `<div id="slot" style="${style}"><section class="BlobContent`)
              .replace("</section>", "</section></div>"),
        });
        await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
        const panel = page.locator("#ghhp-blob-panel");
        await expect(panel).toBeVisible();

        const geo = await page.evaluate(() => {
          const slot = document.getElementById("slot").getBoundingClientRect();
          const p = document.getElementById("ghhp-blob-panel").getBoundingClientRect();
          const f = document.querySelector("#ghhp-blob-panel iframe").getBoundingClientRect();
          return { slot: slot.width, panel: p.width, frame: f.width, scroll: document.documentElement.scrollWidth, inner: innerWidth };
        });
        expect(geo.panel).toBeGreaterThanOrEqual(geo.slot - 1);
        expect(geo.frame).toBeGreaterThanOrEqual(geo.slot - 2);
        expect(geo.scroll).toBeLessThanOrEqual(geo.inner);
      });
    }
  }
});

// Regression (#16, live): GitHub renamed the code section's CSS-module class
// (the "BlobContent-module__" prefix is gone), so the old selector matched
// nothing and the panel was inserted into the toolbar's flex row, rendering
// as a ~300px strip. The panel must sit in the code section's slot instead.
test.describe("blob preview with GitHub's renamed code section", () => {
  test("blob: panel takes the code section's slot, not the toolbar row", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html", {
      transform: (html) => html.replace("BlobContent-module__blobContentSection--s1", "blobContentSection__x1y2z3"),
    });
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    const panel = page.locator("#ghhp-blob-panel");
    await expect(panel).toBeVisible();

    const geo = await page.evaluate(() => {
      const p = document.getElementById("ghhp-blob-panel");
      const main = document.querySelector("main").getBoundingClientRect();
      return { inToolbar: !!p.closest(".file-toolbar"), panel: p.getBoundingClientRect().width, main: main.width };
    });
    expect(geo.inToolbar).toBe(false);
    expect(geo.panel).toBeGreaterThanOrEqual(geo.main - 2);
  });

  test("blob: no panel is placed in the toolbar when no code section is found", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html", {
      transform: (html) => html.replace(/<section[\s\S]*?<\/section>/, ""),
    });
    await page.goto("https://github.com/acme/web/blob/main/docs/index.html");
    await page.waitForTimeout(1500);
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(0);
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(0);
  });
});

// Going Preview -> Blame -> Code: the Blame page carries none of our
// controls, and landing back on the blob route used to auto-select Preview
// even though the user had just clicked Code.
test.describe("Blame -> Code keeps the code view", () => {
  const BLAME = "https://github.com/acme/web/blame/main/docs/index.html";
  const goBlob = () => {
    history.pushState({}, "", "/acme/web/blob/main/docs/index.html");
    document.dispatchEvent(new Event("turbo:load"));
  };

  test("blob: clicking Code on the Blame page does not auto-select Preview", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto(BLAME);
    await page.waitForTimeout(SCAN_MS);
    // The Blame page keeps all three options, but Preview has no panel there.
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(0);

    await page.evaluate(() => {
      const code = [...document.querySelectorAll('ul[aria-label] [role="tab"]')].find((t) => t.textContent.trim() === "Code");
      code.addEventListener("click", (e) => e.preventDefault());
      code.click();
    });
    await page.evaluate(goBlob);

    const tab = page.locator("#ghhp-blob-tab");
    await expect(tab).toBeVisible({ timeout: 6000 });
    await expect(page.locator("#ghhp-blob-panel")).toBeHidden();
    await expect(page.locator('section[class*="blobContentSection"]')).toBeVisible();
    await expect(tab).toHaveAttribute("aria-pressed", "false");

    // Preview still works from there.
    await tab.click();
    await expect(page.locator("#ghhp-blob-panel")).toBeVisible();
  });

  test("blob: arriving from Blame without clicking Code still lands on Preview", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto(BLAME);
    await page.waitForTimeout(SCAN_MS);

    await page.evaluate(goBlob);
    await expect(page.locator("#ghhp-blob-panel")).toBeVisible({ timeout: 6000 });
  });
});

test.describe("Preview stays available on the Blame page", () => {
  const BLAME = "https://github.com/acme/web/blame/main/docs/index.html";

  test("blame: the three-way toggle is Preview | Code | Blame, with Blame selected", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto(BLAME);

    const tab = page.locator("#ghhp-blob-tab");
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("Preview");
    await expect(tab).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(1);
    await expect(page.locator("#ghhp-blob-panel")).toHaveCount(0);
    // It links back to the blob route, which opens on Preview.
    await expect(tab).toHaveAttribute("href", "/acme/web/blob/main/docs/index.html");
  });

  test("blame: no Preview tab for a non-HTML file", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto("https://github.com/acme/web/blame/main/README.md");
    await page.waitForTimeout(SCAN_MS);
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(0);
  });

  test("blame: going back to the blob route replaces the link with the real tab and panel", async ({ context, page }) => {
    await routeApi(context, CONTENTS_API);
    await routeGithub(context, "blob.html");
    await page.goto(BLAME);
    await expect(page.locator("#ghhp-blob-tab")).toBeVisible();

    await page.evaluate(() => {
      history.pushState({}, "", "/acme/web/blob/main/docs/index.html");
      document.dispatchEvent(new Event("turbo:load"));
    });
    await expect(page.locator("#ghhp-blob-panel")).toBeVisible({ timeout: 6000 });
    await expect(page.locator("#ghhp-blob-tab")).toHaveCount(1);
    await expect(page.locator("ul.ghhp-tab-list")).toHaveCount(1);
  });
});
