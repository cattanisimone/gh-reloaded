// E2E: the Triage settings panel on the notifications inbox (#105). A fixture
// of the inbox whose filter header mirrors the measured live one (flex row, no
// gap, wrappers spacing themselves from 1012px). Registry state is set through
// the extension's isolated world with dummy modules, because Triage itself
// ships later. Covers: anchor and native look of the button, the panel
// (keyboard, Esc, outside click, width, viewport), switches, layouts, Show
// native inbox, Restore defaults, the idle engine, reasons, SPA navigation.
import { test, expect, routeGithub, seedStorage, backgroundWorker } from "./support/extension.js";
import { isolatedWorld } from "./support/isolated-world.js";

const INBOX = "https://github.com/notifications";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "ghp_secret123", owner: "" }], defaultTokenId: "t" };
const LAYOUTS = ["integrated", "quickbar", "grouped"];

async function boot(context, page, { storage = {}, modules = "none", api, viewport, url = INBOX } = {}) {
  const requests = [];
  await context.route("https://api.github.com/**", (route) => {
    const u = new URL(route.request().url());
    requests.push(u.pathname);
    if (api) return api(route, u);
    return route.fulfill({ status: 200, contentType: "application/json", body: u.pathname === "/graphql" ? JSON.stringify({ data: { viewer: { login: "mira" }, repository: null } }) : "[]" });
  });
  if (viewport) await page.setViewportSize(viewport);
  await seedStorage(context, storage);
  await routeGithub(context, "notifications.html");
  await page.goto(url);
  const world = await isolatedWorld(context, page);
  await world.ready();
  if (modules === "all") {
    await world.evaluate(`(() => { globalThis.__log = []; const r = GHNotifications.registry;
      r.register({ id: "triage", defaultOn: true, layouts: ${JSON.stringify(LAYOUTS)}, start() { __log.push("+triage"); }, stop() { __log.push("-triage"); } });
      r.register({ id: "reasonTags", defaultOn: true, start() { __log.push("+reasonTags"); }, stop() { __log.push("-reasonTags"); } });
      r.register({ id: "reasonWhy", defaultOn: true, start() { __log.push("+reasonWhy"); }, stop() { __log.push("-reasonWhy"); } });
      return true; })()`);
  }
  return { world, requests };
}

const stored = async (context, keys) => (await backgroundWorker(context)).evaluate((k) => chrome.storage.local.get(k), keys);
const button = (page) => page.locator(".ghnt-triage-btn");
const panel = (page) => page.locator("#ghnt-panel");
const open = async (page) => {
  await button(page).click();
  await expect(panel(page)).toBeVisible();
};
const sw = (page, name) => panel(page).getByRole("switch", { name });

const metrics = (loc) =>
  loc.evaluate((e) => {
    const c = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: r.height, radius: c.borderTopLeftRadius, border: c.borderTopWidth + " " + c.borderTopColor, padding: c.paddingLeft + " " + c.paddingRight, font: c.fontSize + " " + c.fontWeight + " " + c.lineHeight, bg: c.backgroundColor };
  });

test("the button is the next sibling of the Group by wrapper, before the alerts node, in the flex row", async ({ context, page }) => {
  await boot(context, page);
  await expect(button(page)).toHaveCount(1);
  const where = await page.evaluate(() => {
    const wrap = document.querySelector(".ghnt-triage");
    const group = document.getElementById("group-wrap");
    return { next: wrap.previousElementSibling === group, before: wrap.nextElementSibling?.localName, parentIsRow: wrap.parentElement === document.getElementById("filters"), label: wrap.textContent.trim() };
  });
  expect(where).toEqual({ next: true, before: "notification-recent-alerts", parentIsRow: true, label: "Triage" });
});

