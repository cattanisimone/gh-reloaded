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

  const group = page.locator('[class*="horizontalGroupHeader__"]');
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
    const board = document.querySelector('[class*="boardContainer__"]');
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
    document.querySelector('[class*="boardContainer__"]').innerHTML = window.__board;
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

// Real column headers of a grouped board: separate frames found by their
// `data-board-column` attribute, with the description as a sibling of the
// header wrapper and the count next to the name.
test("compacts the column frames of a grouped board: no description, one pill, one line", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-standup-grouped-headers.html");
  await page.goto(BOARD_URL);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(1);

  const visibleText = (id) =>
    page.locator(`#${id}`).evaluate((frame) => {
      const out = [];
      const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.replace(/ /g, " ").trim();
        if (!text || n.parentElement.closest(".prc-VisuallyHidden-VisuallyHidden-Q0qSB")) continue;
        let hidden = false;
        for (let el = n.parentElement; el && el !== frame.parentElement; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.display === "none" || parseFloat(style.fontSize) === 0) hidden = true;
        }
        if (!hidden) out.push(text);
      }
      return out;
    });

  expect(await visibleText("col-progress")).toEqual(["In Progress", "Effort: 13"]);
  expect(await visibleText("col-todo")).toEqual(["Todo", "3"]);
  expect(await visibleText("col-review")).toEqual(["In Review", "Effort: 2"]);

  for (const id of ["col-progress", "col-todo", "col-review"]) {
    const frame = page.locator(`#${id}`);
    await expect(frame.locator("button")).toBeHidden();
    // The hidden "(n)" text stays for assistive technology.
    await expect(frame.locator(".prc-VisuallyHidden-VisuallyHidden-Q0qSB")).toHaveCount(1);
    // One line: the dot and the name on the left, one pill on the right.
    const dot = await frame.locator(".ColorDecorator-module__ColorDecoratorMain__S7eSG").boundingBox();
    const name = await frame.locator("h2").boundingBox();
    const pill = await frame.locator("[data-ghsm-pill]").boundingBox();
    expect(dot.x).toBeLessThan(name.x);
    expect(pill.x).toBeGreaterThan(name.x + name.width);
    expect(Math.abs(pill.y + pill.height / 2 - (name.y + name.height / 2))).toBeLessThan(10);
  }
});

test("finds columns and cards in [data-board-column] frames, with no .board-view-column", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-data-columns.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator(".board-view-column")).toHaveCount(0);
  await expect(page.locator("#ghsm-summary .ghsm-sum-stale")).toHaveText("1 stale in review");
  await expect(card(page, 4).locator(".ghsm-chip-stale")).toHaveText("Stale");
  // The "In review" frame has no visible heading: its name is the attribute's value.
  await expect(page.locator("#ghsm-summary .ghsm-sum-bottleneck")).toHaveText("1 bottleneck");
  await expect(page.locator('[data-board-column="In review"][data-ghsm-bottleneck]')).toHaveCount(1);
  // ...and the bottleneck is drawn, not only detected.
  await expect(page.locator('[data-board-column="In review"]')).toHaveCSS("outline-style", "dashed");
});

test("still works on the previous class naming (Board-module__boardContainer--…)", async ({ context, page }) => {
  await seedStorage(context, TOKEN);
  await routeApi(context, API);
  await routeGithub(context, "board-legacy-classes.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-summary .ghsm-sum-stale")).toHaveText("1 stale in review");
});

test("offers the entry button again after the board re-renders and the view changes", async ({ context, page }) => {
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);

  // GitHub swaps the view-tabs bar and the board on in-app navigation.
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Select view"]');
    const copy = nav.cloneNode(true);
    nav.replaceWith(copy);
    history.pushState({}, "", "/orgs/acme/projects/7/views/2");
  });
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
});

test("offers no entry button on a Table view", async ({ context, page }) => {
  await routeGithub(context, "board-standup.html");
  await page.route("**/orgs/acme/projects/7", (r) => r.fallback());
  await page.goto(BOARD_URL);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
  await page.evaluate(() => {
    const svg = document.querySelector('nav[aria-label="Select view"] [aria-selected="true"] svg');
    svg.setAttribute("class", "octicon octicon-table");
  });
  await page.evaluate(() => history.pushState({}, "", "/orgs/acme/projects/7/views/3"));
  await expect(page.locator("#ghsm-enter")).toHaveCount(0);
});

