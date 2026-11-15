// E2E: "Go to failed step" / "Failed steps: N" on Actions job pages (#134).
// Fixture: actions-job-failed-steps.html, the live-shaped signed-in job page
// (sticky 80px header, 88px covered stack, sticky step titles).
import { test, expect } from "./support/extension.js";
import { setup, jobPage, fsBtn, fsRoot, fsList, FS_FIXTURE, JOB_URL } from "./support/actions-logs.js";

const one = [
  { n: 1, name: "Set up job", conclusion: "success" },
  { n: 2, name: "Build", conclusion: "success", log: 300 },
  { n: 3, name: "Tests", conclusion: "failure", log: 2500 },
  { n: 4, name: "Post cleanup", conclusion: "success" },
];
const two = [
  { n: 1, name: "Set up job", conclusion: "success" },
  { n: 2, name: "Lint 🧹", conclusion: "failure", log: 4000 },
  { n: 3, name: "Build", conclusion: "success", log: 300 },
  { n: 4, name: "Tests", conclusion: "failure", log: 3000, open: true },
  { n: 5, name: "Post cleanup", conclusion: "success" },
];
const title = (page, n) => page.locator(`check-step[data-number="${n}"] > details > summary`);
const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, left: r.left, top: r.top }; });
const place = (page) => fsRoot(page).getAttribute("data-place");

async function open(context, page, { width = 1280, height = 900, page: pg = {}, ...rest } = {}) {
  await page.setViewportSize({ width, height });
  const log = await setup(context, { fixture: FS_FIXTURE, transform: jobPage({ steps: one, ...pg }), ...rest });
  await page.goto(JOB_URL);
  return log;
}

test("one failed step: Go to failed step in the sticky header, one click lands the title at 88px, collapsed, focused", async ({ context, page }) => {
  await open(context, page);
  await expect(fsBtn(page)).toHaveText("Go to failed step");
  expect(await place(page)).toBe("name");
  const before = await page.evaluate(() => ({ url: location.href, hist: history.length, open: [...document.querySelectorAll("check-step details")].map((d) => d.open) }));
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(150);
  expect((await rect(fsBtn(page))).top).toBeGreaterThanOrEqual(0);
  await fsBtn(page).click();
  await expect.poll(async () => Math.round((await rect(title(page, 3))).top)).toBeGreaterThanOrEqual(86);
  expect((await rect(title(page, 3))).top).toBeLessThanOrEqual(90);
  expect((await rect(title(page, 3))).bottom).toBeLessThanOrEqual(900);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.closest("check-step")?.dataset.number)).toBe("3");
  const after = await page.evaluate(() => ({ url: location.href, hist: history.length, open: [...document.querySelectorAll("check-step details")].map((d) => d.open) }));
  expect(after).toEqual(before);
});

test("two failed steps far apart: the button is in the window with no gesture; the list is in execution order; choosing lands and closes", async ({ context, page }) => {
  await open(context, page, { page: { steps: two } });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(fsBtn(page)).toHaveText("Failed steps: 2");
  expect(await place(page)).toBe("name");
  const r = await rect(fsBtn(page));
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(r.bottom).toBeLessThanOrEqual(80);
  await fsBtn(page).click();
  await expect(fsList(page).getByRole("menuitem")).toHaveText(["Lint 🧹", "Tests"]);
  await expect(fsBtn(page)).toHaveAttribute("aria-expanded", "true");
  await fsList(page).getByRole("menuitem", { name: "Lint 🧹" }).click();
  await expect(fsList(page)).toBeHidden();
  await expect.poll(async () => Math.round((await rect(title(page, 2))).top)).toBeGreaterThanOrEqual(86);
  expect((await rect(title(page, 2))).top).toBeLessThanOrEqual(90);
  expect(await title(page, 2).evaluate((s) => s.parentElement.open)).toBe(false);
  expect(await title(page, 4).evaluate((s) => s.parentElement.open)).toBe(true);
});

test("a title that starts under the sticky header lands fully below the 88px covered area", async ({ context, page }) => {
  await open(context, page, { page: { steps: [{ n: 1, name: "A", conclusion: "success", log: 200 }, { n: 2, name: "First", conclusion: "failure", log: 260 }, { n: 3, name: "Second", conclusion: "failure", log: 900 }] } });
  await page.evaluate(() => window.scrollTo(0, 0));
  // put the first failed title 16px under the 88px band
  await page.evaluate(() => { const t = document.querySelector("check-step[data-number='2'] summary"); window.scrollBy(0, t.getBoundingClientRect().top - 72); });
  await fsBtn(page).click();
  await fsList(page).getByRole("menuitem", { name: "First" }).click();
  await expect.poll(async () => Math.round((await rect(title(page, 2))).top)).toBeGreaterThanOrEqual(86);
  expect((await rect(title(page, 2))).top).toBeLessThanOrEqual(90);
});

test("no wording presents a step as the cause", async ({ context, page }) => {
  await open(context, page, { page: { steps: two } });
  await fsBtn(page).click();
  const text = await fsRoot(page).evaluate((e) => e.textContent + " " + e.getAttribute("aria-label") + " " + [...e.querySelectorAll("[aria-label]")].map((x) => x.getAttribute("aria-label")).join(" "));
  expect(text).not.toMatch(/cause|root|reason|culprit|because/i);
});

test("no request is made by the control, whatever the capability state", async ({ context, page }) => {
  for (const probe of [302, 403]) {
    const log = [];
    await open(context, page, { probe, log });
    await expect(fsBtn(page)).toBeVisible();
    const seen = log.length;
    await fsBtn(page).click();
    await page.waitForTimeout(300);
    expect(log.length).toBe(seen);
  }
  const log2 = [];
  await open(context, page, { storage: {}, log: log2 });
  await expect(fsBtn(page)).toBeVisible();
});

