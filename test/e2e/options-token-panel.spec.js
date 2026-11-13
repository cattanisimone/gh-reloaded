// E2E: the token side panel: space reserved beside the list, the sheet below
// 1024px, the draft model, validation, and a saved token that is never shown.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, storageOf } from "./support/tokens.js";

const DEF = "ghp_defaultAAAA";
const OWN = "ghp_ownerBBBB";
const three = {
  githubTokens: [
    { id: "d", name: "Personal", owner: "", token: DEF },
    { id: "o", name: "Work – acme-demo with a rather long name to wrap", owner: "acme-demo", token: OWN },
    { id: "t", name: "Team projects", owner: "rossi-lab", token: "ghp_teamCCCC" },
  ],
  defaultTokenId: "d",
};
const rowEdit = (page, i) => page.locator('#token-list [data-act="edit"]').nth(i);

async function open(context, page, size = { width: 1500, height: 900 }, seed = three) {
  await page.setViewportSize(size);
  await seedStorage(context, seed);
  await openOptions(context, page, "#tokens-section");
}

for (const width of [1500, 1100, 1024]) {
  test(`panel open at ${width}: list reflows beside the 420px panel, nothing covered`, async ({ context, page }) => {
    await open(context, page, { width, height: 900 });
    await rowEdit(page, 1).click();
    // The layout viewport excludes the classic scrollbar, like the panel's right edge.
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    const panelBox = await page.locator("#token-panel").boundingBox();
    expect(Math.abs(panelBox.width - 420)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.x - (vw - 420))).toBeLessThanOrEqual(1);
    const rights = await page.locator("#token-list .token-item .token-row").evaluateAll((rows) =>
      rows.flatMap((row) => [".tr-name", ".state-pill", '[data-act="test"]', '[data-act="edit"]'].map((s) => ({ s, right: row.querySelector(s).getBoundingClientRect().right }))));
    const limit = vw - 420 + 1;
    const worst = rights.filter((r) => r.right > limit);
    expect(worst, `viewport ${width} (layout ${vw}), panel left ${vw - 420}`).toEqual([]);
    const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll[0]).toBeLessThanOrEqual(scroll[1]);
    await expect(page.locator("#token-list .token-item").nth(1)).toHaveClass(/is-editing/);
  });
}

for (const width of [720, 500]) {
  test(`at ${width} the panel is a full-width sheet`, async ({ context, page }) => {
    await open(context, page, { width, height: 800 });
    await rowEdit(page, 0).click();
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    const box = await page.locator("#token-panel").boundingBox();
    expect(Math.abs(box.width - vw), `viewport ${width}, layout ${vw}`).toBeLessThanOrEqual(1);
    expect(box.x).toBeLessThanOrEqual(1);
    const pad = await page.locator(".shell").evaluate((el) => getComputedStyle(el).paddingRight);
    expect(pad).toBe("0px");
  });
}

test("open highlights the row, Esc and close return focus to Edit", async ({ context, page }) => {
  await open(context, page);
  await rowEdit(page, 1).click();
  await expect(page.locator("#token-panel")).toBeVisible();
  await expect(page.locator("#panel-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#token-panel")).toBeHidden();
  await expect(rowEdit(page, 1)).toBeFocused();
  await rowEdit(page, 2).click();
  await page.locator("#panel-close").click();
  await expect(rowEdit(page, 2)).toBeFocused();
  await page.locator("#add-token").click();
  await page.locator("#panel-discard").click();
  await expect(page.locator("#add-token")).toBeFocused();
});

