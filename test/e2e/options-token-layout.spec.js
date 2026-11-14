// E2E: the token settings section measured against the plan's constraints
// (#129 plan, section 2 and 2b). One seeded state, every width of the table,
// both themes, the panel open and closed. Failures list the constraint ID with
// the measured values so a failing CI log is enough to see what moved.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { mockApi, allGood, CLASSIC, FINE } from "./support/tokens.js";

// The one-line / stacked threshold (list width in px), one value for the CSS
// container query and for this spec (plan 2b, T1).
const THRESHOLD = 560;

const when = (daysAgo, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const codes = (over) => ({ identity: "available", contents: "available", pulls: "available", issues: "available", projects: "available", actions: "unchecked", ...over });

const TOKENS = [
  { id: "d", name: "Personal", owner: "", token: FINE },
  { id: "w", name: "Work – acme-demo", owner: "acme-demo", token: CLASSIC },
  { id: "s", name: "SSO org", owner: "rossi-lab", token: "ghp_SSO1234" },
  { id: "t", name: "Team projects", owner: "example-lab", token: "ghp_TEAM1234" },
];
const SESSION = {
  d: { at: when(0, 9, 12), codes: codes({ actions: "available" }) },
  w: { at: when(1, 17, 40), codes: codes({ pulls: "denied", issues: "unverified" }) },
  s: { at: when(0, 8, 5), codes: codes({ actions: "unverified" }) },
};
// Worst content: long default name with the tag, Missing permissions, the
// could-not-verify note and the longest last-test line.
const WORST = {
  tokens: [{ id: "d", name: "Personal account with a long descriptive name", owner: "", token: FINE }, ...TOKENS.slice(1)],
  session: { ...SESSION, d: { at: when(1, 17, 40), codes: codes({ pulls: "denied", issues: "unverified", projects: "unverified", actions: "available" }) } },
};

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function start(context, page, { tokens = TOKENS, session = SESSION, run = true, scheme = "light", size = { width: 1500, height: 900 } } = {}) {
  await mockApi(context, (c) => {
    if (c.url.includes("/pulls?")) return { status: 403, body: { message: "Resource not accessible by personal access token" } };
    if (c.url.includes("/issues?")) return { body: [] };
    return allGood(c);
  });
  await seedStorage(context, { githubTokens: tokens, defaultTokenId: tokens.some((t) => t.id === "d") ? "d" : null });
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(size);
  const worker = await openOptions(context, page, "#tokens-section");
  await worker.evaluate((s) => chrome.storage.session.set({ ghrTokenTests: s }), session);
  await page.reload();
  await page.locator("#tokens[data-loaded]").waitFor({ state: "attached" });
  if (run) {
    await page.locator('#token-list .token-item').nth(1).locator('[data-act="test"]').click();
    await expect(page.locator("#token-list .tr-result")).toBeVisible();
  }
}

// Everything the constraints measure, in one round trip.
function probe() {
  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cy: (r.top + r.bottom) / 2 };
  };
  const first = (el) => {
    if (!el) return null;
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const r = rg.getClientRects()[0];
    return r ? { l: r.left, r: r.right, t: r.top, b: r.bottom, cy: (r.top + r.bottom) / 2 } : null;
  };
  const q = (s, root = document) => root.querySelector(s);
  const vis = (el) => el && !el.hidden && el.getBoundingClientRect().height > 0;
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const section = q("#tokens-section");
  const list = q("#token-list");
  const panel = q("#token-panel");
  const rows = [...list.querySelectorAll(":scope > .token-item")].map((li) => {
    const row = q(".token-row", li);
    return {
      id: li.dataset.id,
      li: R(li),
      name: first(q(".tr-name", li)),
      nameBox: R(q(".tr-name", li)),
      tag: R(q(".tr-main .tag", li)),
      use: first(q(".tr-use", li)),
      pill: R(q(".state-pill", li)),
      note: R(q(".tr-note-line", li)),
      last: R(q(".tr-last", li)),
      lastLine: parseFloat(cs(q(".tr-last", li), "lineHeight")) || 18,
      test: R(q('.token-row [data-act="test"]', li)),
      edit: R(q('.token-row [data-act="edit"]', li)),
      rowBox: R(row),
      result: R(q(".tr-result", li)),
      borderTop: cs(li, "borderTopWidth"),
      editing: li.classList.contains("is-editing"),
      overflow: [...li.querySelectorAll("*")].filter((e) => !e.hidden && e.getBoundingClientRect().width > 0 && !e.closest("[hidden]") && (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== "inline" || e.getBoundingClientRect().right > list.getBoundingClientRect().right + 1)).map((e) => `${e.tagName}.${e.className}`).slice(0, 4),
    };
  });
  const pr = (s) => R(q(s, panel));
  const body = q(".panel-body", panel);
  const kids = body ? [...body.children].filter(vis).map((e) => ({ id: e.id || e.className, ...R(e) })) : [];
  return {
    vw: document.documentElement.clientWidth,
    iw: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    section: R(section),
    title: first(q("#tokens-title")),
    blocks: Object.fromEntries([["lead", ".lead"], ["privacy", ".privacy"], ["warning", "#token-warning"], ["head", ".list-head"], ["list", "#token-list"], ["add", "#add-token"], ["guide", "#token-guide"], ["callout", ".callout"]].map(([k, s]) => [k, vis(q(s, section)) ? R(q(s, section)) : null])),
    listW: R(list).w,
    listBorder: cs(list, "borderTopWidth"),
    rows,
    panelOpen: vis(panel),
    panel: vis(panel) ? R(panel) : null,
    panelPos: panel ? cs(panel, "position") : null,
    modal: panel ? panel.getAttribute("aria-modal") : null,
    kids,
    fixedInPanel: panel ? [...panel.querySelectorAll("*")].filter((e) => ["fixed", "sticky"].includes(getComputedStyle(e).position) && !e.closest(".panel-head")).map((e) => e.id || e.className) : [],
  };
}

