// E2E: Quick assignment (experimental) in the issue side panel of a Projects
// page. The fixture stands in for a Project with an issue open in the panel
// (see project-issue-panel.html) and for GitHub's own Assignees picker inside
// it. The controls are the full page's, so this spec covers what is different
// here: the identity of the issue (URL and the panel's own title link must
// agree), scoping to the panel, and what happens when the panel closes, the
// item switches, a sub-issue opens or history moves. All names are invented.
import { test, expect, routeGithub, routeApi, seedStorage } from "./support/extension.js";

const USER_TABLE = "https://github.com/users/octo-dev/projects/1/views/1";
const ORG_BOARD = "https://github.com/orgs/acme/projects/7/views/3";
const panelUrl = (n, base = USER_TABLE) => `${base}?pane=issue&itemId=I_${n}&issue=acme%7Cweb%7C${n}`;
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };
const ON = { ghqaEnabled: true };

// What GitHub "stores" per issue number; the fixture's save request updates it, the REST read-back reads it.
function makeServer() {
  return { data: { 26: ["alex-dev"], 27: ["mira"], 28: [], 41: ["alex-dev"] }, saves: [], reads: [], requests: [] };
}

async function setup(context, page, { server = makeServer(), storage = { ...TOKENS, ...ON }, url = panelUrl(26), query = "", read } = {}) {
  await seedStorage(context, storage);
  context.on("request", (r) => {
    if (r.url().startsWith("https://api.github.com/")) server.requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await routeApi(context, [
    {
      match: (p) => /^\/repos\/acme\/web\/issues\/\d+$/.test(p),
      status: (u) => read?.(server, Number(u.pathname.split("/").pop()))?.status || 200,
      json: (u) => {
        const n = Number(u.pathname.split("/").pop());
        server.reads.push(n);
        const custom = read?.(server, n);
        if (custom) return custom.json ?? {};
        return { assignees: (server.data[n] || []).map((login) => ({ login })) };
      },
    },
  ]);
  await routeGithub(context, "project-issue-panel.html");
  await context.route("https://github.com/_fixture/save", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    server.saves.push({ issue: body.issue, assignees: body.assignees });
    server.data[Number(body.issue.split("#")[1])] = body.assignees;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(url + query);
  return server;
}

const section = (page) => page.locator('[data-testid="sidebar-assignees-section"]');
const panelSection = (page) => page.locator('[role="dialog"][aria-label^="Side panel"] [data-testid="sidebar-assignees-section"]');
const assignBtn = (page) => page.locator("[data-ghqa-btn]");
const status = (page) => page.locator("[data-ghqa-status]");
const xOf = (page, login) => page.locator(`[data-ghqa-x="${login}"]`);
const anyNode = (page) => page.locator("[data-ghqa-actions], [data-ghqa-x], [data-ghqa], [data-ghqa-row]");
const names = (page) => page.locator('[role="dialog"][aria-label^="Side panel"] [data-testid="issue-assignees"]').allTextContents();
const setState = (page, key, logins) => page.evaluate(([k, l]) => { window.__fx.data[k].state = l.map((login) => ({ login })); window.__fx.render(); }, [key, logins]);

for (const [label, url] of [
  ["user Project, table", panelUrl(26)],
  ["user Project, board", panelUrl(26, "https://github.com/users/octo-dev/projects/1/views/2") + "&layout=board"],
  ["org Project, table", panelUrl(26, ORG_BOARD)],
  ["org Project without a view", panelUrl(26, "https://github.com/orgs/acme/projects/7")],
]) {
  test(`panel: ${label} renders controls in the panel section`, async ({ context, page }) => {
    await setup(context, page, { url });
    await expect(assignBtn(page)).toHaveText("Assign me");
    await expect(xOf(page, "alex-dev")).toHaveCount(1);
    await expect(panelSection(page).locator("[data-ghqa-actions]")).toHaveCount(1);
    await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  });
}

for (const [label, logins, button, xs] of [
  ["none", [], null, []],
  ["self only", ["mira"], "Unassign me", ["mira"]],
  ["colleague only", ["alex-dev"], "Assign me", ["alex-dev"]],
  ["self and colleague", ["mira", "alex-dev"], "Unassign me", ["mira", "alex-dev"]],
]) {
  test(`panel: actions per assignee situation: ${label}`, async ({ context, page }) => {
    await setup(context, page);
    await setState(page, "acme/web#26", logins);
    if (button) await expect(assignBtn(page)).toHaveText(button);
    else {
      await expect(page.locator('[class*="selfAssignButton"]')).toHaveText("Assign yourself");
      await page.waitForTimeout(500);
      await expect(page.locator("[data-ghqa-actions]")).toHaveCount(0);
    }
    for (const l of xs) await expect(xOf(page, l)).toHaveCount(1);
    await expect(page.locator("[data-ghqa-x]")).toHaveCount(xs.length);
    if (button) await expect(page.locator('[class*="selfAssignButton"]')).toHaveCount(0);
  });
}

test("panel: assign me keeps the colleague, confirmed by a read of the panel's issue", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  expect(server.saves).toEqual([{ issue: "acme/web#26", assignees: ["alex-dev", "mira"] }]);
  expect(server.reads.length).toBeGreaterThan(0);
  expect(new Set(server.reads)).toEqual(new Set([26]));
  expect(await names(page)).toEqual(["alex-dev", "mira"]);
  await expect(assignBtn(page)).toHaveText("Unassign me");
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  // focus lands on the control that replaced the one activated
  await expect(assignBtn(page)).toBeFocused();
});

test("panel: ✕ removes only that person", async ({ context, page }) => {
  const server = await setup(context, page);
  await setState(page, "acme/web#26", ["alex-dev", "mira", "sam-dev"]);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(3);
  await xOf(page, "alex-dev").click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Removed @alex-dev");
  expect(server.saves).toEqual([{ issue: "acme/web#26", assignees: ["mira", "sam-dev"] }]);
});

test("panel: no-change read-back is a failure, not a green tick", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ json: { assignees: [{ login: "alex-dev" }] } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✕ Couldn't assign you", { timeout: 15000 });
  await expect(status(page)).toHaveAttribute("data-tone", "bad");
});

test("panel: 403 names Issues: Read; 429 shows the rate limit", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 403, json: { message: "Resource not accessible" } }) });
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toHaveText("Sent, not confirmed");
  await expect(status(page)).toContainText("The token for acme can't read issues (Issues: Read).");
});