test("owner is required, the error sits next to the field and the draft is kept", async ({ context, page }) => {
  await open(context, page, undefined, { githubTokens: [], defaultTokenId: null });
  await page.locator("#add-token").click();
  await page.locator("#panel-name").fill("Work");
  await page.locator("#panel-secret").fill(OWN);
  await page.locator("#panel-save").click();
  await expect(page.locator("#panel-owner-error")).toBeVisible();
  await expect(page.locator("#panel-owner")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#panel-owner")).toBeFocused();
  await expect(page.locator("#panel-name")).toHaveValue("Work");
  expect((await storageOf(page, "local", "githubTokens")).githubTokens ?? []).toEqual([]);
});

test("a duplicate owner is refused; a storage error keeps the draft and says so", async ({ context, page }) => {
  await open(context, page);
  await page.locator("#add-token").click();
  await page.locator("#panel-owner").fill("ACME-demo");
  await page.locator("#panel-secret").fill("ghp_newDDDD");
  await page.locator("#panel-save").click();
  await expect(page.locator("#panel-owner-error")).toContainText("already has a token");
  await page.locator("#panel-owner").fill("fresh-org");
  await page.evaluate(() => { chrome.storage.local.set = () => Promise.reject(new Error("QUOTA_BYTES exceeded")); });
  await page.locator("#panel-save").click();
  await expect(page.locator("#panel-status")).toContainText("Couldn't save the token: QUOTA_BYTES exceeded");
  await expect(page.locator("#panel-owner")).toHaveValue("fresh-org");
  await expect(page.locator("#token-panel")).toBeVisible();
});

test("a saved token is never shown again: Saved and Replace token", async ({ context, page }) => {
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await open(context, page);
  await rowEdit(page, 1).click();
  await expect(page.locator("#panel-saved")).toBeVisible();
  await expect(page.locator("#panel-saved")).toContainText("Saved");
  await expect(page.locator("#panel-secret")).toBeHidden();
  const html = await page.content();
  for (const s of [DEF, OWN, "BBBB"]) expect(html).not.toContain(s);
  const values = await page.locator("input").evaluateAll((els) => els.map((e) => e.value));
  expect(values.join("|")).not.toMatch(/ghp_|BBBB/);
  expect(logs.join("\n")).not.toMatch(/ghp_/);
  await page.locator("#panel-replace").click();
  await expect(page.locator("#panel-secret")).toBeVisible();
  await expect(page.locator("#panel-secret")).toBeFocused();
});

test("draft model: unsaved tag, Discard, Remove then Discard, Remove then Save, nothing written before Save", async ({ context, page }) => {
  await open(context, page);
  const snapshot = () => storageOf(page, "local", ["githubTokens", "defaultTokenId"]);
  const before = await snapshot();
  await rowEdit(page, 1).click();
  await expect(page.locator("#panel-changes")).toBeHidden();
  await page.locator("#panel-name").fill("Renamed");
  await expect(page.locator("#panel-changes")).toHaveText("1 unsaved change: Name");
  await page.locator("#panel-owner").fill("other-org");
  await expect(page.locator("#panel-changes")).toHaveText("2 unsaved changes: Name, GitHub owner");
  expect(await snapshot()).toEqual(before);
  await page.locator("#panel-discard").click();
  expect(await snapshot()).toEqual(before);
  await expect(page.locator("#token-list .token-item").nth(1)).toContainText("Work – acme-demo");

  await rowEdit(page, 1).click();
  await page.locator("#panel-remove").click();
  await expect(page.locator("#panel-changes")).toContainText("removed");
  await page.locator("#panel-discard").click();
  await expect(page.locator("#token-list .token-item")).toHaveCount(3);
  expect(await snapshot()).toEqual(before);

  await rowEdit(page, 1).click();
  await page.locator("#panel-remove").click();
  await page.locator("#panel-save").click();
  await expect(page.locator("#token-list .token-item")).toHaveCount(2);
  const after = await snapshot();
  expect(after.githubTokens.map((t) => t.id)).toEqual(["d", "t"]);
});

test("replace token on the default keeps its name and use and goes back to Not tested", async ({ context, page }) => {
  await mockApi(context, allGood);
  await open(context, page);
  await page.locator('#token-list [data-act="test"]').first().click();
  await expect(page.locator("#token-list .token-item").first()).toContainText(/\d of \d OK/);
  await rowEdit(page, 0).click();
  await page.locator("#panel-replace").click();
  await page.locator("#panel-secret").fill("ghp_replacedEEEE");
  await page.locator("#panel-save").click();
  const row = page.locator("#token-list .token-item").first();
  await expect(row).toContainText("Personal");
  await expect(row).toContainText("Used for: all repositories");
  await expect(row).toContainText("Not tested");
  const stored = (await storageOf(page, "local", "githubTokens")).githubTokens;
  expect(stored[0]).toMatchObject({ id: "d", name: "Personal", token: "ghp_replacedEEEE" });
  const session = await storageOf(page, "session", "ghrTokenTests");
  expect(session.ghrTokenTests?.d).toBeUndefined();
});

test("layout metrics: aligned to the column, buttons keep Primer size, no horizontal scroll", async ({ context, page }) => {
  await open(context, page);
  const m = await page.evaluate(() => {
    const left = (s) => document.querySelector(s).getBoundingClientRect().left;
    const btn = getComputedStyle(document.querySelector('#token-list [data-act="edit"]'));
    const list = document.querySelector("#token-list").getBoundingClientRect();
    const content = document.querySelector("#tokens-section").getBoundingClientRect();
    const inner = parseFloat(getComputedStyle(document.querySelector(".content")).paddingLeft);
    return { listLeft: list.left, sectionLeft: content.left, h1: left("#tokens-title"), guide: left("#token-guide"), share: list.width / content.width, btn: [btn.height, btn.borderTopLeftRadius, btn.borderTopWidth], scroll: [document.documentElement.scrollWidth, innerWidth], inner };
  });
  expect(Math.abs(m.listLeft - m.h1)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.guide - m.h1)).toBeLessThanOrEqual(1);
  expect(m.share).toBeGreaterThanOrEqual(0.98);
  expect(m.btn).toEqual(["32px", "6px", "1px"]);
  expect(m.scroll[0]).toBeLessThanOrEqual(m.scroll[1]);
});