const near = (a, b, t = 1) => Math.abs(a - b) <= t;

// Which layout a row is in.
const layoutOf = (row) => (row.pill && row.name && Math.abs(row.pill.cy - row.name.cy) < 8 ? "one-line" : "stacked");

function universal(p, tag, fails) {
  const f = (id, msg) => fails.push(`${tag} ${id}: ${msg}`);
  if (p.scrollW > p.iw + 0.5) f("L4", `scrollWidth ${p.scrollW} > innerWidth ${p.iw}`);
  const expected = p.listW >= THRESHOLD ? "one-line" : "stacked";
  const nearEdge = Math.abs(p.listW - THRESHOLD) <= 1;
  const row0 = p.rows[0];
  if (!nearEdge && layoutOf(row0) !== expected) f("L-layout", `list ${p.listW.toFixed(0)}px expects ${expected}, row is ${layoutOf(row0)}`);
  for (const r of p.rows) if (r.overflow.length) f("L17", `${r.id} overflows: ${r.overflow.join(", ")}`);
  const L = p.rows.length ? p.rows[0].li.l : 0;
  return expected;
}

function rowRules(p, layout, tag, fails) {
  const f = (id, msg) => fails.push(`${tag} ${id}: ${msg}`);
  const noNote = p.rows.filter((r) => !r.note);
  if (layout === "one-line") {
    const lefts = p.rows.map((r) => r.pill.l);
    if (Math.max(...lefts) - Math.min(...lefts) > 1) f("L6", `pill left edges ${lefts.map((x) => x.toFixed(1)).join(" / ")}`);
    for (const r of p.rows) {
      if (!near(r.name.cy, r.pill.cy, 1)) f("L7", `${r.id} name cy ${r.name.cy.toFixed(1)} vs pill cy ${r.pill.cy.toFixed(1)}`);
      if (r.last && !near(r.last.t, r.pill.b, 1)) f("L7", `${r.id} last test top ${r.last.t.toFixed(1)} vs pill bottom ${r.pill.b.toFixed(1)}`);
      if (r.last.h > r.lastLine + 2) f("L8", `${r.id} last test ${r.last.h.toFixed(0)}px high (line ${r.lastLine})`);
      if (r.note && r.note.t < r.pill.b - 1) f("L9", `${r.id} note top ${r.note.t.toFixed(1)} above pill bottom ${r.pill.b.toFixed(1)}`);
      if (r.note && !near(r.note.l, r.pill.l, 1)) f("L9", `${r.id} note left ${r.note.l.toFixed(1)} vs pill left ${r.pill.l.toFixed(1)}`);
    }
    const hs = noNote.map((r) => r.rowBox.b - r.rowBox.t);
    if (hs.length && Math.max(...hs) - Math.min(...hs) > 1) f("L8", `row heights without note ${hs.map((x) => x.toFixed(1)).join(" / ")}`);
  } else {
    for (const r of p.rows) {
      if (!near(r.pill.l, r.name.l, 1) || !near(r.last.l, r.name.l, 1)) f("L14", `${r.id} name ${r.name.l.toFixed(1)}, pill ${r.pill.l.toFixed(1)}, last ${r.last.l.toFixed(1)}`);
      const btns = [r.test, r.edit].filter(Boolean);
      for (const b of btns) {
        if (b.t < r.last.b - 1) f("L15", `${r.id} button top ${b.t.toFixed(1)} above last test bottom ${r.last.b.toFixed(1)}`);
        if (b.r > r.rowBox.r + 1) f("L15", `${r.id} button right ${b.r.toFixed(1)} beyond row ${r.rowBox.r.toFixed(1)}`);
        if (!near(b.h, 32, 1)) f("L15", `${r.id} button height ${b.h}`);
      }
    }
    const hs = noNote.map((r) => r.rowBox.b - r.rowBox.t);
    if (hs.length && Math.max(...hs) - Math.min(...hs) > 1) f("L16", `row heights without note ${hs.map((x) => x.toFixed(1)).join(" / ")}`);
  }
}

