// E2E: Split diff, one column — the visual contract: the control's size, radius, border and gap
// next to the native button, the header unchanged (before = after), the table filling what is
// not line numbers, dark theme from GitHub's own variables, and hover / pressed / focus states.
// The fixtures mirror the header layout measured live on 2026-11-24 (see support/split.js).
import { test, expect } from "./support/extension.js";
import { setup, sampleFiles, URLS } from "./support/split.js";

const KINDS = ["hashed", "unhashed", "classic"];
const WIDTHS = [1500, 1100, 800, 390];
const PAGE = { hashed: "Files changed", unhashed: "commit", classic: "compare" };

// Everything measured for file 0 (additions-only) in one evaluate.
function probe(page) {
  return page.evaluate(() => {
    const t = document.querySelectorAll("table")[0];
    const c = t.closest("[role=region],[data-tagsearch-path]");
    const hdr = c.firstElementChild;
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right }; };
    const ctrl = c.querySelector("[data-ghsoc-control]");
    const buttons = [...hdr.querySelectorAll("button, details, summary")].filter((b) => b !== ctrl && !ctrl?.contains(b)).map((b) => Math.round(r(b).w * 10) / 10);
    const row = ctrl ? ctrl.parentElement : null;
    const line = [...t.querySelectorAll("tbody > tr")].find((tr) => tr.children.length === 4 && getComputedStyle(tr.children[2]).display !== "none" || (tr.children.length === 4 && getComputedStyle(tr.children[0]).display !== "none" && !tr.querySelector("[data-diff-cell=hunk]")));
    const vis = line ? [...line.children].filter((td) => getComputedStyle(td).display !== "none").map((td) => r(td).w) : [];
    const cs = ctrl ? getComputedStyle(ctrl) : null;
    return {
      vw: innerWidth,
      table: r(t).w,
      hdrH: r(hdr).h,
      ctrl: ctrl ? r(ctrl) : null,
      next: ctrl ? r(ctrl.nextElementSibling) : null,
      prev: ctrl && ctrl.previousElementSibling ? r(ctrl.previousElementSibling) : null,
      buttons,
      rowOverflow: row ? row.scrollWidth - row.clientWidth : null,
      vis,
      label: ctrl ? getComputedStyle(ctrl.querySelector(".ghsoc-lbl")).display : null,
      style: cs && { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, h: cs.height },
    };
  });
}