// #59: with Full-width board off, Standup keeps its own copy of the layout
// rules; on a narrow swimlane board its titles, lane headers and cards must
// hold the same way.
test("standup's own board layout keeps titles, lane headers and cards in line at 800px", async ({ context, page }) => {
  await seedStorage(context, { ghfwEnabled: false });
  await routeGithub(context, "board-swimlanes.html");
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`${BOARD_URL}?groupedBy%5BcolumnId%5D=Assignees`);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("body.ghsm-active:not(.ghfw-active)")).toHaveCount(1);
  const m = await page.evaluate(() => {
    const row = '[class*="horizontalGroupHeader__"] [data-board-column]';
    const h2 = [...document.querySelectorAll(`${row} h2`)].map((e) => e.getBoundingClientRect().height);
    const last = document.querySelector('[class*="horizontalGroupAreaContainer__"] [data-board-column]:last-child').getBoundingClientRect().right;
    const lanes = [...document.querySelectorAll('[class*="styledGroupHeaderWrapper__"]')].map((e) => e.getBoundingClientRect().right);
    const card = document.querySelector(".board-view-column-card").getBoundingClientRect();
    const spill = [...document.querySelector(".board-view-column-card").querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > card.right + 0.5).length;
    return { h2, last, lanes, spill, min: document.querySelector(row).getBoundingClientRect().width };
  });
  for (const h of m.h2) expect(h).toBeLessThanOrEqual(21);
  for (const r of m.lanes) expect(Math.abs(r - m.last)).toBeLessThanOrEqual(1);
  expect(m.spill).toBe(0);
  expect(m.min).toBe(150);
});

// ---- #62: lane bands and compact column headers on narrow windows ----
const LANE_URL = `${BOARD_URL}?groupedBy%5BcolumnId%5D=Assignees`;
const BAND = '[class*="styledGroupHeaderWrapper"]';
const HEADER_ROW = '[class*="horizontalGroupHeader__"], [class*="Board-module__horizontalGroupHeader"]';
const SIZES = [1500, 1100, 800];

async function presentLanes(context, page, width, { fullWidth = true, query = "", transform, height = 900 } = {}) {
  await seedStorage(context, { ghfwEnabled: fullWidth });
  await routeGithub(context, "board-swimlanes.html", { transform });
  await page.setViewportSize({ width, height });
  await page.goto(`${LANE_URL}${query}`);
  await page.locator("#ghsm-enter").click();
  await expect(page.locator("body.ghsm-active")).toHaveCount(1);
  if (fullWidth) await expect(page.locator("body.ghfw-active")).toHaveCount(1);
  await expect(page.locator("[data-ghsm-sticky]").first()).toBeAttached();
  await page.waitForTimeout(300);
}

const sticky = (page) => page.locator(`${BAND}[data-ghsm-sticky]`);