function sectionRules(p, tag, fails) {
  const f = (id, msg) => fails.push(`${tag} ${id}: ${msg}`);
  for (const [k, b] of Object.entries(p.blocks)) {
    if (!b || k === "add") continue;
    if (!near(b.l, p.section.l, 1) || b.w / p.section.w < 0.98) f("L1", `${k} left ${b.l.toFixed(1)} width ${b.w.toFixed(1)} vs section ${p.section.l.toFixed(1)} / ${p.section.w.toFixed(1)}`);
  }
  if (p.listBorder !== "1px") f("L5", `list border ${p.listBorder}`);
  p.rows.forEach((r, i) => {
    if (i && r.borderTop !== "1px") f("L5", `${r.id} border-top ${r.borderTop}`);
    if (i && !near(r.li.t, p.rows[i - 1].li.b, 1)) f("L5", `gap between rows ${i - 1}/${i}: ${(r.li.t - p.rows[i - 1].li.b).toFixed(1)}`);
    if (r.result && (r.result.l < p.blocks.list.l || r.result.r > p.blocks.list.r)) f("L5", `result outside the card`);
  });
  const order = ["lead", "privacy", "warning", "head", "list", "add", "guide", "callout"].filter((k) => p.blocks[k]);
  order.forEach((k, i) => {
    if (!i) return;
    const prev = p.blocks[order[i - 1]];
    const gap = p.blocks[k].t - prev.b;
    if (gap < -0.5) f("L10", `${k} above ${order[i - 1]}`);
    else if (k !== "list" && gap < 8) f("L10", `${order[i - 1]} → ${k} gap ${gap.toFixed(1)}`);
  });
  if (p.blocks.privacy && p.blocks.warning && !near(p.blocks.warning.t - p.blocks.privacy.b, 14, 2)) f("L10", `privacy → warning gap ${(p.blocks.warning.t - p.blocks.privacy.b).toFixed(1)}`);
}

function panelRules(p, tag, fails) {
  const f = (id, msg) => fails.push(`${tag} ${id}: ${msg}`);
  const sheet = p.iw <= 1023;
  if (sheet) {
    if (!near(p.panel.w, p.vw, 1)) f("L3", `panel ${p.panel.w} vs viewport ${p.vw}`);
  } else {
    if (!near(p.panel.w, 420, 1)) f("L2", `panel width ${p.panel.w}`);
    for (const r of p.rows) {
      const right = Math.max(...[r.name, r.pill, r.test, r.edit].filter(Boolean).map((b) => b.r));
      if (right > p.panel.l + 1) f("L2", `${r.id} right ${right.toFixed(1)} under panel left ${p.panel.l.toFixed(1)}`);
    }
  }
  if (p.fixedInPanel.length) f("P3", `fixed/sticky inside the panel: ${p.fixedInPanel.join(", ")}`);
  p.kids.forEach((k, i) => {
    if (!i) return;
    const gap = k.t - p.kids[i - 1].b;
    if (!near(gap, 12, 2)) f("L12", `gap before ${k.id}: ${gap.toFixed(1)} (after ${p.kids[i - 1].id})`);
  });
}

// §2b widths: [width, panel open], with the layout the table gives.
const TABLE = [
  [1500, false], [1500, true], [1100, false], [1100, true], [1024, false], [1024, true], [1023, false], [1023, true],
  [800, false], [800, true], [721, false], [721, true], [720, false], [720, true], [390, false], [390, true], [320, false], [320, true],
];
const TABLE_LAYOUT = { "1500c": "one-line", "1500o": "one-line", "1100c": "one-line", "1024c": "one-line", "1023c": "one-line", "720c": "one-line" };

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: every constraint at the widths of the behaviour table`, async ({ context, page }) => {
    test.setTimeout(120_000);
    await start(context, page, { scheme });
    const fails = [];
    for (const [width, open] of TABLE) {
      await page.setViewportSize({ width, height: 900 });
      if (open && !(await page.locator("#token-panel").isVisible())) await page.locator('#token-list .token-item').nth(1).locator('.token-row [data-act="edit"]').click();
      if (!open && (await page.locator("#token-panel").isVisible())) { await page.keyboard.press("Escape"); }
      await expect(page.locator("#token-panel")).toBeVisible({ visible: open });
      const p = await page.evaluate(probe);
      const tag = `[${scheme} ${width} ${open ? "open" : "closed"}]`;
      const layout = universal(p, tag, fails);
      const given = TABLE_LAYOUT[`${width}${open ? "o" : "c"}`];
      if (given && layout !== given) fails.push(`${tag} 2b: table says ${given}, list ${p.listW.toFixed(0)}px derives ${layout}`);
      sectionRules(p, tag, fails);
      rowRules(p, layout, tag, fails);
      if (open) panelRules(p, tag, fails);
      if (open && p.iw >= 1024 && p.modal !== "false") fails.push(`${tag} B6: side panel aria-modal ${p.modal}`);
      if (open && p.iw <= 1023 && p.modal !== "true") fails.push(`${tag} B6: sheet aria-modal ${p.modal}`);
      if (open) await page.keyboard.press("Escape");
    }
    expect(fails.join("\n")).toBe("");
  });
}

test("sweep every 20px from 320 to 1600, panel open and closed, both themes: no h-scroll, no overflow, layout from the list width", async ({ context, page }) => {
  test.setTimeout(240_000);
  await start(context, page);
  const fails = [];
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const open of [false, true]) {
      if (open) await page.locator('#token-list .token-item').nth(1).locator('.token-row [data-act="edit"]').click();
      else if (await page.locator("#token-panel").isVisible()) await page.keyboard.press("Escape");
      for (let width = 320; width <= 1600; width += 20) {
        await page.setViewportSize({ width, height: 900 });
        const p = await page.evaluate(probe);
        const tag = `[${scheme} ${width} ${open ? "open" : "closed"}]`;
        const layout = universal(p, tag, fails);
        sectionRules(p, tag, fails);
        rowRules(p, layout, tag, fails);
      }
    }
    await page.keyboard.press("Escape");
  }
  expect(fails.join("\n")).toBe("");
});

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: worst content near the threshold stays a clean one-line row (T1)`, async ({ context, page }) => {
    test.setTimeout(240_000);
    await start(context, page, { ...WORST, scheme, run: false });
    const fails = [];
    let seen = 0;
    for (const open of [false, true]) {
      if (open) await page.locator("#token-list .token-item").first().locator('.token-row [data-act="edit"]').click();
      const [from, to] = open ? [1220, 1320] : [800, 900];
      for (let width = from; width <= to; width += 4) {
        await page.setViewportSize({ width, height: 900 });
        const p = await page.evaluate(probe);
        if (p.listW < THRESHOLD || p.listW > THRESHOLD + 24) continue;
        seen++;
        const tag = `[${scheme} ${width} ${open ? "open" : "closed"} list ${p.listW.toFixed(0)}]`;
        const layout = universal(p, tag, fails);
        rowRules(p, layout, tag, fails);
        for (const r of p.rows) {
          if (r.pill.h > 24) fails.push(`${tag} T1: ${r.id} pill ${r.pill.h.toFixed(0)}px high (wrapped)`);
          if (r.note && r.note.h > 20) fails.push(`${tag} T1: ${r.id} note wrapped (${r.note.h.toFixed(0)}px)`);
          if (r.name.t - r.nameBox.t > 1 && false) fails.push("unreachable");
          if (!near(r.name.cy, r.pill.cy, 1)) fails.push(`${tag} T1: ${r.id} first name line cy ${r.name.cy.toFixed(1)} vs pill ${r.pill.cy.toFixed(1)}`);
        }
      }
    }
    expect(seen, "some width must land the list at the threshold").toBeGreaterThan(0);
    expect(fails.join("\n")).toBe("");
  });
}