for (const [w, h] of [[390, 800], [320, 700]]) {
  test(`at ${w}px: no horizontal scroll with the list and the sheet open`, async ({ context, page }) => {
    await open(context, page, { width: w, height: h });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await rowEdit(page, 1).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    const box = await page.locator("#token-panel").boundingBox();
    expect(Math.abs(box.width - vw)).toBeLessThanOrEqual(1);
  });
}

test("dark mode: surfaces and keyboard", async ({ context, page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(context, page);
  await rowEdit(page, 0).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#panel-name")).toBeFocused();
  const bg = await page.locator("#token-panel").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(21, 27, 35)");
  await page.keyboard.press("Escape");
});

// --- Test inside the panel: a draft is tested in memory and writes nothing ---

const spyStorage = (page) => page.evaluate(() => {
  window.__writes = [];
  for (const area of ["local", "session"]) {
    const orig = chrome.storage[area].set.bind(chrome.storage[area]);
    chrome.storage[area].set = (...a) => { window.__writes.push(area); return orig(...a); };
  }
});
const writes = (page) => page.evaluate(() => window.__writes);

test("panel Test: a new token, a replaced token and a changed owner test the draft values and write nothing", async ({ context, page }) => {
  const calls = await mockApi(context, allGood);
  await open(context, page);
  await spyStorage(page);
  const rowBefore = await page.locator("#token-list .token-item").nth(1).innerText();

  // new token
  await page.locator("#add-token").click();
  await expect(page.locator("#panel-test")).toBeDisabled();
  await expect(page.locator("#panel-test-hint")).toHaveText("Enter a token to test it");
  await page.locator("#panel-secret").fill("ghp_draftNEW1");
  await expect(page.locator("#panel-test-hint")).toHaveText("Enter the GitHub owner to test it");
  await page.locator("#panel-owner").fill("new-org");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("Result for the changes in this panel (not saved)");
  await expect(page.locator("#panel-result")).toContainText("5 of 5 OK");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.auth === "Bearer ghp_draftNEW1")).toBe(true);
  expect(calls.some((c) => c.url.includes("/orgs/new-org/repos"))).toBe(true);
  await page.locator("#panel-discard").click();

  // replaced token on a saved row
  calls.length = 0;
  await rowEdit(page, 1).click();
  await page.locator("#panel-replace").click();
  await page.locator("#panel-secret").fill("ghp_draftREP2");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("not saved");
  expect(calls.every((c) => c.auth === "Bearer ghp_draftREP2")).toBe(true);
  expect(calls.some((c) => c.url.includes("/orgs/acme-demo/repos"))).toBe(true);
  await page.locator("#panel-discard").click();

  // changed owner, saved token
  calls.length = 0;
  await rowEdit(page, 1).click();
  await page.locator("#panel-owner").fill("moved-org");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("not saved");
  expect(calls.every((c) => c.auth === `Bearer ${OWN}`)).toBe(true);
  expect(calls.some((c) => c.url.includes("/orgs/moved-org/repos"))).toBe(true);
  await page.locator("#panel-discard").click();

  expect(await writes(page)).toEqual([]);
  expect((await storageOf(page, "session", "ghrTokenTests")).ghrTokenTests).toBeUndefined();
  expect(await page.locator("#token-list .token-item").nth(1).innerText()).toBe(rowBefore);
});

