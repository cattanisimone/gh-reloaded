// E2E: where "Viewed per folder" attaches in GitHub's own markup. The primary anchor is the element the
// folder row's aria-labelledby names; the class part "TreeViewItemContent" is the second choice only when
// that attribute gives no element, and a row with neither gets nothing (no other container, no error).
import { test, expect } from "./support/extension.js";
import { openFiles, settled } from "./support/viewed.js";

const parents = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#tree li[aria-expanded]")].map((li) => {
      const ind = li.querySelector(":scope > .row-container .ghvf-ind");
      const named = document.getElementById(li.getAttribute("aria-labelledby") || "");
      return { id: li.id, has: !!ind, inNamed: !!(ind && named && ind.parentElement === named), parentClass: ind ? ind.parentElement.className : null, last: !!(ind && ind.parentElement.lastElementChild === ind) };
    })
  );

test("current markup (prc- names): the indicator is the last child of the aria-labelledby content", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  const rows = await parents(page);
  expect(rows.length).toBe(8);
  for (const r of rows) {
    expect(r.inNamed, r.id).toBe(true);
    expect(r.last, r.id).toBe(true);
    expect(r.parentClass).toContain("TreeViewItemContent");
  }
});

test("the newer naming (TreeViewItemContent__hash, no prc- prefix) works the same, including the label for the room check", async ({ context, page }) => {
  await openFiles(context, page, { query: "naming=next&pane=256&viewed=docs/guide.md" });
  await settled(page);
  for (const r of await parents(page)) expect(r.inNamed && r.last, r.id).toBe(true);
  expect(await page.evaluate(() => document.querySelector(".TreeViewItemContentText__q1w2e3") !== null && document.querySelector('[class*="prc-TreeView-TreeViewItemContent"]') === null && document.querySelector('[class*="PRIVATE_TreeView-item-content"]') === null)).toBe(true);
  await expect(page.locator('li[id="docs"] .ghvf-ind')).toHaveAttribute("data-state", "viewed");
});

test("a decoy with a content-like class does not capture the indicator: the fallback cannot mask the primary anchor", async ({ context, page }) => {
  await openFiles(context, page, { query: "decoy=1" });
  await settled(page);
  for (const r of await parents(page)) expect(r.inNamed, r.id).toBe(true);
  await expect(page.locator(".TreeViewItemContent__decoy .ghvf-ind")).toHaveCount(0);
});

test("second choice, only when aria-labelledby is missing: the class part is used", async ({ context, page }) => {
  await openFiles(context, page, { query: "nolabelledby=1" });
  await settled(page);
  const rows = await parents(page);
  for (const r of rows) {
    expect(r.has, r.id).toBe(true);
    expect(r.parentClass, r.id).toMatch(/TreeViewItemContent/);
    expect(r.parentClass).not.toMatch(/ContentText/);
  }
});

test("no content element at all: no indicator anywhere, no other container, no description, no error", async ({ context, page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openFiles(context, page, { query: "noanchor=1" });
  await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(8);
  await page.waitForTimeout(700);
  await expect(page.locator(".ghvf-ind")).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("[aria-describedby]")].filter((e) => /ghvf/.test(e.getAttribute("aria-describedby"))).length)).toBe(0);
  expect(errors).toEqual([]);
});

test("a row GitHub re-renders without our indicator gets it back", async ({ context, page }) => {
  await openFiles(context, page);
  await settled(page);
  await page.evaluate(() => document.querySelector('li[id="docs"] .ghvf-ind').remove()); // a React render that drops it
  await expect(page.locator('li[id="docs"] > .row-container .ghvf-ind')).toHaveCount(1);
  await page.evaluate(() => window.__rerender("server")); // a remount
  await expect(page.locator('li[id="server"] > .row-container .ghvf-ind')).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.locator(".ghvf-ind")).toHaveCount(8); // exactly one per folder, never a duplicate
});