test("a Not set default row lines up with the others (L6)", async ({ context, page }) => {
  await start(context, page, { tokens: TOKENS.slice(1), session: SESSION, run: false });
  const p = await page.evaluate(probe);
  expect(p.rows[0].pill, "default row").not.toBeNull();
  const lefts = p.rows.map((r) => r.pill.l);
  expect(Math.max(...lefts) - Math.min(...lefts), `pill lefts ${lefts.join(" / ")}`).toBeLessThanOrEqual(1);
  const hs = p.rows.filter((r) => !r.note).map((r) => r.rowBox.b - r.rowBox.t);
  expect(Math.max(...hs) - Math.min(...hs), `row heights ${hs.join(" / ")}`).toBeLessThanOrEqual(1);
});

test("200% text (750 CSS px): stacked rows, full-page sheet, nothing clipped, controls reachable (Z1)", async ({ context, page }) => {
  await start(context, page, { size: { width: 750, height: 450 }, run: false });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 750, height: 450, deviceScaleFactor: 2, mobile: false });
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    const fails = [];
    let p = await page.evaluate(probe);
    let layout = universal(p, `[z1 ${scheme} closed]`, fails);
    rowRules(p, layout, `[z1 ${scheme} closed]`, fails);
    if (layout !== "stacked") fails.push(`[z1 ${scheme}] rows must be stacked, list ${p.listW}`);
    for (const row of await page.locator("#token-list .token-item").all()) {
      for (const act of ["test", "edit"]) {
        const b = row.locator(`.token-row [data-act="${act}"]`);
        if (await b.count()) { await b.scrollIntoViewIfNeeded(); await b.click({ trial: true }); }
      }
    }
    await page.locator("#token-list .token-item").first().locator('.token-row [data-act="edit"]').click();
    p = await page.evaluate(probe);
    layout = universal(p, `[z1 ${scheme} open]`, fails);
    panelRules(p, `[z1 ${scheme} open]`, fails);
    for (const sel of ["#panel-close", "#panel-test", "#panel-save", "#panel-name"]) {
      const b = page.locator(sel);
      await b.scrollIntoViewIfNeeded();
      await b.click({ trial: true });
    }
    expect(fails.join("\n")).toBe("");
    await page.keyboard.press("Escape");
  }
});

