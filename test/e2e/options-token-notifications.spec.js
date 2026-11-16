// E2E: the notifications check of Test and the Notifications block of
// Settings → GitHub tokens (#131). api.github.com is mocked: every request is
// recorded and nothing leaves the machine.
import fs from "node:fs";
import { test, expect, seedStorage, backgroundWorker } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, CLASSIC, FINE } from "./support/tokens.js";

const manifest = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const OWNER_TOKEN = "ghp_OWNER9999";
const seed = (extra = {}) => ({
  githubTokens: [
    { id: "d", name: "Personal", owner: "", token: CLASSIC },
    { id: "o", name: "Northwind bot", owner: "northwind", token: OWNER_TOKEN },
  ],
  defaultTokenId: "d",
  ...extra,
});
const PROOF = { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" };
const answers = {
  available: () => ({ headers: { "x-oauth-scopes": "notifications" }, body: [{ id: "1" }] }),
  denied: () => ({ status: 403, headers: PROOF, body: { message: "x" } }),
  ambiguous: () => ({ status: 403, body: { message: "Forbidden" } }),
  rate: () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) }, body: { message: "API rate limit exceeded" } }),
};
const withNotifications = (kind) => (call) => (call.url.includes("/notifications?") ? answers[kind]() : allGood(call));
const block = (page) => page.locator("#tokens-more");
const pill = (page) => block(page).locator("[data-nb-pill]");
const row = (page, i) => page.locator("#token-list .token-item").nth(i);
const testBtn = (page, i) => row(page, i).locator('.token-row [data-act="test"]');
const codes = (over) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "available", ...over });

async function start(context, page, { handler = withNotifications("available"), data = seed(), session, hash = "#tokens-section" } = {}) {
  const calls = await mockApi(context, handler);
  await seedStorage(context, data);
  if (session) await (await backgroundWorker(context)).evaluate((s) => chrome.storage.session.set({ ghrTokenTests: s }), session);
  await openOptions(context, page, hash);
  return calls;
}

test("nothing is requested on load; Test on the default token adds one read of the notifications list (8), an owner token stays at 7", async ({ context, page }) => {
  const calls = await start(context, page);
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(0);
  await expect(pill(page)).toHaveText("Not checked");
  await expect(block(page)).toContainText("Not tested yet. Nothing runs until you press Test.");
  await testBtn(page, 0).click();
  await expect(row(page, 0)).toContainText("6 of 6 OK");
  const defaultCalls = calls.length;
  const notif = calls.filter((c) => c.url.includes("/notifications"));
  expect(notif.map((c) => [c.method, c.url, c.auth])).toEqual([["GET", "https://api.github.com/notifications?per_page=1", `Bearer ${CLASSIC}`]]);
  calls.length = 0;
  await testBtn(page, 1).click();
  await expect(row(page, 1)).toContainText("OK");
  const ownerCalls = calls.length;
  console.log(`MEASURED Test requests: default token ${defaultCalls}, owner token ${ownerCalls}`);
  expect(defaultCalls).toBe(8);
  expect(ownerCalls).toBe(7);
  expect(calls.some((c) => c.url.includes("/notifications"))).toBe(false);
  await expect(pill(page)).toHaveText("Available");
  await expect(block(page)).toContainText("This token can read your full notifications list.");
});

test("fine-grained default with Triage on: Works, Not verified with its text, out of the count, no how-to, no Missing permissions, no request for the list", async ({ context, page }) => {
  const calls = await start(context, page, {
    data: seed({ githubTokens: [{ id: "d", name: "Personal", owner: "", token: FINE }] }),
    handler: (c) => (c.url.endsWith("/user") ? { body: { login: "sam" } } : withNotifications("available")(c)),
  });
  await testBtn(page, 0).click();
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  expect(calls.some((c) => c.url.includes("/notifications"))).toBe(false);
  await expect(pill(page)).toHaveText("Not verified");
  await expect(block(page)).toContainText("Fine-grained tokens can't read this list: that's GitHub's rule. It's optional and you don't have to change anything.");
  await expect(block(page)).toContainText("Only a classic default token can read this list.");
  await expect(block(page).locator('[data-nb="how"]')).toHaveCount(0);
  await expect(page.locator("#token-warning")).toBeHidden();
  await expect(row(page, 0)).not.toContainText("of 6");
  expect(await block(page).innerText()).not.toMatch(/replace your default token|switch to a classic/i);
});

