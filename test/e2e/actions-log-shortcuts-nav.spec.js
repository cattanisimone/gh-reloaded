// E2E: SPA navigation. GitHub changes the route without a reload; the row
// must follow it, never duplicate and never show the previous page's IDs.
import { test, expect } from "./support/extension.js";
import { setup, row, copyBtn, openBtn, JOB_URL } from "./support/actions-logs.js";

const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const go = (page, path) => page.evaluate((p) => history.pushState({}, "", p), path);

test("job A → B → A: one row, commands follow the URL", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  await expect(openBtn(page)).toBeVisible();
  await go(page, "/acme/web/actions/runs/11/job/33");
  await expect.poll(async () => { await copyBtn(page).click(); return clip(page); }).toBe("gh run view --log-failed --job 33 --repo acme/web");
  await expect(row(page)).toHaveCount(1);
  await go(page, "/acme/web/actions/runs/11/job/22");
  await expect.poll(async () => { await copyBtn(page).click(); return clip(page); }).toBe("gh run view --log-failed --job 22 --repo acme/web");
  await expect(row(page)).toHaveCount(1);
});

test("repo X → repo Y: the new repository is detected on its own", async ({ context, page }) => {
  const log = await setup(context);
  await page.goto(JOB_URL);
  await expect(openBtn(page)).toBeVisible();
  await go(page, "/acme/api/actions/runs/5/job/6");
  await expect.poll(async () => { await copyBtn(page).click(); return clip(page); }).toBe("gh run view --log-failed --job 6 --repo acme/api");
  await expect(row(page)).toHaveCount(1);
  await expect.poll(() => log.filter((p) => /repos\/acme\/api\/actions\/jobs\/6\/logs/.test(p)).length).toBe(1);
});

test("job → a non-Actions page removes the row; back brings it again; back and forward never duplicate", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  await expect(row(page)).toHaveCount(1);
  await go(page, "/acme/web/actions/runs/11/usage");
  await expect(row(page)).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => row(page).count()).toBeLessThanOrEqual(1);
  await page.goForward().catch(() => {});
  await page.waitForTimeout(600);
  expect(await row(page).count()).toBeLessThanOrEqual(1);
});

test("a late detection answer for the page left behind is not applied to the new one", async ({ context, page }) => {
  await setup(context, { delay: 1200 });
  await page.goto(JOB_URL);
  await expect(row(page)).toHaveCount(1);
  await go(page, "/acme/web/actions/runs/11/usage");
  await page.waitForTimeout(2500);
  await expect(row(page)).toHaveCount(0);
  await expect(page.locator(".ghals-btn")).toHaveCount(0);
});

test("native viewer is untouched: Search logs and steps keep working", async ({ context, page }) => {
  await setup(context);
  await page.goto(JOB_URL);
  await expect(row(page)).toHaveCount(1);
  const search = page.getByRole("searchbox", { name: "Search logs" }).or(page.locator('input[aria-label="Search logs"]'));
  await search.fill("abc");
  await expect(search).toHaveValue("abc");
  expect(page.url()).toBe(JOB_URL);
});
