// E2E: the Quick jump panel's geometry (the native quick search box per header variant), its content by
// width and its native look states. These are fixture tests of the contract's numbers, not the live check.
import { test, expect } from "./support/extension.js";
import { setup, openPanel, panel, input, rows, issue, repoRow } from "./support/quick-jump.js";

const WIDTHS = [1920, 1500, 1100, 1012, 800, 544, 390, 320];
const LONG = "A very long pull request title that keeps going to prove that a title wraps at word boundaries and never pushes the type label out of the row at any width";
const LONG_REPO = "a-very-long-organization-login-of-39-ch/an-equally-long-repository-name-for-the-ellipsis-case";

const rect = (page, sel) => page.locator(sel).first().evaluate((n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, w: r.width, h: r.height }; });
const noHScroll = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, panel: document.querySelector(".ghqj-panel").scrollWidth - document.querySelector(".ghqj-panel").clientWidth, list: document.querySelector(".ghqj-list").scrollWidth - document.querySelector(".ghqj-list").clientWidth }));

for (const variant of ["signed-in", "signed-out"]) {
  test.describe(`geometry, ${variant} header`, () => {
    for (const w of WIDTHS) {
      test(`at ${w}px`, async ({ context, page }) => {
        await page.setViewportSize({ width: w, height: 800 });
        await setup(context, { pages: { "*": { title: "Notifications", nwo: "", variant } } });
        await openPanel(context, page, "https://github.com/notifications");
        await expect(rows(page).first()).toBeVisible();
        const p = await rect(page, ".ghqj-panel");
        const full = w < 1012;
        const exp = full ? { l: 0, r: w } : variant === "signed-in" ? { l: 91, r: w - 340 } : { l: w - 212 - 480, r: w - 212 };
        expect({ w, l: Math.round(p.l), r: Math.round(p.r) }, `viewport ${w}, ${variant}: panel edges`).toEqual({ w, l: exp.l, r: exp.r });
        const radius = await panel(page).evaluate((n) => getComputedStyle(n).borderRadius);
        expect(radius).toBe(full ? "0px 0px 12px 12px" : "12px");
        if (!full) expect(Math.abs(p.t - (variant === "signed-in" ? 3 : 5))).toBeLessThanOrEqual(1);
        else expect(p.t).toBe(0);
        const box = await rect(page, ".ghqj-box");
        expect(Math.round(box.h)).toBe(32);
        expect(Math.round(box.l - p.l), "input box inset").toBe(12);
        const inp = await rect(page, ".ghqj-input");
        expect(Math.abs(inp.l - p.l - 45), "placeholder text start").toBeLessThanOrEqual(2);
        const sc = await noHScroll(page);
        expect(sc, `no horizontal scroll at ${w}`).toEqual({ doc: 0, panel: 0, list: 0 });
      });
    }
  });
}

