// E2E: the Quick jump row of Settings (Features), its Shortcut selector and the
// no-token, off and unassigned states. The page reads the platform and Chrome's
// shortcut assignment from the browser; both are stubbed per test.
import { test, expect, seedStorage } from "./support/extension.js";
import { openOptions } from "./support/options.js";
import { CLASSIC } from "./support/tokens.js";

const TOKENS = { githubTokens: [{ id: "d", name: "Work", owner: "", token: CLASSIC }], defaultTokenId: "d" };
const ROW = "#quick-jump";
const FULL_CMDK = { win: "Ctrl+K — replaces GitHub's command palette", mac: "⌘K — replaces GitHub's command palette" };
const ADDRESS = "chrome://extensions/shortcuts";

// The Settings tokens of each scheme (options.css :root).
const TOKENS_BY_SCHEME = {
  light: { text: "rgb(31, 35, 40)", muted: "rgb(89, 99, 110)", link: "rgb(9, 105, 218)", line: "rgb(209, 217, 224)", focus: "rgb(9, 105, 218)", bg: "rgb(246, 248, 250)" },
  dark: { text: "rgb(230, 237, 243)", muted: "rgb(145, 152, 161)", link: "rgb(88, 166, 255)", line: "rgb(47, 55, 66)", focus: "rgb(88, 166, 255)", bg: "rgb(13, 17, 23)" },
};

// Opens Settings with the platform and the command's shortcut stubbed. The stub
// reads window.__qjShortcut each time, so a test can change it and fire "focus"
// (what returning from Chrome's shortcut page does).
async function start(context, page, { tokens = true, stored = {}, mac = false, shortcut = "Alt+Shift+K", hash = "", size, scheme, onByDefault = true } = {}) {
  await seedStorage(context, { ...(tokens ? TOKENS : { githubTokens: [] }), ...(onByDefault ? { ghqjEnabled: true } : {}), ...stored });
  await page.addInitScript(([isMac, sc]) => {
    Object.defineProperty(navigator, "platform", { get: () => (isMac ? "MacIntel" : "Linux x86_64"), configurable: true });
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined, configurable: true });
    window.__qjShortcut = sc;
    const getAll = (cb) => {
      const all = [{ name: "_execute_action", shortcut: "", description: "" }, { name: "open-quick-jump", shortcut: window.__qjShortcut, description: "Open Quick jump" }];
      if (typeof cb === "function") return void cb(all);
      return Promise.resolve(all);
    };
    try { chrome.commands.getAll = getAll; } catch { /* replaced below */ }
    if (chrome.commands.getAll !== getAll) Object.defineProperty(chrome.commands, "getAll", { value: getAll, configurable: true });
  }, [mac, shortcut]);
  if (size) await page.setViewportSize(size);
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  const worker = await openOptions(context, page, hash);
  await expect(page.locator(`${ROW} .row-title`)).toHaveText("Quick jump Experimental");
  return worker;
}

const sw = (page) => page.locator("#feature-ghqj");
const select = (page) => page.locator("#qj-shortcut");
const change = (page) => page.getByRole("link", { name: "Change shortcut" });
const clear = (page) => page.locator(ROW).getByText("Clear recent items");
const line = (page) => page.locator("#qj-line");
const stored = (worker, keys) => worker.evaluate((k) => chrome.storage.local.get(k), keys);

test("the row is marked Experimental and is off by default: nothing stored, no select, no links; the accessible names stay Quick jump", async ({ context, page }) => {
  const worker = await start(context, page, { onByDefault: false });
  await expect(page.locator(`${ROW} .row-title .badge`)).toHaveText("Experimental");
  await expect(page.locator(ROW)).toHaveAccessibleName("Quick jump");
  await expect(sw(page)).toHaveAccessibleName("Quick jump");
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await expect(sw(page)).not.toHaveAttribute("aria-disabled", "true");
  expect(await stored(worker, "ghqjEnabled")).toEqual({});
  await expect(select(page)).toBeHidden();
  await expect(change(page)).toHaveCount(0);
  await expect(clear(page)).toHaveCount(0);
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => stored(worker, "ghqjEnabled")).toEqual({ ghqjEnabled: true });
  await expect(select(page)).toBeVisible();
});