test("Group by wins over Sort by; Sort by is the designed fallback only while Group by is absent", async ({ context, page }) => {
  await boot(context, page);
  await expect(button(page)).toHaveCount(1);
  const after = () => page.evaluate(() => document.querySelector(".ghnt-triage")?.previousElementSibling?.id ?? null);
  expect(await after()).toBe("group-wrap");
  await page.evaluate(() => {
    window.__g = document.getElementById("group-wrap");
    window.__g.remove();
  });
  await expect.poll(after).toBe("sort-wrap");
  await expect(button(page)).toHaveCount(1);
  await page.evaluate(() => document.getElementById("sort-wrap").after(window.__g));
  await expect.poll(after).toBe("group-wrap");
  await expect(button(page)).toHaveCount(1);
});

test("neither Group by nor Sort by: no button anywhere, it appears when one is added", async ({ context, page }) => {
  await boot(context, page);
  await expect(button(page)).toHaveCount(1);
  await page.evaluate(() => {
    window.__g = document.getElementById("group-wrap");
    window.__s = document.getElementById("sort-wrap");
    window.__g.remove();
    window.__s.remove();
    document.querySelector(".ghnt-triage")?.remove();
  });
  await page.waitForTimeout(800);
  await expect(button(page)).toHaveCount(0);
  await page.evaluate(() => document.getElementById("filters").prepend(window.__s));
  await expect(button(page)).toHaveCount(1);
});

test("opens with aria-expanded, Enter and Space toggle, Esc returns focus, outside click closes", async ({ context, page }) => {
  await boot(context, page);
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await button(page).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(button(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(panel(page)).toHaveCount(0);
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("form .ghnt-panel")).toHaveCount(0);
});

test("open: fill, border and label use the Primer accent variables; closed: back to Group by's colours", async ({ context, page }) => {
  await boot(context, page);
  const group = page.locator("#group-wrap .Button");
  const closed = await metrics(button(page));
  expect({ ...closed, w: 0 }).toEqual({ ...(await metrics(group)), w: 0 });
  await open(page);
  await page.mouse.move(0, 0);
  await expect.poll(() => button(page).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.backgroundColor = "var(--bgColor-accent-muted)";
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }));
  const accent = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.cssText = "background-color:var(--bgColor-accent-muted);border:1px solid var(--borderColor-accent-emphasis);color:var(--fgColor-accent)";
    document.body.append(probe);
    const c = getComputedStyle(probe);
    const out = { bg: c.backgroundColor, border: c.borderTopColor, color: c.color };
    probe.remove();
    const b = getComputedStyle(document.querySelector(".ghnt-triage-btn"));
    return { want: out, got: { bg: b.backgroundColor, border: b.borderTopColor, color: b.color } };
  });
  expect(accent.got).toEqual(accent.want);
  const opened = await metrics(button(page));
  expect({ ...opened, bg: 0, border: opened.border.split(" ")[0] }).toEqual({ ...closed, bg: 0, border: closed.border.split(" ")[0] });
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await expect.poll(() => metrics(button(page))).toEqual(closed);
});