for (const kind of KINDS) {
  test.describe(PAGE[kind], () => {
    for (const w of WIDTHS) {
      test(`header at ${w}px: control 28px, 6px radius, 1px border, 8px gap, header and native buttons unchanged`, async ({ context, page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        const { url } = await setup(context, kind, sampleFiles(), { storage: { ghsocEnabled: false } });
        await page.goto(url);
        await page.waitForTimeout(300);
        const before = await probe(page);
        expect(before.ctrl).toBeNull();
        await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ ghsocEnabled: true }));
        await expect(page.locator("[data-ghsoc-control]").first()).toBeVisible();
        const after = await probe(page);
        const msg = JSON.stringify({ before, after });
        expect(after.ctrl.h, msg).toBeGreaterThanOrEqual(27);
        expect(after.ctrl.h, msg).toBeLessThanOrEqual(29);
        expect(after.style.radius).toBe("6px");
        expect(after.style.border).toBe("1px");
        // classic: the … menu is a 32px box with its own 8px padding, so the visible gap is inside it
        if (kind !== "classic") expect(Math.abs(after.next.x - after.ctrl.right - 8), msg).toBeLessThanOrEqual(1);
        // 8px to the previous sibling too (the view toggle), also where the parent has no gap (classic)
        if (after.prev) expect(Math.abs(after.ctrl.x - after.prev.right - 8), msg).toBeLessThanOrEqual(1);
        // same top as the native neighbour in its row
        expect(Math.abs(after.ctrl.y + after.ctrl.h / 2 - (after.next.y + after.next.h / 2)), msg).toBeLessThanOrEqual(1);
        expect(Math.abs(after.hdrH - before.hdrH), msg).toBeLessThanOrEqual(1);
        expect(after.buttons.length, msg).toBe(before.buttons.length);
        after.buttons.forEach((bw, i) => expect(Math.abs(bw - before.buttons[i]), `button ${i} ${msg}`).toBeLessThanOrEqual(1));
        expect(after.rowOverflow, msg).toBeLessThanOrEqual(0);
        // GitHub's own breakpoint for the Viewed label: label at >= 768px, icon only below
        if (w >= 768) expect(after.label).not.toBe("none");
        else {
          expect(after.label).toBe("none");
          expect(after.ctrl.w, msg).toBeGreaterThanOrEqual(28);
          await expect(page.locator("[data-ghsoc-control]").first()).toHaveAccessibleName("Side by side");
        }
      });

      test(`table at ${w}px: width unchanged, the text column fills everything that is not line numbers`, async ({ context, page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        const { url } = await setup(context, kind, sampleFiles(), { storage: { ghsocEnabled: false } });
        await page.goto(url);
        await page.waitForTimeout(300);
        const before = await probe(page);
        await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ ghsocEnabled: true }));
        await expect(page.locator("[data-ghsoc-control]").first()).toBeVisible();
        const after = await probe(page);
        const msg = JSON.stringify({ before: before.vis, after: after.vis, table: after.table });
        expect(Math.abs(after.table - before.table), msg).toBeLessThanOrEqual(1);
        expect(after.vis.length, msg).toBe(3);
        const [n1, n2, text] = after.vis;
        expect(Math.abs(n1 - 40), msg).toBeLessThanOrEqual(1.5);
        expect(Math.abs(n2 - 40), msg).toBeLessThanOrEqual(1.5);
        const share = text / (after.table - n1 - n2);
        expect(share, msg).toBeGreaterThanOrEqual(0.99);
        expect(Math.abs(n1 + n2 + text - after.table), msg).toBeLessThanOrEqual(1);
      });
    }

    test("deletions-only: old numbers only, the text column fills the rest, no horizontal scroll", async ({ context, page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect(page.locator("table").nth(1)).toHaveAttribute("data-ghsoc", "deletions");
      const m = await page.evaluate(() => {
        const t = document.querySelectorAll("table")[1];
        const tr = [...t.querySelectorAll("tbody > tr")].find((x) => x.children.length === 4);
        const vis = [...tr.children].filter((td) => getComputedStyle(td).display !== "none").map((td) => td.getBoundingClientRect().width);
        return { vis, table: t.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth - innerWidth };
      });
      expect(m.vis.length).toBe(2);
      expect(m.vis[1] / (m.table - m.vis[0]), JSON.stringify(m)).toBeGreaterThanOrEqual(0.99);
      expect(m.scroll, JSON.stringify(m)).toBeLessThanOrEqual(0);
    });

    test("the table's visible text starts where GitHub's Unified puts it, right of the last number column", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect(page.locator("table").first()).toHaveAttribute("data-ghsoc", "additions");
      const m = await page.evaluate(() => {
        const t = document.querySelectorAll("table")[0];
        const tr = [...t.querySelectorAll("tbody > tr")].find((x) => x.children.length === 4);
        const v = [...tr.children].filter((td) => getComputedStyle(td).display !== "none");
        return { lastNum: v[1].getBoundingClientRect().right, textLeft: v[2].getBoundingClientRect().left };
      });
      expect(Math.abs(m.textLeft - m.lastNum), JSON.stringify(m)).toBeLessThanOrEqual(1);
    });

    test("states: hover and pressed darken like the native default button, keyboard focus shows a 2px ring at offset -2px", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      const btn = page.locator("[data-ghsoc-control]").first();
      await expect(btn).toBeVisible();
      const css = () => btn.evaluate((b) => { const s = getComputedStyle(b); return { bg: s.backgroundColor, shadow: s.boxShadow, outline: s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor, offset: s.outlineOffset, border: s.borderTopColor, font: s.fontFamily, size: s.fontSize + "/" + s.fontWeight + "/" + s.lineHeight }; });
      const rest = await css();
      expect(rest.bg).toBe("rgb(246, 248, 250)");
      expect(rest.border).toBe("rgb(209, 217, 224)");
      expect(rest.size).toBe("12px/500/18px");
      await btn.hover();
      await expect.poll(async () => (await css()).bg).toBe("rgb(239, 242, 245)"); // after the 80ms transition
      await page.mouse.down();
      await expect.poll(async () => (await css()).bg).toBe("rgb(230, 234, 239)");
      expect((await css()).shadow).toBe("none");
      await page.mouse.move(2, 2);
      await page.mouse.up();
      // keyboard modality: focus the native neighbour, then Shift+Tab onto the control
      await btn.evaluate((b) => b.nextElementSibling.matches("details") ? b.nextElementSibling.querySelector("summary").focus() : b.nextElementSibling.focus());
      await page.keyboard.press("Shift+Tab");
      const focus = await css();
      expect(focus.outline, JSON.stringify(focus)).toBe("solid 2px rgb(9, 105, 218)");
      expect(focus.offset).toBe("-2px");
      await expect(btn).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(btn).toHaveText("One column");
      await expect(btn).toBeFocused(); // the same element: the focus stays on the control
    });
  });
}