test.describe("content by width", () => {
  const data = {
    assigned: [issue(1, LONG_REPO, 30, LONG), issue(2, "acme/web", 40, "Short title")],
    review: { total_count: 1, items: [issue(61, "acme/web", 10, "Retry the upload")] },
    repos: [repoRow("acme/web", 10)],
  };
  for (const w of [1500, 1100, 800, 544, 390, 320]) {
    test(`at ${w}px`, async ({ context, page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await setup(context, { pages: { "*": { title: "acme/web", repoHeader: true } }, data });
      await openPanel(context, page, "https://github.com/acme/web");
      await expect(rows(page).first()).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.locator(".ghqj-seg-btn.ghqj-on")).toHaveText("Everywhere", { useInnerText: true });
      const narrow = (await rect(page, ".ghqj-panel")).w < 544;
      // scope control: label stays, never shrinks or wraps, "This repo" below 544
      const seg = await rect(page, ".ghqj-seg");
      expect(Math.round(seg.h)).toBe(28);
      await expect(page.locator(".ghqj-scope-label")).toBeVisible();
      const first = page.locator(".ghqj-seg-btn").first();
      await expect(first).toHaveText(narrow ? "This repo" : "This repository", { useInnerText: true });
      const lines = await first.evaluate((n) => { const r = document.createRange(); r.selectNodeContents(n.querySelector("span:not([style*='none'])")); return r.getClientRects().length; });
      expect(lines).toBeLessThanOrEqual(1);
      await expect(page.locator(".ghqj-tabhint")).toBeVisible({ visible: !narrow });
      // type label and enter hint
      const type = page.locator(".ghqj-row .ghqj-type").first();
      if (narrow) await expect(type).toBeHidden();
      else await expect(type).toBeVisible();
      // long title: at most 2 lines, owner/repo ellipsis keeps #n
      const longRow = rows(page).filter({ hasText: "A very long pull request title" }).first();
      const lh = await longRow.locator(".ghqj-title").evaluate((n) => n.getBoundingClientRect().height);
      expect(lh).toBeLessThanOrEqual(42.5);
      const ctx = await longRow.locator(".ghqj-first").evaluate((n) => ({ num: n.querySelector(".ghqj-num").getBoundingClientRect().right <= n.getBoundingClientRect().right + 0.5, vis: n.querySelector(".ghqj-num").getBoundingClientRect().width > 0 }));
      expect(ctx).toEqual({ num: true, vis: true });
      const noWrapBreak = await longRow.locator(".ghqj-repo").evaluate((n) => getComputedStyle(n).textOverflow === "ellipsis" && getComputedStyle(n).whiteSpace === "nowrap");
      expect(noWrapBreak).toBe(true);
      // footer: keys always there; labels dropped when narrow
      await expect(page.locator(".ghqj-key").first().locator(".ghqj-kbd")).toBeVisible();
      if (narrow) await expect(page.locator(".ghqj-keylabel").first()).toBeHidden();
      else await expect(page.locator(".ghqj-keylabel").first()).toBeVisible();
      await expect(page.locator(".ghqj-change")).toBeVisible();
      expect(await noHScroll(page)).toEqual({ doc: 0, panel: 0, list: 0 });
    });
  }

  test("the signed-out panel (480px) uses the narrow rules too", async ({ context, page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setup(context, { pages: { "*": { title: "acme/web", repoHeader: true, variant: "signed-out" } }, data });
    await openPanel(context, page, "https://github.com/acme/web");
    await expect(rows(page).first()).toBeVisible();
    expect(Math.round((await rect(page, ".ghqj-panel")).w)).toBe(480);
    await expect(page.locator(".ghqj-seg-btn").first()).toHaveText("This repo", { useInnerText: true });
    await expect(page.locator(".ghqj-row .ghqj-type").first()).toBeHidden();
  });

  test("the context line wraps at its separators; no segment is cut mid-word", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await setup(context, { pages: { "*": { title: "acme/web", repoHeader: true } }, data });
    await openPanel(context, page, "https://github.com/acme/web");
    await expect(rows(page).first()).toBeVisible();
    const row = rows(page).filter({ hasText: "Retry the upload" }).first();
    await expect(row).toBeVisible();
    const segs = await row.locator(".ghqj-seg-text").evaluateAll((els) => els.map((e) => ({ h: e.getBoundingClientRect().height, text: e.textContent })));
    for (const s of segs) expect(s.h, `${s.text} stays on one line`).toBeLessThanOrEqual(19);
  });
});