test("panel: a rate limit shows when it resets", async ({ context, page }) => {
  await setup(context, page, { read: () => ({ status: 429, json: { message: "API rate limit exceeded" } }) });
  await assignBtn(page).click();
  await expect(status(page)).toContainText("GitHub rate limit reached");
});

test("panel: every api.github.com request is a GET", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  expect(server.requests.length).toBeGreaterThan(0);
  expect(server.requests.filter((r) => !r.startsWith("GET "))).toEqual([]);
});

// --- identity ---------------------------------------------------------------

test("panel: URL and title disagree → nothing", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toHaveCount(1);
  await page.evaluate(() => document.querySelector('[role=dialog][aria-label^="Side panel"] h1 a').setAttribute("href", "/acme/web/issues/99"));
  await expect(anyNode(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(anyNode(page)).toHaveCount(0);
  // and back in agreement: the controls return
  await page.evaluate(() => document.querySelector('[role=dialog][aria-label^="Side panel"] h1 a').setAttribute("href", "/acme/web/issues/26"));
  await expect(assignBtn(page)).toHaveCount(1);
});

test("panel: URL names another repository than the title link → nothing", async ({ context, page }) => {
  await setup(context, page, { url: `${USER_TABLE}?pane=issue&issue=acme%7Capi%7C26` });
  await page.waitForTimeout(600);
  await expect(anyNode(page)).toHaveCount(0);
});

test("panel: pull request and draft items get nothing", async ({ context, page }) => {
  await setup(context, page, { url: panelUrl(41) });
  await expect(panelSection(page)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(anyNode(page)).toHaveCount(0);
  await page.evaluate(() => window.__fx.close());
  await page.evaluate(() => window.__fx.open("draft"));
  await expect(panelSection(page)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(anyNode(page)).toHaveCount(0);
});

test("panel: no edit button (read-only) → nothing", async ({ context, page }) => {
  await setup(context, page, { query: "&ro" });
  await expect(panelSection(page)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(anyNode(page)).toHaveCount(0);
});

test("panel: no panel (the Project page alone) → nothing", async ({ context, page }) => {
  await setup(context, page, { url: USER_TABLE });
  await page.waitForTimeout(600);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(anyNode(page)).toHaveCount(0);
});

test("panel: primary anchor is the section inside the panel, not a section elsewhere on the page", async ({ context, page }) => {
  await setup(context, page, { query: "&decoy" });
  await expect(panelSection(page).locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(page.locator("#decoy [data-ghqa-actions], #decoy [data-ghqa-x], #decoy [data-ghqa]")).toHaveCount(0);
  // a panel without its own section gets nothing, never the decoy
  await page.evaluate(() => document.querySelector('[role=dialog][aria-label^="Side panel"] [data-testid="sidebar-assignees-section"]').removeAttribute("data-testid"));
  await expect(anyNode(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.locator("#decoy [data-ghqa-actions], #decoy [data-ghqa-x], #decoy [data-ghqa]")).toHaveCount(0);
});

test("panel: previous Name-module class naming works too", async ({ context, page }) => {
  await setup(context, page, { query: "&old" });
  await expect(assignBtn(page)).toHaveText("Assign me");
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
});

// --- navigation ---------------------------------------------------------------

test("panel: switching item during the read-back drops the status, no read of the old issue after the switch", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await page.evaluate(() => window.__fx.open("acme/web#27"));
  await expect(page.locator('[role=dialog][aria-label^="Side panel"] h1 a')).toHaveAttribute("href", "/acme/web/issues/27");
  const readsAtSwitch = server.reads.length;
  await expect(assignBtn(page)).toHaveText("Unassign me"); // #27 is mira's own
  await page.waitForTimeout(7000); // longer than the whole read-back schedule
  await expect(status(page)).toHaveCount(0);
  expect(server.reads.length, "no read of issue 26 after the switch").toBe(readsAtSwitch);
  expect(server.reads.filter((n) => n === 27)).toEqual([]);
});

test("panel: closing during Saving… tears down", async ({ context, page }) => {
  const server = await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page)).toContainText("Saving…");
  await page.evaluate(() => window.__fx.close());
  await expect(anyNode(page)).toHaveCount(0);
  const reads = server.reads.length;
  await page.waitForTimeout(7000);
  await expect(anyNode(page)).toHaveCount(0);
  expect(server.reads.length).toBe(reads);
});

test("panel: sub-issue in panel re-renders for the new issue, back returns to the parent", async ({ context, page }) => {
  await setup(context, page);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await page.locator(".sublink").click();
  await expect(page).toHaveURL(/issue=acme%7Cweb%7C28/);
  await expect(page.locator('[class*="selfAssignButton"]')).toHaveText("Assign yourself"); // #28 has no assignees
  await expect(page.locator("[data-ghqa-actions], [data-ghqa-x]")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/issue=acme%7Cweb%7C26/);
  await expect(xOf(page, "alex-dev")).toHaveCount(1);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
});

test("panel: open → close → reopen and back/forward leave one set of controls", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toHaveCount(1);
  await page.keyboard.press("Escape"); // GitHub closes the panel
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(anyNode(page)).toHaveCount(0);
  await page.evaluate(() => window.__fx.open("acme/web#26"));
  await expect(assignBtn(page)).toHaveCount(1);
  await page.goBack(); // closed
  await expect(anyNode(page)).toHaveCount(0);
  await page.goForward(); // reopened
  await expect(assignBtn(page)).toHaveCount(1);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
});

test("panel: React re-render re-asserts once", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toHaveCount(1);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__fx.render());
  await expect(assignBtn(page)).toHaveCount(1);
  await expect(page.locator("[data-ghqa-actions]")).toHaveCount(1);
  await expect(page.locator("[data-ghqa-x]")).toHaveCount(1);
});