for (const width of [1500, 1100, 1020, 1011, 800, 360]) {
  test(`native look at ${width}px: size, radius, border, padding and font equal Group by's, no layout damage`, async ({ context, page }) => {
    await boot(context, page, { viewport: { width, height: 1400 } });
    await expect(button(page)).toBeVisible();
    const group = page.locator("#group-wrap .Button");
    const mine = await metrics(button(page));
    const theirs = await metrics(group);
    expect({ ...mine, w: 0 }).toEqual({ ...theirs, w: 0 });
    // The label sits where Group by's does: the content grows (flex 1 0 auto), it is not left-packed.
    const content = (loc) => loc.evaluate((b) => { const c = b.querySelector(".Button-content"); const r = c.getBoundingClientRect(), br = b.getBoundingClientRect(); return { grow: getComputedStyle(c).flexGrow, left: Math.round(r.left - br.left), fill: Math.abs(r.width - (br.width - 2 - 12 - (b.querySelector(".Button-trailingVisual")?.getBoundingClientRect().width || 0))) < 40 }; });
    const myContent = await content(button(page));
    const theirContent = await content(group);
    expect(myContent.grow).toBe(theirContent.grow);
    expect(myContent.fill, JSON.stringify([myContent, theirContent])).toBe(theirContent.fill);
    const geo = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const wrap = document.querySelector(".ghnt-triage");
      const ids = ["sort-wrap", "group-wrap"];
      const sizes = (hidden) => {
        wrap.style.display = hidden ? "none" : "";
        return ids.map((id) => [Math.round(r(document.getElementById(id)).width), r(document.getElementById(id)).height]);
      };
      const withBtn = sizes(false);
      const q = Math.round(r(document.querySelector(".f-query input")).width);
      const gw = r(document.querySelector("#group-wrap")), tw = r(wrap);
      const scroll = document.documentElement.scrollWidth;
      const without = sizes(true);
      wrap.style.display = "";
      return { withBtn, without, q, scroll, vw: document.documentElement.clientWidth, ml: getComputedStyle(wrap).marginLeft, left: Math.round(tw.left - gw.right), sameLeft: Math.round(tw.left - gw.left), tw: Math.round(tw.width), gw: Math.round(gw.width), gap: Math.round(tw.top - gw.bottom) };
    });
    expect(geo.withBtn).toEqual(geo.without);
    expect(geo.scroll, JSON.stringify(geo)).toBeLessThanOrEqual(geo.vw);
    if (width >= 1012) {
      expect(geo.left, JSON.stringify(geo)).toBe(8);
      expect(geo.ml).toBe("8px");
      expect(geo.q, JSON.stringify(geo)).toBeGreaterThanOrEqual(200);
    } else {
      expect(geo.tw, JSON.stringify(geo)).toBe(geo.gw);
      expect(geo.sameLeft).toBe(0);
      expect(geo.gap).toBe(8);
      expect(mine.w).toBe(theirs.w);
    }
  });
}

test("hover darkens the button and keyboard focus draws a 2px ring", async ({ context, page }) => {
  await boot(context, page);
  const rest = (await metrics(button(page))).bg;
  await button(page).hover();
  await expect.poll(async () => (await metrics(button(page))).bg).not.toBe(rest);
  await page.mouse.move(0, 0);
  await page.locator("#group-wrap .Button").focus();
  await page.keyboard.press("Tab");
  await expect(button(page)).toBeFocused();
  expect(await button(page).evaluate((e) => getComputedStyle(e).outlineWidth)).toBe("2px");
});