test.describe("long text in lines", () => {
  const NAME_SPACES = "Personal work laptop token for acme and octo-fixture projects";
  const NAME_WORD = "acme-ci-readonly-token-for-quick-jump-tests-2026";
  for (const [label, name] of [["with spaces", NAME_SPACES], ["one 47-character word", NAME_WORD]]) {
    for (const w of [1100, 390, 320]) {
      test(`the token name ${label} in the can't-read line at ${w}px wraps at word boundaries`, async ({ context, page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        await setup(context, { storage: { githubTokens: [{ id: "d", name, token: "ghp_x", owner: "" }], defaultTokenId: "d" }, pages: { "*": { title: "Notifications", nwo: "" } }, data: { assigned: { status: 404 } } });
        await openPanel(context, page, "https://github.com/notifications");
        const line = page.locator('[data-line="cannot-assigned"]');
        await expect(line).toBeVisible();
        const info = await line.evaluate((n) => {
          const st = getComputedStyle(n);
          const text = n.textContent;
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          const broken = [];
          let t;
          while ((t = tw.nextNode())) {
            for (const m of t.textContent.matchAll(/\S+/g)) {
              const r = document.createRange();
              r.setStart(t, m.index);
              r.setEnd(t, m.index + m[0].length);
              if (r.getClientRects().length > 1) broken.push(m[0]);
            }
          }
          return { overflow: n.scrollWidth - n.clientWidth, ellipsis: st.textOverflow, broken, text };
        });
        expect(info.overflow).toBeLessThanOrEqual(0);
        expect(info.ellipsis).not.toBe("ellipsis");
        const mayBreak = (word) => word.length > 40 && word.includes(name);
        expect(info.broken.filter((b) => !mayBreak(b)), "a word that fits one line is never cut").toEqual([]);
        expect(info.text).toContain(`“${name}”`);
        expect(await noHScroll(page)).toEqual({ doc: 0, panel: 0, list: 0 });
      });
    }
  }

  test("the owner line keeps at most three logins and 'and 2 more' together", async ({ context, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const owners = ["acme-labs", "octo-fixture-industries", "a-very-long-organization-login-of-39-ch", "fourth-org", "fifth-org"];
    await setup(context, { storage: { githubTokens: [{ id: "d", name: "Main", token: "x", owner: "" }, ...owners.map((o, i) => ({ id: `o${i}`, name: o, token: "y", owner: o }))], defaultTokenId: "d" }, pages: { "*": { title: "Notifications", nwo: "" } } });
    await openPanel(context, page, "https://github.com/notifications");
    const line = page.locator('[data-line="owner-line"]');
    await expect(line).toContainText("and 2 more");
    const t = await line.textContent();
    expect(t).not.toContain("fourth-org");
    const rects = await line.evaluate((n) => { const tw = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); const t = tw.nextNode(); const i = t.textContent.indexOf("and 2 more"); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + "and 2 more".length); return r.getClientRects().length; });
    expect(rects).toBe(1);
    expect(await noHScroll(page)).toEqual({ doc: 0, panel: 0, list: 0 });
  });
});