test("with a token and the switch on, the row is described, with the Shortcut select and both links", async ({ context, page }) => {
  await start(context, page);
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
  await expect(sw(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#qj-desc")).toHaveText("Remembers the issues, pull requests and repositories you open on GitHub, in this browser only. Clear recent items");
  await expect(page.getByLabel("Shortcut", { exact: true })).toBeVisible();
  await expect(change(page)).toBeVisible();
  await expect(clear(page)).toBeVisible();
  // The description ends with the link (A10), "Change shortcut" sits beside the select.
  expect(await page.evaluate(() => document.querySelector("#qj-desc").lastElementChild.textContent)).toBe("Clear recent items");
  // Same rhythm as the sibling rows: the description follows the title directly, the switch is centred on both.
  const geo = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const t = r("#quick-jump .row-title"), d = r("#qj-desc"), s = r("#feature-ghqj");
    const sib = document.querySelector("#feature-ghrc").closest(".row");
    const st = sib.querySelector(".row-title").getBoundingClientRect(), sd = sib.querySelector(".row-desc").getBoundingClientRect(), ss = sib.querySelector(".switch").getBoundingClientRect();
    return { gap: d.top - t.bottom, sibGap: sd.top - st.bottom, off: (s.top + s.height / 2) - (t.top + d.bottom) / 2 , sibOff: (ss.top + ss.height / 2) - (st.top + sd.bottom) / 2 };
  });
  expect(Math.abs(geo.gap - geo.sibGap), JSON.stringify(geo)).toBeLessThanOrEqual(1);
  expect(Math.abs(geo.off), JSON.stringify(geo)).toBeLessThanOrEqual(1);
  await expect(page.locator("#qj-notice")).toBeHidden();
  await expect(page.locator("#qj-fallback")).toBeHidden();
});

test("the row sits in the Features list as one more row with its switch", async ({ context, page }) => {
  await start(context, page);
  await expect(page.locator(`#features .card.list > ${ROW}`)).toHaveCount(1);
  await expect(page.locator("#features").getByRole("switch")).toHaveCount(18);
  await expect(page.locator("#features").getByRole("switch", { name: "Quick jump" })).toHaveCount(1);
});

test("switching off hides the select and the links and stores false; the choice is kept; switching on shows them again", async ({ context, page }) => {
  const worker = await start(context, page, { stored: { ghqjShortcut: "cmdk" } });
  await expect(select(page)).toHaveValue("cmdk");
  await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => stored(worker, ["ghqjEnabled", "ghqjShortcut"])).toEqual({ ghqjEnabled: false, ghqjShortcut: "cmdk" });
  await expect(select(page)).toBeHidden();
  await expect(change(page)).toHaveCount(0);
  await expect(clear(page)).toHaveCount(0);
  await expect(page.locator("#qj-line")).toBeHidden();
  await expect(page.locator("#qj-desc")).toHaveText("Remembers the issues, pull requests and repositories you open on GitHub, in this browser only.");
  await sw(page).click();
  await expect(select(page)).toHaveValue("cmdk");
  await expect(change(page)).toBeVisible();
  await expect.poll(() => stored(worker, "ghqjEnabled")).toEqual({ ghqjEnabled: true });
  // A saved off state shows off after a reload, with no select.
  await sw(page).click();
  await page.reload();
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await expect(select(page)).toBeHidden();
});

test("switching Quick jump does not touch other stored settings or the tokens (Settings never deletes ghqjRecent here; the background does)", async ({ context, page }) => {
  const worker = await start(context, page, { stored: { ghdgEnabled: false, ghsmStaleDays: 5 } });
  await sw(page).click();
  await expect.poll(() => stored(worker, "ghqjEnabled")).toEqual({ ghqjEnabled: false });
  expect(await stored(worker, ["ghdgEnabled", "ghsmStaleDays", "githubTokens", "defaultTokenId"])).toEqual({ ghdgEnabled: false, ghsmStaleDays: 5, ...TOKENS });
});

