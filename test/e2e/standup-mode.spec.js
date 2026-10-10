// E2E: the standup-mode feature on a Projects board. On by default: the
// entry button is offered on a Board view, entering keeps the whole board
// visible and flags what needs attention (stale in review, orphan block,
// priority) from the GitHub data, a summary entry jumps to a flagged card,
// and Esc exits cleanly. Without a token the board still presents, with
// only the DOM-visible signals. The disabled state is "no entry button".
import { test, expect, routeGithub, routeApi, seedStorage, backgroundWorker } from "./support/extension.js";

const BOARD_URL = "https://github.com/orgs/acme/projects/7";
const TOKEN = { githubTokens: [{ id: "t1", name: "Test", token: "ghp_test", owner: "" }], defaultTokenId: "t1" };

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// What the batched GraphQL query returns per issue number, for project #7.
function issueNode(number) {
  const base = { state: "OPEN", labels: { nodes: [] }, comments: { nodes: [] } };
  const item = (status, extra = {}) => ({
    projectItems: {
      nodes: [{ project: { number: 7, owner: { login: "acme" } }, fieldValues: { nodes: [{ name: status, updatedAt: daysAgo(1) }] }, ...extra }],
    },
  });
  switch (number) {
    case 3: // high priority, in progress
      return { ...base, ...item("In progress", { priority: { name: "High" } }) };
    case 4: // stale: six days in review
      return { ...base, ...item("In review", { fieldValues: { nodes: [{ name: "In review", updatedAt: daysAgo(6) }] } }) };
    case 5: // fresh in review
      return { ...base, ...item("In review") };
    case 6: // labelled blocked, no blocker, no comment explaining it
      return { ...base, labels: { nodes: [{ name: "blocked" }] }, ...item("In progress") };
    default:
      return { ...base, ...item("Todo") };
  }
}

const API = [
  {
    method: "POST",
    match: (p) => p === "/graphql",
    json: (_url, request) => {
      const { variables } = JSON.parse(request.postData());
      const data = {};
      for (const [k, number] of Object.entries(variables)) {
        const m = /^n(\d+)$/.exec(k);
        if (m) data[`i${m[1]}`] = { issueOrPullRequest: issueNode(number) };
      }
      return { data };
    },
  },
];

const card = (page, number) => page.locator(`.board-view-column-card:has(a[href$="/issues/${number}"])`);

test("keeps the whole board visible and flags what needs attention", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);

  const enter = page.locator("#ghsm-enter");
  await expect(enter).toHaveCount(1);
  await enter.click();

  // The board is not replaced by an overlay or a walk-through: every card
  // stays on screen, with a slim bar on top.
  await expect(page.locator("body.ghsm-active")).toHaveCount(1);
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);
  await expect(page.locator(".board-view-column-card:visible")).toHaveCount(6);

  // The summary names what was found.
  const summary = page.locator("#ghsm-summary");
  await expect(summary.locator(".ghsm-sum-stale")).toHaveText("1 stale in review");
  await expect(summary.locator(".ghsm-sum-orphan")).toHaveText("1 orphan block");
  await expect(summary.locator(".ghsm-sum-critical")).toHaveCount(0);
  // The six-day-old review card makes "In review" a bottleneck column.
  await expect(summary.locator(".ghsm-sum-bottleneck")).toHaveText("1 bottleneck");
  await expect(page.locator(".board-view-column[data-ghsm-bottleneck] h3")).toHaveText("In review");

  // Cards carry their own badges: stale review, orphan block, priority.
  await expect(card(page, 4)).toHaveClass(/ghsm-flag-stale/);
  await expect(card(page, 4).locator(".ghsm-chip-stale")).toHaveText("Stale");
  await expect(card(page, 4).locator(".ghsm-chip-age")).toHaveText("6d");
  await expect(card(page, 5)).not.toHaveClass(/ghsm-flag-/);
  await expect(card(page, 6)).toHaveClass(/ghsm-flag-orphan/);
  // A draft item has no issue to look up, but still gets the DOM-visible signals.
  const draft = page.locator(".board-view-column-card:not(:has(a))");
  await expect(draft.locator(".ghsm-chip-blocked")).toHaveText("Blocked");
  await expect(card(page, 3).locator(".ghsm-chip-priority")).toHaveText("High");
  await expect(card(page, 3)).toHaveAttribute("data-ghsm-priority", "2");

  // Clicking a summary entry points at the card.
  await summary.locator(".ghsm-sum-stale").click();
  await expect(card(page, 4)).toHaveClass(/ghsm-focus/);

  // Esc exits cleanly — nothing the mode added is left behind.
  await page.keyboard.press("Escape");
  await expect(page.locator("body.ghsm-active")).toHaveCount(0);
  await expect(page.locator("#ghsm-bar")).toHaveCount(0);
  await expect(page.locator(".ghsm-badges")).toHaveCount(0);
  await expect(page.locator("[class*='ghsm-flag-'], .ghsm-focus, [data-ghsm-sig], [data-ghsm-bottleneck]")).toHaveCount(0);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
});