for (const dark of [false, true]) {
  test.describe(`native states, ${dark ? "dark" : "light"}`, () => {
    const C = dark
      ? { bg: "rgb(1, 4, 9)", hover: "rgba(101, 108, 118, 0.2)", press: "rgba(101, 108, 118, 0.25)", sel: "rgba(101, 108, 118, 0.2)", bar: "rgb(31, 111, 235)", link: "rgb(68, 147, 248)", track: "rgb(1, 4, 9)", thumb: "rgb(38, 44, 54)", line: "rgb(61, 68, 77)", shadow: "rgb(61, 68, 77) 0px 0px 0px 1px, rgba(1, 4, 9, 0.4) 0px 6px 12px -3px, rgba(1, 4, 9, 0.4) 0px 6px 18px 0px" }
      : { bg: "rgb(255, 255, 255)", hover: "rgba(129, 139, 152, 0.1)", press: "rgba(129, 139, 152, 0.15)", sel: "rgba(129, 139, 152, 0.15)", bar: "rgb(9, 105, 218)", link: "rgb(9, 105, 218)", track: "rgb(230, 234, 239)", thumb: "rgb(255, 255, 255)", line: "rgb(209, 217, 224)", shadow: "rgba(209, 217, 224, 0.25) 0px 0px 0px 1px, rgba(37, 41, 46, 0.04) 0px 6px 12px -3px, rgba(37, 41, 46, 0.12) 0px 6px 18px 0px" };

    async function open(context, page) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
      await setup(context, { pages: { "*": { title: "acme/web", repoHeader: true, dark } } });
      await openPanel(context, page, "https://github.com/acme/web");
      await expect(rows(page).first()).toContainText("Retry the upload");
    }
    const css = (loc, props) => loc.evaluate((n, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(n)[p]])), props);

    test("panel and rows: rest, hover, pressed and the selected row's bar", async ({ context, page }) => {
      await open(context, page);
      expect(await css(panel(page), ["backgroundColor", "borderRadius", "boxShadow"])).toEqual({ backgroundColor: C.bg, borderRadius: "12px", boxShadow: C.shadow });
      const row = rows(page).nth(1);
      expect(await css(row, ["borderRadius", "backgroundColor", "fontSize", "fontWeight"])).toMatchObject({ borderRadius: "6px", backgroundColor: "rgba(0, 0, 0, 0)", fontSize: "14px", fontWeight: "400" });
      await row.hover();
      await expect(row).toHaveCSS("background-color", C.hover);
      await page.mouse.down();
      await expect(row).toHaveCSS("background-color", C.press);
      await page.mouse.move(600, 880); // released away from the row, so the press is not a click
      await page.mouse.up();
      const selRow = rows(page).first();
      await expect(selRow).toHaveClass(/ghqj-sel/);
      await page.mouse.move(600, 880);
      await expect(selRow).toHaveCSS("background-color", C.sel);
      const bar = await selRow.evaluate((n) => { const s = getComputedStyle(n, "::before"); return { w: s.width, left: s.left, bg: s.backgroundColor, r: s.borderRadius }; });
      expect(bar).toEqual({ w: "4px", left: "-8px", bg: C.bar, r: "6px" });
      // a one-line row is 33px high like the native option
      const oneLine = await rows(page).filter({ hasText: "All assigned issues on GitHub" }).evaluate((n) => n.getBoundingClientRect().height);
      expect(oneLine).toBe(33);
    });

    test("scope control: track, selected thumb, hover, pressed and the focus ring", async ({ context, page }) => {
      await open(context, page);
      const seg = page.locator(".ghqj-seg");
      expect(await css(seg, ["height", "borderRadius", "borderTopColor", "backgroundColor"])).toEqual({ height: "28px", borderRadius: "6px", borderTopColor: C.line, backgroundColor: C.track });
      const on = page.locator(".ghqj-seg-btn.ghqj-on");
      expect(await css(on, ["backgroundColor", "fontWeight"])).toEqual({ backgroundColor: C.thumb, fontWeight: "600" });
      const off = page.locator(".ghqj-seg-btn:not(.ghqj-on)");
      expect(await off.evaluate((n) => getComputedStyle(n).fontWeight)).toBe("400");
      await off.hover();
      await expect(off.locator("span").first()).toHaveCSS("background-color", dark ? "rgb(42, 49, 60)" : "rgb(224, 230, 235)");
      await page.mouse.down();
      await expect(off.locator("span").first()).toHaveCSS("background-color", dark ? "rgb(47, 55, 66)" : "rgb(218, 224, 231)");
      await page.mouse.move(600, 880);
      await page.mouse.up();
      await page.keyboard.press("Shift");
      await page.locator(".ghqj-seg-btn").first().focus();
      expect(await css(page.locator(".ghqj-seg-btn").first(), ["outlineStyle", "outlineWidth", "outlineColor"])).toEqual({ outlineStyle: "solid", outlineWidth: "2px", outlineColor: dark ? "rgb(68, 147, 248)" : "rgb(9, 105, 218)" });
    });

    test("footer Change link: rest, hover underline and the focus ring", async ({ context, page }) => {
      await open(context, page);
      const link = page.locator(".ghqj-change");
      expect(await css(link, ["color", "fontSize", "fontWeight", "textDecorationLine"])).toMatchObject({ color: C.link, fontSize: "12px", fontWeight: "400", textDecorationLine: "none" });
      await link.hover();
      expect(await link.evaluate((n) => getComputedStyle(n).textDecorationLine)).toBe("underline");
      await page.mouse.move(600, 880);
      await page.keyboard.press("Shift");
      await link.focus();
      expect(await css(link, ["outlineStyle", "outlineWidth", "outlineOffset"])).toEqual({ outlineStyle: "solid", outlineWidth: "2px", outlineOffset: "-2px" });
    });
  });
}

test("the panel takes GitHub's own Primer variables when the page defines them", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await setup(context, { pages: { "*": { title: "acme/web", repoHeader: true, primer: true, head: "<style>html{--bgColor-default:#fafbfc}</style>" } } });
  await openPanel(context, page, "https://github.com/acme/web");
  await expect(panel(page)).toHaveCSS("background-color", "rgb(250, 251, 252)");
  void input;
});