test("proven missing permission with Triage or Tags on: Access denied, Missing permissions, 5 of 6 OK, the warning with the release sentence from the manifest, a how-to that opens", async ({ context, page }) => {
  await start(context, page, { handler: withNotifications("denied") });
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Access denied");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Missing permissions");
  await expect(row(page, 0)).toContainText("5 of 6 OK");
  const warning = page.locator("#token-warning");
  await expect(warning).toBeVisible();
  await expect(page.locator("#warning-title")).toHaveText("Beyond this page needs a permission your token doesn't have");
  await expect(page.locator("#warning-body")).toContainText(`Available from release ${manifest.version}: reading beyond the loaded page requires a classic token with the notifications permission. Everything else keeps working.`);
  await expect(warning.getByRole("button", { name: "How to add it" })).toBeVisible();
  await expect(warning.getByRole("button", { name: "Test again" })).toBeVisible();
  await expect(warning.getByRole("button", { name: "Later" })).toBeVisible();
  const how = block(page).locator('[data-nb="how"]');
  await expect(how).toHaveAttribute("open", "");
  await expect(how.locator("li")).toHaveCount(4);
  await expect(block(page).getByRole("link", { name: /Permissions in the README/ })).toHaveAttribute("href", "https://github.com/cattanisimone/gh-reloaded#optional-the-notifications-permission-classic-token");
  await block(page).locator('[data-nb="how"] > summary').click();
  await expect(how).not.toHaveAttribute("open", "");
  await warning.getByRole("button", { name: "How to add it" }).click();
  await expect(how).toHaveAttribute("open", "");
  await expect(block(page).locator('[data-nb="how"] > summary')).toBeFocused();
});

test("proven missing permission with Triage and Tags both off: Access denied tagged optional, the token stays Works, no warning", async ({ context, page }) => {
  await start(context, page, { handler: withNotifications("denied"), data: seed({ ghntModules: { triage: false, reasonTags: false } }) });
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Access denied");
  await expect(block(page).locator(".nb-name .opt")).toHaveText("optional");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  await expect(page.locator("#token-warning")).toBeHidden();
  await expect(block(page)).toContainText("doesn't make the token Missing permissions");
});

test("ambiguous 403 or an SSO header on a classic token: Not verified, no cause named, out of the count", async ({ context, page }) => {
  await start(context, page, { handler: withNotifications("ambiguous") });
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Not verified");
  await expect(row(page, 0)).toContainText("5 of 5 OK");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  await expect(block(page)).toContainText("didn't say why");
  const why = block(page).locator('[data-nb="why"]');
  await expect(why).not.toHaveAttribute("open", "");
  await why.locator("summary").click();
  await expect(why).toContainText("Some organizations don't allow this, and some tokens can't do it. We can't tell which from here.");
  await expect(page.locator("#token-warning")).toBeHidden();
});

test("the stored outcome shows its age after a reload; after a browser restart the token reads Not tested and the check Not checked", async ({ context, page }) => {
  await start(context, page, { handler: withNotifications("denied") });
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Access denied");
  await page.reload();
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  await expect(pill(page)).toHaveText("Access denied");
  await expect(block(page)).toContainText(/Tested (just now|\d+ minutes? ago)\. GitHub may answer differently now\./);
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Missing permissions");
  await (await backgroundWorker(context)).evaluate(() => chrome.storage.session.remove("ghrTokenTests"));
  await page.reload();
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Not tested");
  await expect(pill(page)).toHaveText("Not checked");
  await expect(block(page)).toContainText("Not tested yet. Nothing runs until you press Test.");
});

test("a rate limit on the notifications read leaves the check Not checked with its text and keeps the previous result", async ({ context, page }) => {
  let kind = "available";
  await start(context, page, { handler: (c) => (c.url.includes("/notifications?") ? answers[kind]() : allGood(c)) });
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Available");
  kind = "rate";
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Not checked");
  await expect(block(page)).toContainText("Not checked: GitHub's rate limit was reached");
  await expect(row(page, 0).locator(".state-pill")).toHaveText("Works");
  await expect(row(page, 0)).toContainText("6 of 6 OK");
});

test("no default token: Not checked with its text and the how-to closed; the needs are readable with no token and no Test", async ({ context, page }) => {
  const calls = await start(context, page, { data: { githubTokens: [], defaultTokenId: "" } });
  await expect(block(page)).toContainText("No default token is set. Only a default token can read this list.");
  await expect(pill(page)).toHaveText("Not checked");
  const needs = block(page).locator('[data-nb="needs"]');
  await needs.locator("summary").click();
  for (const t of ["Triage", "Tags", "“Why is this here?”", "Beyond this page"]) await expect(needs).toContainText(t);
  await expect(needs).toContainText("Optional. Needs a classic default token with the notifications permission. Data: GitHub's notifications list, read with the default token, 50 per page.");
  await expect(block(page).locator('[data-nb="how"]')).not.toHaveAttribute("open", "");
  expect(calls).toHaveLength(0);
});

