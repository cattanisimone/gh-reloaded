// E2E: linked PR status on a Projects Board. Issue cards whose issue has
// explicitly linked pull requests get a thin row (PR number + one text
// signal, or a neutral aggregate) and a details dialog. Covers: rows only
// where links exist, the primary anchor on current and previous class naming,
// the native Linked pull requests field, widths x zoom x theme, text state,
// the modal's accessibility, click versus drag, SPA/view navigation, Standup
// mode, degraded data, the feature switch and the request budget. All names
// are invented.
import { test, expect, routeGithub, routeApi, seedStorage, backgroundWorker } from "./support/extension.js";

const URL = "https://github.com/orgs/acme/projects/1/views/1";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };

const pr = (number, over = {}, repo = "acme/web") => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  repository: { nameWithOwner: repo },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
});
const checks = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });

const DATA = {
  207: [pr(317, { reviewDecision: "REVIEW_REQUIRED", ...checks("FAILURE") })],
  208: [pr(318, { reviewDecision: "REVIEW_REQUIRED" })],
  209: [],
  211: [
    pr(321, { reviewDecision: "CHANGES_REQUESTED", ...checks("FAILURE") }),
    pr(325, { reviewDecision: "REVIEW_REQUIRED" }, "acme/api"),
  ],
  212: [pr(322, { state: "MERGED", reviewDecision: "APPROVED" })],
  213: [pr(331, { reviewDecision: "APPROVED" })], // its rollup comes back with an error
  214: [pr(330, { reviewDecision: "APPROVED" })],
  217: [pr(340, { reviewDecision: "APPROVED", ...checks("PENDING") })],
  218: [pr(350, { isDraft: true })],
};

function graphqlHandler(log = [], { data = DATA, status, errorsFor = [213], fail } = {}) {
  return {
    method: "POST",
    match: (p) => p === "/graphql",
    status: () => (fail ? fail : status),
    json: (_u, request) => {
      const { query } = JSON.parse(request.postData() || "{}");
      log.push(query);
      if (/contexts\(first: 50\)/.test(query)) {
        return {
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
                    { __typename: "CheckRun", name: "build", conclusion: "FAILURE" },
                    { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS" },
                    { __typename: "CheckRun", name: "e2e", conclusion: "TIMED_OUT" },
                  ] } } } }],
                },
              },
            },
          },
        };
      }
      const out = {};
      const errors = [];
      for (const m of query.matchAll(/(i\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issue\(number: (\d+)\)/g)) {
        const list = data[m[4]];
        out[m[1]] = list ? { issue: { closedByPullRequestsReferences: { nodes: list } } } : { issue: { closedByPullRequestsReferences: { nodes: [] } } };
        if (errorsFor.includes(Number(m[4]))) {
          out[m[1]].issue.closedByPullRequestsReferences.nodes = list.map((n) => ({ ...n, commits: null }));
          errors.push({ type: "FORBIDDEN", message: "rollup", path: [m[1], "issue", "closedByPullRequestsReferences", "nodes", 0, "commits"] });
        }
      }
      return errors.length ? { data: out, errors } : { data: out };
    },
  };
}

async function setup(context, page, { storage = {}, tokens = TOKENS, handlers, fixture = "board-linked-prs.html", transform, log, go = true, url = URL } = {}) {
  await seedStorage(context, { ...tokens, ...storage });
  await routeApi(context, handlers || [graphqlHandler(log)]);
  await routeGithub(context, fixture, { transform });
  if (go) await page.goto(url);
}

const card = (page, n) => page.locator(`.board-view-column-card[data-num="${n}"]`);
const row = (page, n) => card(page, n).locator(".ghlps-row");

