// E2E: "Viewed per folder" on the new Files changed page — one indicator per folder row, the states
// and nested counts, collapsing, the native tick, the switch, and the pages that must stay untouched.
import { test, expect, backgroundWorker, seedStorage } from "./support/extension.js";
import { openFiles, indicators, settled, FILES } from "./support/viewed.js";

const ALL_VIEWED_API = "viewed=server/api/src/handlers/auth.rs,server/api/src/handlers/routes.rs,server/api/src/lib.rs,server/api/Cargo.toml";

test("every folder row has one indicator, file rows none", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const folders = await page.locator("#tree li[aria-expanded]").count();
  expect(folders).toBe(8); // docs, features/quick-jump, server, api, src, handlers, storage_backend_migrations, web/src (compacted)
  await expect(page.locator("#tree .ghvf-ind")).toHaveCount(folders);
  for (const li of await page.locator("#tree li[aria-expanded]").all()) await expect(li.locator(":scope > .row-container .ghvf-ind")).toHaveCount(1);
  await expect(page.locator("#tree li:not([aria-expanded]) .ghvf-ind")).toHaveCount(0);
  await expect(page.locator("#tree .ghvf-ind[aria-hidden=true]")).toHaveCount(folders);
});

test("states and nested counts: check, partial, empty, parents count every descendant", async ({ context, page }) => {
  await openFiles(context, page, { query: ALL_VIEWED_API + ",server/main.rs,docs/guide.md" });
  await settled(page);
  const ind = await indicators(page);
  expect(ind["docs"]).toMatchObject({ state: "viewed", count: "", text: "1 of 1 file viewed" });
  expect(ind["server/api"]).toMatchObject({ state: "viewed", text: "All 4 files viewed" }); // Cargo.toml + lib.rs + 2 handlers
  expect(ind["server/api/src"]).toMatchObject({ state: "viewed", text: "All 3 files viewed" });
  expect(ind["server"]).toMatchObject({ state: "partial", count: "5/9", text: "5 of 9 files viewed" }); // 4 below api + main.rs, of 9
  expect(ind["server/api/src/handlers"]).toMatchObject({ state: "viewed", text: "All 2 files viewed" });
  expect(ind["server/storage_backend_migrations"]).toMatchObject({ state: "toview", count: "0/3", text: "0 of 3 files viewed" });
  expect(ind["features/quick-jump"]).toMatchObject({ state: "toview", count: "0/2" });
  expect(ind["web/src"]).toMatchObject({ state: "toview", count: "0/2" });
});

test("collapsing and expanding keeps every indicator", async ({ context, page }) => {
  await openFiles(context, page, { query: ALL_VIEWED_API });
  await settled(page);
  const before = await indicators(page);
  await page.locator('li[id="server"] > .row-container').click(); // collapse: the rows below are unmounted
  await expect(page.locator('li[id="server"]')).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('li[id="server/api"]')).toHaveCount(0);
  const collapsed = await indicators(page);
  expect(collapsed["server"]).toEqual(before["server"]);
  expect(collapsed["docs"]).toEqual(before["docs"]);
  await page.locator('li[id="server"] > .row-container').click(); // expand: brand new rows
  await expect(page.locator('li[id="server/api"]')).toHaveCount(1);
  await settled(page);
  expect(await indicators(page)).toEqual(before);
});

test("tick updates every containing folder before the next frame; untick restores", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const before = await indicators(page);
  expect(before["server/api/src/handlers"].count).toBe("0/2");
  const after = await page.evaluate(async () => {
    const region = [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("handlers/auth.rs"));
    region.querySelector("button").click();
    await new Promise((r) => requestAnimationFrame(() => r())); // the next frame
    const read = (id) => document.getElementById(id).querySelector(".ghvf-count").textContent;
    return { handlers: read("server/api/src/handlers"), src: read("server/api/src"), api: read("server/api"), server: read("server"), docs: read("docs") };
  });
  expect(after).toEqual({ handlers: "1/2", src: "1/3", api: "1/4", server: "1/9", docs: "0/1" });
  await page.locator("#diffs [role=region] button").nth(5).click(); // another file, untouched folders stay put
  const restored = await page.evaluate(async () => {
    const region = [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("handlers/auth.rs"));
    region.querySelector("button").click(); // untick
    await new Promise((r) => requestAnimationFrame(() => r()));
    return document.getElementById("server/api/src/handlers").querySelector(".ghvf-count").textContent;
  });
  expect(restored).toBe("0/2");
});

