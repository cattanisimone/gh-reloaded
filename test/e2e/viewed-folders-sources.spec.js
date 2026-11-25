// E2E: where "Viewed per folder" gets its state: the native buttons, the read-only API read,
// what is shown while it loads and when part of it cannot be read, and that it only ever reads.
import { test, expect, backgroundWorker } from "./support/extension.js";
import { openFiles, indicators, settled } from "./support/viewed.js";

const ALL = [
  "README.md", "docs/guide.md", "features/quick-jump/content.js", "features/quick-jump/model.js", "server/Cargo.toml", "server/main.rs",
  "server/api/Cargo.toml", "server/api/src/lib.rs", "server/api/src/handlers/auth.rs", "server/api/src/handlers/routes.rs",
  "server/storage_backend_migrations/0001_init.sql", "server/storage_backend_migrations/0002_users.sql", "server/storage_backend_migrations/0003_index.sql",
  "web/src/app.tsx", "web/src/index.tsx",
];
const vendor = (n) => Array.from({ length: n }, (_, i) => `vendor/lib/file-${String(i + 1).padStart(3, "0")}.rs`);
const unviewed = (paths) => Object.fromEntries(paths.map((p) => [p, "UNVIEWED"]));

test("loading: folders that are not exact show the static pill while the read is pending, then the exact state", async ({ context, page }) => {
  await openFiles(context, page, { token: true, query: "rendered=0&extra=99", api: { delay: 1500, states: { ...unviewed([...ALL, ...vendor(99)]), "docs/guide.md": "VIEWED" } } });
  await expect(page.locator('li[id="server"] > .row-container .ghvf-ind')).toHaveAttribute("data-state", "loading");
  const loading = await indicators(page);
  expect(loading["vendor/lib"]).toMatchObject({ state: "loading", count: "", text: "Reading viewed state of 99 files" });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".ghvf-ind .ghvf-pill")).animationName)).toBe("none");
  await settled(page);
  const done = await indicators(page);
  expect(done["docs"]).toMatchObject({ state: "viewed" });
  expect(done["vendor/lib"]).toMatchObject({ state: "toview", count: "0/99" });
});

test("API read: exact counts for files whose diffs are not rendered; read is one POST to the GraphQL endpoint", async ({ context, page }) => {
  const states = { ...unviewed([...ALL, ...vendor(99)]), "vendor/lib/file-001.rs": "VIEWED", "vendor/lib/file-002.rs": "VIEWED", "server/main.rs": "DISMISSED" };
  const log = await openFiles(context, page, { token: true, query: "rendered=0&extra=99", api: { states } });
  await settled(page);
  const ind = await indicators(page);
  expect(ind["vendor/lib"]).toMatchObject({ state: "partial", count: "2/99", text: "2 of 99 files viewed" });
  expect(ind["server"]).toMatchObject({ state: "toview", count: "0/9" }); // DISMISSED is not viewed
  expect(log.length).toBe(2); // 114 files: two pages of up to 100
  expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(Array(2).fill("POST https://api.github.com/graphql"));
  const body = JSON.parse(log[0].post);
  expect(body.query).not.toMatch(/mutation/i);
  expect(body.variables).toMatchObject({ owner: "acme", repo: "web", number: 7 });
});

test("a read paginated in pages of 100 gives the same counts", async ({ context, page }) => {
  const states = { ...unviewed([...ALL, ...vendor(199)]), "vendor/lib/file-150.rs": "VIEWED" };
  const log = await openFiles(context, page, { token: true, query: "rendered=0&extra=199", api: { states } });
  await settled(page);
  expect(log.length).toBe(3);
  expect((await indicators(page))["vendor/lib"]).toMatchObject({ count: "1/199" });
});

test("no token: the page alone; folders it cannot prove show the dashed ring with a lower bound, complete ones stay exact", async ({ context, page }) => {
  // The first 8 diffs render (README.md, docs/guide.md, quick-jump x2, server/Cargo.toml, api/Cargo.toml, auth.rs, routes.rs).
  const log = await openFiles(context, page, { query: "rendered=8&extra=99&viewed=server/api/src/handlers/auth.rs" });
  await settled(page);
  expect(log).toEqual([]); // no token, no request
  const ind = await indicators(page);
  expect(ind["server/api/src/handlers"]).toMatchObject({ state: "partial", count: "1/2" }); // both known
  expect(ind["docs"]).toMatchObject({ state: "toview", count: "0/1" });
  expect(ind["features/quick-jump"]).toMatchObject({ state: "toview", count: "0/2" });
  expect(ind["server"]).toMatchObject({ state: "unknown", count: "1+/9", text: "At least 1 of 9 files viewed; the state of 5 files cannot be read" });
  expect(ind["server/api"]).toMatchObject({ state: "unknown", count: "1+/4" });
  expect(ind["vendor/lib"]).toMatchObject({ state: "unknown", count: "?/99", text: "The viewed state of 99 files cannot be read" });
  expect(ind["server/storage_backend_migrations"]).toMatchObject({ state: "unknown", count: "?/3" });
  for (const v of Object.values(ind)) if (v.state === "unknown") expect(v.text).not.toMatch(/\bAll\b|\b0 of\b/);
});