test("rows appear only on cards with linked PRs, with the PR number and one text signal", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 207)).toBeVisible();
  await expect(row(page, 207).locator(".ghlps-pr")).toHaveText("PR #317");
  await expect(row(page, 207).locator(".ghlps-pr")).toHaveAttribute("href", "https://github.com/acme/web/pull/317");
  await expect(row(page, 207).locator(".ghlps-label")).toHaveText("Checks failed");
  await expect(row(page, 208).locator(".ghlps-label")).toHaveText("Review pending");
  await expect(row(page, 212).locator(".ghlps-label")).toHaveText("Merged");
  await expect(row(page, 217).locator(".ghlps-label")).toHaveText("Checks pending");
  // No linked PR, a PR item and a draft item: no row.
  for (const n of [209, 215, 216]) await expect(row(page, n)).toHaveCount(0);
  // The signal is conveyed by text, not colour alone: every summary button is named.
  for (const n of [207, 208, 211, 212]) {
    const name = await row(page, n).locator("button").getAttribute("aria-label");
    expect(name).toMatch(/Show details$/);
  }
});

test("cards without links keep exactly their height; switching the feature on adds rows only elsewhere", async ({ context, page }) => {
  await setup(context, page, { storage: { ghlpsEnabled: false } });
  await expect(card(page, 209)).toBeVisible();
  const heights = {};
  for (const n of [209, 215, 216, 207]) heights[n] = (await card(page, n).boundingBox()).height;
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghlpsEnabled: true }));
  await expect(row(page, 207)).toBeVisible();
  for (const n of [209, 215, 216]) expect((await card(page, n).boundingBox()).height).toBe(heights[n]);
  expect((await card(page, 207).boundingBox()).height).toBeGreaterThan(heights[207]);
  // Switching off removes everything at once.
  await worker.evaluate(() => chrome.storage.local.set({ ghlpsEnabled: false }));
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  expect((await card(page, 207).boundingBox()).height).toBe(heights[207]);
});

for (const [name, transform] of [
  ["current naming (Name__hash)", undefined],
  ["previous naming (Name-module__x--hash)", (h) => h.replace(/Box_1__h1/g, "Card-module__box--h1").replace(/Header__h4/g, "Card-module__header--h4").replace(/Fields__h3/g, "Card-module__fields--h3").replace(/Title__h2/g, "Card-module__title--h2")],
]) {
  test(`the row sits right after the Fields list on ${name}`, async ({ context, page }) => {
    await setup(context, page, { transform });
    await expect(row(page, 207)).toBeVisible();
    const placed = await card(page, 207).evaluate((c) => {
      const r = c.querySelector(".ghlps-row");
      return { prevIsFields: r.previousElementSibling?.matches('ul[aria-label="Fields"]'), sameParent: r.parentElement === c.querySelector('ul[aria-label="Fields"]').parentElement };
    });
    expect(placed).toEqual({ prevIsFields: true, sameParent: true });
    // No fields list: the end of the card's first child, never another container.
    const bare = await card(page, 217).evaluate((c) => c.querySelector(".ghlps-row")?.parentElement === c.firstElementChild);
    expect(bare).toBe(true);
  });
}

test("the row is not added when the card has no issue link, and retries once the link appears", async ({ context, page }) => {
  await setup(context, page, { transform: (h) => h.replace('<a href="/acme/web/issues/207"', '<a href="/acme/web/x/207"') });
  await expect(row(page, 208)).toBeVisible();
  await expect(row(page, 207)).toHaveCount(0);
  await card(page, 207).locator("a.Title__h2").evaluate((a) => a.setAttribute("href", "/acme/web/issues/207"));
  await expect(row(page, 207)).toBeVisible();
});

test("GitHub's native Linked pull requests field is not duplicated", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 214)).toBeVisible();
  await expect(row(page, 214).locator(".ghlps-pr")).toHaveCount(0);
  await expect(row(page, 214).locator(".ghlps-label")).toHaveText("Approved");
  await expect(card(page, 214).locator('ul[aria-label="Fields"] a[href*="/pull/"]')).toHaveCount(1);
  await expect(row(page, 207).locator(".ghlps-pr")).toHaveCount(1);
});