test("leaves one header: hides the title row, the filter bar and the controls that only edit", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);

  await expect(page.locator(".project-title-row")).toBeVisible();
  await expect(page.locator(".toolbar")).toBeVisible();
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  // GitHub's own title row, the filter bar and the View button are gone; the bar is the only header.
  await expect(page.locator(".project-title-row")).toBeHidden();
  await expect(page.locator(".toolbar")).toBeHidden();
  await expect(page.locator(".view-options button")).toBeHidden();
  await expect(page.getByRole("button", { name: "Add item" })).toBeHidden();
  await expect(page.locator("#ghsm-bar .ghsm-project")).toHaveText("Platform roadmap");

  // The filter still applies to the board, so the bar says which subset this is.
  await expect(page.locator("#ghsm-bar .ghsm-filter")).toHaveText("Filter: assignee:@me -status:Done");

  // Everything comes back on exit.
  await page.keyboard.press("Escape");
  await expect(page.locator(".project-title-row")).toBeVisible();
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect(page.locator(".view-options button")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add item" })).toBeVisible();
  await expect(page.locator("[data-ghsm-hide], [data-ghsm-flat], [data-ghsm-row], [data-ghsm-pill], [data-ghsm-keep]")).toHaveCount(0);
  await expect(page.locator(".column-header .column-description").first()).toBeVisible();
});

test("shows no filter text in the bar when the board is not filtered", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator(".toolbar input").fill("");
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);
  await expect(page.locator("#ghsm-bar .ghsm-filter")).toBeHidden();
});

test("compacts each column header to a dot and name on the left and one metric pill on the right", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const column = (name) => page.locator(".board-view-column", { has: page.locator(`h3:text-is("${name}")`) });

  for (const name of ["Todo", "In progress", "In review"]) {
    const col = column(name);
    await expect(col.locator(".column-description")).toBeHidden();
    await expect(col.locator('button[aria-label="Column menu"]')).toBeHidden();
    await expect(col.locator(".status-dot")).toBeVisible();
    await expect(col.locator("h3")).toBeVisible();
  }

  // A field-sum pill wins over the count pill; never both.
  await expect(column("Todo").locator(".sum")).toBeVisible();
  await expect(column("Todo").locator(".Counter")).toBeHidden();
  await expect(column("In review").locator(".sum")).toBeVisible();
  await expect(column("In review").locator(".Counter")).toBeHidden();
  // No field-sum configured: fall back to the card count.
  await expect(column("In progress").locator(".Counter")).toBeVisible();
  await expect(column("In progress").locator(".sum")).toHaveCount(0);

  // One row: the pill sits to the right of the name, on the same line.
  for (const [name, pill] of [["Todo", ".sum"], ["In progress", ".Counter"]]) {
    const heading = await column(name).locator("h3").boundingBox();
    const dot = await column(name).locator(".status-dot").boundingBox();
    const metric = await column(name).locator(pill).boundingBox();
    expect(dot.x).toBeLessThan(heading.x);
    expect(metric.x).toBeGreaterThan(heading.x + heading.width);
    expect(Math.abs(metric.y + metric.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(8);
  }
  await expect(column("Todo")).toContainText("Effort: 5");
});

test("still keeps the header on one line when the column has no wrapper around its parts", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.evaluate(() => {
    for (const w of document.querySelectorAll(".column-header, .column-title-row")) w.replaceWith(...w.childNodes);
  });
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const col = page.locator(".board-view-column", { has: page.locator('h3:text-is("Todo")') });
  await expect(col.locator(".column-description")).toBeHidden();
  await expect(col.locator('button[aria-label="Column menu"]')).toBeHidden();
  await expect(col.locator(".Counter")).toBeHidden();
  const heading = await col.locator("h3").boundingBox();
  const metric = await col.locator(".sum").boundingBox();
  expect(metric.x).toBeGreaterThan(heading.x + heading.width);
  expect(Math.abs(metric.y + metric.height / 2 - (heading.y + heading.height / 2))).toBeLessThan(10);
});