test("panel width: 380px from 1012px, min(380, 100vw - 32) below, always inside the viewport", async ({ context, page }) => {
  for (const [width, want] of [[1280, 380], [1012, 380], [800, 380], [420, 380], [360, 328]]) {
    if (width === 1280) await boot(context, page, { viewport: { width, height: 1400 } });
    await page.setViewportSize({ width, height: 1400 });
    await open(page);
    const box = await panel(page).boundingBox();
    expect(Math.round(box.width), `width at ${width}`).toBe(want);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(1400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
  }
});

test("empty registry: button shown, native inbox works, modules and layout disabled with a reason, no layout radio", async ({ context, page }) => {
  await boot(context, page);
  await open(page);
  for (const name of ["Triage", "Tags", /Why is this here/]) {
    await expect(sw(page, name)).toBeDisabled();
  }
  await expect(panel(page)).toContainText("Not available in this version");
  await expect(panel(page)).toContainText("Layouts can be chosen once the Triage view is available");
  await expect(panel(page).getByRole("radio")).toHaveCount(0);
  await sw(page, "Show native inbox").click();
  await expect(sw(page, "Show native inbox")).toHaveAttribute("aria-checked", "true");
  expect(await stored(context, null)).toMatchObject({ ghntNativeInbox: true });
  expect(Object.keys(await stored(context, ["ghntModules", "ghntLayout"]))).toEqual([]);
});

test("native inbox on: engine stopped, button still present and opens, switches kept and shown paused", async ({ context, page }) => {
  const { world } = await boot(context, page, { modules: "all", storage: { ghntNativeInbox: true, ghntModules: { reasonTags: false } } });
  await expect(button(page)).toHaveCount(1);
  expect(await world.evaluate("GHNotifications.engine.isActive()")).toBe(false);
  expect(await world.evaluate("__log.join()")).toBe("");
  await open(page);
  await expect(panel(page)).toContainText("GitHub's original inbox is shown");
  await expect(sw(page, "Tags")).toHaveAttribute("aria-checked", "false");
  await expect(sw(page, "Triage")).toHaveAttribute("aria-checked", "true");
  await sw(page, "Show native inbox").click();
  await expect.poll(() => world.evaluate("__log.join()")).toBe("+triage,+reasonWhy");
});

test("engine idle: no coverage, permission or token note and no api.github.com request when opening", async ({ context, page }) => {
  const { requests } = await boot(context, page, { storage: TOKENS });
  await open(page);
  await expect(panel(page)).not.toContainText(/Coverage|permission|scope|token/i);
  expect(await panel(page).innerText()).not.toContain("ghp_secret123");
  await sw(page, "Show native inbox").click();
  await page.getByRole("button", { name: "Restore defaults" }).click();
  expect(requests).toEqual([]);
});

test("first run: nothing stored, every module on, Integrated navigation selected, nothing written", async ({ context, page }) => {
  const { world } = await boot(context, page, { modules: "all" });
  await expect.poll(() => world.evaluate("__log.join()")).toBe("+triage,+reasonTags,+reasonWhy");
  await open(page);
  for (const name of ["Triage", "Tags", /Why is this here/]) await expect(sw(page, name)).toHaveAttribute("aria-checked", "true");
  await expect(panel(page).getByRole("radio", { name: "Integrated navigation" })).toBeChecked();
  expect(await stored(context, null)).toEqual({});
});

test("a switch writes only its own id, triage off keeps the layout and stops only triage", async ({ context, page }) => {
  const { world } = await boot(context, page, { modules: "all", storage: { ghntModules: { other: true }, ghntLayout: "grouped" } });
  await open(page);
  await sw(page, "Triage").click();
  await expect(sw(page, "Triage")).toHaveAttribute("aria-checked", "false");
  expect(await stored(context, null)).toEqual({ ghntModules: { other: true, triage: false }, ghntLayout: "grouped" });
  await expect.poll(() => world.evaluate("__log.join()")).toBe("+triage,+reasonTags,+reasonWhy,-triage");
  expect(await world.evaluate("GHNotifications.registry.layout()")).toBe("grouped");
  await sw(page, "Tags").click();
  expect((await stored(context, "ghntModules")).ghntModules).toEqual({ other: true, triage: false, reasonTags: false });
  await expect(panel(page)).toContainText("Opens from a reason tag: turn Tags on to use it");
});

test("layouts: a radiogroup of three, one checked, arrow keys move it, it survives a reload", async ({ context, page }) => {
  await boot(context, page, { modules: "all" });
  await open(page);
  await expect(panel(page).getByRole("radiogroup")).toHaveCount(1);
  await expect(panel(page).getByRole("radio")).toHaveCount(3);
  await panel(page).getByRole("radio", { name: "Integrated navigation" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel(page).getByRole("radio", { name: "Quick bar" })).toBeChecked();
  await expect.poll(async () => await stored(context, null)).toEqual({ ghntLayout: "quickbar" });
  expect(await panel(page).locator("input:checked").count()).toBe(1);
  await panel(page).getByText("Grouped sections").click();
  await expect.poll(async () => (await stored(context, "ghntLayout")).ghntLayout).toBe("grouped");
  await page.reload();
  const world = await isolatedWorld(context, page);
  await world.ready();
  await world.evaluate(`GHNotifications.registry.register({ id: "triage", defaultOn: true, layouts: ${JSON.stringify(LAYOUTS)} })`);
  await open(page);
  await expect(panel(page).getByRole("radio", { name: "Grouped sections" })).toBeChecked();
});

test("unregistered triage: its switch is disabled and no layout radio exists, while Tags can be registered alone", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await world.evaluate(`GHNotifications.registry.register({ id: "reasonTags", defaultOn: true })`);
  await open(page);
  await expect(sw(page, "Triage")).toBeDisabled();
  await expect(sw(page, "Tags")).toBeEnabled();
  await expect(panel(page).getByRole("radio")).toHaveCount(0);
});

test("native inbox on stops everything and changes only its own key; Restore defaults removes exactly the panel keys", async ({ context, page }) => {
  const { world, requests } = await boot(context, page, { modules: "all", storage: { ghntMentionWindowDays: 3 } });
  await open(page);
  await sw(page, "Show native inbox").click();
  await expect.poll(() => world.evaluate("__log.join()")).toBe("+triage,+reasonTags,+reasonWhy,-triage,-reasonTags,-reasonWhy");
  expect(await stored(context, null)).toEqual({ ghntMentionWindowDays: 3, ghntNativeInbox: true });
  await sw(page, "Triage").click();
  await panel(page).getByText("Quick bar").click();
  await expect.poll(async () => Object.keys(await stored(context, null)).sort()).toEqual(["ghntLayout", "ghntMentionWindowDays", "ghntModules", "ghntNativeInbox"]);
  await page.getByRole("button", { name: "Restore defaults" }).click();
  await expect.poll(async () => await stored(context, null)).toEqual({ ghntMentionWindowDays: 3 });
  await expect(sw(page, "Triage")).toHaveAttribute("aria-checked", "true");
  expect(requests).toEqual([]);
});

test("a missing-scope capability shows its reason and a Settings link that opens the tokens section", async ({ context, page }) => {
  const { world } = await boot(context, page, {
    modules: "all",
    storage: TOKENS,
    api: (route, u) => (u.pathname === "/notifications"
      ? route.fulfill({ status: 403, contentType: "application/json", headers: { "x-oauth-scopes": "read:user", "x-accepted-oauth-scopes": "notifications, repo" }, body: JSON.stringify({ message: "x" }) })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { viewer: { login: "mira" }, repository: null } }) })),
  });
  await expect.poll(() => world.evaluate("GHNotifications.engine.getState().capabilities['api:notifications']")).toBe("missing-scope");
  await open(page);
  await expect(panel(page)).toContainText("needs the notifications scope");
  expect(await panel(page).innerText()).not.toContain("ghp_secret123");
  const [tab] = await Promise.all([context.waitForEvent("page"), panel(page).getByRole("button", { name: /GitHub tokens/ }).click()]);
  expect(tab.url()).toMatch(/options\/options\.html#tokens-section$/);
});

