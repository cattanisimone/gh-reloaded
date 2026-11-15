// E2E: Resolved conversations across in-page navigation (Turbo-style): exactly
// one bar on a Conversation tab with resolved conversations, none elsewhere.
import { test, expect } from "./support/extension.js";
import { PR, bar, label, button, setup } from "./support/resolved.js";

const FILES = '<main class="page"><h2>Files changed</h2><p>No review threads here.</p></main>';

// What Turbo does: swap the page body, push the history entry, fire its events.
const visit = (page, url, html) =>
  page.evaluate(([u, h]) => {
    history.pushState({}, "", u);
    document.querySelector("main").outerHTML = h;
    document.dispatchEvent(new Event("turbo:render"));
    document.dispatchEvent(new Event("turbo:load"));
  }, [url, html]);

test("Conversation → Files changed → Conversation: one bar, none on Files changed, rebuilt from a snapshot", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(bar(page)).toHaveCount(1);
  const snapshot = await page.evaluate(() => document.querySelector("main").outerHTML); // includes the bar, without its listeners
  expect(snapshot).toContain("ghrc-bar");
  await visit(page, "/acme/web/pull/7/files", FILES);
  await page.waitForTimeout(500);
  await expect(bar(page)).toHaveCount(0);
  await visit(page, "/acme/web/pull/7", snapshot);
  await expect(bar(page)).toHaveCount(1);
  // The rebuilt bar works: the snapshot's copy had no listeners.
  await button(page).click();
  await expect(label(page)).toHaveText("7 of 7 resolved conversations expanded");
});

test("the bar left in the DOM of another route goes at the next scan", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(bar(page)).toHaveCount(1);
  // Route changes without swapping the DOM (history.pushState alone).
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7/files"));
  await expect(bar(page)).toHaveCount(0);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7"));
  await expect(bar(page)).toHaveCount(1);
});

test("another pull request, then back and forward: always exactly one bar for the page shown", async ({ context, page }) => {
  await setup(context);
  await page.goto(PR);
  await expect(label(page)).toHaveText("7 resolved conversations");
  const pageA = await page.evaluate(() => document.querySelector("main").outerHTML);
  // PR B has two resolved conversations.
  const pageB = await page.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = '<main class="page"><div class="js-discussion" id="discussion">' + [21, 22].map((i) => window.ghrcThread(i, true, false)).join("") + "</div></main>";
    return d.innerHTML;
  });
  await visit(page, "/acme/web/pull/8", pageB);
  await expect(bar(page)).toHaveCount(1);
  await expect(label(page)).toHaveText("2 resolved conversations");
  await page.goBack().catch(() => {});
  await page.evaluate((h) => { document.querySelector("main").outerHTML = h; document.dispatchEvent(new Event("turbo:render")); }, pageA);
  await expect(bar(page)).toHaveCount(1);
  await expect(label(page)).toHaveText("7 resolved conversations");
  await visit(page, "/acme/web/pull/8", pageB);
  await expect(bar(page)).toHaveCount(1);
  await expect(label(page)).toHaveText("2 resolved conversations");
});

test("a Turbo re-render that replaces the bar's frame leaves exactly one bar", async ({ context, page }) => {
  await setup(context);
  await page.goto(`${PR}?n=3`);
  await expect(bar(page)).toHaveCount(1);
  await page.evaluate(() => {
    const frame = document.querySelector("turbo-frame");
    frame.outerHTML = window.ghrcThread(1, true, false);
  });
  await expect(bar(page)).toHaveCount(1);
  await expect(label(page)).toHaveText("3 resolved conversations");
});

test("leaving the Conversation tab while Expanding ends the run and leaves nothing behind", async ({ context, page }) => {
  await setup(context, { delay: 200 });
  await page.goto(`${PR}?n=10`);
  await button(page).click();
  await expect(button(page)).toHaveText("Expanding…");
  await visit(page, "/acme/web/pull/7/files", FILES);
  await page.waitForTimeout(800);
  await expect(bar(page)).toHaveCount(0);
  // Back on the Conversation tab with no resolved conversation loaded: still no bar, and the dead run did not revive one.
  await visit(page, "/acme/web/pull/7", '<main class="page"><div class="js-discussion"></div></main>');
  await page.waitForTimeout(500);
  await expect(bar(page)).toHaveCount(0);
});