test("two owners with different access: each by-owner entry is right, adding a token for one leaves the other unchanged", async ({ context, page }) => {
  const session = { d: { at: Date.now(), codes: codes({ notifications: "denied" }) }, o: { at: Date.now(), codes: codes({ pulls: "available", issues: "available" }) } };
  await start(context, page, { session, hash: "#tokens-more" });
  const t = await openAt(context, page, "?owner=acme&state=denied", "#tokens-more", session);
  expect(t).toBeTruthy();
  const owners = block(page).locator(".nb-owner");
  await expect(owners).toHaveCount(2);
  await expect(owners.nth(0)).toContainText("acme — can't be read");
  await expect(owners.nth(0).locator(".diag-pill")).toHaveText("Access denied");
  await expect(owners.nth(1)).toContainText("northwind — Northwind bot (classic): reads its pull requests and issues. Not used for your notifications list");
  await expect(owners.nth(1).locator(".diag-pill")).toHaveText("Available");
  await expect(owners.nth(1).getByRole("button")).toHaveCount(0);
  await owners.nth(0).getByRole("button", { name: "Add token for acme" }).click();
  await expect(page.locator("#token-panel")).toBeVisible();
  await expect(page.locator("#panel-owner")).toHaveValue("acme");
  await expect(page.locator("#panel-name")).toHaveValue("");
  await expect(page.locator("#panel-secret")).toHaveValue("");
  await expect(owners.nth(1)).toContainText("northwind — Northwind bot");
});

async function openAt(context, page, query, hash, session) {
  const worker = await backgroundWorker(context);
  if (session) await worker.evaluate((s) => chrome.storage.session.set({ ghrTokenTests: s }), session);
  const id = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${id}/options/options.html${query}${hash}`);
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  return true;
}

test("no new storage key, and no token value or fragment in the DOM, the URL or storage", async ({ context, page }) => {
  await start(context, page, { handler: withNotifications("denied") });
  const worker = await backgroundWorker(context);
  const keys = async () => worker.evaluate(async () => ({ local: Object.keys(await chrome.storage.local.get(null)).sort(), session: Object.keys(await chrome.storage.session.get(null)).sort() }));
  const before = await keys();
  await testBtn(page, 0).click();
  await expect(pill(page)).toHaveText("Access denied");
  await testBtn(page, 1).click();
  await expect(row(page, 1)).toContainText("OK");
  const after = await keys();
  expect(after.local).toEqual(before.local);
  expect(after.session).toEqual(["ghrTokenTests"]);
  const html = await page.content();
  for (const secret of [CLASSIC, OWNER_TOKEN, CLASSIC.slice(0, 8)]) {
    expect(html).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
  }
  const record = JSON.stringify(await worker.evaluate(() => chrome.storage.session.get("ghrTokenTests")));
  expect(record).not.toMatch(/ghp_|github_pat_/);
});

// ---- landing on the block, keyboard, layout ----

const WIDTHS = [1280, 390, 320];

for (const width of WIDTHS) {
  test(`a link with an owner lands on GitHub tokens with the Notifications block in view at ${width}px (no side panel, nothing prefilled)`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockApi(context, withNotifications("available"));
    await seedStorage(context, seed());
    await openAt(context, page, "?owner=acme&state=denied", "#tokens-more");
    await expect(page.locator("#tokens-section")).toBeVisible();
    for (const other of ["features", "shortcuts-section", "advanced-section"]) await expect(page.locator(`#${other}`)).toBeHidden();
    await expect(page.locator("#tokens-more-title")).toBeFocused();
    const rect = await block(page).evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight }; });
    expect(rect.top, JSON.stringify(rect)).toBeGreaterThanOrEqual(0);
    expect(rect.top, JSON.stringify(rect)).toBeLessThan(rect.vh);
    await expect(page.locator("#token-panel")).toBeHidden();
    await expect(page.locator("#panel-owner")).toHaveValue("");
    await expect(block(page).locator(".nb-owner").first()).toContainText("acme");
  });

  test(`unreachable targets still land on the block at ${width}px: an invalid owner, an unknown state, a delayed storage read`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 700 });
    await mockApi(context, withNotifications("available"));
    await seedStorage(context, seed());
    for (const q of ["?owner=bad%2Fname&state=denied", "?owner=acme&state=weird", "?other=1"]) {
      await openAt(context, page, q, "#tokens-more");
      await expect(page.locator("#tokens-section")).toBeVisible();
      await expect(page.locator("#token-panel")).toBeHidden();
      await expect(page.locator("#panel-owner")).toHaveValue("");
      const top = await block(page).evaluate((e) => e.getBoundingClientRect().top);
      expect(top, q).toBeGreaterThanOrEqual(0);
      expect(top, q).toBeLessThan(700);
      if (q.includes("bad")) expect(await block(page).innerText()).not.toContain("bad");
      if (q.includes("weird")) await expect(block(page).locator(".nb-owner").first()).toContainText("acme");
    }
    // the hash alone, before the token list has rendered (storage answers late)
    const worker = await backgroundWorker(context);
    const id = new URL(worker.url()).host;
    await page.addInitScript(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (...a) => new Promise((r) => setTimeout(() => r(get(...a)), 800));
    });
    await page.goto(`chrome-extension://${id}/options/options.html#tokens-more`);
    await expect(page.locator("#tokens-section")).toBeVisible();
    const early = await block(page).evaluate((e) => e.getBoundingClientRect().top);
    expect(early).toBeGreaterThanOrEqual(0);
    expect(early).toBeLessThan(700);
    await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
    const late = await block(page).evaluate((e) => e.getBoundingClientRect().top);
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThan(700);
  });
}