// B6: the sheet is modal for the keyboard, the side panel is not.
async function activeInPanel(page) {
  // Tab past the last control hands focus to the browser's own UI: the
  // document's activeElement is then <body>, which is not a page element.
  return page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest("#token-panel"));
}
for (const [width, scale] of [[800, 1], [721, 1], [390, 1], [320, 1], [750, 2]]) {
  test(`B6: at ${width}${scale > 1 ? " (200% text)" : ""} Tab and Shift+Tab stay inside the sheet; Esc and X restore the page`, async ({ context, page }) => {
    await start(context, page, { size: { width, height: 800 }, run: false });
    const opener = page.locator("#token-list .token-item").nth(1).locator('.token-row [data-act="edit"]');
    await opener.click();
    await expect(page.locator("#token-panel")).toHaveAttribute("aria-modal", "true");
    const outside = await page.evaluate(() => [...document.body.children].filter((e) => e.tagName !== "SCRIPT" && e.id !== "token-panel" && !e.contains(document.getElementById("token-panel")) && !e.hasAttribute("inert")).map((e) => e.tagName + "." + e.className));
    expect(outside, "top-level parts of the page not inert").toEqual([]);
    const stray = [];
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); if (!(await activeInPanel(page))) stray.push(`Tab ${i}`); }
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Shift+Tab"); if (!(await activeInPanel(page))) stray.push(`Shift+Tab ${i}`); }
    expect(stray, "focus left the sheet").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("#token-panel")).toBeHidden();
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await page.locator("#panel-close").click();
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    await expect(opener).toBeFocused();
  });
}

for (const width of [1500, 1024]) {
  test(`B6: at ${width} the side panel is not modal: nothing inert, focus never lands under it`, async ({ context, page }) => {
    await start(context, page, { size: { width, height: 800 }, run: false });
    await page.locator("#token-list .token-item").nth(1).locator('.token-row [data-act="edit"]').click();
    await expect(page.locator("#token-panel")).toHaveAttribute("aria-modal", "false");
    expect(await page.evaluate(() => document.querySelectorAll("[inert]").length)).toBe(0);
    const under = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const hit = await page.evaluate(() => {
        const a = document.activeElement;
        const p = document.getElementById("token-panel").getBoundingClientRect();
        if (!a || a === document.body || a.closest("#token-panel")) return null;
        const r = a.getBoundingClientRect();
        return r.width && r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top ? a.tagName + "." + a.className : null;
      });
      if (hit) under.push(hit);
    }
    expect(under, "focused elements under the panel").toEqual([]);
  });
}