test("several PRs: a neutral aggregate, no verdict, details in the dialog", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 211).locator(".ghlps-long")).toHaveText("2 linked PRs · 1 needs attention");
  await expect(row(page, 211).locator(".ghlps-tone-neutral")).toHaveCount(1);
  await expect(row(page, 211).locator(".ghlps-pr")).toHaveCount(0);
  await row(page, 211).locator("button").click();
  const d = page.locator("dialog.ghlps-dialog");
  await expect(d.locator(".ghlps-pr-section")).toHaveCount(2);
  const first = d.locator(".ghlps-pr-section").nth(0);
  await expect(first).toContainText("Checks");
  await expect(first).toContainText("Failing");
  await expect(first).toContainText("Failing: build, e2e");
  await expect(first).toContainText("Changes requested");
  await expect(first).toContainText("Next: Address the review feedback and fix the failing checks.");
  const second = d.locator(".ghlps-pr-section").nth(1);
  await expect(second).toContainText("acme/api");
  await expect(second).toContainText("Review pending");
  await expect(second.locator("a")).toHaveAttribute("href", "https://github.com/acme/api/pull/325");
  await expect(d).not.toContainText(/ready to|mergeable/i);
});

test("a PR whose checks cannot be read says Status unavailable, never green", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 213).locator(".ghlps-label")).toHaveText("Status unavailable");
  await expect(row(page, 213).locator(".ghlps-pr")).toHaveText("PR #331");
  await expect(row(page, 213).locator(".ghlps-tone-neutral")).toHaveCount(1);
  await expect(row(page, 208).locator(".ghlps-label")).toHaveText("Review pending"); // siblings unaffected
});

for (const width of [280, 320]) {
  for (const zoom of [1, 1.25, 1.5]) {
    for (const mode of ["light", "dark"]) {
      test(`row fits a ${width}px card at ${zoom * 100}% zoom, ${mode} theme`, async ({ context, page }) => {
        await setup(context, page, { go: false });
        await page.addInitScript(([w, z, m]) => {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.dataset.colorMode = m;
            document.documentElement.style.setProperty("--card-w", `${w}px`);
            document.body.style.zoom = String(z);
          });
        }, [width, zoom, mode]);
        await page.goto(URL);
        for (const n of [207, 211, 212, 213]) {
          const r = row(page, n);
          await expect(r).toBeVisible();
          const m = await r.evaluate((el) => {
            const c = el.closest(".board-view-column-card").getBoundingClientRect();
            const b = el.getBoundingClientRect();
            const chip = el.querySelector(".ghlps-sig");
            const cs = getComputedStyle(chip);
            return { overflow: el.scrollWidth > el.clientWidth + 1, inside: b.left >= c.left - 1 && b.right <= c.right + 1, chipRight: chip.getBoundingClientRect().right <= c.right + 1, color: cs.color, text: chip.innerText.trim() };
          });
          expect(m.overflow, `row ${n} overflows`).toBe(false);
          expect(m.inside, `row ${n} outside card`).toBe(true);
          expect(m.chipRight).toBe(true);
          expect(m.text.length).toBeGreaterThan(2);
        }
        if (width === 280) await expect(row(page, 211).locator(".ghlps-short")).toBeVisible(); // short wording below 300px
        else await expect(row(page, 211).locator(".ghlps-long")).toBeVisible();
        const colour = await row(page, 207).locator(".ghlps-sig").evaluate((e) => getComputedStyle(e).color);
        expect(colour).toBe(mode === "dark" ? "rgb(248, 81, 73)" : "rgb(209, 36, 47)");
      });
    }
  }
}

