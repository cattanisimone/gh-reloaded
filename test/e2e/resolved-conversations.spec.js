// E2E: Resolved conversations, behaviour. The fixture carries the markup probed
// live on public pull requests; GitHub's lazy content requests are answered by
// the test and every other request is logged.
import { test, expect, backgroundWorker } from "./support/extension.js";
import { PR, bar, button, label, status, threads, resolvedThreads, setup } from "./support/resolved.js";

const expanded = (page) => page.locator('review-thread-collapsible[data-resolved="true"] > div > button[aria-expanded="true"]');

test.describe("Expand and Collapse", () => {
  test("Expand opens every resolved conversation and nothing else; the label and button follow", async ({ context, page }) => {
    await setup(context);
    await page.goto(PR);
    await expect(label(page)).toHaveText("7 resolved conversations");
    await expect(button(page)).toHaveText("Expand all resolved");
    await expect(button(page)).toHaveAttribute("aria-expanded", "false");
    await button(page).click();
    await expect(label(page)).toHaveText("7 of 7 resolved conversations expanded");
    await expect(button(page)).toHaveText("Collapse all resolved");
    await expect(button(page)).toHaveAttribute("aria-expanded", "true");
    await expect(expanded(page)).toHaveCount(7);
    // The closed unresolved conversation was not opened; the open one stayed open; content really loaded.
    await expect(page.locator('review-thread-collapsible[data-resolved="false"] button.review-thread-chevron').nth(1)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('review-thread-collapsible[data-resolved="false"] button.review-thread-chevron').nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(resolvedThreads(page).first().locator(".thread-content")).toHaveText("Comment 1 (loaded)");
    await expect(status(page)).toHaveText("7 resolved conversations expanded");
  });

  test("Collapse closes the resolved conversations and leaves unresolved ones as they were", async ({ context, page }) => {
    await setup(context);
    await page.goto(PR);
    await button(page).click();
    await expect(button(page)).toHaveText("Collapse all resolved");
    await button(page).click();
    await expect(expanded(page)).toHaveCount(0);
    await expect(label(page)).toHaveText("7 resolved conversations");
    await expect(button(page)).toHaveText("Expand all resolved");
    await expect(status(page)).toHaveText("7 resolved conversations collapsed");
    await expect(page.locator('review-thread-collapsible[data-resolved="false"] button.review-thread-chevron').nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('review-thread-collapsible[data-resolved="false"] button.review-thread-chevron').nth(1)).toHaveAttribute("aria-expanded", "false");
  });

  test("closing one conversation by hand after Expand switches back to Expand and the first-row label", async ({ context, page }) => {
    await setup(context);
    await page.goto(PR);
    await button(page).click();
    await expect(button(page)).toHaveText("Collapse all resolved");
    await resolvedThreads(page).nth(2).locator("button.review-thread-chevron").click();
    await expect(button(page)).toHaveText("Expand all resolved");
    await expect(label(page)).toHaveText("7 resolved conversations");
    await expect(button(page)).toHaveAttribute("aria-expanded", "false");
    // Expand opens only the closed one again.
    await button(page).click();
    await expect(label(page)).toHaveText("7 of 7 resolved conversations expanded");
  });

  test("one resolved conversation uses the singular", async ({ context, page }) => {
    await setup(context);
    await page.goto(`${PR}?n=1`);
    await expect(label(page)).toHaveText("1 resolved conversation");
    await button(page).click();
    await expect(label(page)).toHaveText("1 of 1 resolved conversation expanded");
    await expect(status(page)).toHaveText("1 resolved conversation expanded");
  });
});

test.describe("Load more on the page", () => {
  test("copy follows the Load more column in every state and Load more is never activated", async ({ context, page }) => {
    const { requests, apiCalls } = await setup(context);
    await page.goto(`${PR}?n=6&loadmore`);
    await expect(label(page)).toHaveText("6 loaded resolved conversations · more may be hidden");
    await expect(button(page)).toHaveText("Expand loaded resolved");
    await button(page).click();
    await expect(label(page)).toHaveText("6 of 6 loaded resolved conversations expanded · more may be hidden");
    await expect(button(page)).toHaveText("Collapse loaded resolved");
    await expect(status(page)).toHaveText("6 loaded resolved conversations expanded, more may be hidden");
    await button(page).click();
    await expect(status(page)).toHaveText("6 loaded resolved conversations collapsed, more may be hidden");
    // The extension sent nothing: only GitHub's own lazy content of the opened conversations went out.
    expect(requests.filter((u) => !/^\/acme\/web\/pull\/7\/threads\/\d+\?/.test(u))).toEqual([]);
    expect(requests.some((u) => /more_threads|timeline_more_items/.test(u))).toBe(false);
    expect(apiCalls).toEqual([]);
    expect(await page.evaluate(() => window.__loadMoreSubmits)).toBe(0);
  });

  test("a partial Expand reads K of N in its Load more form", async ({ context, page }) => {
    await setup(context, { fragment: (id) => (id === 2 ? "500" : "ok") });
    await page.goto(`${PR}?n=6&loadmore`);
    await expect(bar(page)).toBeVisible();
    await button(page).click();
    await expect(label(page)).toHaveText("5 of 6 loaded resolved conversations expanded · more may be hidden");
    await expect(button(page)).toHaveText("Expand loaded resolved");
    await expect(status(page)).toHaveText("5 of 6 loaded resolved conversations expanded, more may be hidden");
  });

  test("loading more resolved conversations updates the count, and the Load more block going away updates the copy", async ({ context, page }) => {
    await setup(context);
    await page.goto(`${PR}?n=4&loadmore`);
    await expect(label(page)).toHaveText("4 loaded resolved conversations · more may be hidden");
    await page.evaluate(() => {
      const forms = document.querySelectorAll("form.ajax-pagination-form");
      const last = forms[forms.length - 1];
      last.insertAdjacentHTML("beforebegin", [11, 12, 13].map((i) => window.ghrcThread(i, true, false)).join(""));
      forms.forEach((f) => f.remove());
    });
    await expect(label(page)).toHaveText("7 resolved conversations");
    await expect(button(page)).toHaveText("Expand all resolved");
    await expect(bar(page)).toHaveCount(1);
  });
});

test.describe("Nothing to show", () => {
  test("no review threads, and only unresolved ones: nothing is added to the page", async ({ context, page }) => {
    await setup(context, { storage: { ghrcEnabled: false } });
    await page.goto(`${PR}?none`);
    const base = await page.locator("#discussion").evaluate((e) => e.outerHTML);
    await page.goto(`${PR}?unresolved`);
    const baseU = await page.locator("#discussion").evaluate((e) => e.outerHTML);
    const worker = await backgroundWorker(context);
    await worker.evaluate(() => chrome.storage.local.set({ ghrcEnabled: true }));
    await page.goto(`${PR}?none`);
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
    expect(await page.locator("#discussion").evaluate((e) => e.outerHTML)).toBe(base);
    await page.goto(`${PR}?unresolved`);
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
    expect(await page.locator("#discussion").evaluate((e) => e.outerHTML)).toBe(baseU);
  });

  test("with the anchor renamed, nothing is added and nothing is logged", async ({ context, page }) => {
    await setup(context);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${PR}?renamed`);
    await expect(page.locator("review-thread-box")).toHaveCount(7 + 2);
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the primary anchor is used on current markup: the bar is the previous sibling of the first resolved conversation", async ({ context, page }) => {
    await setup(context);
    await page.goto(PR);
    await expect(bar(page)).toHaveCount(1);
    const info = await page.evaluate(() => {
      const b = document.querySelector(".ghrc-bar");
      const next = b.nextElementSibling;
      return { tag: next && next.tagName.toLowerCase(), resolved: next && next.dataset.resolved, firstResolved: next === document.querySelector('review-thread-collapsible[data-resolved="true"]'), parent: b.parentElement.tagName.toLowerCase() };
    });
    expect(info).toEqual({ tag: "review-thread-collapsible", resolved: "true", firstResolved: true, parent: "turbo-frame" });
  });

  test("the bar does not depend on any class of GitHub's own markup", async ({ context, page }) => {
    await setup(context);
    await page.goto(PR);
    await expect(bar(page)).toHaveCount(1);
    await page.goto(`${PR}?n=3`);
    await page.evaluate(() => {
      document.querySelectorAll("review-thread-collapsible, review-thread-collapsible *").forEach((e) => e.removeAttribute("class"));
      document.querySelector(".ghrc-bar").remove();
    });
    await expect(bar(page)).toHaveCount(1);
    await expect(label(page)).toHaveText("3 resolved conversations");
  });

  test("a resolved conversation becoming unresolved leaves the count, and the bar goes at zero", async ({ context, page }) => {
    await setup(context);
    await page.goto(`${PR}?n=2`);
    await expect(label(page)).toHaveText("2 resolved conversations");
    await page.evaluate(() => {
      const t = document.querySelector('review-thread-collapsible[data-resolved="true"]');
      t.dataset.resolved = "false";
      t.querySelector(".Label").remove();
    });
    await expect(label(page)).toHaveText("1 resolved conversation");
    await page.evaluate(() => {
      const t = document.querySelector('review-thread-collapsible[data-resolved="true"]');
      t.dataset.resolved = "false";
      t.querySelector(".Label").remove();
    });
    await expect(bar(page)).toHaveCount(0);
    // And a thread resolved later makes it appear above the first resolved one.
    await page.evaluate(() => {
      const t = document.querySelector("review-thread-collapsible");
      t.dataset.resolved = "true";
      t.querySelector("span.flex-auto").insertAdjacentHTML("beforeend", '<span class="Label Label--secondary">Resolved</span>');
    });
    await expect(label(page)).toHaveText("1 resolved conversation");
  });
});

test.describe("Settings switch", () => {
  test("off: no bar; switched on while the page is open it appears; off again it goes", async ({ context, page }) => {
    await setup(context, { storage: { ghrcEnabled: false } });
    await page.goto(PR);
    await page.waitForTimeout(600);
    await expect(bar(page)).toHaveCount(0);
    const worker = await backgroundWorker(context);
    await worker.evaluate(() => chrome.storage.local.set({ ghrcEnabled: true }));
    await expect(bar(page)).toHaveCount(1);
    await worker.evaluate(() => chrome.storage.local.set({ ghrcEnabled: false }));
    await expect(bar(page)).toHaveCount(0);
  });

  test("on by default with nothing stored", async ({ context, page }) => {
    await setup(context, { storage: {} });
    await page.goto(PR);
    await expect(bar(page)).toHaveCount(1);
  });
});

test.describe("Many conversations, slow and failing loads", () => {
  test("40 conversations: the status comes only after the last one is open, and the page stays responsive", async ({ context, page }) => {
    const { stats } = await setup(context, { delay: 30 });
    await page.goto(`${PR}?n=40`);
    await expect(label(page)).toHaveText("40 resolved conversations");
    await page.evaluate(() => {
      window.__long = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ entryTypes: ["longtask"] });
    });
    await button(page).click();
    await expect(button(page)).toHaveText("Expanding…");
    await expect(button(page)).toHaveAttribute("aria-disabled", "true");
    await expect(status(page)).toHaveText("");
    await expect(label(page)).toHaveText("40 resolved conversations");
    await expect(status(page)).toHaveText("40 resolved conversations expanded", { timeout: 30000 });
    expect(await expanded(page).count()).toBe(40);
    // A few at a time, never all at once.
    expect(stats.maxInflight).toBeGreaterThan(1);
    expect(stats.maxInflight).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => window.__long)).toBeLessThan(400);
    await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
  });

  test("one load fails and one never answers: Expanding still ends, K of N is true and Expand is offered again", async ({ context, page }) => {
    await setup(context, { delay: 10, fragment: (id) => (id === 5 ? "500" : id === 9 ? "hang" : "ok") });
    await page.goto(`${PR}?n=40`);
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.ghrcBoundMs = "600"; });
    const t0 = Date.now();
    await button(page).click();
    await expect(label(page)).toHaveText("38 of 40 resolved conversations expanded", { timeout: 30000 });
    expect(Date.now() - t0).toBeLessThan(15000);
    await expect(button(page)).toHaveText("Expand all resolved");
    await expect(button(page)).toHaveAttribute("aria-expanded", "false");
    await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(status(page)).toHaveText("38 of 40 resolved conversations expanded");
    // The two stay as GitHub shows them: a failed load keeps its fragment and its open button.
    await expect(resolvedThreads(page).nth(4).locator("include-fragment")).toHaveCount(1);
  });

  test("a conversation left closed brings back Expand; expanding again opens the late one without closing the failed one", async ({ context, page }) => {
    let mode = "500";
    await setup(context, { delay: 10, fragment: (id) => (id === 2 ? mode : "ok") });
    await page.goto(`${PR}?n=3`);
    await button(page).click();
    await expect(label(page)).toHaveText("2 of 3 resolved conversations expanded");
    // Expand again does not click the already-open (failed) conversation: it would close it.
    mode = "ok";
    await button(page).click();
    await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(resolvedThreads(page).nth(1).locator("> div > button")).toHaveAttribute("aria-expanded", "true");
  });
});

test("switching the feature off while Expanding stops opening conversations", async ({ context, page }) => {
  await setup(context, { delay: 300 });
  await page.goto(`${PR}?n=12`);
  await button(page).click();
  await expect(button(page)).toHaveText("Expanding…");
  const sw = await backgroundWorker(context);
  await sw.evaluate(() => chrome.storage.local.set({ ghrcEnabled: false }));
  await expect(bar(page)).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await resolvedThreads(page).evaluateAll((l) => l.filter((t) => t.querySelector("button[aria-expanded]").getAttribute("aria-expanded") === "true").length)).toBeLessThan(12);
});
