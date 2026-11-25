// E2E: the look and room of "Viewed per folder" against the native Primer TreeView row measured live
// (row 32px, content padding 0 8px with gap 8px, GitHub's label flex 1 1 auto truncating with an ellipsis):
// right edge, centring, nothing native moved, and the behaviour by pane width x depth x variant.
import { test, expect } from "./support/extension.js";
import { openFiles, settled } from "./support/viewed.js";

// Per folder row: native positions and, for the indicator, its box and what the row left for the label.
function measure(page) {
  return page.evaluate(() => {
    const glyphX = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 3) });
      const t = w.nextNode();
      if (!t) return null;
      const r = document.createRange();
      const i = t.textContent.search(/\S/);
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      return r.getBoundingClientRect();
    };
    const rows = [];
    const tree = document.getElementById("tree").getBoundingClientRect();
    for (const li of document.querySelectorAll("#tree li[aria-expanded]")) {
      const row = li.querySelector(":scope > .row-container");
      const content = document.getElementById(li.getAttribute("aria-labelledby"));
      const label = content.querySelector('[class*="TreeViewItemContentText"]');
      const toggle = row.querySelector(".PRIVATE_TreeView-item-toggle").getBoundingClientRect();
      const visual = content.querySelector(".PRIVATE_TreeView-item-visual").getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      const g = glyphX(label);
      const range = document.createRange();
      range.selectNodeContents(label);
      const textRight = range.getBoundingClientRect().right;
      const cs = getComputedStyle(content);
      const cr = content.getBoundingClientRect();
      const ind = content.querySelector(":scope > .ghvf-ind");
      const o = { id: li.id, level: Number(li.getAttribute("aria-level")), rowH: row.getBoundingClientRect().height, toggleX: toggle.left, visualX: visual.left, visualY: visual.top, labelX: g.left, labelLeft: lr.left, labelW: lr.width, labelMid: g.top + g.height / 2, contentInnerRight: cr.right - parseFloat(cs.paddingRight), treeRight: tree.right };
      if (ind && getComputedStyle(ind).display !== "none") {
        const r = ind.getBoundingClientRect();
        const glyph = ind.querySelector(".ghvf-glyph").getBoundingClientRect();
        const count = ind.querySelector(".ghvf-count");
        o.ind = { left: r.left, right: r.right, mid: r.top + r.height / 2, w: r.width, h: r.height, glyphW: glyph.width, glyphH: glyph.height, compact: ind.classList.contains("ghvf-compact"), count: count.textContent, countShown: getComputedStyle(count).display !== "none", font: getComputedStyle(count).fontSize, nums: getComputedStyle(ind).fontVariantNumeric, state: ind.dataset.state };
        o.gap = ind.getBoundingClientRect().left - lr.right;
        o.textGap = ind.getBoundingClientRect().left - textRight;
      }
      rows.push(o);
    }
    return rows;
  });
}

const hideInd = (page) => page.addStyleTag({ content: ".ghvf-ind{display:none!important}" }).then((h) => h);

test("nothing native moves: row height, chevron, folder icon and label start are identical with and without the indicator", async ({ context, page }) => {
  await openFiles(context, page, { query: "viewed=docs/guide.md,server/api/Cargo.toml" });
  await settled(page);
  const handle = await hideInd(page);
  const before = await measure(page);
  await handle.evaluate((n) => n.remove());
  const after = await measure(page);
  expect(after.length).toBe(before.length);
  for (let i = 0; i < before.length; i++) {
    const [b, a] = [before[i], after[i]];
    expect(Math.abs(a.rowH - b.rowH), a.id).toBeLessThanOrEqual(0.5);
    expect(a.toggleX, a.id).toBe(b.toggleX);
    expect(a.visualX, a.id).toBe(b.visualX);
    expect(a.visualY, a.id).toBe(b.visualY);
    expect(Math.abs(a.labelX - b.labelX), a.id).toBeLessThanOrEqual(1);
    expect(a.labelMid, a.id).toBe(b.labelMid);
  }
});