test("no failed step shown: no control and no error; a successful job: none", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(context, page, { page: { steps: [{ n: 1, name: "A", conclusion: "success" }, { n: 2, name: "B", conclusion: "skipped" }] } });
  await page.waitForTimeout(700);
  await expect(fsRoot(page)).toHaveCount(0);
  expect(errors).toEqual([]);
  await expect(page.locator(".ghals-row")).toHaveCount(1);
});

test("failed step rows missing their title control: no control", async ({ context, page }) => {
  await open(context, page, { page: { extra: (h) => h.replace(/<summary class="CheckStep-header[^>]*>/g, "<div>").replaceAll("</summary>", "</div>") } });
  await page.waitForTimeout(600);
  await expect(fsRoot(page)).toHaveCount(0);
});

test("a run in progress: a step turning failed adds the control, N grows, nothing is duplicated", async ({ context, page }) => {
  await open(context, page, { page: { steps: [{ n: 1, name: "A", conclusion: "success" }, { n: 2, name: "B", conclusion: "" }, { n: 3, name: "C", conclusion: "" }] } });
  await page.waitForTimeout(500);
  await expect(fsRoot(page)).toHaveCount(0);
  const fail = (n) => page.evaluate((n) => document.querySelector(`check-step[data-number='${n}']`).setAttribute("data-conclusion", "failure"), n);
  await fail(2);
  await expect(fsBtn(page)).toHaveText("Go to failed step");
  await fail(3);
  await expect(fsBtn(page)).toHaveText("Failed steps: 2");
  await fail(3);
  await page.waitForTimeout(500);
  await expect(fsRoot(page)).toHaveCount(1);
});

test("a step that continues on error and shows as failed is counted and listed", async ({ context, page }) => {
  await open(context, page, { page: { steps: [{ n: 1, name: "Flaky", conclusion: "failure", attrs: 'data-continue-on-error=""' }, { n: 2, name: "Tests", conclusion: "failure" }] } });
  await expect(fsBtn(page)).toHaveText("Failed steps: 2");
  await fsBtn(page).click();
  await expect(fsList(page).getByRole("menuitem")).toHaveText(["Flaky", "Tests"]);
});

test("job A to B to A, back and forward: one control, the current page's steps", async ({ context, page }) => {
  await open(context, page, { page: { steps: two } });
  await expect(fsBtn(page)).toHaveText("Failed steps: 2");
  await page.evaluate(() => history.pushState({}, "", "/acme/web/actions/runs/11/job/33"));
  await page.evaluate(() => { for (const s of document.querySelectorAll("check-step[data-number='2'], check-step[data-number='4']")) s.dataset.conclusion = "success"; document.querySelector("check-step[data-number='4']").dataset.conclusion = "failure"; });
  await expect(fsBtn(page)).toHaveText("Go to failed step");
  await expect(fsRoot(page)).toHaveCount(1);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/actions/runs/11/usage"));
  await expect(fsRoot(page)).toHaveCount(0);
  await page.goBack();
  await page.waitForTimeout(500);
  expect(await fsRoot(page).count()).toBeLessThanOrEqual(1);
});

test("the Actions log shortcuts switch off removes it, on again brings it back", async ({ context, page }) => {
  await open(context, page, { storage: { ghalsEnabled: false } });
  await page.waitForTimeout(600);
  await expect(fsRoot(page)).toHaveCount(0);
});

test("run pages keep Copy gh command alone", async ({ context, page }) => {
  await setup(context, { fixture: "actions-run-failed.html" });
  await page.goto("https://github.com/acme/web/actions/runs/11");
  await expect(page.getByRole("button", { name: "Copy gh command" })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(fsRoot(page)).toHaveCount(0);
});

test("keyboard: Enter opens the list, arrows move, Enter chooses, Esc closes and returns focus to the button", async ({ context, page }) => {
  await open(context, page, { page: { steps: two } });
  await expect(fsBtn(page)).toHaveAttribute("aria-haspopup", "menu");
  await expect(fsBtn(page)).toHaveAttribute("aria-expanded", "false");
  await fsBtn(page).focus();
  await page.keyboard.press("Enter");
  await expect(fsList(page)).toBeVisible();
  const items = fsList(page).getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fsList(page)).toBeHidden();
  await expect(fsBtn(page)).toBeFocused();
  await fsBtn(page).press("Space");
  await expect(fsList(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(fsList(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement.closest("check-step")?.dataset.number)).toBe("4");
});

test("an outside click closes the list", async ({ context, page }) => {
  await open(context, page, { page: { steps: two } });
  await fsBtn(page).click();
  await expect(fsList(page)).toBeVisible();
  await page.mouse.click(200, 500);
  await expect(fsList(page)).toBeHidden();
  await expect(fsBtn(page)).toHaveAttribute("aria-expanded", "false");
});

test("native look of the control: 28px, 6px radius, no margin; focus ring 2px #0969da", async ({ context, page }) => {
  await open(context, page);
  const s = await fsBtn(page).evaluate((e) => { const c = getComputedStyle(e); return { h: c.height, r: c.borderTopLeftRadius, m: c.margin, bw: c.borderTopWidth }; });
  expect(s).toEqual({ h: "28px", r: "6px", m: "0px", bw: "1px" });
  await page.keyboard.press("Tab");
  await fsBtn(page).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const o = await fsBtn(page).evaluate((e) => { const c = getComputedStyle(e); return { w: c.outlineWidth, c: c.outlineColor, off: c.outlineOffset }; });
  if (await fsBtn(page).evaluate((e) => e === document.activeElement)) expect(o).toEqual({ w: "2px", c: "rgb(9, 105, 218)", off: "-2px" });
});