test("a multi-line title keeps its row under the fields, inside the card", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 212)).toBeVisible();
  const g = await card(page, 212).evaluate((c) => {
    const t = c.querySelector("a.Title__h2").getBoundingClientRect();
    const f = c.querySelector("ul").getBoundingClientRect();
    const r = c.querySelector(".ghlps-row").getBoundingClientRect();
    const b = c.getBoundingClientRect();
    return { lines: Math.round(t.height / 19), below: r.top >= f.bottom - 1, inside: r.bottom <= b.bottom + 1 };
  });
  expect(g.lines).toBeGreaterThan(1);
  expect(g.below && g.inside).toBe(true);
});

test("summary buttons look native: pill, hover darkens, keyboard focus ring", async ({ context, page }) => {
  await setup(context, page);
  const btn = row(page, 207).locator("button");
  await expect(btn).toBeVisible();
  const chip = row(page, 207).locator(".ghlps-sig");
  const rest = await chip.evaluate((e) => ({ r: getComputedStyle(e).borderTopLeftRadius, b: getComputedStyle(e).borderTopWidth, h: e.getBoundingClientRect().height }));
  expect(rest.b).toBe("1px");
  expect(rest.h).toBeLessThanOrEqual(20);
  await btn.hover();
  await expect.poll(() => chip.evaluate((e) => getComputedStyle(e).filter)).toContain("brightness(0.95)");
  await page.keyboard.press("Tab");
  await btn.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ring = await btn.evaluate((e) => getComputedStyle(e).outlineStyle + " " + getComputedStyle(e).outlineWidth);
  expect(ring).toBe("solid 2px");
});

test("dialog: role, modal, name, initial focus, Tab trap, Esc and Close restore focus, board inert", async ({ context, page }) => {
  await setup(context, page);
  const btn = row(page, 207).locator("button");
  await btn.focus();
  await page.keyboard.press("Enter");
  const d = page.locator("dialog.ghlps-dialog");
  await expect(d).toBeVisible();
  await expect(d).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: "Linked pull requests" })).toBeVisible();
  await expect(d.locator("h2")).toBeFocused();
  // Enter on the row did not reach the card's own handler.
  expect(await page.evaluate(() => window.__cardClicks)).toEqual([]);
  // Tab cycles inside the dialog.
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    seen.add(await page.evaluate(() => !!document.activeElement.closest("dialog.ghlps-dialog")));
  }
  expect([...seen]).toEqual([true]);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement.closest("dialog.ghlps-dialog"))).toBe(true);
  // The board behind is inert.
  expect(await page.evaluate(() => document.elementFromPoint(5, 400)?.closest("dialog") !== null || document.elementFromPoint(5, 400)?.nodeName === "DIALOG")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(btn).toBeFocused();
  // Space opens, the Close button closes and restores focus.
  await page.keyboard.press("Space");
  await expect(d).toBeVisible();
  await d.getByRole("button", { name: "Close" }).first().click();
  await expect(d).toHaveCount(0);
  await expect(btn).toBeFocused();
  expect(await page.evaluate(() => window.__cardClicks)).toEqual([]);
});

test("dialog on a 375px viewport fills most of it and scrolls inside, the page does not scroll", async ({ context, page }) => {
  await setup(context, page);
  await page.setViewportSize({ width: 375, height: 420 });
  await row(page, 211).locator("button").click();
  const d = page.locator("dialog.ghlps-dialog");
  await expect(d).toBeVisible();
  const g = await d.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector(".ghlps-body");
    return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, scrolls: body.scrollHeight > body.clientHeight, htmlOverflow: getComputedStyle(document.documentElement).overflow };
  });
  expect(g.w).toBeGreaterThan(g.vw - 20);
  expect(g.w).toBeLessThanOrEqual(g.vw - 16 + 1);
  expect(g.h).toBeLessThanOrEqual(g.vh - 16 + 1);
  expect(g.scrolls).toBe(true);
  expect(g.htmlOverflow).toBe("hidden");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
});