test("panel: Escape that closes the picker does not close the panel", async ({ context, page }) => {
  await setup(context, page);
  await assignBtn(page).click();
  await expect(status(page).locator(".ghqa-line")).toContainText("✓ Assigned");
  await expect(page.locator('[role="dialog"][aria-label^="Side panel"]')).toHaveCount(1);
  await expect(page).toHaveURL(/pane=issue/);
  // the user's own picker: opened and closed with Escape, the panel stays
  await panelSection(page).locator("#edit").click();
  await expect(page.locator('[role=combobox][aria-label="Filter assignees"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[role=combobox][aria-label="Filter assignees"]')).toHaveCount(0);
  await expect(page.locator('[role="dialog"][aria-label^="Side panel"]')).toHaveCount(1);
});

// --- off, appearance --------------------------------------------------------------

test("panel: off by default", async ({ context, page }) => {
  await setup(context, page, { storage: { ...TOKENS } });
  await expect(panelSection(page)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(anyNode(page)).toHaveCount(0);
});

test("panel: switching off mid-panel removes every node", async ({ context, page }) => {
  await setup(context, page);
  await expect(assignBtn(page)).toHaveCount(1);
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ ghqaEnabled: false }));
  await expect(anyNode(page)).toHaveCount(0);
});

for (const mode of ["light", "dark"]) {
  test(`panel: ✕ and buttons look native (${mode})`, async ({ context, page }) => {
    await setup(context, page);
    await page.evaluate((m) => document.documentElement.setAttribute("data-color-mode", m), mode);
    await expect(assignBtn(page)).toBeVisible();
    const btn = await assignBtn(page).evaluate((b) => { const cs = getComputedStyle(b); return { h: b.getBoundingClientRect().height, r: cs.borderRadius, bw: cs.borderTopWidth, bg: cs.backgroundColor, font: cs.fontFamily }; });
    expect(btn.h).toBe(32);
    expect(btn.r).toBe("6px");
    expect(btn.bw).toBe("1px");
    expect(btn.bg).not.toBe("rgba(0, 0, 0, 0)");
    const row = rowBox(page, "alex-dev");
    await page.locator("li", { has: page.locator('a[href="/alex-dev"]') }).hover();
    await expect(xOf(page, "alex-dev")).toHaveCSS("opacity", "1");
    expect((await row()).height).toBe(32);
  });
}
const rowBox = (page, login) => () => page.locator("li", { has: page.locator(`a[href="/${login}"]`) }).boundingBox();