test("a read that fails (403, 404, 500) is silent: the page is used, no dialog, no error", async ({ context, page }) => {
  const problems = [];
  page.on("dialog", (d) => problems.push("dialog " + d.message()));
  page.on("pageerror", (e) => problems.push(e.message));
  const log = await openFiles(context, page, { token: true, query: "rendered=2", api: { status: 403 } });
  await settled(page);
  expect(log.length).toBe(1);
  const ind = await indicators(page);
  expect(ind["docs"]).toMatchObject({ state: "toview", count: "0/1" }); // README.md, docs/guide.md rendered
  expect(ind["server"].state).toBe("unknown");
  expect(problems).toEqual([]);
});

test("GitHub returning nothing for the pull request (null) behaves like a failed read", async ({ context, page }) => {
  await openFiles(context, page, { token: true, query: "rendered=2", api: { body: { data: { repository: { pullRequest: null } } } } });
  await settled(page);
  expect((await indicators(page))["server"].state).toBe("unknown");
});

test("a tick made while the read is in flight is not undone by its (older) answer", async ({ context, page }) => {
  await openFiles(context, page, { token: true, api: { delay: 1000, states: unviewed(ALL) } });
  await expect(page.locator('li[id="docs"] > .row-container .ghvf-ind')).toBeVisible();
  await page.evaluate(() => [...document.querySelectorAll("#diffs [role=region]")].find((r) => r.querySelector("code").textContent.includes("docs/guide.md")).querySelector("button").click());
  await expect(page.locator('li[id="docs"] > .row-container .ghvf-ind')).toHaveAttribute("data-state", "viewed"); // page source, read still pending
  await settled(page); // the read arrives and says UNVIEWED
  await expect(page.locator('li[id="docs"] > .row-container .ghvf-ind')).toHaveAttribute("data-state", "viewed");
});

test("the read decides a file the page showed before the read started", async ({ context, page }) => {
  // The page rendered docs/guide.md as viewed; the read (made after) says it is not: the newer source wins.
  await openFiles(context, page, { token: true, query: "viewed=docs/guide.md", api: { states: unviewed(ALL) } });
  await settled(page);
  await expect(page.locator('li[id="docs"] > .row-container .ghvf-ind')).toHaveAttribute("data-state", "toview");
});

test("the file list is not proven (no token, tree smaller than the counter): every folder is unknown part, never exact", async ({ context, page }) => {
  // Arrives filtered to "api": the tree lists 4 of the 15 changed files while the counter says 15.
  await openFiles(context, page, { query: "filter=api&viewed=server/api/Cargo.toml" });
  await settled(page);
  const ind = await indicators(page);
  expect(Object.keys(ind).sort()).toEqual(["server", "server/api", "server/api/src", "server/api/src/handlers"].sort());
  for (const v of Object.values(ind)) {
    expect(v.state).toBe("unknown");
    expect(v.text).toMatch(/the number of changed files in this folder cannot be read/);
    expect(v.text).not.toMatch(/\bAll\b|\b0 of\b/);
  }
  expect(ind["server/api"].count).toBe("1+/?");
  expect(ind["server/api/src/handlers"].count).toBe("?");
});

test("no counter text on the page and no token: the list cannot be proven, so no folder is exact", async ({ context, page }) => {
  await openFiles(context, page, { query: "counter=none" });
  await expect(page.locator("#tree .ghvf-ind")).toHaveCount(8);
  for (const v of Object.values(await indicators(page))) expect(v.state).toBe("unknown");
});

test("a text filter applied after arrival never shrinks a count", async ({ context, page }) => {
  await openFiles(context, page, { query: "viewed=server/api/src/handlers/auth.rs" });
  await settled(page);
  const before = await indicators(page);
  await page.evaluate(() => window.__filter("auth"));
  await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(4); // server, api, src, handlers
  await settled(page);
  const after = await indicators(page);
  for (const id of Object.keys(after)) expect(after[id]).toEqual(before[id]);
  expect(after["server/api/src/handlers"]).toMatchObject({ count: "1/2" }); // 2 files below, not the 1 the filter shows
  await page.evaluate(() => window.__filter(""));
  await settled(page);
  expect(await indicators(page)).toEqual(before);
});

test("it only reads: one GraphQL query, no mutation, no click on any native control", async ({ context, page }) => {
  const log = await openFiles(context, page, { token: true, api: { states: unviewed(ALL) } });
  await settled(page);
  await page.locator('li[id="server"] > .row-container').click();
  await page.locator('li[id="server"] > .row-container').click();
  await page.locator("#diffs [role=region] button").first().click(); // the user's own tick
  await page.locator(".ghvf-ind").first().hover();
  await page.waitForTimeout(400);
  expect(log.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://api.github.com/graphql"]);
  expect(log.every((r) => !/mutation|markFileAsViewed/i.test(r.post || ""))).toBe(true);
  const native = await page.evaluate(() => window.__native);
  expect(native.untrusted).toEqual([]); // nothing the extension did was a click
  expect(native.viewedClicks).toBe(1); // only the user's
});

test("the native counter, the Viewed buttons and the filter are identical with and without the feature", async ({ context, page }) => {
  await openFiles(context, page, { storage: { ghvfEnabled: false } });
  await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(8);
  const snap = () => page.evaluate(() => ({
    counter: document.getElementById("counter-box").outerHTML,
    buttons: [...document.querySelectorAll("#diffs .viewed-btn")].map((b) => b.outerHTML).join("\n"),
    filter: document.getElementById("filter-box").outerHTML + document.getElementById("viewed-files-filter").outerHTML,
  }));
  const off = await snap();
  // switch it on in the same page and compare again
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghvfEnabled: true }));
  await settled(page);
  expect(await snap()).toEqual(off);
});