test("clicking the row does not click the card; clicking the card body and the PR link keep working", async ({ context, page }) => {
  await setup(context, page);
  await row(page, 207).locator("button").click();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__cardClicks)).toEqual([]);
  await card(page, 208).locator(".Header__h4").click();
  expect(await page.evaluate(() => window.__cardClicks)).toContain(208);
  const popup = page.waitForEvent("popup");
  await row(page, 208).locator(".ghlps-pr").click();
  const p = await popup;
  expect(p.url()).toContain("/acme/web/pull/318");
  // The click on the PR link did not reach the card either.
  expect(await page.evaluate(() => window.__cardClicks.filter((n) => n === 208).length)).toBe(1);
});

test("dragging from the row moves the card and opens no dialog", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 208)).toBeVisible();
  const from = await row(page, 208).locator(".ghlps-open").boundingBox();
  const to = await page.locator('.board-view-column[data-board-column="In progress"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x + 40, to.y + 40, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__drops)).toEqual([[208, "In progress"]]);
  await expect(page.locator("dialog.ghlps-dialog")).toHaveCount(0);
  await expect(page.locator('.board-view-column[data-board-column="In progress"] [data-num="208"] .ghlps-row')).toHaveCount(1);
});

test("rows follow re-rendered cards and reordered columns; leaving the Board removes them, back restores them", async ({ context, page }) => {
  const log = [];
  await setup(context, page, { log });
  await expect(row(page, 207)).toBeVisible();
  const requests = log.length;
  // React replaces the card's inner markup: the row is put back.
  await card(page, 207).evaluate((c) => c.querySelector(".ghlps-row").remove());
  await expect(row(page, 207)).toBeVisible();
  // Reorder: move a card to another column.
  await page.evaluate(() => document.querySelector('[data-board-column="Todo"]').append(document.querySelector('[data-num="208"]')));
  await expect(page.locator('[data-board-column="Todo"] [data-num="208"] .ghlps-row')).toHaveCount(1);
  // Board -> Table: the selected tab loses the board icon.
  await page.evaluate(() => {
    history.pushState({}, "", "/orgs/acme/projects/1/views/2");
    const tab = document.querySelector('[role="tab"]');
    tab.querySelector("svg").setAttribute("class", "octicon octicon-table");
  });
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  // Back to the Board.
  await page.evaluate(() => {
    history.pushState({}, "", "/orgs/acme/projects/1/views/1");
    document.querySelector('[role="tab"] svg').setAttribute("class", "octicon octicon-project");
  });
  await expect(row(page, 207)).toBeVisible();
  expect(log.length).toBeGreaterThanOrEqual(requests); // a navigation refreshes the facts
});