test("compacts a group header, dropping the chevron and menu but keeping the name, avatar and total", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup-grouped.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const group = page.locator('[class*="Board-module__horizontalGroupHeader"]');
  await expect(group.locator('button[aria-label="Collapse group"]')).toBeHidden();
  await expect(group.locator('button[aria-label="Group menu"]')).toBeHidden();
  await expect(group.locator(".avatar")).toBeVisible();
  await expect(group.locator(".group-name")).toBeVisible();
  await expect(group.locator(".group-total")).toBeVisible();
});

// ---- why the signals may be missing ----

const summaryNote = (page) => page.locator("#ghsm-summary .ghsm-note");

test("an error on one card still gives signals for the rest of the board, and says so", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [
    {
      method: "POST",
      match: (p) => p === "/graphql",
      json: (_url, request) => {
        const { variables } = JSON.parse(request.postData());
        const data = {};
        for (const [k, number] of Object.entries(variables)) {
          const m = /^n(\d+)$/.exec(k);
          if (m) data[`i${m[1]}`] = number === 5 ? null : { issueOrPullRequest: issueNode(number) };
        }
        return { data, errors: [{ type: "NOT_FOUND", path: ["i1"], message: "Could not resolve to a Repository with the name 'acme/gone'." }] };
      },
    },
  ]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();

  await expect(card(page, 4).locator(".ghsm-chip-stale")).toHaveText("Stale");
  await expect(card(page, 3).locator(".ghsm-chip-priority")).toHaveText("High");
  await expect(summaryNote(page)).toContainText("Some cards could not be read");
  await expect(page.locator("#ghsm-summary .ghsm-sum-stale")).toHaveText("1 stale in review");
  await expect(summaryNote(page)).not.toContainText("token");
});

test("blames the token only when GitHub refuses access", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [{ method: "POST", match: (p) => p === "/graphql", status: 403, json: { message: "Forbidden" } }]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toContainText("the token may lack Projects access");
});

test("blames the token for a 200 whose only error is 'Resource not accessible'", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [
    { method: "POST", match: (p) => p === "/graphql", json: { data: null, errors: [{ message: "Resource not accessible by personal access token" }] } },
  ]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toContainText("the token may lack Projects access");
});

test("shows a neutral message, with the detail in a tooltip, for any other failure", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [{ method: "POST", match: (p) => p === "/graphql", status: 502, json: { message: "Bad gateway" } }]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  const warnings = [];
  page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toHaveText("Board signals could not be loaded.");
  await expect(summaryNote(page)).toHaveAttribute("title", /502/);
  await expect(summaryNote(page)).not.toContainText("token");
  await expect.poll(() => warnings.some((w) => w.includes("Standup signals") && w.includes("502"))).toBe(true);
});

test("a project that returns nothing readable is not reported as a token problem", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [{ method: "POST", match: (p) => p === "/graphql", json: { data: {} } }]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toHaveText("Board signals could not be loaded.");
  await expect(summaryNote(page)).not.toContainText("token");
  await expect(page.locator(".board-view-column-card:visible")).toHaveCount(6);
});

test("shows the loading note, not an error, while the board has not rendered any cards yet", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  const columns = await page.evaluate(() => {
    const board = document.querySelector('[class*="Board-module__boardContainer"]');
    const html = board.innerHTML;
    board.replaceChildren();
    window.__board = html;
    return html.length;
  });
  expect(columns).toBeGreaterThan(0);
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toHaveText("Reading board signals…");

  // The board arrives: the real signals replace the note.
  await page.evaluate(() => {
    document.querySelector('[class*="Board-module__boardContainer"]').innerHTML = window.__board;
  });
  await expect(page.locator("#ghsm-summary .ghsm-sum-stale")).toHaveText("1 stale in review");
});

test("an empty board says so instead of showing an error", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await page.evaluate(() => document.querySelectorAll(".board-view-column-card").forEach((c) => c.remove()));
  await page.locator("#ghsm-enter").click();
  await expect(summaryNote(page)).toHaveText("No cards on this board yet.");
});

test("still presents the board without a token, with the DOM-visible signals only", async ({ context, page }) => {
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-summary .ghsm-note")).toContainText("Add a GitHub token");
  await expect(page.locator(".board-view-column-card:visible")).toHaveCount(6);
  // The visible "P1" label on card #2 still becomes a priority chip...
  await expect(card(page, 2).locator(".ghsm-chip-priority")).toHaveText("P1");
  // ...but no API-backed badge appears.
  await expect(page.locator(".ghsm-chip-stale, .ghsm-chip-orphan, .ghsm-chip-critical")).toHaveCount(0);

  await page.locator("#ghsm-exit").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(0);
});

