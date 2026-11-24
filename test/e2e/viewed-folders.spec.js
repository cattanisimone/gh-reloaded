// E2E: "Viewed per folder" on the new Files changed page — one indicator per folder row, the states
// and nested counts, collapsing, the native tick, the switch, and the pages that must stay untouched.
import { test, expect } from "./support/extension.js";
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