test("Standup mode and Full-width board together: the row stays, before the standup badges", async ({ context, page }) => {
  const dataset = { 3: [pr(401, { reviewDecision: "CHANGES_REQUESTED" })], 4: [pr(402, checks("FAILURE"))] };
  const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const standup = {
    method: "POST",
    match: (p) => p === "/graphql",
    json: (_u, request) => {
      const { query, variables } = JSON.parse(request.postData());
      if (/closedByPullRequestsReferences/.test(query)) return graphqlHandler([], { data: dataset, errorsFor: [] }).json(null, request);
      const data = {};
      for (const [k, number] of Object.entries(variables || {})) {
        const m = /^n(\d+)$/.exec(k);
        if (!m) continue;
        const status = number === 4 ? "In review" : "Todo";
        data[`i${m[1]}`] = { issueOrPullRequest: { state: "OPEN", labels: { nodes: [] }, comments: { nodes: [] }, projectItems: { nodes: [{ project: { number: 1, owner: { login: "acme" } }, fieldValues: { nodes: [{ name: status, updatedAt: days(number === 4 ? 6 : 1) }] } }] } } };
      }
      return { data };
    },
  };
  await setup(context, page, { fixture: "board-standup.html", handlers: [standup], url: "https://github.com/orgs/acme/projects/1" });
  await expect(row(page, 4).or(page.locator('.board-view-column-card:has(a[href$="/issues/4"]) .ghlps-row'))).toBeVisible();
  const c4 = page.locator('.board-view-column-card:has(a[href$="/issues/4"])');
  await expect(c4.locator(".ghlps-row .ghlps-label")).toHaveText("Checks failed");
  await page.locator("#ghsm-enter").click();
  await expect(c4.locator(".ghsm-badges")).toBeVisible();
  await expect(c4.locator(".ghlps-row")).toBeVisible();
  const order = await c4.evaluate((c) => {
    const r = c.querySelector(".ghlps-row");
    const b = c.querySelector(".ghsm-badges");
    return !!(r.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test("no token: no rows and no request", async ({ context, page }) => {
  const log = [];
  await setup(context, page, { tokens: { githubTokens: [], defaultTokenId: null }, log });
  await expect(card(page, 207)).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  expect(log.length).toBe(0);
});

test("a refusal from GitHub leaves unlinked-knowledge cards without a row", async ({ context, page }) => {
  await setup(context, page, { handlers: [{ method: "POST", match: (p) => p === "/graphql", status: 403, json: { message: "forbidden" } }] });
  await expect(card(page, 207)).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
});

test("temporary loss of access: known PRs turn Status unavailable, nothing turns green", async ({ context, page }) => {
  let down = false;
  const h = graphqlHandler([], { errorsFor: [] });
  await setup(context, page, { handlers: [{ ...h, status: () => (down ? 403 : 200) }] });
  await expect(row(page, 207).locator(".ghlps-label")).toHaveText("Checks failed");
  down = true;
  // Age the cached facts: move the Date of the extension's isolated world, and
  // of the service worker's own 60 s response cache, two minutes ahead.
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => { const real = Date.now; Date.now = () => real() + 130_000; });
  const cdp = await context.newCDPSession(page);
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context));
  await cdp.send("Runtime.enable");
  const isolated = contexts.find((c) => c.origin.startsWith("chrome-extension://"));
  expect(isolated, "extension isolated world").toBeTruthy();
  await cdp.send("Runtime.evaluate", { contextId: isolated.id, expression: "(() => { const real = Date.now; Date.now = () => real() + 130000; })()" });
  // Any re-render of the board triggers a scan.
  await page.evaluate(() => document.querySelector("main").append(document.createElement("i")));
  await expect(row(page, 207).locator(".ghlps-label")).toHaveText("Status unavailable");
  await expect(row(page, 207).locator(".ghlps-pr")).toHaveText("PR #317");
  await expect(row(page, 208).locator(".ghlps-label")).toHaveText("Status unavailable");
  await expect(row(page, 209)).toHaveCount(0);
  await expect(page.locator(".ghlps-tone-bad, .ghlps-tone-warn")).toHaveCount(0);
});

test("only cards near the viewport are queried; scrolling asks for the rest once", async ({ context, page }) => {
  const log = [];
  await setup(context, page, { log });
  await expect(row(page, 207)).toBeVisible();
  expect(log.join("\n")).not.toContain("issue(number: 218)");
  await card(page, 218).scrollIntoViewIfNeeded();
  await expect(row(page, 218)).toBeVisible();
  await expect(row(page, 218).locator(".ghlps-label")).toHaveText("Draft");
  const count = log.filter((q) => q.includes("issue(number: 218)")).length;
  expect(count).toBe(1);
  await card(page, 207).scrollIntoViewIfNeeded();
  await card(page, 218).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  expect(log.filter((q) => q.includes("issue(number: 218)")).length).toBe(1);
});

test("disabled: no row and no request", async ({ context, page }) => {
  const log = [];
  await setup(context, page, { storage: { ghlpsEnabled: false }, log });
  await expect(card(page, 207)).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  expect(log.length).toBe(0);
});

test("the request is read-only and asks for explicit links only", async ({ context, page }) => {
  const log = [];
  await setup(context, page, { log });
  await expect(row(page, 207)).toBeVisible();
  const all = log.join("\n");
  expect(all).toContain("closedByPullRequestsReferences");
  expect(all).not.toMatch(/mutation|timelineItems|search\(/);
});

test("a swapped <main> after a soft navigation gets its rows without waiting for the cache", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 207)).toBeVisible();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const clone = main.cloneNode(true);
    clone.querySelectorAll(".ghlps-row").forEach((r) => r.remove());
    main.replaceWith(clone);
    history.pushState({}, "", "/orgs/acme/projects/1/views/1?x=1");
  });
  await expect(row(page, 207)).toBeVisible();
});