test("panel Test on an unchanged saved token is the row's own test", async ({ context, page }) => {
  await mockApi(context, allGood);
  await open(context, page);
  await rowEdit(page, 1).click();
  await page.locator("#panel-name").fill("Only the name changed");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("Test result");
  await expect(page.locator("#panel-result")).not.toContainText("not saved");
  await expect(page.locator("#token-list .token-item").nth(1)).toContainText("5 of 5 OK");
  expect((await storageOf(page, "session", "ghrTokenTests")).ghrTokenTests.o.codes.issues).toBe("available");
});

test("editing the token or the owner while a panel Test runs aborts it: Not checked", async ({ context, page }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await mockApi(context, async (c) => { if (c.url.endsWith("/user")) await gate; return allGood(c); });
  await open(context, page);
  await spyStorage(page);
  await rowEdit(page, 1).click();
  await page.locator("#panel-owner").fill("moved-org");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-test")).toHaveText("Testing…");
  await page.locator("#panel-owner").fill("moved-again");
  await expect(page.locator("#panel-result")).toContainText("Not checked");
  await expect(page.locator("#panel-result")).toContainText("The token or owner changed while testing. Test again.");
  await expect(page.locator("#panel-test")).toBeEnabled();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator("#panel-result")).toContainText("Not checked");
  expect(await writes(page)).toEqual([]);
});

test("Save adopts a draft result taken with exactly the saved token and owner; otherwise Not tested", async ({ context, page }) => {
  await mockApi(context, allGood);
  await open(context, page);
  await rowEdit(page, 1).click();
  await page.locator("#panel-replace").click();
  await page.locator("#panel-secret").fill("ghp_adoptFFFF");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("5 of 5 OK");
  await page.locator("#panel-save").click();
  await expect(page.locator("#token-list .token-item").nth(1)).toContainText("5 of 5 OK");
  expect((await storageOf(page, "session", "ghrTokenTests")).ghrTokenTests.o).toBeTruthy();

  // tested, then the owner changed: the result is for other values and is dropped
  await rowEdit(page, 1).click();
  await page.locator("#panel-owner").fill("elsewhere");
  await page.locator("#panel-test").click();
  await expect(page.locator("#panel-result")).toContainText("not saved");
  await page.locator("#panel-owner").fill("elsewhere-2");
  await page.locator("#panel-save").click();
  const r = page.locator("#token-list .token-item").nth(1);
  await expect(r).toContainText("Not tested");
  expect((await storageOf(page, "session", "ghrTokenTests")).ghrTokenTests?.o).toBeUndefined();
});

test("Esc on another section does not discard the hidden token draft", async ({ context, page }) => {
  await open(context, page);
  await rowEdit(page, 1).click();
  await page.locator("#panel-name").fill("Kept draft");
  await page.locator('.nav a[href="#features"]').click();
  await expect(page.locator("#tokens-section")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.locator('.nav a[href="#tokens-section"]').click();
  await expect(page.locator("#token-panel")).toBeVisible();
  await expect(page.locator("#panel-name")).toHaveValue("Kept draft");
});

test("re-rendering the list keeps an open repository check and its focus", async ({ context, page }) => {
  await mockApi(context, allGood);
  await open(context, page);
  await page.locator('#token-list .token-item').nth(1).locator('.token-row [data-act="test"]').click();
  const item = page.locator("#token-list .token-item").nth(1);
  await item.getByRole("button", { name: "Check a specific repository" }).click();
  await item.locator(".diag-repo").fill("acme-demo/ap");
  await page.locator('#token-list .token-item').first().locator('.token-row [data-act="test"]').click();
  await expect(page.locator("#token-list .token-item").first()).toContainText("Works");
  await expect(item.locator(".diag-repo")).toHaveValue("acme-demo/ap");
});
