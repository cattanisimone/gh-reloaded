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
      nodes: [{ project: { number: 7, owner: { login: "acme" } }, status: { name: status, updatedAt: daysAgo(1) }, ...extra }],
    },
  });
  switch (number) {
    case 3: // high priority, in progress
      return { ...base, ...item("In progress", { priority: { name: "High" } }) };
    case 4: // stale: six days in review
      return { ...base, ...item("In review", { status: { name: "In review", updatedAt: daysAgo(6) } }) };
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
  await expect(page.locator(".board-view-column-card:visible")).toHaveCount(5);

  // The summary names what was found.
  const summary = page.locator("#ghsm-summary");
  await expect(summary.locator(".ghsm-sum-stale")).toHaveText("1 stale in review");
  await expect(summary.locator(".ghsm-sum-orphan")).toHaveText("1 orphan block");
  await expect(summary.locator(".ghsm-sum-critical")).toHaveCount(0);

  // Cards carry their own badges: stale review, orphan block, priority.
  await expect(card(page, 4)).toHaveClass(/ghsm-flag-stale/);
  await expect(card(page, 4).locator(".ghsm-chip-stale")).toHaveText("Stale");
  await expect(card(page, 4).locator(".ghsm-chip-age")).toHaveText("6d");
  await expect(card(page, 5)).not.toHaveClass(/ghsm-flag-/);
  await expect(card(page, 6)).toHaveClass(/ghsm-flag-orphan/);
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
  await expect(page.locator("[class*='ghsm-flag-'], .ghsm-focus, [data-ghsm-sig]")).toHaveCount(0);
  await expect(page.locator("#ghsm-enter")).toHaveCount(1);
});

test("still presents the board without a token, with the DOM-visible signals only", async ({ context, page }) => {
  await routeApi(context, API);
  await routeGithub(context, "board-standup.html");
  await page.goto(BOARD_URL);

  await page.locator("#ghsm-enter").click();
  await expect(page.locator("#ghsm-summary .ghsm-note")).toContainText("Add a GitHub token");
  await expect(page.locator(".board-view-column-card:visible")).toHaveCount(5);
  // The visible "P1" label on card #2 still becomes a priority chip...
  await expect(card(page, 2).locator(".ghsm-chip-priority")).toHaveText("P1");
  // ...but no API-backed badge appears.
  await expect(page.locator(".ghsm-chip-stale, .ghsm-chip-orphan, .ghsm-chip-critical")).toHaveCount(0);

  await page.locator("#ghsm-exit").click();
  await expect(page.locator("#ghsm-bar")).toHaveCount(0);
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