for (const fullWidth of [true, false]) {
  for (const w of SIZES) {
    for (const lanes of ["", "&lanes=scroll"]) {
      const label = `${w}px, full-width ${fullWidth ? "on" : "off"}${lanes ? ", lanes scroll" : ""}`;
      test(`lane band sits at the top of its lane, under the header row (${label})`, async ({ context, page }) => {
        await presentLanes(context, page, w, { fullWidth, query: lanes });
        const m = await page.evaluate(({ BAND, HEADER_ROW }) => {
          const row = document.querySelector(HEADER_ROW).getBoundingClientRect();
          const band = document.querySelector(BAND);
          const b = band.getBoundingClientRect();
          const lane = band.closest('[class*="horizontalGroupAreaContainer"]').getBoundingClientRect();
          const cards = [...band.closest('[class*="horizontalGroupAreaContainer"]').querySelectorAll(".board-view-column-card")].map((c) => c.getBoundingClientRect().top);
          return { rowBottom: row.bottom, bandTop: b.top, bandBottom: b.bottom, laneTop: lane.top, firstCard: Math.min(...cards) };
        }, { BAND, HEADER_ROW });
        expect(Math.abs(m.bandTop - m.laneTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(m.bandTop - m.rowBottom)).toBeLessThanOrEqual(1);
        expect(m.bandBottom).toBeLessThanOrEqual(m.firstCard + 1);
      });

      test(`lane band spans the columns, also after scrolling sideways (${label})`, async ({ context, page }) => {
        await presentLanes(context, page, w, { fullWidth, query: lanes });
        await page.evaluate(() => {
          const v = document.querySelector('[class*="boardView__"]');
          v.scrollLeft = v.scrollWidth;
        });
        await page.waitForTimeout(100);
        const m = await page.evaluate(({ BAND, HEADER_ROW }) => {
          const frames = [...document.querySelectorAll(`:is(${HEADER_ROW}) [data-board-column]`)];
          const lastHeader = frames[frames.length - 1].getBoundingClientRect().right;
          const lastCol = [...document.querySelector('[class*="horizontalGroupAreaContainer"]').querySelectorAll("[data-board-column]")].pop().getBoundingClientRect().right;
          return { lastHeader, lastCol, bands: [...document.querySelectorAll(BAND)].map((b) => b.getBoundingClientRect().right) };
        }, { BAND, HEADER_ROW });
        for (const r of m.bands) {
          expect(Math.abs(r - m.lastCol)).toBeLessThanOrEqual(1);
          expect(Math.abs(r - m.lastHeader)).toBeLessThanOrEqual(1);
        }
      });

      test(`scrubbing the board hands bands over without overlap (${label})`, async ({ context, page }) => {
        await presentLanes(context, page, w, { fullWidth, query: `?tall${lanes}` });
        for (let step = 0; step < 12; step++) {
          await page.evaluate((y) => { document.querySelector('[class*="boardView__"]').scrollTop = y; }, step * 120);
          await page.waitForTimeout(30);
          const m = await page.evaluate(({ BAND, HEADER_ROW }) => {
            const rowBottom = document.querySelector(HEADER_ROW).getBoundingClientRect().bottom;
            const bands = [...document.querySelectorAll(BAND)].map((b) => { const r = b.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
            return { rowBottom, bands };
          }, { BAND, HEADER_ROW });
          for (let i = 1; i < m.bands.length; i++) expect(m.bands[i].top).toBeGreaterThanOrEqual(m.bands[i - 1].bottom - 1);
          for (const b of m.bands) expect(b.top).toBeGreaterThanOrEqual(m.rowBottom - 1);
          // A band whose lane is under the header row is stuck right at its bottom.
          const stuck = m.bands.filter((b) => Math.abs(b.top - m.rowBottom) <= 1);
          expect(stuck.length).toBeLessThanOrEqual(1);
          if (step >= 1 && step <= 3) expect(stuck).toHaveLength(1);
        }
      });
    }

    test(`compact headers keep the pill whole and show no scrollbar (${w}px, full-width ${fullWidth ? "on" : "off"})`, async ({ context, page }) => {
      await presentLanes(context, page, w, { fullWidth, query: "?sums" });
      const m = await page.$$eval(`:is(${HEADER_ROW}) [data-board-column]`, (frames) =>
        frames.map((f) => {
          const pill = f.querySelector("[data-ghsm-pill]").getBoundingClientRect();
          const h2 = f.querySelector("h2");
          return { overflow: f.scrollWidth - f.clientWidth, pillRight: pill.right, frameRight: f.getBoundingClientRect().right, pillText: f.querySelector("[data-ghsm-pill]").textContent, h2Over: h2.scrollWidth > h2.clientWidth, ellipsis: getComputedStyle(h2).textOverflow };
        })
      );
      expect(m).toHaveLength(6);
      for (const f of m) {
        expect(f.overflow).toBeLessThanOrEqual(0);
        expect(f.pillRight).toBeLessThanOrEqual(f.frameRight + 0.5);
        expect(f.pillText).toMatch(/^Effort: \d+$/);
        expect(f.ellipsis).toBe("ellipsis");
      }
    });
  }
}

test("gaps under the bar and around the bands are the same at every width", async ({ context, page }) => {
  const gaps = [];
  for (const w of SIZES) {
    await presentLanes(context, page, w, { query: "&lanes=scroll" });
    gaps.push(
      await page.evaluate(({ BAND, HEADER_ROW }) => {
        const bar = document.getElementById("ghsm-bar").getBoundingClientRect().bottom;
        const row = document.querySelector(HEADER_ROW).getBoundingClientRect();
        const band = document.querySelector(BAND).getBoundingClientRect();
        const card = document.querySelector(".board-view-column-card").getBoundingClientRect();
        return { barToRow: Math.round(row.top - bar), rowToBand: Math.round(band.top - row.bottom), bandToCard: Math.round(card.top - band.bottom) };
      }, { BAND, HEADER_ROW })
    );
    await page.reload();
  }
  expect(gaps[1]).toEqual(gaps[0]);
  expect(gaps[2]).toEqual(gaps[0]);
});

test("the lane band anchor matches both class namings and marks only the band", async ({ context, page }) => {
  const old = (html) => html.replace(/\bstyledGroupHeaderWrapper__(\w+)/g, "Board-module__styledGroupHeaderWrapper--$1");
  for (const transform of [undefined, old]) {
    await presentLanes(context, page, 1100, { transform });
    const m = await page.$$eval("[data-ghsm-sticky]", (els) => els.map((e) => e.className));
    const bands = m.filter((c) => /styledGroupHeaderWrapper/.test(c));
    expect(bands).toHaveLength(2);
    expect(bands.every((c) => (transform ? /Board-module__styledGroupHeaderWrapper--/.test(c) : /styledGroupHeaderWrapper__/.test(c)))).toBe(true);
    await page.reload();
  }
});

test("exit puts the band offset and the lane scrollers back", async ({ context, page }) => {
  await presentLanes(context, page, 800, { query: "&lanes=scroll" });
  await expect(page.locator("[data-ghsm-lane]")).toHaveCount(2);
  const before = await page.$$eval(BAND, (els) => els.map((e) => e.style.top));
  await page.keyboard.press("Escape");
  await expect(page.locator("body.ghsm-active")).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('[class*="ghsm"], [data-ghsm-lane], [data-ghsm-sticky], [data-ghsm-row]').length)).toBe(0);
  expect(await page.$$eval(BAND, (els) => els.map((e) => e.style.top))).toEqual(before);
  expect(await page.$$eval(".lane-scroll", (els) => els.map((e) => getComputedStyle(e).overflowX))).toEqual(["auto", "auto"]);
});