test("counts the columns of a grouped board once, not once per horizontal section", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup-grouped.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator(".ghsm-badges").first()).toBeAttached();
  await expect(page.locator("#ghsm-summary")).toContainText("Nothing needs attention");
  // The second section's Todo holds most of the open cards, but it is the
  // intake column: its position is 0 within its section, so it is never a bottleneck.
  await expect(page.locator(".board-view-column[data-ghsm-bottleneck]")).toHaveCount(0);
});

test("says so when the dependency check could not run, instead of an all-clear", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, [
    ...API,
    { method: "GET", match: (p) => p.includes("/dependencies/"), status: 404, json: { message: "Not Found" } },
  ]);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-summary")).toContainText("Some dependencies could not be read");
  await expect(page.locator("#ghsm-summary .ghsm-ok")).toHaveCount(0);
});

test("tears down an active session when the feature is switched off mid-present", async ({ context, page }) => {
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator("body.ghsm-active")).toHaveCount(1);
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  // Flipping the feature off in Settings while presenting must stop the
  // session, not just hide the entry button.
  const worker = await backgroundWorker(context);
  await worker.evaluate(() => chrome.storage.local.set({ ghsmEnabled: false }));

  await expect(page.locator("body.ghsm-active")).toHaveCount(0);
  await expect(page.locator("#ghsm-bar")).toHaveCount(0);
  await expect(page.locator(".ghsm-badges")).toHaveCount(0);
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
});

test("offers no entry button when the feature is disabled", async ({ context, page }) => {
  await seedStorage(context, { ghsmEnabled: false });
  await routeGithub(context, "board.html");
  await page.goto(BOARD_URL);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
});

// Header variants with invented names: the description as a sibling, as a
// bare text node next to the heading, inside the heading's wrapper, absent,
// on an empty column, and as bare text directly in the column.
test("hides every description variant and keeps only the dot, the name and one pill", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup-headers.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const visibleText = (id) =>
    page.locator(`#${id}`).evaluate((col) => {
      const out = [];
      const walker = document.createTreeWalker(col, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim() || n.parentElement.closest(".board-view-column-card")) continue;
        const style = getComputedStyle(n.parentElement);
        if (style.display === "none" || parseFloat(style.fontSize) === 0 || n.parentElement.closest("[data-ghsm-hide]")) continue;
        out.push(n.textContent.trim());
      }
      return out;
    });

  const expected = {
    "c-sibling": ["Alpha", "Effort: 3"],
    "c-bare": ["Bravo", "Effort: 4"],
    "c-inner": ["Charlie", "1"],
    "c-none": ["Delta", "1"],
    "c-empty": ["Echo", "0"],
    "c-direct": ["Foxtrot", "1"],
  };
  for (const [id, texts] of Object.entries(expected)) {
    expect(await visibleText(id), id).toEqual(texts);
    const col = page.locator(`#${id}`);
    await expect(col.locator(".status-dot")).toBeVisible();
    await expect(col.locator("h3")).toBeVisible();
    await expect(col.locator('button[aria-label="Column menu"]')).toBeHidden();
    // The first card keeps its own size.
    const card = col.locator(".board-view-column-card a").first();
    if (await card.count()) await expect(card).toHaveCSS("font-size", "16px");
  }

  // Everything is restored on exit.
  await page.keyboard.press("Escape");
  await expect(page.locator("#c-bare")).toContainText("Bravo bare description");
  await expect(page.locator("[data-ghsm-quiet], [data-ghsm-sticky]")).toHaveCount(0);
  await expect(page.locator("#c-direct")).not.toHaveAttribute("style", /ghsm/);
});

test("leaves a gap under the bar and keeps sticky headers clear of it", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup-headers.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const barBottom = async () => {
    const b = await page.locator("#ghsm-bar").boundingBox();
    return b.y + b.height;
  };
  const header = page.locator("#c-sibling .column-header");
  const first = await header.boundingBox();
  expect(first.y).toBeGreaterThanOrEqual((await barBottom()) + 8 - 1);

  // The offset follows the bar's measured height.
  const h = await page.evaluate(() => document.documentElement.style.getPropertyValue("--ghsm-bar-h"));
  expect(parseFloat(h)).toBeGreaterThan(0);
  await page.evaluate(() => (document.getElementById("ghsm-bar").style.height = "80px"));
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ghsm-bar-h"))).toBe("80px");
  expect((await header.boundingBox()).y).toBeGreaterThanOrEqual((await barBottom()) + 8 - 1);

  // Scrolled, the sticky header still sits below the bar, not under it or away from it.
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(async () => Math.round((await header.boundingBox()).y - (await barBottom()))).toBe(8);
});