test.describe("no token", () => {
  test("the row is off, announced as unavailable with its description, and cannot be switched on", async ({ context, page }) => {
    const worker = await start(context, page, { tokens: false, onByDefault: false });
    await expect(sw(page)).toHaveAttribute("aria-checked", "false");
    await expect(sw(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#qj-desc")).toHaveText("Needs a GitHub token. Add one in GitHub tokens.");
    expect(await sw(page).getAttribute("aria-describedby")).toBe("qj-desc");
    await expect(sw(page)).toHaveAccessibleName("Quick jump");
    await expect(sw(page)).toHaveAccessibleDescription("Needs a GitHub token. Add one in GitHub tokens.");
    await sw(page).click({ force: true });
    await sw(page).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await expect(sw(page)).toHaveAttribute("aria-checked", "false");
    expect(await stored(worker, "ghqjEnabled")).toEqual({});
    await expect(select(page)).toBeHidden();
    await expect(change(page)).toHaveCount(0);
    await expect(clear(page)).toHaveCount(0);
    await expect(page.locator(`${ROW} .qj-addr`)).toBeHidden();
  });

  test("GitHub tokens links to that panel", async ({ context, page }) => {
    await start(context, page, { tokens: false });
    const link = page.locator("#qj-desc").getByRole("link", { name: "GitHub tokens" });
    await expect(link).toHaveAttribute("href", "#tokens-section");
    await link.click();
    await expect(page.locator("#tokens-section")).toBeVisible();
    await expect(page.locator("#features")).toBeHidden();
  });

  test("a stored choice is not changed; saving a token restores it without a reload; removing the last token turns the row off again", async ({ context, page }) => {
    const worker = await start(context, page, { tokens: false, stored: { ghqjEnabled: false, ghqjShortcut: "cmdk" } });
    await expect(sw(page)).toHaveAttribute("aria-checked", "false");
    expect(await stored(worker, ["ghqjEnabled", "ghqjShortcut"])).toEqual({ ghqjEnabled: false, ghqjShortcut: "cmdk" });
    await worker.evaluate((t) => chrome.storage.local.set(t), TOKENS);
    await expect(sw(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(sw(page)).toHaveAttribute("aria-checked", "false"); // the user's last choice
    await sw(page).click();
    await expect(select(page)).toHaveValue("cmdk");
    await worker.evaluate(() => chrome.storage.local.set({ githubTokens: [], defaultTokenId: null }));
    await expect(sw(page)).toHaveAttribute("aria-disabled", "true");
    await expect(sw(page)).toHaveAttribute("aria-checked", "false");
    await expect(select(page)).toBeHidden();
    expect(await stored(worker, "ghqjEnabled")).toEqual({ ghqjEnabled: true });
  });

  test("a token record with an empty secret does not count as a token", async ({ context, page }) => {
    await start(context, page, { tokens: false, stored: { githubTokens: [{ id: "x", name: "Empty", owner: "", token: "" }], defaultTokenId: "x" } });
    await expect(sw(page)).toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("Shortcut selector", () => {
  test("Windows and Linux: two values, full labels, the line follows the value, is announced and stored", async ({ context, page }) => {
    const worker = await start(context, page);
    await expect(select(page).locator("option")).toHaveText(["Alt+Shift+K", FULL_CMDK.win]);
    await expect(select(page).locator("option")).toHaveCount(2);
    expect(await select(page).locator("option").evaluateAll((os) => os.map((o) => o.value))).toEqual(["browser", "cmdk"]);
    await expect(select(page)).toHaveValue("browser");
    await expect(line(page)).toHaveText("Works on every GitHub page, outside text fields. Ctrl+K stays GitHub's.");
    await select(page).selectOption("cmdk");
    await expect(line(page)).toHaveText("Outside text fields, Ctrl+K opens Quick jump instead of GitHub's command palette, which still opens with Ctrl+Alt+K. In comment boxes and editors Ctrl+K stays GitHub's: it inserts a link. Alt+Shift+K keeps working too.");
    await expect.poll(() => stored(worker, "ghqjShortcut")).toEqual({ ghqjShortcut: "cmdk" });
    await page.reload();
    await expect(select(page)).toHaveValue("cmdk");
    await select(page).selectOption("browser");
    await expect(line(page)).toHaveText("Works on every GitHub page, outside text fields. Ctrl+K stays GitHub's.");
    await expect.poll(() => stored(worker, "ghqjShortcut")).toEqual({ ghqjShortcut: "browser" });
  });

  test("Mac: symbols for the shortcut and for the palette", async ({ context, page }) => {
    await start(context, page, { mac: true, shortcut: "MacCtrl+Shift+K" });
    await expect(select(page).locator("option")).toHaveText(["⌃⇧K", FULL_CMDK.mac]);
    await expect(line(page)).toHaveText("Works on every GitHub page, outside text fields. ⌘K stays GitHub's.");
    await select(page).selectOption("cmdk");
    await expect(line(page)).toHaveText("Outside text fields, ⌘K opens Quick jump instead of GitHub's command palette, which still opens with ⌘⌥K. In comment boxes and editors ⌘K stays GitHub's: it inserts a link. ⌃⇧K keeps working too.");
  });

  test("the select is labelled, described by the line, and the line is a polite live region", async ({ context, page }) => {
    await start(context, page);
    await expect(select(page)).toHaveAccessibleName("Shortcut");
    expect(await select(page).getAttribute("aria-describedby")).toBe("qj-line");
    await expect(select(page)).toHaveAccessibleDescription("Works on every GitHub page, outside text fields. Ctrl+K stays GitHub's.");
    await expect(line(page)).toHaveAttribute("role", "status");
    await expect(line(page)).toHaveAttribute("aria-live", "polite");
    // The same element changes its text (a live region announces a change, not a replacement).
    const handle = await line(page).elementHandle();
    await select(page).selectOption("cmdk");
    await expect(line(page)).toContainText("opens Quick jump instead");
    expect(await handle.evaluate((el) => el.isConnected && el === document.querySelector("#qj-line"))).toBe(true);
    await expect(select(page)).toHaveAccessibleDescription(/opens Quick jump instead of GitHub's command palette/);
  });

  test("unassigned: the first value reads Browser shortcut (not set), a notice links to Chrome's page, ⌘K can still be chosen", async ({ context, page }) => {
    const worker = await start(context, page, { shortcut: "" });
    await expect(select(page).locator("option").first()).toHaveText("Browser shortcut (not set)");
    const notice = page.locator("#qj-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(`Chrome left the shortcut unassigned. Set it on ${ADDRESS}.`);
    await expect(notice.getByRole("link")).toHaveAttribute("href", ADDRESS);
    await select(page).selectOption("cmdk");
    await expect(line(page)).not.toContainText("keeps working too");
    await expect.poll(() => stored(worker, "ghqjShortcut")).toEqual({ ghqjShortcut: "cmdk" });
    // Assigning it on Chrome's page and coming back updates the row without a reload.
    await page.evaluate(() => { window.__qjShortcut = "Alt+Shift+K"; window.dispatchEvent(new Event("focus")); });
    await expect(select(page).locator("option").first()).toHaveText("Alt+Shift+K");
    await expect(notice).toBeHidden();
    await expect(line(page)).toContainText("Alt+Shift+K keeps working too.");
  });

  test("Change shortcut opens Chrome's shortcut page", async ({ context, page }) => {
    await start(context, page);
    await page.evaluate(() => { window.__tabs = []; chrome.tabs.create = async (o) => { window.__tabs.push(o); return {}; }; });
    await change(page).click();
    await expect.poll(() => page.evaluate(() => window.__tabs)).toEqual([{ url: ADDRESS }]);
    await expect(page.locator("#qj-fallback")).toBeHidden();
  });

  test("when the page cannot be opened, the address is shown in a copyable notice that breaks after each /", async ({ context, page }) => {
    await start(context, page);
    await page.evaluate(() => { chrome.tabs.create = () => Promise.reject(new Error("blocked")); });
    await change(page).click();
    const notice = page.locator("#qj-fallback");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText(new RegExp(`${ADDRESS.replace(/[/.]/g, "\\$&")}$`));
    const addr = notice.locator(".qj-addr");
    await expect(addr).toHaveText(ADDRESS);
    expect(await addr.innerHTML()).toBe("chrome:/<wbr>/<wbr>extensions/<wbr>shortcuts");
    expect(await addr.evaluate((e) => getComputedStyle(e).userSelect)).toBe("all");
    await expect(notice).toHaveAttribute("role", "status");
    // A throwing call (not a rejection) shows it too.
    await page.evaluate(() => { document.querySelector("#qj-fallback").hidden = true; chrome.tabs.create = () => { throw new Error("nope"); }; });
    await change(page).click();
    await expect(notice).toBeVisible();
  });

  test("Clear recent items deletes ghqjRecent and says so", async ({ context, page }) => {
    const worker = await start(context, page, { stored: { ghqjRecent: [{ key: "a/b#1", url: "https://github.com/a/b/issues/1" }], ghqjShortcut: "cmdk" } });
    expect(await stored(worker, "ghqjRecent")).toMatchObject({ ghqjRecent: [{}] });
    await clear(page).click();
    await expect.poll(() => stored(worker, ["ghqjRecent"])).toEqual({});
    await expect(page.locator("#qj-cleared")).toHaveText("Recent items cleared.");
    await expect(page.locator("#qj-cleared")).toHaveAttribute("role", "status");
    expect(await stored(worker, ["ghqjShortcut", "ghqjEnabled"])).toEqual({ ghqjShortcut: "cmdk", ghqjEnabled: true });
  });
});

test.describe("deep link", () => {
  test("options.html#quick-jump opens Features, scrolls to the row and focuses its title", async ({ context, page }) => {
    await start(context, page, { hash: "#quick-jump", size: { width: 1280, height: 500 } });
    await expect(page.locator("#features")).toBeVisible();
    await expect(page.locator('.nav a[aria-current="page"]')).toHaveText("Features");
    await expect(page.locator(`${ROW} .row-title`)).toBeFocused();
    await expect(page.locator(`${ROW} .row-title`)).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });

  test("from another panel, by hash change, and at phone width the title clears the tab bar", async ({ context, page }) => {
    await start(context, page, { hash: "#advanced-section", size: { width: 375, height: 500 } });
    await expect(page.locator("#features")).toBeHidden();
    await page.evaluate(() => { location.hash = "quick-jump"; });
    await expect(page.locator("#features")).toBeVisible();
    await expect(page.locator(`${ROW} .row-title`)).toBeFocused();
    const m = await page.evaluate(() => ({ t: document.querySelector("#quick-jump .row-title").getBoundingClientRect().top, bar: document.querySelector(".sidebar").getBoundingClientRect().bottom }));
    expect(m.t).toBeGreaterThanOrEqual(m.bar - 0.5);
  });

  test("with no token the deep link still opens the row", async ({ context, page }) => {
    await start(context, page, { tokens: false, hash: "#quick-jump" });
    await expect(page.locator(`${ROW} .row-title`)).toBeFocused();
  });
});

test("a11y: the row is a labelled group; the switch is a named switch; nothing is hidden from the tree that is shown", async ({ context, page }) => {
  await start(context, page);
  await expect(page.getByRole("group", { name: "Quick jump" })).toHaveCount(1);
  await expect(page.getByRole("switch", { name: "Quick jump" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("combobox", { name: "Shortcut" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change shortcut" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear recent items" })).toBeVisible();
  // Keyboard: Tab reaches the switch, the select, the link; Space toggles the switch.
  await sw(page).focus();
  await page.keyboard.press("Space");
  await expect(sw(page)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Space");
  await expect(sw(page)).toHaveAttribute("aria-checked", "true");
});

const WIDTHS = [1500, 1100, 800, 700, 390, 320];
for (const scheme of ["light", "dark"]) {
  test.describe(`width, ${scheme}`, () => {
    for (const width of WIDTHS) {
      test(`${width}px`, async ({ context, page }) => {
        await start(context, page, { size: { width, height: 900 }, scheme });
        const t = TOKENS_BY_SCHEME[scheme];
        const fullFits = width >= 700; // the full ⌘K label (about 363px) fits the 446px of 800 and up, not the 336px of 390
        const widthNote = `${scheme} ${width}`;

        const measure = () => page.evaluate(() => {
          const q = (s) => document.querySelector(s);
          const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
          const sel = q("#qj-shortcut");
          const cs = getComputedStyle(sel);
          const ctx = document.createElement("canvas").getContext("2d");
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const label = sel.options[sel.selectedIndex].textContent;
          const need = ctx.measureText(label).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
          const links = [...document.querySelectorAll("#qj-controls .qj-link:not(.qj-addr), #qj-desc .qj-link")];
          const change = links.find((l) => l.textContent === "Change shortcut");
          const clearL = links.find((l) => l.textContent === "Clear recent items");
          const addr = q("#qj-notice .qj-addr");
          let addrBreaks = null;
          if (addr && addr.getClientRects().length) {
            const w = document.createTreeWalker(addr, NodeFilter.SHOW_TEXT);
            const chars = [];
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              for (let i = 0; i < n.length; i++) {
                const r = document.createRange();
                r.setStart(n, i);
                r.setEnd(n, i + 1);
                const rect = r.getClientRects()[0];
                if (rect) chars.push({ ch: n.data[i], top: rect.top });
              }
            }
            addrBreaks = chars.map((c, i) => (i && Math.abs(c.top - chars[i - 1].top) > 3 ? chars[i - 1].ch : null)).filter(Boolean);
          }
          const row = q("#quick-jump");
          const colour = (el) => getComputedStyle(el).color;
          return {
            hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            rowScroll: row.scrollWidth - row.clientWidth,
            track: box(q("#feature-ghqj .switch-track")),
            sw: box(q("#feature-ghqj")),
            rowBox: box(row),
            select: box(sel),
            selectClient: sel.clientWidth,
            label,
            need,
            selectOverflow: sel.scrollWidth - sel.clientWidth,
            change: change && box(change),
            clear: clearL && box(clearL),
            changeLines: change && change.getClientRects().length,
            clearLines: clearL && clearL.getClientRects().length,
            addrBreaks,
            title: box(q("#quick-jump .row-title")),
            descBox: box(q("#qj-desc")),
            colours: { title: colour(q("#quick-jump .row-title")), desc: colour(q("#qj-desc")), line: colour(q("#qj-line")), link: change && colour(change), select: colour(sel), border: cs.borderTopColor, bg: cs.backgroundColor },
            options: [...sel.options].map((o) => o.textContent),
          };
        });
        const overlap = (a, b) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;

        const check = (m, name) => {
          const note = `${widthNote} ${name}: ${JSON.stringify({ label: m.label, need: m.need, client: m.selectClient, select: m.select, change: m.change, clear: m.clear })}`;
          expect(m.hscroll, `no horizontal scroll, ${note}`).toBeLessThanOrEqual(0);
          expect(m.rowScroll, `row fits, ${note}`).toBeLessThanOrEqual(0);
          expect([m.track.w, m.track.h], `switch stays 36x20, ${note}`).toEqual([36, 20]);
          expect(m.sw.r, `switch inside the row, ${note}`).toBeLessThanOrEqual(m.rowBox.r + 0.5);
          expect(m.need, `closed label fits the select, ${note}`).toBeLessThanOrEqual(m.selectClient + 0.5);
          expect(m.selectOverflow, `label not clipped, ${note}`).toBeLessThanOrEqual(0);
          expect(m.select.r, `select inside the row, ${note}`).toBeLessThanOrEqual(m.rowBox.r + 0.5);
          expect(overlap(m.select, m.change), `select and Change shortcut do not intersect, ${note}`).toBe(false);
          expect(overlap(m.select, m.clear), `select and Clear recent items do not intersect, ${note}`).toBe(false);
          expect(overlap(m.change, m.clear), `links do not intersect, ${note}`).toBe(false);
          expect(m.changeLines, `Change shortcut is one line box, ${note}`).toBe(1);
          expect(m.clearLines, `Clear recent items is one line box, ${note}`).toBe(1);
          expect(m.colours.title, "title colour").toBe(t.text);
          expect(m.colours.desc, "description colour").toBe(t.muted);
          expect(m.colours.line, "describing line colour").toBe(t.muted);
          expect(m.colours.link, "link colour").toBe(t.link);
          expect(m.colours.select, "select text colour").toBe(t.text);
          expect(m.colours.border, "select border").toBe(t.line);
          expect(m.colours.bg, "select fill").toBe(t.bg);
        };

        // 1. browser shortcut assigned.
        let m = await measure();
        check(m, "browser");
        expect(m.options).toEqual(["Alt+Shift+K", fullFits ? FULL_CMDK.win : "Ctrl+K"]);
        // Layout: switch on the right, centred on the title and the description like the sibling rows; at <=720 the title and the switch share the first line.
        const mid = width <= 720 ? m.title.y + m.title.h / 2 : (m.title.y + m.descBox.y + m.descBox.h) / 2;
        expect(Math.abs(m.sw.y + m.sw.h / 2 - mid), `switch centred with the title${width <= 720 ? "" : " and description"}, ${widthNote}`).toBeLessThanOrEqual(3);
        expect(m.sw.r, `switch at the right edge, ${widthNote}`).toBeGreaterThan(m.rowBox.r - 20);
        if (width <= 720) expect(m.select.w, `controls use the row width, ${widthNote}`).toBeLessThanOrEqual(m.rowBox.w);
        else expect(m.select.r, `select stays left of the switch, ${widthNote}`).toBeLessThanOrEqual(m.sw.x);

        // 2. ⌘K chosen: the longest label.
        await select(page).selectOption("cmdk");
        m = await measure();
        check(m, "cmdk");
        expect(m.options[1], `full label only when it fits, ${widthNote}`).toBe(fullFits ? FULL_CMDK.win : "Ctrl+K");
        expect(m.label).toBe(m.options[1]);
        if (width === 800) expect(m.change.y, "Change shortcut wraps under the select at 800").toBeGreaterThan(m.select.b - 1);
        if (width === 1500 || width === 1100) expect(m.change.y + m.change.h / 2, "Change shortcut beside the select").toBeLessThanOrEqual(m.select.b + 1);
        if (width === 700) expect(m.change.y + m.change.h / 2, "Change shortcut beside the select at 700").toBeLessThanOrEqual(m.select.b + 1);
        await expect(line(page)).toBeVisible();
        const lineBox = await line(page).boundingBox();
        expect(lineBox.x + lineBox.width, `describing line inside the row, ${widthNote}`).toBeLessThanOrEqual(m.rowBox.r + 0.5);
        // Never truncated, clamped or hidden: all of the text is laid out in the box.
        expect(await line(page).evaluate((e) => e.scrollHeight - e.clientHeight), `describing line not clamped, ${widthNote}`).toBeLessThanOrEqual(0);

        // 3. unassigned: the long first label and the notice with the breaking address.
        await select(page).selectOption("browser");
        await page.evaluate(() => { window.__qjShortcut = ""; window.dispatchEvent(new Event("focus")); });
        await expect(select(page).locator("option").first()).not.toHaveText("Alt+Shift+K");
        await expect(page.locator("#qj-notice")).toBeVisible();
        m = await measure();
        check(m, "unassigned");
        expect(m.options[0], `Browser shortcut (not set) fits in full from 320, ${widthNote}`).toBe("Browser shortcut (not set)");
        expect(m.addrBreaks.every((c) => c === "/"), `the address breaks only after /: ${JSON.stringify(m.addrBreaks)}, ${widthNote}`).toBe(true);
        if (width === 320 || width === 390) {
          // Force a break: the address is wider than a narrow line only when the notice wraps; either way never mid-word.
          expect(m.addrBreaks.length, "address broke at most at its three slashes").toBeLessThanOrEqual(3);
        }
        const noticeBox = await page.locator("#qj-notice").boundingBox();
        expect(noticeBox.x + noticeBox.width, `notice inside the row, ${widthNote}`).toBeLessThanOrEqual(m.rowBox.r + 0.5);
        expect(await page.locator("#qj-notice").evaluate((e) => e.scrollWidth - e.clientWidth), `notice not clipped, ${widthNote}`).toBeLessThanOrEqual(0);

        // 4. the fallback notice too, at its narrowest.
        await page.evaluate(() => { chrome.tabs.create = () => Promise.reject(new Error("blocked")); });
        await change(page).click();
        await expect(page.locator("#qj-fallback")).toBeVisible();
        const fb = await page.evaluate(() => {
          const e = document.querySelector("#qj-fallback");
          const r = e.getBoundingClientRect();
          return { scroll: e.scrollWidth - e.clientWidth, right: r.right, row: document.querySelector("#quick-jump").getBoundingClientRect().right, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(fb.scroll).toBeLessThanOrEqual(0);
        expect(fb.right).toBeLessThanOrEqual(fb.row + 0.5);
        expect(fb.doc).toBeLessThanOrEqual(0);
      });
    }

    test(`no token, ${scheme} at 320px: title, switch and description fit`, async ({ context, page }) => {
      await start(context, page, { tokens: false, size: { width: 320, height: 800 }, scheme });
      const m = await page.evaluate(() => ({
        h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        track: (({ width, height }) => [width, height])(document.querySelector("#feature-ghqj .switch-track").getBoundingClientRect()),
        desc: getComputedStyle(document.querySelector("#qj-desc")).color,
        link: getComputedStyle(document.querySelector("#qj-desc a")).color,
      }));
      expect(m.h).toBeLessThanOrEqual(0);
      expect(m.track).toEqual([36, 20]);
      expect(m.desc).toBe(TOKENS_BY_SCHEME[scheme].muted);
      expect(m.link).toBe(TOKENS_BY_SCHEME[scheme].link);
    });
  });
}

test.describe("look", () => {
  test("links look and behave like Settings' own links (Configure)", async ({ context, page }) => {
    await start(context, page, { size: { width: 1280, height: 900 } });
    const style = (loc) => loc.evaluate((e) => { const c = getComputedStyle(e); return { color: c.color, weight: c.fontWeight, deco: c.textDecorationLine, nowrap: c.whiteSpace }; });
    const cfg = page.locator("#features a.cfg").first();
    const restCfg = await style(cfg);
    const restChange = await style(change(page));
    const restClear = await style(clear(page));
    for (const r of [restChange, restClear]) {
      expect(r.color).toBe(restCfg.color);
      expect(r.weight).toBe(restCfg.weight);
      expect(r.deco).toBe("none");
      expect(r.nowrap).toBe("nowrap");
    }
    await cfg.hover();
    const hoverCfg = await style(cfg);
    for (const loc of [change(page), clear(page)]) {
      await loc.hover();
      const h = await style(loc);
      expect(h.deco).toBe(hoverCfg.deco);
      expect(h.deco).toBe("underline");
      expect(h.color).toBe(restCfg.color);
    }
    await page.mouse.move(0, 0);
    expect((await style(change(page))).deco).toBe("none");
  });

  test("keyboard focus shows a 2px focus ring at offset 2px on the links", async ({ context, page }) => {
    await start(context, page, { size: { width: 1280, height: 900 } });
    for (const loc of [change(page), clear(page)]) {
      await loc.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(loc).toBeFocused();
      const o = await loc.evaluate((e) => { const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.outlineOffset, c.outlineColor]; });
      expect(o).toEqual(["solid", "2px", "2px", TOKENS_BY_SCHEME.light.focus]);
    }
  });

  for (const scheme of ["light", "dark"]) {
    test(`select: 32px high, 6px radius, 1px border, Settings input fill, focus ring like the inputs, ${scheme}`, async ({ context, page }) => {
      await start(context, page, { size: { width: 1280, height: 900 }, scheme });
      const t = TOKENS_BY_SCHEME[scheme];
      const s = await select(page).evaluate((e) => { const c = getComputedStyle(e); return { h: e.getBoundingClientRect().height, r: c.borderTopLeftRadius, bw: c.borderTopWidth, bs: c.borderTopStyle, bc: c.borderTopColor, bg: c.backgroundColor, font: c.fontFamily, fs: c.fontSize, pl: c.paddingLeft }; });
      expect(s).toMatchObject({ h: 32, r: "6px", bw: "1px", bs: "solid", bc: t.line, bg: t.bg, pl: "10px" });
      // The same font as the Settings inputs (font: inherit).
      const inputFont = await page.evaluate(() => { const i = document.querySelector("#ghsm-stale-days"); const c = getComputedStyle(i); return { font: c.fontFamily, fs: c.fontSize }; });
      expect({ font: s.font, fs: s.fs }).toEqual(inputFont);
      await select(page).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(select(page)).toBeFocused();
      const f = await select(page).evaluate((e) => { const c = getComputedStyle(e); return { o: [c.outlineStyle, c.outlineWidth, c.outlineOffset, c.outlineColor], b: c.borderTopColor }; });
      expect(f).toEqual({ o: ["solid", "2px", "-1px", t.focus], b: t.focus });
    });
  }
});