test("a click GitHub reverts is followed: the indicator shows what the button shows", async ({ context, page }) => {
  await openFiles(context, page, { query: "revert=1" });
  await settled(page);
  await page.evaluate(() => [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("docs/guide.md")).querySelector("button").click());
  await expect(page.locator('li[id="docs"] .ghvf-ind')).toHaveAttribute("data-state", "viewed"); // optimistic
  await expect(page.locator('li[id="docs"] .ghvf-ind')).toHaveAttribute("data-state", "toview"); // reverted by GitHub
  await expect(page.locator('li[id="docs"] .ghvf-count')).toHaveText("0/1");
});

test("switching the feature off removes every indicator and its description; back on restores them", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const worker = await backgroundWorker(context);
  expect(await page.evaluate(() => document.getElementById("server").getAttribute("aria-describedby"))).toMatch(/ghvf-d-\d+/);
  await worker.evaluate(() => chrome.storage.local.set({ ghvfEnabled: false }));
  await expect(page.locator(".ghvf-ind")).toHaveCount(0);
  await expect(page.locator(".ghvf-tip")).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("#tree [aria-describedby]")].filter((e) => /ghvf/.test(e.getAttribute("aria-describedby"))).length)).toBe(0);
  await worker.evaluate(() => chrome.storage.local.set({ ghvfEnabled: true }));
  await settled(page);
  await expect(page.locator("#tree .ghvf-ind")).toHaveCount(8);
});

test("seeded off at load: nothing is added", async ({ context, page }) => {
  const log = await openFiles(context, page, { token: true, storage: { ghvfEnabled: false } });
  await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(8);
  await page.waitForTimeout(600);
  await expect(page.locator(".ghvf-ind")).toHaveCount(0);
  expect(log).toEqual([]); // switched off: no read either
});

test("the classic Files changed page and other pages are left alone, with no request and no error", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const log = await openFiles(context, page, { query: "classic=1", token: true });
  await page.waitForTimeout(700);
  await expect(page.locator(".ghvf-ind, .ghvf-tip")).toHaveCount(0);
  expect(log).toEqual([]);
  expect(errors).toEqual([]);
});

for (const path of ["/acme/web/pull/7", "/acme/web/pull/7/commits", "/acme/web/pull/7/files/aaa111..bbb222", "/acme/web/pull/7/changes/aaa111", "/acme/web/issues/7"]) {
  test(`${path}: nothing is added and nothing is requested`, async ({ context, page }) => {
    const log = await openFiles(context, page, { path, token: true });
    await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(8);
    await page.waitForTimeout(600);
    await expect(page.locator(".ghvf-ind")).toHaveCount(0);
    expect(log).toEqual([]);
  });
}

test("lifecycle: Files changed to Conversation and back re-reads; another pull request starts clean", async ({ context, page }) => {
  const log = await openFiles(context, page, { token: true, api: { states: { "docs/guide.md": "VIEWED" } } });
  await settled(page);
  await expect.poll(() => log.length).toBe(1);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7"));
  await expect(page.locator(".ghvf-ind")).toHaveCount(0);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/7/changes"));
  await settled(page);
  await expect.poll(() => log.length).toBe(2);
  await page.evaluate(() => history.back()); // popstate: back to the Conversation entry
  await expect(page.locator(".ghvf-ind")).toHaveCount(0);
  await page.evaluate(() => history.forward());
  await settled(page);
  await expect.poll(() => log.length).toBe(3);
  await page.evaluate(() => history.pushState({}, "", "/acme/web/pull/8/files"));
  await expect.poll(() => log.length).toBe(4);
  expect(JSON.parse(log[3].post).variables).toMatchObject({ owner: "acme", repo: "web", number: 8 });
});