const rgbOf = (hex) => {
  const n = parseInt(hex.trim().slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

for (const scheme of ["light", "dark"]) {
  for (const width of WIDTHS) {
    test(`keyboard order and focus in the Notifications block, ${scheme}, ${width}px`, async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      const session = { d: { at: Date.now(), codes: codes({ notifications: "denied" }) } };
      await mockApi(context, withNotifications("denied"));
      await seedStorage(context, seed());
      await openAt(context, page, "?owner=acme&state=denied", "#tokens-more", session);
      await page.locator("#add-token").focus();
      const seen = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const a = document.activeElement;
          const s = getComputedStyle(a);
          const r = a.getBoundingClientRect();
          return { text: a.textContent.replace(/\s+/g, " ").trim(), style: s.outlineStyle, w: s.outlineWidth, color: s.outlineColor, focus: getComputedStyle(document.documentElement).getPropertyValue("--focus"), inView: r.left >= 0 && r.right <= innerWidth && r.width > 0, inBlock: !!a.closest("#tokens-more") };
        });
        seen.push(info);
        if (info.text === "Full guide") break;
      }
      const inside = seen.filter((s) => s.inBlock);
      expect(inside.map((s) => s.text), JSON.stringify(seen.map((s) => s.text))).toEqual([
        "Permissions in the README ↗",
        "By owner",
        "Add token for acme",
        "What each notifications feature needs",
        "How to add the notifications permission to your token",
        "Developer settings → Tokens (classic) ↗",
      ]);
      expect(seen.at(-1).text).toBe("Full guide");
      for (const s of inside) {
        expect([s.style, s.w, s.color], s.text).toEqual(["solid", "2px", rgbOf(s.focus)]);
        expect(s.inView, `${s.text} outside the viewport`).toBe(true);
      }
      // a native summary opens with Enter
      const needs = block(page).locator('[data-nb="needs"]');
      await needs.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(needs).toHaveAttribute("open", "");
      // the link hovers with an underline, like the page's other inline links
      await block(page).getByRole("button", { name: "Add token for acme" }).hover();
      expect(await block(page).getByRole("button", { name: "Add token for acme" }).evaluate((b) => getComputedStyle(b).textDecorationLine)).toBe("underline");
    });

    test(`tokens-more layout: edges, heading, stacking and no horizontal scroll, ${scheme}, ${width}px`, async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      const session = { d: { at: Date.now(), codes: codes({ notifications: "denied" }) } };
      await mockApi(context, withNotifications("denied"));
      await seedStorage(context, seed());
      await openAt(context, page, "?owner=acme&state=denied", "#tokens-more", session);
      const m = await page.evaluate(() => {
        const rect = (s) => document.querySelector(s).getBoundingClientRect();
        const textStart = (s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); return r.getBoundingClientRect().left; };
        const card = rect(".nb-card");
        const list = rect("#token-list");
        const pill = rect(".nb-check .diag-pill");
        const main = rect(".nb-main");
        return { cardL: card.left, cardR: card.right, listL: list.left, listR: list.right, headL: textStart("#tokens-more-title"), tokensL: textStart("#tokens .list-head"), pillBelow: pill.top >= main.bottom - 1, pillBeside: pill.left >= main.right - 1, sw: document.documentElement.scrollWidth, iw: innerWidth };
      });
      const msg = JSON.stringify(m);
      expect(Math.abs(m.cardL - m.listL), msg).toBeLessThanOrEqual(1);
      expect(Math.abs(m.cardR - m.listR), msg).toBeLessThanOrEqual(1);
      expect(Math.abs(m.headL - m.tokensL), msg).toBeLessThanOrEqual(1);
      expect(m.sw, msg).toBeLessThanOrEqual(m.iw);
      if (width < 720) expect(m.pillBelow, msg).toBe(true);
      else expect(m.pillBeside, msg).toBe(true);
    });
  }
}