test("right edge on the content's inner right edge, centred on the label's text line, 16px glyph, 12px tabular count, the row's own gap", async ({ context, page }) => {
  await openFiles(context, page, { query: "viewed=docs/guide.md,server/api/Cargo.toml" });
  await settled(page);
  for (const m of await measure(page)) {
    expect(m.ind, m.id).toBeTruthy();
    expect(Math.abs(m.ind.right - m.contentInnerRight), `${m.id} right edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.ind.mid - m.labelMid), `${m.id} centre`).toBeLessThanOrEqual(1);
    expect(m.ind.glyphW, m.id).toBe(m.ind.state === "loading" ? 28 : 16);
    expect(m.ind.glyphH, m.id).toBe(16);
    if (m.ind.count) {
      expect(m.ind.font).toBe("12px");
      expect(m.ind.nums).toContain("tabular-nums");
    }
    expect(m.gap, `${m.id} label to indicator`).toBeGreaterThanOrEqual(8 - 1); // the row's gap (8px), no margin added
  }
  // no margin of our own: the gap is the row's
  const margin = await page.evaluate(() => getComputedStyle(document.querySelector(".ghvf-ind")).margin);
  expect(margin).toBe("0px");
});

// --- the behaviour table: pane width x depth x variant ---------------------------------------------

const DEEP = ["a/x.rs", "a/storage_backend_migrations/x.rs", "a/storage_backend_migrations/c/x.rs", "a/storage_backend_migrations/c/dd/x.rs", "a/storage_backend_migrations/c/dd/e/x.rs"];
const deepQuery = (more = "") => `paths=${DEEP.join(",")}&extraDir=a/storage_backend_migrations/c/dd/e${more}`;
const unviewed = (n, dir) => Array.from({ length: n }, (_, i) => `${dir}/file-${String(i + 1).padStart(3, "0")}.rs`);

const VARIANTS = [
  { name: "check", query: `paths=${DEEP.join(",")}&viewed=${DEEP.join(",")}`, opts: {} },
  { name: "3/7 style (n/N)", query: deepQuery("&extra=7&rendered=3&viewed=a/x.rs,a/storage_backend_migrations/x.rs,a/storage_backend_migrations/c/x.rs"), opts: {} },
  { name: "2+/108", query: deepQuery("&extra=108&rendered=0"), opts: { token: true, api: { states: Object.fromEntries([...DEEP, ...unviewed(108, "a/storage_backend_migrations/c/dd/e")].slice(0, 111).map((p, i) => [p, i < 2 ? "VIEWED" : "UNVIEWED"])), total: 113 } } },
  { name: "?/108", query: deepQuery("&extra=108&rendered=0"), opts: {} },
  { name: "0/1500 (4 digits)", query: deepQuery("&extra=1500&rendered=0"), opts: { token: true, api: { states: Object.fromEntries([...DEEP, ...unviewed(1500, "a/storage_backend_migrations/c/dd/e")].map((p) => [p, "UNVIEWED"])) } } },
  { name: "loading pill", query: deepQuery("&extra=20&rendered=0"), opts: { token: true, api: { delay: 20000, states: {} } }, loading: true },
];

for (const pane of [298, 256]) {
  for (const v of VARIANTS) {
    test(`pane ${pane}px, depth 1-5, ${v.name}: indicator inside the row, label truncates first, count dropped only when the label would be < 32px`, async ({ context, page }) => {
      await page.setViewportSize({ width: 1500, height: 900 });
      await openFiles(context, page, { query: `${v.query}&pane=${pane}`, ...v.opts });
      if (v.loading) await expect(page.locator("#tree li[aria-expanded] > .row-container .ghvf-ind[data-state=loading]").first()).toBeVisible();
      else await settled(page);
      await page.waitForTimeout(150); // the layout pass after the last render
      const rows = await measure(page);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      const seen = new Set(rows.map((r) => r.level));
      expect([...seen].sort()).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
      for (const r of rows) {
        const why = `${r.id} (level ${r.level}) ${JSON.stringify(r.ind)}`;
        expect(r.ind, why).toBeTruthy();
        expect(r.ind.right, `${why}: inside the content`).toBeLessThanOrEqual(r.contentInnerRight + 1);
        expect(r.ind.right, `${why}: inside the tree (never clipped)`).toBeLessThanOrEqual(r.treeRight);
        expect(r.gap, `${why}: no overlap with the label, gap ${r.gap}`).toBeGreaterThanOrEqual(7);
        expect(r.rowH, why).toBeLessThanOrEqual(32.7);
        expect(r.ind.glyphW, `${why}: glyph kept`).toBeGreaterThanOrEqual(16);
        expect(r.ind.h).toBeLessThanOrEqual(32);
        if (r.ind.compact) expect(r.ind.countShown, why).toBe(false);
        else expect(r.labelW, `${why}: label width ${r.labelW} when the count is shown`).toBeGreaterThanOrEqual(32 - 0.5);
      }
      // consistency: a row that kept its count would not have been compact if it had the room; a compact row had < 32px.
      const compact = await page.evaluate(() => {
        const out = [];
        for (const li of document.querySelectorAll("#tree li[aria-expanded]")) {
          const ind = li.querySelector(":scope > .row-container .ghvf-ind");
          if (!ind || !ind.classList.contains("ghvf-compact")) continue;
          ind.classList.remove("ghvf-compact");
          const label = li.querySelector(':scope > .row-container [class*="TreeViewItemContentText"]');
          out.push({ id: li.id, labelWithCount: label.getBoundingClientRect().width });
          ind.classList.add("ghvf-compact");
        }
        return out;
      });
      for (const c of compact) expect(c.labelWithCount, `${c.id} was compact but had room`).toBeLessThan(32);
    });
  }
}

test("a long folder name is truncated by GitHub's own ellipsis, then the full indicator; a short name leaves free space before the right-aligned indicator", async ({ context, page }) => {
  await openFiles(context, page, { query: "pane=256&viewed=server/api/Cargo.toml" });
  await settled(page);
  const m = Object.fromEntries((await measure(page)).map((r) => [r.id, r]));
  const long = m["server/storage_backend_migrations"];
  const short = m["docs"];
  expect(long.ind.compact).toBe(false);
  expect(await page.evaluate(() => { const l = document.querySelector('li[id="server/storage_backend_migrations"] [class*="TreeViewItemContentText"]'); return l.scrollWidth > l.clientWidth || getComputedStyle(l).textOverflow; })).toBeTruthy();
  expect(long.gap).toBeGreaterThanOrEqual(7);
  expect(short.textGap).toBeGreaterThan(40); // right-aligned, not pulled next to the name
  expect(Math.abs(short.ind.right - short.contentInnerRight)).toBeLessThanOrEqual(1);
});

test("the pane resizes: the deepest rows (13 levels, 4-digit count) drop their count as it narrows and get it back as it widens", async ({ context, page }) => {
  const levels = "a,b,c,d,e,f,g,h,i,j,k,l,m".split(",");
  const chain = levels.map((_, i) => `${levels.slice(0, i + 1).join("/")}/x.rs`);
  const deepest = unviewed(1500, levels.join("/"));
  await openFiles(context, page, { query: `paths=${chain.join(",")}&extraDir=${levels.join("/")}&extra=1500&rendered=0&pane=700`, token: true, api: { states: Object.fromEntries([...chain, ...deepest].map((p) => [p, "UNVIEWED"])) } });
  await settled(page);
  await page.waitForTimeout(150);
  const wide = await measure(page);
  expect(wide.every((r) => !r.ind.compact)).toBe(true);
  await page.evaluate(() => window.__setPane(256));
  await expect.poll(async () => (await measure(page)).some((r) => r.ind.compact), { timeout: 5000 }).toBe(true);
  await page.evaluate(() => window.__setPane(700));
  await expect.poll(async () => (await measure(page)).every((r) => !r.ind.compact), { timeout: 5000 }).toBe(true);
});

test("below ~1075px GitHub hides the pane: nothing of ours is visible and nothing is injected elsewhere", async ({ context, page }) => {
  await page.setViewportSize({ width: 1074, height: 800 });
  await openFiles(context, page);
  await expect(page.locator("#tree li[aria-expanded]")).toHaveCount(8);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => [...document.querySelectorAll(".ghvf-ind")].filter((i) => i.getClientRects().length).length)).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll(".ghvf-ind")].filter((i) => !document.getElementById("tree").contains(i)).length)).toBe(0);
  await page.setViewportSize({ width: 1200, height: 800 });
  await settled(page);
  expect(await page.evaluate(() => [...document.querySelectorAll(".ghvf-ind")].filter((i) => i.getClientRects().length).length)).toBe(8);
});

// --- colour: 3:1 for glyph and count on the row at rest, hover and selected, light and dark ---------

function contrastReport(page, id) {
  return page.evaluate((rowId) => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const li = document.getElementById(rowId);
    const row = li.querySelector(":scope > .row-container");
    const page = parse(getComputedStyle(document.body).backgroundColor);
    const bg = over(parse(getComputedStyle(row).backgroundColor), page);
    const ind = row.querySelector(".ghvf-ind");
    const out = { bg, parts: {} };
    out.parts.count = ratio(parse(getComputedStyle(ind.querySelector(".ghvf-count")).color), bg);
    const g = ind.querySelector(".ghvf-glyph");
    for (const sel of [".ghvf-track", ".ghvf-arc", ".ghvf-dashed"]) { const e = g.querySelector(sel); if (e) out.parts[sel] = ratio(parse(getComputedStyle(e).stroke), bg); }
    if (ind.dataset.state === "viewed") out.parts.check = ratio(parse(getComputedStyle(ind).color), bg);
    return out;
  }, id);
}

for (const dark of [false, true]) {
  test(`contrast >= 3:1 for glyph and count on rest, hover and selected rows (${dark ? "dark" : "light"})`, async ({ context, page }) => {
    await openFiles(context, page, { query: `${dark ? "dark=1&" : ""}rendered=8&extra=20&viewed=server/api/src/handlers/auth.rs,docs/guide.md,README.md` });
    await settled(page);
    for (const id of ["docs", "server/api/src/handlers", "server", "vendor/lib"]) {
      const ids = [];
      ids.push(["rest", await contrastReport(page, id)]);
      await page.locator(`li[id="${id}"] > .row-container`).hover();
      ids.push(["hover", await contrastReport(page, id)]);
      await page.mouse.move(900, 700);
      await page.evaluate((i) => document.getElementById(i).setAttribute("aria-selected", "true"), id);
      ids.push(["selected", await contrastReport(page, id)]);
      await page.evaluate((i) => document.getElementById(i).setAttribute("aria-selected", "false"), id);
      for (const [state, rep] of ids) for (const [part, ratio] of Object.entries(rep.parts)) expect(ratio, `${id} ${state} ${part}`).toBeGreaterThanOrEqual(3);
    }
  });
}