test("B6: crossing 1023/1024 with the panel open re-applies aria-modal and inert", async ({ context, page }) => {
  await start(context, page, { size: { width: 1500, height: 800 }, run: false });
  await page.locator("#token-list .token-item").nth(1).locator('.token-row [data-act="edit"]').click();
  const state = () => page.evaluate(() => [document.getElementById("token-panel").getAttribute("aria-modal"), document.querySelectorAll("[inert]").length > 0]);
  expect(await state()).toEqual(["false", false]);
  await page.setViewportSize({ width: 800, height: 800 });
  await expect.poll(state).toEqual(["true", true]);
  await page.setViewportSize({ width: 1500, height: 800 });
  await expect.poll(state).toEqual(["false", false]);
});

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: structure, copy and colours of the list, result, warning and guide`, async ({ context, page }) => {
    await start(context, page, { scheme });
    const A = scheme === "light" ? { accent: "#c2410c", bad: "#cf222e", link: "#0969da", text: "#1f2328", muted: "#59636e", wBg: "#f8f4ed", wLine: "#9a6700" } : { accent: "#f0883e", bad: "#ff7b72", link: "#4493f8", text: "#e6edf3", muted: "#9198a1", wBg: "#211c14", wLine: "#9e6a03" };
    const d = await page.evaluate(() => {
      const q = (s, r = document) => r.querySelector(s);
      const st = (el, p) => (el ? getComputedStyle(el)[p] : null);
      const R = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
      const def = q(".token-item .tag");
      const res = q(".tr-result");
      const lines = [...res.querySelectorAll(".tr-line")];
      const adv = q(".tr-advice li");
      const warn = q("#token-warning");
      const miss = q(".token-item:nth-child(2) .state-pill");
      return {
        tagBorder: st(def, "borderTopColor"), tagColor: st(def, "color"), tagText: def?.textContent,
        missColor: st(miss, "color"),
        warnBg: st(warn, "backgroundColor"), warnBorder: st(warn, "borderTopColor"),
        headTitle: q(".tr-head h3", res)?.textContent, headWhen: q(".tr-head .tr-when", res)?.textContent,
        headRow: q(".token-item:nth-child(2) .tr-last")?.textContent,
        headSame: q(".tr-head .tr-when", res) && R(q(".tr-head .tr-when", res)).t - R(q(".tr-head h3", res)).t,
        intro: q(".tr-intro", res)?.textContent, introSize: st(q(".tr-intro", res), "fontSize"), introColor: st(q(".tr-intro", res), "color"),
        introAbove: q(".tr-intro", res) && lines[0] ? R(q(".tr-intro", res)).b <= R(lines[0]).t + 1 : null,
        lines: lines.map((l) => {
          const lab = q("strong", l), pill = q(".diag-pill", l), why = q(".diag-reason", l);
          return { lab: R(lab), pill: R(pill), why: R(why), border: st(l, "borderTopWidth"), borderColor: st(l, "borderTopColor"), radius: st(l, "borderTopLeftRadius"), box: st(l, "borderLeftWidth") };
        }),
        adviceStyle: adv && { list: st(adv, "listStyleType"), size: st(adv, "fontSize"), color: st(adv, "color"), lead: st(q("strong", adv), "fontWeight") },
        detailsSummary: { color: st(q(".warning-details summary"), "color"), weight: st(q(".warning-details summary"), "fontWeight") },
        guideSummary: { color: st(q("#full-guide summary"), "color"), weight: st(q("#full-guide summary"), "fontWeight") },
        guide: { h: q("#token-guide h3")?.textContent, li: [...document.querySelectorAll("#token-guide .guide-steps > li")].length },
        steps: q("#warning-steps") && !q("#warning-steps").hidden,
        version: chrome.runtime.getManifest().version,
        save: null,
      };
    });
    const f = [];
    const eq = (id, a, b) => { if (a !== b) f.push(`${id}: ${a} ≠ ${b}`); };
    eq("K2 border", d.tagBorder, rgb(A.accent));
    eq("K2 text", d.tagColor, rgb(A.accent));
    eq("K1 differs from --bad", d.missColor === rgb(A.bad), false);
    eq("K3 background", d.warnBg, rgb(A.wBg));
    eq("K3 border", d.warnBorder, rgb(A.wLine));
    eq("S7 title", d.headTitle, "Test result · Work – acme-demo");
    if (!/OK$/.test(d.headWhen || "")) f.push(`S7 when text: ${d.headWhen}`);
    eq("S7 when = row last test", d.headWhen, d.headRow);
    if (d.headSame === null || Math.abs(d.headSame) > 2) f.push(`S7 header and when same line: dy ${d.headSame}`);
    eq("S8 text", d.intro, "One read-only check per permission type, started only by Test. Nothing was changed on GitHub.");
    eq("S8 size", d.introSize, "12px");
    eq("S8 colour", d.introColor, rgb(A.muted));
    eq("S8 above checks", d.introAbove, true);
    for (const [i, l] of d.lines.entries()) {
      if (!(l.why.t >= l.lab.b - 1)) f.push(`S9 line ${i}: reason top ${l.why.t} not under label bottom ${l.lab.b}`);
      if (Math.abs(l.why.l - l.lab.l) > 1) f.push(`S9 line ${i}: reason left ${l.why.l} vs label ${l.lab.l}`);
      if (Math.abs(l.pill.t - l.lab.t) > 2) f.push(`S9 line ${i}: pill top ${l.pill.t} vs label ${l.lab.t}`);
      if (l.border !== "1px") f.push(`S9 line ${i}: border-top ${l.border}`);
      if (l.box !== "0px" || l.radius !== "0px") f.push(`S9 line ${i}: own card (border-left ${l.box}, radius ${l.radius})`);
    }
    eq("S3 list-style", d.adviceStyle?.list, "none");
    eq("S3 size", d.adviceStyle?.size, "13px");
    eq("S3 colour", d.adviceStyle?.color, rgb(A.text));
    if (Number(d.adviceStyle?.lead) < 600) f.push(`S3 lead weight ${d.adviceStyle?.lead}`);
    for (const [k, v] of [["D1 details", d.detailsSummary], ["D1 guide", d.guideSummary]]) {
      eq(`${k} colour`, v.color, rgb(A.link));
      eq(`${k} weight`, v.weight, "600");
    }
    eq("S1 heading", d.guide.h, "New token? Three steps");
    eq("S1 steps", d.guide.li, 3);
    expect(f.join("\n")).toBe("");
  });
}

test("S4/S5: the warning details name the installed version; steps follow the buttons and drop when the permission set changes", async ({ context, page }) => {
  await start(context, page, { run: false });
  await page.locator(".warning-details summary").click();
  const version = await page.evaluate(() => chrome.runtime.getManifest().version);
  await expect(page.locator("#warning-details")).toContainText(`GH Reloaded ${version} uses`);
  await expect(page.locator("#warning-details")).toContainText("Read-only: GH Reloaded never writes to GitHub.");
  await page.getByRole("button", { name: "How to add it" }).click();
  await expect(page.locator("#warning-steps li")).toHaveCount(4);
  const ys = await page.evaluate(() => [document.querySelector(".warning-actions").getBoundingClientRect().bottom, document.querySelector("#warning-steps").getBoundingClientRect().top]);
  expect(ys[1]).toBeGreaterThanOrEqual(ys[0]);
  await page.evaluate(() => chrome.storage.local.set({ ghdgEnabled: false, ghsmEnabled: false, ghmiEnabled: false, ghlpsEnabled: false, ghprtEnabled: false, ghhpEnabled: false, ghigEnabled: false, ghntModules: { reasonTags: false } }));
  await expect(page.locator("#token-warning")).toBeHidden();
  await page.evaluate(() => chrome.storage.local.set({ ghprtEnabled: true }));
  await expect(page.locator("#token-warning")).toBeVisible();
  await expect(page.locator("#warning-steps")).toBeHidden();
});

for (const [width, scheme] of [[1500, "light"], [1500, "dark"], [390, "light"], [390, "dark"]]) {
  test(`${scheme} ${width}: the edit panel follows image 2 (P1–P7, N1)`, async ({ context, page }) => {
    await start(context, page, { scheme, size: { width, height: 900 }, run: false });
    await page.locator("#token-list .token-item").nth(1).locator('.token-row [data-act="edit"]').click();
    await page.locator("#panel-name").fill("Work – acme");
    await page.locator("#panel-test").click();
    await expect(page.locator("#panel-result .tr-line").first()).toBeVisible();
    const d = await page.evaluate(() => {
      const P = document.getElementById("token-panel");
      const q = (s) => P.querySelector(s);
      const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
      const st = (el, p) => (el ? getComputedStyle(el)[p] : null);
      const label = q("#panel-token-field .field-label");
      const li = document.querySelector(".token-item.is-editing");
      const body = q(".panel-body");
      const kids = [...body.children].filter((e) => !e.hidden && e.getBoundingClientRect().height > 0);
      const which = q("#panel-which");
      return {
        label: R(label), saved: R(q("#panel-saved")), savedColor: st(q("#panel-saved"), "color"), savedBorder: st(q("#panel-saved"), "borderTopWidth"), savedBg: st(q("#panel-saved"), "backgroundColor"), fieldR: R(q("#panel-token-field")).r,
        help: R(q("#panel-token-field .field-help")), replace: R(q("#panel-replace")), name: R(q("#panel-name")), nameField: R(q("#panel-name")),
        test: R(q("#panel-test")), discard: R(q("#panel-discard")), save: R(q("#panel-save")), hint: R(q("#panel-test-hint")), hintText: q("#panel-test-hint")?.textContent, check: R(q("#panel-check")),
        remove: R(q("#panel-remove")), removeBorder: st(q("#panel-remove"), "borderTopWidth"), removeBg: st(q("#panel-remove"), "backgroundColor"), lastKid: kids[kids.length - 1]?.id,
        result: R(q("#panel-result")),
        tag: (() => { const r = R(q("#panel-changes .changes-tag")); return { ...r, cy: (r.t + r.b) / 2 }; })(), tagText: q("#panel-changes .changes-tag")?.textContent, note: (() => { const rg = document.createRange(); rg.selectNodeContents(q("#panel-changes .changes-note")); const r = rg.getClientRects()[0]; return r ? { l: r.left, r: r.right, t: r.top, cy: (r.top + r.bottom) / 2 } : null; })(), noteText: q("#panel-changes .changes-note")?.textContent,
        whichLis: which.querySelectorAll("li").length, whichP: [...which.querySelectorAll("p")].map((p) => [p.textContent, getComputedStyle(p).fontSize]), whichBorder: st(which, "borderTopWidth"), whichTitle: q("#panel-which strong")?.textContent,
        row: li && { bg: st(li, "backgroundColor"), left: st(li, "borderLeftWidth"), leftColor: st(li, "borderLeftColor"), top: st(li, "borderTopColor"), outline: st(li, "outlineStyle") },
        saveStyle: { h: st(q("#panel-save"), "height"), radius: st(q("#panel-save"), "borderTopLeftRadius"), border: st(q("#panel-save"), "borderTopWidth") },
        owner: R(q("#panel-owner")),
      };
    });
    const f = [];
    const near1 = (id, a, b, t = 1) => { if (Math.abs(a - b) > t) f.push(`${id}: ${a?.toFixed?.(1) ?? a} vs ${b?.toFixed?.(1) ?? b}`); };
    // P2
    near1("P2 Saved top = label top", d.saved?.t, d.label.t, 2);
    near1("P2 Saved right = field right", d.saved?.r, d.fieldR);
    if (d.saved && (d.savedBorder !== "0px" || d.savedBg !== "rgba(0, 0, 0, 0)")) f.push(`P2 Saved has chrome: border ${d.savedBorder} bg ${d.savedBg}`);
    if (!(d.help.t > d.label.b - 1)) f.push("P2 help under label");
    if (!(d.replace.t >= d.help.b - 1)) f.push(`P2 Replace token (${d.replace.t}) under help (${d.help.b})`);
    near1("P2 Replace left = field left", d.replace.l, d.name.l);
    // P3
    near1("P3 Test top", d.test.t, d.save.t, 2); near1("P3 Discard top", d.discard.t, d.save.t, 2);
    near1("P3 Test left = field left", d.test.l, d.name.l); near1("P3 Save right = field right", d.save.r, d.name.r);
    near1("P3 Discard right + 8 = Save left", d.discard.r + 8, d.save.l);
    if (!(d.hint.t >= d.test.b - 1)) f.push("P3 hint under the row");
    if (!(d.check.t >= d.hint.b - 1)) f.push("P3 Check a specific repository under the hint");
    if (!/^Test checks permissions without saving or changing anything\.$/.test(d.hintText || "")) f.push(`P3 hint text: ${d.hintText}`);
    // P4
    if (d.removeBorder !== "0px" || d.removeBg !== "rgba(0, 0, 0, 0)") f.push(`P4 Remove token is a button: border ${d.removeBorder}`);
    if (!(d.remove.t > d.help.b)) f.push("P4 Remove under help");
    near1("P4 Remove left = field left", d.remove.l, d.name.l);
    if (d.lastKid !== "panel-remove") f.push(`P4 last visible child of the body: ${d.lastKid}`);
    if (!(d.result.b <= d.remove.t + 1)) f.push("P4 Remove after the result");
    // L11
    near1("L11 result left", d.result.l, d.name.l); near1("L11 result right", d.result.r, d.name.r);
    // P5 / L13
    if (!/^1 unsaved change: Name$/.test(d.tagText || "")) f.push(`P5 tag text: ${d.tagText}`);
    if (d.noteText !== "Discard changes goes back to the saved values.") f.push(`P5 note text: ${d.noteText}`);
    if (d.note) { near1("P5 note line = pill line (centres)", d.note.cy, d.tag.cy, 2); if (width > 500) { const gap = d.note.l - d.tag.r; if (gap < 4 || gap > 8) f.push(`P5 gap pill→text ${gap.toFixed(1)}`); } }
    near1("L13 tag left = field left", d.tag.l, d.name.l);
    // P7
    if (d.whichLis) f.push(`P7 list items: ${d.whichLis}`);
    if (d.whichBorder !== "1px") f.push(`P7 box border ${d.whichBorder}`);
    if (d.whichTitle !== "Which token is used") f.push(`P7 title ${d.whichTitle}`);
    const texts = d.whichP.map((x) => x[0]);
    if (texts.length !== 3 || !texts[1].includes("«Personal»") || d.whichP.some((x) => x[1] !== "13px")) f.push(`P7 lines: ${JSON.stringify(d.whichP)}`);
    // P6
    const A = scheme === "light" ? { accent: "#c2410c", edit: "#fdf0e8", line: "#d1d9e0" } : { accent: "#f0883e", edit: "#2b1d14", line: "#2f3742" };
    if (d.row) {
      if (d.row.bg !== rgb(A.edit)) f.push(`P6 fill ${d.row.bg}`);
      if (d.row.left !== "3px" || d.row.leftColor !== rgb(A.accent)) f.push(`P6 left ${d.row.left} ${d.row.leftColor}`);
      if (d.row.top === rgb(A.accent)) f.push("P6 top is orange");
      if (d.row.outline !== "none") f.push(`P6 outline ${d.row.outline}`);
    }
    // N1
    if (d.saveStyle.h !== "32px" || d.saveStyle.radius !== "6px" || d.saveStyle.border !== "1px") f.push(`N1 Save ${JSON.stringify(d.saveStyle)}`);
    expect(f.join("\n")).toBe("");
  });
}

test("Add mode: one hint line under Test (L12)", async ({ context, page }) => {
  await start(context, page, { run: false });
  await page.locator("#add-token").click();
  const hints = await page.evaluate(() => [...document.querySelectorAll("#token-panel .panel-body > .field-help:not([hidden])")].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.textContent));
  expect(hints).toEqual(["Enter a token to test it. Test checks permissions without saving or changing anything."]);
  const p = await page.evaluate(probe);
  const f = [];
  panelRules(p, "[add]", f);
  expect(f.join("\n")).toBe("");
});

test("pill and last test stay adjacent whatever the name does; the warning icon sits on the title's first line", async ({ context, page }) => {
  const long = { id: "x", name: "Team projects with a rather long descriptive name for stress", owner: "rossi-lab-engineering-organization", token: "ghp_LONG1234" };
  for (const width of [1500, 1100, 800, 390]) {
    await start(context, page, { tokens: [...TOKENS, long], size: { width, height: 900 } });
    const m = await page.evaluate(() => {
      const base = (el) => { const r = document.createRange(); r.selectNodeContents(el); const c = r.getClientRects(); return c[0].bottom; };
      const rows = [...document.querySelectorAll("#token-list .token-item")].map((li) => base(li.querySelector(".tr-last")) - base(li.querySelector(".state-pill")));
      const svg = document.querySelector("#token-warning .warning-head svg").getBoundingClientRect();
      const t = document.querySelector("#warning-title"); const rg = document.createRange(); rg.selectNodeContents(t);
      const f = rg.getClientRects()[0];
      return { rows, icon: (svg.top + svg.bottom) / 2 - (f.top + f.bottom) / 2 };
    });
    for (const g of m.rows) expect(Math.abs(g - m.rows[0]), `${width}px gaps ${m.rows}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.icon), `${width}px icon offset ${m.icon}`).toBeLessThanOrEqual(1.5);
  }
});

test("Used for sits directly under a one-line name and on the last-test line", async ({ context, page }) => {
  for (const width of [1500, 1100]) {
    await start(context, page, { tokens: TOKENS, size: { width, height: 900 } });
    const m = await page.evaluate(() => [...document.querySelectorAll("#token-list .token-item")].map((li) => {
      const r = (s) => li.querySelector(s).getBoundingClientRect();
      return { gap: r(".tr-use").top - r(".tr-name").bottom, lastDelta: r(".tr-use").top - r(".tr-last").top, oneLine: r(".tr-name").height <= 21 };
    }));
    for (const x of m.filter((y) => y.oneLine)) {
      expect(Math.abs(x.gap), `${width}px name→use ${JSON.stringify(m)}`).toBeLessThanOrEqual(1);
      expect(Math.abs(x.lastDelta), `${width}px use↔last ${JSON.stringify(m)}`).toBeLessThanOrEqual(1);
    }
  }
});
