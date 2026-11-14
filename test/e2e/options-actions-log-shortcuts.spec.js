// E2E: the Actions log shortcuts row, its note and warnings in Settings.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";

const NOTE = "Open raw log appears only when your token can read Actions for that repository. Fine-grained tokens need the optional Actions: Read-only permission and access to the repository; a classic token with repo usually already has it.";
const DESC = "On GitHub Actions run and job pages: Copy gh command. On job pages also Open raw log, where your token can read Actions.";
const TOKENS = {
  githubTokens: [
    { id: "t1", name: "Default", token: "ghp_a", owner: "" },
    { id: "t2", name: "Acme", token: "ghp_b", owner: "acme" },
  ],
  defaultTokenId: "t1",
};
const NP = { acme: { state: "not-permitted", at: Date.UTC(2026, 10, 13, 10, 42) } };
// Saving tokens clears stored outcomes (by design), so tokens go first.
async function seed(context, tokens, rest) {
  await seedStorage(context, tokens);
  await new Promise((r) => setTimeout(r, 150));
  await seedStorage(context, rest);
}
const row = (page) => page.locator("#features .row", { hasText: "Actions log shortcuts" });

test("the row shows the description and the note in every state, switch on by default", async ({ context, page }) => {
  await openOptions(context, page);
  await expect(row(page).locator(".row-title")).toHaveText("Actions log shortcuts");
  await expect(row(page).locator(".row-desc").first()).toHaveText(DESC);
  await expect(row(page).locator(".ghals-note")).toHaveText(NOTE);
  await expect(page.locator("#feature-ghals")).toHaveAttribute("aria-checked", "true");
  await page.locator("#feature-ghals").click();
  await expect(page.locator("#feature-ghals")).toHaveAttribute("aria-checked", "false");
  await expect(row(page).locator(".ghals-note")).toBeVisible();
  expect((await page.evaluate(() => chrome.storage.local.get("ghalsEnabled"))).ghalsEnabled).toBe(false);
});

test("no warning without a not-permitted outcome; ok and no outcome show nothing", async ({ context, page }) => {
  await seed(context, TOKENS, { ghalsOutcomes: { acme: { state: "ok", at: 1 } } });
  await openOptions(context, page);
  await expect(page.locator(".ghals-warn")).toHaveCount(0);
});

test("not-permitted warns in Features and on the owner's card; Open GitHub tokens links to the tokens panel", async ({ context, page }) => {
  await seed(context, TOKENS, { ghalsOutcomes: NP });
  await openOptions(context, page);
  const f = row(page).locator(".ghals-warn");
  await expect(f).toHaveCount(1);
  await expect(f.locator(".ghals-warn-title, .ghals-warn-when")).toHaveCount(0);
  await expect(f.locator(".ghals-warn-body")).toHaveText(/^The last check for acme could not read Actions logs \([^)]+\), so Open raw log may be hidden on its job pages\. Copy gh command keeps working\. To use it there: a fine-grained token with Actions: Read-only and access to the repository\.$/);
  await expect(f.locator(".ghals-warn-link")).toHaveAttribute("href", "#tokens-section");
  await expect(f.locator("svg[aria-hidden=true]")).toHaveCount(1);
  await page.goto(page.url().replace(/#.*$/, "") + "#tokens-section");
  const card = page.locator("#tokens .token-card", { has: page.locator(".tok-owner[value=acme]") });
  await expect(card.locator(".ghals-warn")).toContainText("Actions logs not readable for acme");
  await expect(card.locator(".ghals-warn .ghals-warn-when")).toContainText("Last check:");
  await expect(page.locator("#tokens .ghals-warn")).toHaveCount(1);
});

test("an owner without its own card warns on the default card", async ({ context, page }) => {
  await seed(context, { githubTokens: [{ id: "t1", name: "D", token: "x", owner: "" }], defaultTokenId: "t1" }, { ghalsOutcomes: NP });
  await openOptions(context, page, "#tokens-section");
  await expect(page.locator("#tokens .token-card.is-default .ghals-warn")).toContainText("acme");
});

test("switching the feature off hides the warning", async ({ context, page }) => {
  await seed(context, TOKENS, { ghalsOutcomes: NP, ghalsEnabled: true });
  await seedStorage(context, { ghalsEnabled: false });
  await openOptions(context, page);
  await expect(page.locator(".ghals-warn")).toHaveCount(0);
  await expect(row(page).locator(".ghals-note")).toBeVisible();
});

test("the fine-grained table lists Actions: Read-only as optional", async ({ context, page }) => {
  await openOptions(context, page, "#tokens-section");
  const r = page.locator("#tokens-section .permission-row", { hasText: "Actions" });
  await expect(r).toContainText("optional, only for Open raw log");
  await expect(r.locator("strong")).toHaveText("Read-only");
});

for (const [name, opts] of [["light", { colorScheme: "light" }], ["dark", { colorScheme: "dark" }], ["390 px", { colorScheme: "light", viewport: { width: 390, height: 800 } }]]) {
  test(`warning geometry (${name})`, async ({ context, page }) => {
    if (opts.viewport) await page.setViewportSize(opts.viewport);
    await page.emulateMedia({ colorScheme: opts.colorScheme });
    await seed(context, TOKENS, { ghalsOutcomes: NP });
    await openOptions(context, page);
    const g = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const text = document.querySelector("#features .row:has(#feature-ghals) .row-desc");
      const note = document.querySelector(".ghals-note");
      const warn = document.querySelector("#features .ghals-warn");
      const col = text.parentElement;
      const sw = document.querySelector("#feature-ghals");
      return { colW: r(col).width, noteW: r(note).width, warnW: r(warn).width, noteL: r(note).left, descL: r(text).left, warnL: r(warn).left, noteTop: r(note).top, descBottom: r(text).bottom, warnTop: r(warn).top, noteBottom: r(note).bottom, swW: r(sw).width, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(Math.abs(g.noteL - g.descL)).toBeLessThanOrEqual(1);
    expect(g.noteTop).toBeGreaterThan(g.descBottom - 1);
    expect(g.warnTop).toBeGreaterThan(g.noteBottom);
    expect(g.noteW / g.colW).toBeGreaterThanOrEqual(0.99);
    expect(g.warnW / g.colW).toBeGreaterThanOrEqual(0.99);
    expect(Math.abs(g.warnL - g.descL)).toBeLessThanOrEqual(1);
    expect(g.swW).toBeGreaterThan(20);
    expect(g.overflow).toBeLessThanOrEqual(0);
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector("#features .ghals-warn")).backgroundColor);
    expect(bg).toBe(opts.colorScheme === "dark" ? "rgba(187, 128, 9, 0.15)" : "rgb(255, 248, 197)");
  });
}
