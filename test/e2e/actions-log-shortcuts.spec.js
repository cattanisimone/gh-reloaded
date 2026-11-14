// E2E: Actions log shortcuts on run and job pages. Fixtures carry the markup
// probed live; the logs endpoint is mocked at the extension's boundary.
import { test, expect } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";
import { setup, row, copyBtn, openBtn, JOB_URL, RUN_URL, SHA } from "./support/actions-logs.js";

const clip = (page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("Copy gh command", () => {
  test("copies the job command with --log-failed and announces Copied", async ({ context, page }) => {
    await setup(context);
    await page.goto(JOB_URL);
    await expect(copyBtn(page)).toBeVisible();
    // The live region is in the row, empty, before the click, so the text set on click is announced.
    await expect(row(page).locator(".ghals-msg[role=status]")).toHaveCount(1);
    await expect(row(page).locator(".ghals-msg[role=status]")).toHaveText("");
    await copyBtn(page).click();
    expect(await clip(page)).toBe("gh run view --log-failed --job 22 --repo acme/web");
    await expect(page.locator(".ghals-msg[role=status]")).toHaveText("Copied");
  });

  test("copies the run command on a run page and never shows Open raw log there", async ({ context, page }) => {
    await setup(context, { fixture: "actions-run-failed.html" });
    await page.goto(RUN_URL);
    await copyBtn(page).click();
    expect(await clip(page)).toBe("gh run view 11 --log-failed --repo acme/web");
    await expect(openBtn(page)).toHaveCount(0);
  });

  test("a successful job copies --log", async ({ context, page }) => {
    await setup(context, { fixture: "actions-job-success.html" });
    await page.goto(JOB_URL);
    await copyBtn(page).click();
    expect(await clip(page)).toBe("gh run view --log --job 22 --repo acme/web");
  });

  test("a timed-out (cancelled) job copies --log", async ({ context, page }) => {
    await setup(context, { fixture: "actions-job-timed-out.html" });
    await page.goto(JOB_URL);
    await copyBtn(page).click();
    expect(await clip(page)).toBe("gh run view --log --job 22 --repo acme/web");
  });

  test("an older-attempt job adds --attempt; the latest attempt with an attempt menu does not", async ({ context, page }) => {
    await setup(context, { fixture: "actions-job-older-attempt.html" });
    await page.goto(JOB_URL);
    await copyBtn(page).click();
    expect(await clip(page)).toBe("gh run view --log-failed --job 22 --attempt 1 --repo acme/web");
    const p2 = await context.newPage();
    await context.unroute("https://github.com/**");
    const { routeGithub } = await import("./support/extension.js");
    await routeGithub(context, "actions-job-latest-attempt.html");
    await p2.goto(JOB_URL);
    await copyBtn(p2).click();
    expect(await clip(p2)).toBe("gh run view --log-failed --job 22 --repo acme/web");
  });

  test("copy failure shows Copy failed and keeps the command selectable", async ({ context, page }) => {
    await setup(context, { clipboard: false });
    await page.goto(JOB_URL);
    await expect(copyBtn(page)).toBeVisible();
    const iso = await isolatedWorld(context, page);
    await iso.evaluate(`Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no")) }, configurable: true }); document.execCommand = () => false; 1`);
    await copyBtn(page).click();
    await expect(page.locator(".ghals-msg")).toHaveText("Copy failed");
    await expect(page.locator(".ghals-cmd")).toHaveValue("gh run view --log-failed --job 22 --repo acme/web");
  });

  test("copy sends no request and works with no token", async ({ context, page }) => {
    const log = await setup(context, { storage: {} });
    await page.goto(JOB_URL);
    await copyBtn(page).click();
    await expect(page.locator(".ghals-msg")).toHaveText("Copied");
    expect(log).toEqual([]);
  });

  test("an in-progress job and run show no row content", async ({ context, page }) => {
    await setup(context, { fixture: "actions-job-in-progress.html" });
    await page.goto(JOB_URL);
    await expect(row(page)).toHaveCount(1);
    await expect(page.locator(".ghals-btn")).toHaveCount(0);
  });
});

test.describe("Open raw log", () => {
  test("shown with the ok state, opens the page link in a new tab, no permission text", async ({ context, page }) => {
    const log = await setup(context);
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    const [tab] = await Promise.all([context.waitForEvent("page"), openBtn(page).click()]);
    expect(tab.url()).toBe(`https://github.com/acme/web/commit/${SHA}/checks/22/logs`);
    expect(log.filter((p) => /actions\/jobs\/22\/logs/.test(p)).length).toBeGreaterThanOrEqual(1);
    await expect(page.locator("body")).not.toContainText(/permission/i);
  });

  for (const [name, opts] of [
    ["not-permitted (404)", { probe: 404 }],
    ["not-permitted (403)", { probe: 403 }],
    ["unknown (500)", { probe: 500 }],
    ["unknown (401)", { probe: 401 }],
    ["rate-limited (429)", { probe: 429 }],
    ["no token", { storage: {} }],
    ["no raw-log link on the page (signed out)", { fixture: "actions-job-signed-out.html" }],
    ["the job in progress", { fixture: "actions-job-in-progress.html" }],
  ]) {
    test(`hidden when ${name}; Copy stays; no message`, async ({ context, page }) => {
      await setup(context, opts);
      await page.goto(JOB_URL);
      if (!/in progress/.test(name)) await expect(copyBtn(page)).toBeVisible();
      await page.waitForTimeout(1800);
      await expect(openBtn(page)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/permission|could not/i);
    });
  }

  test("one probe per repository and token: a second view of the same repo sends none", async ({ context, page }) => {
    const log = await setup(context);
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    expect(log.filter((p) => /actions\/jobs\/22\/logs/.test(p)).length).toBe(1);
  });

  test("a click that fails shows Could not open log", async ({ context, page }) => {
    await setup(context, { probe: (() => { let n = 0; return 302; })() });
    await page.goto(JOB_URL);
    await expect(openBtn(page)).toBeVisible();
    await context.unroute("https://api.github.com/**");
    await context.route("https://api.github.com/**", (r) => r.fulfill({ status: 404, body: "{}", contentType: "application/json" }));
    await openBtn(page).click();
    await expect(page.locator(".ghals-msg")).toHaveText("Could not open log");
  });
});

test.describe("switch and anchors", () => {
  test("switch off: no row, no probe", async ({ context, page }) => {
    const log = await setup(context, { storage: { ghalsEnabled: false, githubTokens: [{ id: "t1", name: "D", token: "x", owner: "" }], defaultTokenId: "t1" } });
    await page.goto(JOB_URL);
    await page.waitForTimeout(1800);
    await expect(row(page)).toHaveCount(0);
    expect(log).toEqual([]);
  });

  test("a missing primary anchor means no row and no fallback", async ({ context, page }) => {
    await setup(context, { transform: (h) => h.replace('id="logs"', 'id="logz"') });
    await page.goto(JOB_URL);
    await page.waitForTimeout(1000);
    await expect(row(page)).toHaveCount(0);
  });

  test("the row sits in the content column, above the content, on current markup", async ({ context, page }) => {
    await setup(context);
    await page.goto(JOB_URL);
    await expect(row(page)).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector(".ghals-row").parentElement.matches("div.flex-auto.min-width-0") && document.querySelector(".ghals-row").nextElementSibling.getAttribute("classes") === "pb-2")).toBe(true);
  });

  test("other Actions pages get nothing", async ({ context, page }) => {
    await setup(context);
    await page.goto("https://github.com/acme/web/actions/runs/11/usage");
    await page.waitForTimeout(800);
    await expect(row(page)).toHaveCount(0);
  });
});