test("panel: controls are reachable by keyboard", async ({ context, page }) => {
  await setup(context, page);
  await xOf(page, "alex-dev").focus();
  await expect(xOf(page, "alex-dev")).toBeFocused();
  await assignBtn(page).focus();
  await expect(assignBtn(page)).toBeFocused();
});

// --- width ------------------------------------------------------------------------

for (const vw of [1500, 1100, 800, 400]) {
  test(`panel widths: ${vw}px with assignees, actions box and ✕ stay inside the scroll container's right edge`, async ({ context, page }) => {
    await page.setViewportSize({ width: vw, height: 900 });
    await setup(context, page);
    await setState(page, "acme/web#26", ["alex-dev", "sam-dev", "jo_acme"]);
    await expect(page.locator("[data-ghqa-x]")).toHaveCount(3);
    await expect(assignBtn(page)).toHaveCount(1);
    const m = await page.evaluate(() => {
      const sec = document.querySelector('[role="dialog"][aria-label^="Side panel"] [data-testid="sidebar-assignees-section"]');
      let sc = null;
      for (let el = sec.parentElement; el && !el.matches('[role="dialog"]'); el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && el.getBoundingClientRect().width > 1) { sc = el; break; }
      }
      if (!sc) return { found: false };
      const right = sc.getBoundingClientRect().right;
      const edge = (el) => el.getBoundingClientRect().right;
      const sr = sec.getBoundingClientRect();
      return {
        found: true, right, scrollW: sc.scrollWidth, clientW: sc.clientWidth,
        box: edge(document.querySelector("[data-ghqa-actions]")),
        xs: [...document.querySelectorAll("[data-ghqa-x]")].map(edge),
        secLeft: sr.left, secWidth: sr.width, boxLeft: document.querySelector("[data-ghqa-actions]").getBoundingClientRect().left, boxWidth: document.querySelector("[data-ghqa-actions]").getBoundingClientRect().width,
        rows: [...document.querySelectorAll("[data-ghqa-row]")].map((r) => r.getBoundingClientRect().height),
      };
    });
    expect(m.found, "the test must resolve the panel body's scroll container").toBe(true);
    const ctx = JSON.stringify(m);
    expect(m.box, ctx).toBeLessThanOrEqual(m.right + 1);
    for (const x of m.xs) expect(x, ctx).toBeLessThanOrEqual(m.right + 1);
    expect(m.scrollW, ctx).toBe(m.clientW);
    expect(Math.abs(m.boxLeft - m.secLeft), ctx).toBeLessThanOrEqual(1);
    expect(m.boxWidth / m.secWidth, ctx).toBeGreaterThanOrEqual(0.98);
    for (const h of m.rows) expect(h, ctx).toBe(32);
  });
}