test.describe("dark theme", () => {
  for (const w of [1100, 390]) {
    test(`Files changed at ${w}px: the control's colours are Viewed's, from GitHub's variables, and differ from the header`, async ({ context, page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      const { url } = await setup(context, "hashed", sampleFiles(), { dark: true });
      await page.goto(url);
      const btn = page.locator("[data-ghsoc-control]").first();
      await expect(btn).toBeVisible();
      const m = await page.evaluate(() => {
        const c = document.querySelector("[data-ghsoc-control]");
        const v = c.nextElementSibling;
        const f = (e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderTopColor, color: s.color }; };
        const hdr = getComputedStyle(c.closest(".diff-file-header__CV6GPS")).backgroundColor;
        return { ctrl: f(c), viewed: f(v), hdr };
      });
      expect(m.ctrl, JSON.stringify(m)).toEqual(m.viewed);
      expect(m.ctrl.bg).toBe("rgb(33, 40, 48)"); // #212830, not the light fallback
      expect(m.ctrl.border).toBe("rgb(61, 68, 77)");
      expect(m.ctrl.color).toBe("rgb(240, 246, 252)");
      expect(m.ctrl.border).not.toBe(m.hdr);
      expect(m.ctrl.color).not.toBe(m.hdr);
      await btn.hover();
      await expect.poll(() => btn.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(38, 44, 54)");
    });
  }
});

test("767px vs 768px: the label flips with GitHub's Viewed label", async ({ context, page }) => {
  const { url } = await setup(context, "hashed", sampleFiles());
  for (const [w, shown] of [[768, true], [767, false]]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(url);
    const m = await page.evaluate(() => {
      const c = document.querySelector("[data-ghsoc-control]");
      return { ours: getComputedStyle(c.querySelector(".ghsoc-lbl")).display !== "none", viewed: getComputedStyle(c.nextElementSibling.querySelector("[class*=hide-on-mobile]")).display !== "none" };
    });
    expect(m, String(w)).toEqual({ ours: shown, viewed: shown });
  }
  void URLS;
});

test("header ≤ 561px wide: GitHub hides its view buttons and the control stays", async ({ context, page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const { url } = await setup(context, "hashed", sampleFiles());
  await page.goto(url);
  await page.evaluate(() => { document.querySelector("main").style.width = "560px"; });
  const m = await page.evaluate(() => {
    const c = document.querySelector("[data-ghsoc-control]");
    const seg = document.querySelector("ul[aria-label='File view']");
    return { seg: getComputedStyle(seg).display, ctrl: c.getBoundingClientRect().width };
  });
  expect(m.seg).toBe("none");
  expect(m.ctrl).toBeGreaterThan(28);
  await expect(page.locator("[data-ghsoc-control]").first()).toBeVisible();
});

// Classic header of a file without the view toggle (new files): the actions row holds only the …
// menu, 16px high. The 28px control must neither glue to anything nor grow the stacked header.
for (const w of [1500, 390]) {
  test(`classic header with only the … menu at ${w}px: the header keeps its height, 8px to the menu`, async ({ context, page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    const files = sampleFiles().map((f) => ({ ...f, noToggle: true }));
    const { url } = await setup(context, "classic", files, { storage: { ghsocEnabled: false } });
    await page.goto(url);
    await page.waitForTimeout(300);
    const before = await probe(page);
    await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ ghsocEnabled: true }));
    await expect(page.locator("[data-ghsoc-control]").first()).toBeVisible();
    const after = await probe(page);
    const msg = JSON.stringify({ before, after });
    expect(after.prev, msg).toBeNull();
    expect(Math.abs(after.hdrH - before.hdrH), msg).toBeLessThanOrEqual(1);
    expect(Math.abs(after.next.x - after.ctrl.right), msg).toBeLessThanOrEqual(1); // the menu's own padding is the gap
    expect(after.ctrl.h, msg).toBeGreaterThanOrEqual(27);
  });
}
