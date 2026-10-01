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