test("the row is inset like the card's own text and the divider with it", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 207)).toBeVisible();
  const g = await card(page, 207).evaluate((c) => {
    const r = c.querySelector(".ghlps-row").getBoundingClientRect();
    const t = c.querySelector("a.Title__h2").getBoundingClientRect();
    const pr = c.querySelector(".ghlps-pr").getBoundingClientRect();
    const chip = c.querySelector(".ghlps-sig").getBoundingClientRect();
    const b = c.getBoundingClientRect();
    const rule = getComputedStyle(c.querySelector(".ghlps-row"), "::before");
    return { textLeft: t.left - b.left, prLeft: pr.left - b.left, chipRight: b.right - chip.right, ruleLeft: parseFloat(rule.left), ruleRight: parseFloat(rule.right), rowEdge: r.left - b.left };
  });
  expect(g, JSON.stringify(g)).toMatchObject({ prLeft: g.textLeft, ruleLeft: 12, ruleRight: 12 });
  expect(g.chipRight).toBeGreaterThanOrEqual(g.textLeft - 1);
});

test("an open PR with no review or checks signal shows the PR link and no chip", async ({ context, page }) => {
  const data = { ...DATA, 207: [pr(317, { reviewDecision: null, ...checks("SUCCESS") })] };
  await setup(context, page, { handlers: [graphqlHandler([], { data, errorsFor: [] })] });
  await expect(row(page, 207).locator(".ghlps-pr")).toHaveText("PR #317");
  await expect(row(page, 207).locator(".ghlps-sig, button")).toHaveCount(0);
  await expect(row(page, 207)).not.toContainText("Open");
});

test("no token: a dismissible hint names the cause and Settings, remembered once dismissed", async ({ context, page }) => {
  await setup(context, page, { tokens: { githubTokens: [], defaultTokenId: null } });
  const hint = page.locator(".ghlps-hint");
  await expect(hint).toContainText("needs a GitHub token");
  await expect(hint.getByRole("link", { name: "Open Settings" })).toBeVisible();
  await expect(page.locator(".ghlps-row")).toHaveCount(0);
  await hint.getByRole("button", { name: "Dismiss" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(card(page, 207)).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".ghlps-hint")).toHaveCount(0);
});

test("a refused token: the hint names Pull requests: Read; a working token shows no hint", async ({ context, page }) => {
  await setup(context, page, { handlers: [{ method: "POST", match: (p) => p === "/graphql", status: 403, json: { message: "Resource not accessible by personal access token" } }] });
  await expect(page.locator(".ghlps-hint")).toContainText("Pull requests: Read");
});

test("a rate limit shows a hint that is not remembered", async ({ context, page }) => {
  await setup(context, page, { handlers: [{ method: "POST", match: (p) => p === "/graphql", status: 429, json: { message: "rate limit" } }] });
  await expect(page.locator(".ghlps-hint")).toContainText("rate limit");
  await page.locator(".ghlps-hint").getByRole("button", { name: "Dismiss" }).click();
  expect(await backgroundWorker(context).then((w) => w.evaluate(() => chrome.storage.local.get("ghlpsHintDismissed")))).toEqual({});
});

test("no hint while data loads fine", async ({ context, page }) => {
  await setup(context, page);
  await expect(row(page, 207)).toBeVisible();
  await expect(page.locator(".ghlps-hint")).toHaveCount(0);
});
