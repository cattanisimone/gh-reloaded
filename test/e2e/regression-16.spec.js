// Regression test for issue #16: on a PR "Files changed" page, the
// html-preview scan marked a diff row as "checked" BEFORE the file's
// path was resolvable. When the path arrived a moment later (progressive
// diff rendering), the already-marked row was skipped forever, so the
// Preview button never appeared until a full reload.
//
// This drives the real bug: the kebab is present but the path isn't, the
// first scan runs, then the path is injected and a later scan must still
// add the button.
import { test, expect, routeGithub, routeApi } from "./support/extension.js";

test("#16: a diff row whose path resolves late still gets a Preview button", async ({
  context,
  page,
}) => {
  await routeApi(context, []);
  await routeGithub(context, "pr-files-lazy.html");
  await page.goto("https://github.com/acme/web/pull/5/files");

  // The kebab is there from the start; the path is not.
  await page.waitForSelector('summary[aria-label="More options"]');
  await expect(page.locator(".ghhp-preview-btn")).toHaveCount(0);

  // Let the content script run at least one scan against the path-less
  // row (initial sync + an 800ms poll tick). On main, this is where the
  // row gets permanently marked as checked.
  await page.waitForTimeout(1200);

  // Now the path arrives, as it would with progressive diff rendering.
  await page.evaluate(() => {
    const header = document.querySelector("#diff-0 .file-header");
    const span = document.createElement("span");
    span.className = "file-name";
    span.innerHTML = "<code>docs/index.html</code>";
    header.insertBefore(span, header.firstChild);
  });

  // A later scan must now add the button; before the fix the row had
  // already been marked as checked and was skipped forever.
  await expect(page.locator(".ghhp-preview-btn")).toHaveCount(1, { timeout: 6000 });
});