test("soft navigation inbox -> subscriptions -> inbox and back/forward: one button, preferences kept", async ({ context, page }) => {
  await boot(context, page, { storage: { ghntLayout: "quickbar" } });
  await open(page);
  const go = (path) => page.evaluate((p) => { history.pushState({}, "", p); document.dispatchEvent(new Event("turbo:load")); }, path);
  await go("/notifications/subscriptions");
  await expect(button(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await go("/notifications?query=is%3Aunread");
  await expect(button(page)).toHaveCount(1);
  await page.goBack();
  await page.goBack();
  await expect(button(page)).toHaveCount(1);
  await page.goForward();
  await expect(button(page)).toHaveCount(0);
  await page.goForward();
  await expect(button(page)).toHaveCount(1);
  expect((await stored(context, "ghntLayout")).ghntLayout).toBe("quickbar");
});

for (const scheme of ["light", "dark"]) {
  test(`${scheme}: panel text contrast, card sizes and thumbnails at 360, 600 and 1280px`, async ({ context, page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(context, page, { modules: "all", viewport: { width: 1280, height: 1400 } });
    for (const width of [1280, 600, 360]) {
      await page.setViewportSize({ width, height: 1400 });
      await open(page);
      const res = await page.evaluate(() => {
        const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const p = document.getElementById("ghnt-panel");
        p.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
        const bg = getComputedStyle(p).backgroundColor;
        const overflow = [...p.querySelectorAll(".ghnt-card")].flatMap((c) => { const cr = c.getBoundingClientRect(); return [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > cr.right + 0.5).map((e) => e.className + ":" + Math.round(e.getBoundingClientRect().right - cr.right)); });
        const text = [...p.querySelectorAll(".ghnt-hint, .ghnt-row-title, .ghnt-card-title")].map((e) => ratio(getComputedStyle(e).color, bg));
        const cards = [...p.querySelectorAll(".ghnt-card")].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        const thumbs = [...p.querySelectorAll(".ghnt-thumb")].map((t) => { const r = t.getBoundingClientRect(); return r.width / r.height; });
        const sel = getComputedStyle(p.querySelector(".ghnt-card.is-selected")).borderTopColor;
        const marks = [...p.querySelectorAll(".ghnt-thumb")].map((t) => t.querySelectorAll("i").length);
        const defaultMarker = p.querySelector(".ghnt-default")?.textContent;
        const cardLines = [...p.querySelectorAll(".ghnt-card .ghnt-hint, .ghnt-card-title")].map((c) => Math.round(c.getBoundingClientRect().height / 18));
        return { overflow, panelScroll: p.scrollWidth - p.clientWidth, marks, defaultMarker, cardLines, min: Math.min(...text), cards, thumbs, selected: ratio(sel, bg), scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
      });
      expect(res.min, `${scheme} ${width}`).toBeGreaterThanOrEqual(4.5);
      expect(res.selected, `${scheme} ${width} selected border`).toBeGreaterThanOrEqual(3);
      expect(res.scroll).toBe(true);
      expect(res.overflow, `${scheme} ${width} card overflow`).toEqual([]);
      expect(res.panelScroll, `${scheme} ${width} panel scroll`).toBeLessThanOrEqual(0);
      expect(new Set(res.cards.map((c) => c.join("x"))).size, JSON.stringify(res.cards)).toBe(1);
      for (const t of res.thumbs) expect(Math.abs(t - 16 / 9)).toBeLessThan(0.05);
      expect(res.marks, `${scheme} ${width} thumbnails`).toEqual([6, 7, 3].concat([6, 7, 3]).slice(0, 3));
      expect(res.defaultMarker).toBe("\u2713 Default");
      expect(res.cardLines.every((n) => n <= 3), JSON.stringify(res.cardLines)).toBe(true);
      await page.keyboard.press("Escape");
    }
  });
}

test("three layout cards share one row on desktop", async ({ context, page }) => {
  await boot(context, page, { modules: "all", viewport: { width: 1280, height: 1400 } });
  await open(page);
  const ys = await panel(page).locator(".ghnt-card").evaluateAll((c) => c.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(ys).size, JSON.stringify(ys)).toBe(1);
});

test("a Turbo snapshot restore leaves one working button", async ({ context, page }) => {
  await boot(context, page);
  await expect(button(page)).toHaveCount(1);
  await page.evaluate(() => {
    window.__snap = document.getElementById("main").cloneNode(true);
    history.pushState({}, "", "/notifications/subscriptions");
    document.dispatchEvent(new Event("turbo:load"));
  });
  await expect(button(page)).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState({}, "", "/notifications");
    document.getElementById("main").replaceWith(window.__snap);
    document.dispatchEvent(new Event("turbo:load"));
  });
  await expect(button(page)).toHaveCount(1);
  await open(page);
});

test("a registered module without defaultOn is shown off, like the registry runs it", async ({ context, page }) => {
  const { world } = await boot(context, page);
  await world.evaluate(`GHNotifications.registry.register({ id: "reasonTags" })`);
  await open(page);
  await expect(sw(page, "Tags")).toHaveAttribute("aria-checked", "false");
});

test("engine running with no token: a note and the Settings link, not a clean look", async ({ context, page }) => {
  const { world } = await boot(context, page, { modules: "all" });
  await expect.poll(() => world.evaluate("GHNotifications.engine.getState().phase")).toBe("ready");
  await open(page);
  await expect(panel(page)).toContainText("No GitHub token is configured");
  await expect(panel(page).getByRole("button", { name: /GitHub tokens/ })).toBeVisible();
});
