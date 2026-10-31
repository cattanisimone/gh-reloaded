// E2E: the reason tags module in the real extension, against a fixture of the
// inbox built on the measured live row structure (fictional data, signed in
// as mira). Covers tags per reason, placement and layout budget, the inline panel
// (semantics, row tie, geometry, focus), keyboard, isolation from GitHub's row
// handlers, injected nodes not feeding back, live updates, the off switch and
// contrast in both themes.
import { test, expect, routeGithub, seedStorage } from "./support/extension.js";

const INBOX = "https://github.com/notifications";
const TOKENS = { githubTokens: [{ id: "t", name: "d", token: "x", owner: "" }], defaultTokenId: "t" };
const ME = "mira";
const user = (login) => ({ __typename: "User", login });
const team = (org, slug) => ({ __typename: "Team", slug, organization: { login: org } });
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const reviewNode = (over = {}) => ({
  state: "OPEN",
  headRefOid: "h2",
  author: { login: "lee" },
  reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: user(ME) }] },
  reviews: { totalCount: 0, nodes: [] },
  timelineItems: { totalCount: 1, nodes: [{ __typename: "ReviewRequestedEvent", createdAt: iso(1), requestedReviewer: user(ME) }] },
  ...over,
});
const teamNode = () =>
  reviewNode({
    reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: team("acme-labs", "platform-reviewers") }] },
    reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: iso(0.5), author: { login: "dana", __typename: "User" }, commit: { oid: "h2" } }] },
    timelineItems: { totalCount: 1, nodes: [{ __typename: "ReviewRequestedEvent", createdAt: iso(1), requestedReviewer: team("acme-labs", "platform-reviewers") }] },
  });
const rereviewNode = () =>
  reviewNode({
    reviews: { totalCount: 1, nodes: [{ state: "CHANGES_REQUESTED", submittedAt: iso(3), author: { login: ME, __typename: "User" }, commit: { oid: "h1" } }] },
    timelineItems: { totalCount: 2, nodes: [{ __typename: "ReviewRequestedEvent", createdAt: iso(4), requestedReviewer: user(ME) }, { __typename: "ReviewRequestedEvent", createdAt: iso(1), requestedReviewer: user(ME) }] },
  });
const mentionNode = () => ({
  state: "OPEN",
  url: "https://github.com/acme-labs/atlas-web/pull/1475",
  body: "Pagination fix",
  createdAt: iso(20),
  author: { login: "lee" },
  comments: { totalCount: 1, nodes: [{ url: "https://github.com/acme-labs/atlas-web/pull/1475#issuecomment-1", body: "@mira can you look?", createdAt: iso(1), author: { login: "lee" } }] },
  reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0 },
});

// Answers by pull request number; `mode` lets a test change what #1475 is.
function graphqlFor(mode = {}) {
  return (aliases, body) => {
    const repository = {};
    for (const a of aliases) {
      const n = Number(a.slice(1));
      const review = new RegExp(`${a}: pullRequest\\(number: ${n}\\) \\{[^}]*state headRefOid`).test(body.query);
      repository[a] =
        n === 1482 ? reviewNode()
        : n === 311 ? teamNode()
        : n === 1490 ? rereviewNode()
        : n === 1475 ? (review ? reviewNode() : mentionNode())
        : null;
    }
    if (body.variables.owner === "northwind") return { data: { viewer: { login: ME }, repository: null } };
    if (mode.fail) return { status: 500, json: { message: "boom" } };
    return { data: { viewer: { login: ME }, repository } };
  };
}

async function routeApi(context, log, { graphql = graphqlFor() } = {}) {
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    log.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === "/graphql") {
      const aliases = [...body.query.matchAll(/([pi])(\d+): (?:pullRequest|issue)/g)].map((m) => `${m[1]}${m[2]}`);
      const res = graphql(aliases, body);
      return route.fulfill({ status: res.status || 200, contentType: "application/json", body: JSON.stringify(res.json ?? res) });
    }
    if (url.pathname === "/notifications") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

async function boot(context, page, { storage = TOKENS, graphql, url = INBOX, transform, width = 1500, height = 900, wait = true } = {}) {
  const log = [];
  await seedStorage(context, storage);
  await routeApi(context, log, { graphql });
  await routeGithub(context, "notifications-reason-tags.html", { transform });
  await page.setViewportSize({ width, height });
  await page.goto(url);
  if (wait) await expect(page.locator(".ghnt-tag").first()).toBeVisible();
  return { log };
}

const rowOf = (page, path) => page.locator("li.notifications-list-item", { has: page.locator(`a[href*="${path}"]`) });
const tagIn = (page, path) => rowOf(page, path).locator(".ghnt-tag");
const panelOf = (page, path) => rowOf(page, path).locator("xpath=following-sibling::*[1][self::li and contains(@class,'ghnt-why')]");
const rec = (page) => page.evaluate(() => window.__rec.slice());
// The focused element, named, so a failure says what took focus.
const activeOf = (page) => page.evaluate(() => (document.activeElement === document.body ? "body" : document.activeElement?.outerHTML.slice(0, 160) ?? "null"));

const EXPECTED = [
  ["pull/1482", "Direct review request"],
  ["pull/311", "Team review request"],
  ["pull/1490", "Re-review requested"],
  ["pull/1475", "Mention"],
  ["pull/204", "Unverifiable"],
  ["pull/77", "Subscribed"],
  ["runs/7", "CI"],
];

test("every tag shows text, an icon and an aria-label; the order stays native; other reasons get nothing", async ({ context, page }) => {
  await boot(context, page);
  for (const [path, label] of EXPECTED) {
    const tag = tagIn(page, path);
    await expect(tag).toHaveText(label);
    await expect(tag.locator("svg[aria-hidden='true']")).toHaveCount(1);
    expect(await tag.getAttribute("aria-label")).toMatch(new RegExp(`^${label}: .{10,}`));
  }
  await expect(rowOf(page, "issues/70").locator(".ghnt-tag, .ghnt-line")).toHaveCount(0);
  const hrefs = await page.locator("li.notifications-list-item a.notification-list-item-link").evaluateAll((as) => as.map((a) => new URL(a.href).pathname));
  expect(hrefs[0]).toBe("/acme-labs/atlas-web/pull/1482");
  expect(hrefs.length).toBe(9);
});

test("the live label 'mention' gets a Mention tag, and every tag has its mockup tone", async ({ context, page }) => {
  await boot(context, page);
  expect(await rowOf(page, "pull/1475").locator("span.f6").first().innerText()).toBe("mention");
  await expect(tagIn(page, "pull/1475")).toHaveText("Mention");
  for (const [path, tone] of [["pull/1482", "accent"], ["pull/311", "attention"], ["pull/1490", "accent"], ["pull/1475", "done"], ["pull/204", "severe"], ["pull/77", "neutral"], ["runs/7", "neutral"]]) {
    await expect(tagIn(page, path)).toHaveClass(new RegExp(`\\bghnt-tone-${tone}\\b`));
  }
});

test("no injected class contains 'reason'", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/1482").click();
  const bad = await page.evaluate(() => [...document.querySelectorAll("[class*='ghnt-']")].filter((e) => /reason/i.test(e.getAttribute("class"))).length);
  expect(bad).toBe(0);
});

test("on by default: no stored preference is needed, and nothing is written", async ({ context, page }) => {
  await boot(context, page);
  const worker = context.serviceWorkers()[0];
  expect(await worker.evaluate(() => chrome.storage.local.get("ghntModules"))).toEqual({});
});

test("no token: Mention, Subscribed and CI are shown, review rows are Unverifiable", async ({ context, page }) => {
  await boot(context, page, { storage: { githubTokens: [], defaultTokenId: "" } });
  await expect(tagIn(page, "pull/1475")).toHaveText("Mention");
  await expect(tagIn(page, "pull/77")).toHaveText("Subscribed");
  await expect(tagIn(page, "runs/7")).toHaveText("CI");
  for (const p of ["pull/1482", "pull/311", "pull/1490"]) await expect(tagIn(page, p)).toHaveText("Unverifiable");
  await tagIn(page, "pull/1482").click();
  const pop = page.locator(".ghnt-why-card");
  await expect(pop).toContainText("no GitHub token for acme-labs");
  await expect(pop.getByRole("button", { name: "Open GitHub tokens settings" })).toBeVisible();
});

// --- placement ---------------------------------------------------------------

const measure = (page, path) =>
  rowOf(page, path).evaluate((li) => {
    const r = (el) => el.getBoundingClientRect();
    const line = li.querySelector(".ghnt-line");
    const link = li.querySelector("a.notification-list-item-link");
    const text = link.querySelector(":scope > div.flex-auto");
    const cluster = li.querySelector(".cluster");
    const tag = line.querySelector(".ghnt-tag");
    const cs = getComputedStyle(li);
    const before = line.style.display;
    line.style.display = "none";
    const nativeHeight = r(li).height;
    const nativeTitleWidth = r(link).width;
    line.style.display = before;
    return {
      lastChild: li.lastElementChild === line,
      afterResponsive: li.lastElementChild.previousElementSibling.matches("ul.notification-list-item-actions-responsive"),
      padding: parseFloat(getComputedStyle(line).paddingLeft),
      expectedPadding: r(text).left - r(li).left - parseFloat(cs.paddingLeft),
      tagLeft: r(tag).left,
      titleLeft: r(text).left,
      lineHeight: r(line).height,
      growth: r(li).height - nativeHeight,
      titleWidth: r(link).width,
      nativeTitleWidth,
      inLink: link.contains(line),
      inCluster: cluster.contains(line),
      clipped: tag.scrollWidth > tag.clientWidth,
      tagRight: r(tag).right,
      liRight: r(li).right,
    };
  });

for (const [width, extra] of [[1500, ""], [1100, ""], [800, ""], [360, "#nosidebar"]]) {
  test(`placement at ${width}px: own line under the title, title column, growth <= 24px`, async ({ context, page }) => {
    await boot(context, page, { width, url: `${INBOX}${extra}` });
    for (const path of ["pull/1482", "pull/1475", "pull/77", "pull/1500"]) {
      // The rows render one after another: measure a row only once its line is there.
      await expect(tagIn(page, path)).toBeVisible();
      const m = await measure(page, path);
      const why = JSON.stringify({ width, path, ...m });
      expect(m.lastChild, why).toBe(true);
      expect(m.afterResponsive, why).toBe(true);
      expect(m.padding, why).toBeCloseTo(m.expectedPadding, 0);
      // Lead (37px, 29px below 768px) plus the link's status icon (16px + 8px).
      expect(m.padding, why).toBeCloseTo(width >= 768 ? 61 : 53, 0);
      expect(Math.abs(m.tagLeft - m.titleLeft), why).toBeLessThanOrEqual(1);
      expect(m.lineHeight, why).toBe(24);
      expect(m.growth, why).toBeLessThanOrEqual(24);
      expect(m.titleWidth, why).toBe(m.nativeTitleWidth);
      expect(m.inLink || m.inCluster, why).toBe(false);
      expect(m.clipped, why).toBe(false);
      expect(m.tagRight, why).toBeLessThanOrEqual(m.liRight);
    }
  });
}


// One left column (documented in reason-tags.css): the pill's and the card's border boxes start at the
// title text's left (the div.flex-auto after the link's status icon, not the link); the card's content starts at the tag icon, its marks share the icon's column and
// its line text the tag label's column.
const columns = (page, path) =>
  rowOf(page, path).evaluate((li) => {
    const left = (el) => (el ? Math.round(el.getBoundingClientRect().left * 100) / 100 : null);
    const panel = li.nextElementSibling?.matches(".ghnt-why") ? li.nextElementSibling : null;
    const card = panel?.querySelector(".ghnt-why-card");
    const line = card?.querySelector(".ghnt-why-line:not(.ghnt-why-rule):not(.ghnt-why-linkrow)");
    return {
      // The title text column: the div after the link's status icon, not the link.
      title: left(li.querySelector("a.notification-list-item-link > div.flex-auto")),
      link: left(li.querySelector("a.notification-list-item-link")),
      tag: left(li.querySelector(".ghnt-tag")),
      icon: left(li.querySelector(".ghnt-tag .ghnt-icon")),
      label: left(li.querySelector(".ghnt-tag-text")),
      rowLi: left(li),
      panelLi: left(panel),
      card: left(card),
      cardTitle: left(card?.querySelector(".ghnt-why-title")),
      mark: left(line?.querySelector(".ghnt-why-mark")),
      text: left(line?.querySelector(".ghnt-why-mark + span")),
    };
  });

function expectColumns(c, why) {
  const near = (a, b, what) => expect(Math.abs(a - b), `${what}: ${why} ${JSON.stringify(c)}`).toBeLessThanOrEqual(0.5);
  near(c.tag, c.title, "tag left vs title text left");
  expect(c.title - c.link, `title text is past the link's status icon: ${why} ${JSON.stringify(c)}`).toBeGreaterThan(20);
  if (c.card === null) return;
  near(c.panelLi, c.rowLi, "panel li left vs row li left (accent bar)");
  near(c.card, c.tag, "card left vs tag left");
  near(c.cardTitle, c.icon, "card content vs tag icon");
  near(c.mark, c.icon, "card mark vs tag icon");
  near(c.text, c.label, "card line text vs tag label");
}

for (const [width, extra] of [[1500, ""], [1100, ""], [800, ""], [360, "#nosidebar"]]) {
  for (const [theme, hash] of [["light", ""], ["dark", "#dark"]]) {
    test(`left column at ${width}px (${theme}): title, tag and open card line up on unread and read rows`, async ({ context, page }) => {
      await boot(context, page, { width, url: `${INBOX}${extra}${hash}` });
      for (const path of ["pull/1482", "pull/77", "pull/1500"]) {
        await expect(tagIn(page, path)).toBeVisible();
        expectColumns(await columns(page, path), `${width} ${theme} ${path} closed`);
        await tagIn(page, path).click();
        await expect(panelOf(page, path)).toHaveCount(1);
        expectColumns(await columns(page, path), `${width} ${theme} ${path} open`);
        // The accent bar of the active state moves nothing.
        await rowOf(page, path).hover({ position: { x: 4, y: 4 } });
        await expect.poll(() => panelOf(page, path).getAttribute("data-ghnt-active")).not.toBeNull();
        expectColumns(await columns(page, path), `${width} ${theme} ${path} active`);
        await page.mouse.move(2, 2);
        await tagIn(page, path).click();
        await expect(page.locator(".ghnt-why")).toHaveCount(0);
      }
    });
  }
}

test("left column in grouped mode, across the 768px breakpoint and with the sidebar toggled", async ({ context, page }) => {
  await boot(context, page, { width: 1100, url: `${INBOX}#grouped` });
  const path = "pull/311";
  await expect(tagIn(page, path)).toBeVisible();
  await tagIn(page, path).click();
  expectColumns(await columns(page, path), "grouped 1100");
  for (const width of [700, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => { const c = await columns(page, path); return Math.abs(c.card - c.title) + Math.abs(c.tag - c.title); }).toBeLessThanOrEqual(1);
    expectColumns(await columns(page, path), `grouped ${width}`);
  }
  await page.evaluate(() => document.getElementById("side").classList.toggle("closed"));
  await expect.poll(async () => { const c = await columns(page, path); return Math.abs(c.card - c.title) + Math.abs(c.tag - c.title); }).toBeLessThanOrEqual(1);
  expectColumns(await columns(page, path), "grouped, sidebar toggled");
});

test("a lead column that changes width without resizing the list keeps tag and card on the title column", async ({ context, page }) => {
  await boot(context, page);
  for (const path of ["pull/1482", "pull/77"]) await expect(tagIn(page, path)).toBeVisible();
  await tagIn(page, "pull/77").click();
  await expect(panelOf(page, "pull/77")).toHaveCount(1);
  // Selection mode, a font swap or GitHub re-laying out the row: only the lead column changes.
  const listWidth = () => page.evaluate(() => document.querySelector("ul.list").getBoundingClientRect().width);
  const w = await listWidth();
  // The rule is in place before; only a class flips, so no node is added or removed.
  await page.evaluate(() => document.head.insertAdjacentHTML("beforeend", "<style>body.wide-lead .lead { width: 61px !important; }</style>"));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.body.classList.add("wide-lead"));
  expect(await listWidth()).toBe(w);
  for (const path of ["pull/1482", "pull/77"]) {
    await expect.poll(async () => { const c = await columns(page, path); return Math.abs(c.tag - c.title) + (c.card === null ? 0 : Math.abs(c.card - c.title)); }, `${path} after the lead grew`).toBeLessThanOrEqual(0.5);
    expectColumns(await columns(page, path), `${path} wide lead`);
  }
  await page.evaluate(() => document.body.classList.remove("wide-lead"));
  for (const path of ["pull/1482", "pull/77"]) {
    await expect.poll(async () => { const c = await columns(page, path); return Math.abs(c.tag - c.title) + (c.card === null ? 0 : Math.abs(c.card - c.title)); }, `${path} after the lead shrank back`).toBeLessThanOrEqual(0.5);
  }
});

test("no title text in the link: no tag on that row, and the tag comes back once the text is there", async ({ context, page }) => {
  await boot(context, page);
  const path = "pull/77";
  await expect(tagIn(page, path)).toBeVisible();
  // GitHub renders the link with its status icon only (the text column not there yet).
  await rowOf(page, path).evaluate((li) => { const d = li.querySelector("a.notification-list-item-link > div.flex-auto"); window.__heldText = d; d.remove(); });
  await expect(rowOf(page, path).locator(".ghnt-line")).toHaveCount(0);
  // Never placed against the link or the icon in the meantime.
  await page.waitForTimeout(300);
  await expect(rowOf(page, path).locator(".ghnt-line")).toHaveCount(0);
  await rowOf(page, path).evaluate((li) => li.querySelector("a.notification-list-item-link").append(window.__heldText));
  await expect(tagIn(page, path)).toBeVisible();
  expectColumns(await columns(page, path), "text column back");
});

test("a link that holds its text directly (no status icon) keeps the tag on the text", async ({ context, page }) => {
  await boot(context, page);
  const path = "pull/1482";
  await expect(tagIn(page, path)).toBeVisible();
  // The older markup: the repo line and the title straight under the link.
  await rowOf(page, path).evaluate((li) => { const a = li.querySelector("a.notification-list-item-link"); a.querySelector(".status").remove(); a.append(...a.querySelector("div.flex-auto").children); a.querySelector("div.flex-auto").remove(); });
  await expect.poll(() => rowOf(page, path).evaluate((li) => {
    const tag = li.querySelector(".ghnt-tag");
    return tag ? Math.abs(tag.getBoundingClientRect().left - li.querySelector("a.notification-list-item-link p").getBoundingClientRect().left) : 99;
  })).toBeLessThanOrEqual(0.5);
});

test("a row replaced by GitHub keeps tag and open card on the title column", async ({ context, page }) => {
  await boot(context, page);
  const path = "pull/77";
  await expect(tagIn(page, path)).toBeVisible();
  await tagIn(page, path).click();
  await page.evaluate((p) => window.__fx.replaceRow(p), path);
  await expect(panelOf(page, path)).toHaveCount(1);
  // The old card can still match the title before the new row gets its tag back, so wait for the tag first.
  await expect(tagIn(page, path)).toBeVisible();
  await expect.poll(async () => { const c = await columns(page, path); return c.card === null || c.tag === null ? 99 : Math.abs(c.card - c.title) + Math.abs(c.tag - c.title); }).toBeLessThanOrEqual(0.5);
  expectColumns(await columns(page, path), "replaced row");
});

test("grouped by repository: per row, headers untouched", async ({ context, page }) => {
  await boot(context, page, { url: `${INBOX}#grouped` });
  expect(await page.locator("h3.group .ghnt-line, h3.group .ghnt-tag").count()).toBe(0);
  await expect(page.locator(".ghnt-line")).toHaveCount(8);
  const m = await measure(page, "pull/311");
  expect(m.lastChild).toBe(true);
  expect(m.growth).toBeLessThanOrEqual(24);
});

test("a li that is a non-wrapping flex row gets no tag; the rest do", async ({ context, page }) => {
  await boot(context, page, { wait: false, transform: (html) => html.replace("</style>", "li.notifications-list-item:first-child { display: flex; flex-wrap: nowrap; }</style>") });
  await expect(tagIn(page, "pull/311")).toBeVisible();
  await expect(rowOf(page, "pull/1482").locator(".ghnt-line")).toHaveCount(0);
});

test("a row whose native label is gone has no tag and nothing else is used", async ({ context, page }) => {
  await boot(context, page);
  await page.evaluate(() => window.__fx.setLabel("pull/77", null));
  await expect(rowOf(page, "pull/77").locator(".ghnt-line")).toHaveCount(0);
  // The tag of another row is still there; the removed one is not read back as "Subscribed".
  await expect(tagIn(page, "pull/1482")).toBeVisible();
  await page.waitForTimeout(600);
  await expect(rowOf(page, "pull/77").locator(".ghnt-line")).toHaveCount(0);
});

// --- panel ---------------------------------------------------------------------

const rowStyle = (loc) =>
  loc.evaluate((n) => {
    const cs = getComputedStyle(n);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, bb: cs.borderBottomWidth, bbc: cs.borderBottomColor, h: n.getBoundingClientRect().height };
  });
const ACTIVE_BG = "rgb(221, 244, 255)";

test("panel opens under its row, labelled; Esc closes it and returns focus to the tag", async ({ context, page }) => {
  await boot(context, page);
  const tag = tagIn(page, "pull/311");
  await expect(tag).toHaveAttribute("aria-expanded", "false");
  await tag.click();
  const panel = panelOf(page, "pull/311");
  const card = page.getByRole("region", { name: "Why is this here?" });
  await expect(panel).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(tag).toHaveAttribute("aria-expanded", "true");
  await expect(tag).toHaveAttribute("aria-controls", (await panel.getAttribute("id")) || "");
  await expect(tag).toBeFocused();
  await expect(card).toContainText("GitHub reason: review requested");
  await expect(card).toContainText("Request addressed to team acme-labs/platform-reviewers, not to you");
  await expect(card).toContainText("Review by dana APPROVED (does not satisfy a pending request)");
  await expect(card).toContainText("A team request does not mean the review is owed by you");
  expect(await panel.evaluate((n) => n.parentElement === n.previousElementSibling.parentElement && !n.className.includes("notifications-list-item") && getComputedStyle(n).position)).toBe("static");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
  await expect(tag).toBeFocused();
  await expect(tag).toHaveAttribute("aria-expanded", "false");
});

test("clicking the same tag again closes it; opening another closes the first", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/1482").click();
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  await tagIn(page, "pull/1482").click();
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
  await tagIn(page, "pull/1482").click();
  await tagIn(page, "pull/1475").click();
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  await expect(page.locator(".ghnt-why")).toContainText("Mentioned by @lee in a comment");
  await expect(tagIn(page, "pull/1482")).toHaveAttribute("aria-expanded", "false");
  await expect(tagIn(page, "pull/1475")).toBeFocused();
});

for (const { path, label, links } of [
  { path: "pull/1482", label: "Direct", links: 0 },
  { path: "pull/204", label: "Unverifiable", links: 1 },
]) {
  test(`${label}: the panel is in the tab order, tag then link then the next row, and back`, async ({ context, page }) => {
    await boot(context, page);
    const tag = tagIn(page, path);
    await tag.focus();
    await page.keyboard.press("Tab");
    const afterClosed = await page.evaluate(() => (window.__after = document.activeElement) && document.activeElement.outerHTML.slice(0, 60));
    await tag.focus();
    await page.keyboard.press("Enter");
    await expect(panelOf(page, path)).toHaveCount(1);
    await expect(tag).toBeFocused();
    for (let i = 0; i < links; i++) {
      await page.keyboard.press("Tab");
      await expect(panelOf(page, path).locator(".ghnt-why-link").nth(i)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement === window.__after), `Tab leaves the panel for ${afterClosed}`).toBe(true);
    expect(await page.evaluate(() => /skip/i.test(document.activeElement.outerHTML.slice(0, 80)))).toBe(false);
    await expect(panelOf(page, path)).toHaveCount(1);
    for (let i = 0; i < links + 1; i++) await page.keyboard.press("Shift+Tab");
    await expect(tag).toBeFocused();
    await expect(panelOf(page, path)).toHaveCount(1);
  });
}

test("scroll, PageDown, ArrowDown and resize keep the panel open and the focus where it is", async ({ context, page }) => {
  await boot(context, page);
  const tag = tagIn(page, "pull/204");
  await tag.click();
  const link = panelOf(page, "pull/204").locator(".ghnt-why-link");
  for (const act of [
    () => page.keyboard.press("PageDown"),
    () => page.keyboard.press("ArrowDown"),
    () => page.mouse.wheel(0, 200),
    () => page.setViewportSize({ width: 1100, height: 700 }),
    () => page.setViewportSize({ width: 360, height: 700 }),
    () => page.mouse.click(5, 5),
  ]) {
    await tag.focus();
    await act();
    await page.waitForTimeout(100);
    await expect(page.locator(".ghnt-why")).toHaveCount(1);
    await expect(tag).toHaveAttribute("aria-expanded", "true");
  }
  await tag.focus();
  await page.keyboard.press("PageDown");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
});

test("Esc from the panel link closes it and focuses the tag", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  await panelOf(page, "pull/204").locator(".ghnt-why-link").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
  await expect(tagIn(page, "pull/204")).toBeFocused();
});

test("an open panel is not rebuilt by unrelated page changes", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  const link = panelOf(page, "pull/204").locator(".ghnt-why-link");
  await link.focus();
  await page.evaluate(() => (window.__node = document.querySelector(".ghnt-why")) && document.body.append(document.createElement("span")));
  await page.waitForTimeout(700);
  await expect(link).toBeFocused();
  expect(await page.evaluate(() => document.querySelector(".ghnt-why") === window.__node)).toBe(true);
});

for (const where of ["tag", "link"]) {
  test(`GitHub replaces the row while focus is on the ${where}: panel and tag come back, focus on the new tag`, async ({ context, page }) => {
    await boot(context, page);
    await tagIn(page, "pull/204").click();
    if (where === "link") await panelOf(page, "pull/204").locator(".ghnt-why-link").focus();
    else await tagIn(page, "pull/204").focus();
    await page.evaluate(() => window.__fx.replaceRow("pull/204"));
    await expect(panelOf(page, "pull/204")).toHaveCount(1);
    await expect(page.locator(".ghnt-why")).toHaveCount(1);
    await expect(tagIn(page, "pull/204")).toBeFocused();
    await expect(tagIn(page, "pull/204")).toHaveAttribute("aria-expanded", "true");
    expect(await rowOf(page, "pull/204").getAttribute("data-ghnt-why-open")).not.toBeNull();
  });
}

test("a replaced row does not take focus the user already moved elsewhere", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  await rowOf(page, "pull/311").locator("input[type=checkbox]").focus();
  await page.evaluate(() => window.__fx.replaceRow("pull/204"));
  await expect(panelOf(page, "pull/204")).toHaveCount(1);
  await expect(rowOf(page, "pull/311").locator("input[type=checkbox]")).toBeFocused();
});

test("after a click on empty page space, later renders do not pull focus back to the tag; j reaches GitHub", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  await expect(tagIn(page, "pull/204")).toBeFocused();
  await page.locator("header").click({ position: { x: 2, y: 2 } });
  expect(await activeOf(page)).toBe("body");
  // A resize (relayout) and an unrelated node (render) both re-render the open panel.
  await page.setViewportSize({ width: 1450, height: 900 });
  await page.evaluate(() => document.body.append(document.createElement("span")));
  await page.waitForTimeout(700);
  expect(await activeOf(page)).toBe("body");
  expect(await rowOf(page, "pull/204").getAttribute("data-ghnt-active")).toBeNull();
  await page.evaluate(() => (window.__rec.length = 0));
  await page.keyboard.press("j");
  expect(await rec(page)).toContain("b:key:j");
});

// A slow runner can run a render before any timer fires after the click: the decision
// that the user left must not wait for one. A resize dispatched in the same task as
// the focusout stands in for that render.
test("a render right after a click on empty page space does not pull focus back to the tag", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  await expect(tagIn(page, "pull/204")).toBeFocused();
  await page.evaluate(() =>
    window.addEventListener("focusout", () => queueMicrotask(() => window.dispatchEvent(new Event("resize"))), { capture: true, once: true }),
  );
  await page.locator("header").click({ position: { x: 2, y: 2 } });
  await page.waitForTimeout(300);
  expect(await activeOf(page)).toBe("body");
  await page.setViewportSize({ width: 1450, height: 900 });
  await page.evaluate(() => document.body.append(document.createElement("span")));
  await page.waitForTimeout(700);
  expect(await activeOf(page)).toBe("body");
});

test("Esc on another row's tag leaves the open panel and the focus alone", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/1482").click();
  await tagIn(page, "pull/1475").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  await expect(tagIn(page, "pull/1482")).toHaveAttribute("aria-expanded", "true");
  await expect(tagIn(page, "pull/1475")).toBeFocused();
});

test("a panel or tag line removed by someone else comes back on the next scan", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  await page.evaluate(() => {
    document.querySelector(".ghnt-why").remove();
    document.querySelector("li a[href*='pull/77']").closest("li").querySelector(".ghnt-line").remove();
  });
  await expect(panelOf(page, "pull/204")).toHaveCount(1);
  await expect(tagIn(page, "pull/204")).toHaveAttribute("aria-expanded", "true");
  await expect(tagIn(page, "pull/77")).toHaveCount(1);
  // One click still closes it: the panel is not a ghost.
  await tagIn(page, "pull/204").click();
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
});

// Row and panel read as one item (C18, C20-C23).
for (const [name, hash] of [["light", ""], ["dark", "#dark"]]) {
  test(`panel matches its row: unread, read, hovered, focused, selected (${name})`, async ({ context, page }) => {
    await boot(context, page, { url: `${INBOX}${hash}` });
    const colors = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { unread: cs.getPropertyValue("--color-notifications-row-bg").trim(), read: cs.getPropertyValue("--color-notifications-row-read-bg").trim() };
    });
    expect(colors.unread).not.toBe(colors.read);
    for (const path of ["pull/204", "pull/77"]) {
      const row = rowOf(page, path);
      const panel = panelOf(page, path);
      await expect(tagIn(page, path)).toBeVisible();
      const nativeRow = await rowStyle(row);
      const rowH = nativeRow.h;
      await tagIn(page, path).click();
      await page.mouse.move(2, 2);
      await expect(panel).toHaveCount(1);
      await page.evaluate(() => document.activeElement.blur());
      const rest = await rowStyle(row);
      const p = await rowStyle(panel);
      expect(p.bg, `${path} panel vs row background`).toBe(rest.bg);
      expect(rest.bg).not.toBe(ACTIVE_BG);
      expect(rest.h, "row height unchanged").toBe(rowH);
      expect(rest.bbc, "row divider hidden").toBe("rgba(0, 0, 0, 0)");
      expect(rest.bb).toBe(nativeRow.bb);
      expect(p.bb).toBe("1px");
      expect(await row.evaluate((n) => n.getAttribute("data-ghnt-active"))).toBeNull();
      // j/k selection
      await page.evaluate((k) => window.__fx.navFocus(k), path);
      await expect.poll(() => panel.getAttribute("data-ghnt-active")).not.toBeNull();
      const sel = await rowStyle(panel);
      expect(sel.shadow).toContain("2px 0px 0px 0px inset");
      expect((await rowStyle(row)).bg).toBe(sel.bg);
      await page.evaluate((k) => window.__fx.navFocus(k, false), path);
      await expect.poll(() => panel.getAttribute("data-ghnt-active")).toBeNull();
      // pointer on the panel only
      await panel.hover();
      await expect.poll(() => row.getAttribute("data-ghnt-active")).not.toBeNull();
      expect((await rowStyle(row)).bg).toBe((await rowStyle(panel)).bg);
      expect((await rowStyle(row)).shadow).toContain("inset");
      await page.mouse.move(2, 2);
      await expect.poll(() => row.getAttribute("data-ghnt-active")).toBeNull();
      // pointer on the row only
      await row.hover({ position: { x: 4, y: 4 } });
      await expect.poll(() => panel.getAttribute("data-ghnt-active")).not.toBeNull();
      expect((await rowStyle(panel)).bg).toBe((await rowStyle(row)).bg);
      await page.mouse.move(2, 2);
      await tagIn(page, path).focus();
      await page.keyboard.press("Escape");
      await expect(page.locator(".ghnt-why")).toHaveCount(0);
      expect(await row.evaluate((n) => [...n.attributes].filter((a) => a.name.startsWith("data-ghnt")).length)).toBe(0);
      expect((await rowStyle(row)).bbc).not.toBe("rgba(0, 0, 0, 0)");
    }
  });
}

test("opening with Enter makes row and panel active; Tab into the link keeps them, Tab out restores", async ({ context, page }) => {
  await boot(context, page);
  for (const path of ["pull/204", "pull/77"]) {
    const row = rowOf(page, path);
    const panel = panelOf(page, path);
    await page.mouse.move(2, 2);
    const tag = tagIn(page, path);
    await tag.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(1);
    expect((await rowStyle(row)).bg).toBe(ACTIVE_BG);
    expect((await rowStyle(panel)).bg).toBe(ACTIVE_BG);
    expect((await rowStyle(panel)).shadow).toContain("inset");
    if (path === "pull/204") {
      await page.keyboard.press("Tab");
      await expect(panel.locator(".ghnt-why-link")).toBeFocused();
      expect((await rowStyle(row)).bg).toBe(ACTIVE_BG);
      expect((await rowStyle(panel)).bg).toBe(ACTIVE_BG);
      await page.keyboard.press("Tab");
    } else {
      await page.keyboard.press("Tab");
    }
    await expect.poll(async () => (await rowStyle(row)).bg).not.toBe(ACTIVE_BG);
    await expect.poll(async () => (await rowStyle(panel)).bg).not.toBe(ACTIVE_BG);
    await tag.focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => document.activeElement.blur());
  }
});

test("panel under the last row: the row keeps its height and no divider, the panel has none", async ({ context, page }) => {
  await boot(context, page);
  const row = rowOf(page, "pull/1500");
  await expect(tagIn(page, "pull/1500")).toBeVisible();
  const before = await rowStyle(row);
  expect(before.bb).toBe("0px");
  await tagIn(page, "pull/1500").click();
  const panel = panelOf(page, "pull/1500");
  await expect(panel).toHaveCount(1);
  const open = await rowStyle(row);
  expect(open.h).toBe(before.h);
  expect(open.bb).toBe("0px");
  expect((await rowStyle(panel)).bb).toBe("0px");
  await page.keyboard.press("Escape");
  const closed = await rowStyle(row);
  expect(closed.bb).toBe("0px");
  expect(closed.h).toBe(before.h);
});

for (const [width, extra] of [[1500, ""], [1100, ""], [800, ""], [360, "#nosidebar"]]) {
  test(`panel geometry at ${width}px: row and title unchanged, panel inside the list, no horizontal scroll`, async ({ context, page }) => {
    await boot(context, page, { width, url: `${INBOX}${extra}` });
    const path = "pull/204";
    const snap = () =>
      rowOf(page, path).evaluate((li) => {
        const link = li.querySelector("a.notification-list-item-link");
        return { h: li.getBoundingClientRect().height, tw: link.getBoundingClientRect().width };
      });
    await expect(tagIn(page, path)).toBeVisible();
    const before = await snap();
    await tagIn(page, path).click();
    const after = await snap();
    expect(after).toEqual(before);
    const g = await page.evaluate((p) => {
      const li = document.querySelector(`li a[href*="${p}"]`).closest("li");
      const panel = li.nextElementSibling;
      const cardEl = panel.querySelector(".ghnt-why-card");
      const card = cardEl.getBoundingClientRect();
      const tag = li.querySelector(".ghnt-tag").getBoundingClientRect();
      const list = li.parentElement.getBoundingClientRect();
      const actionsEl = li.querySelector("ul.notification-list-item-actions-responsive");
      const actions = actionsEl.getBoundingClientRect();
      const rowBox = li.getBoundingClientRect();
      const rowContentRight = rowBox.right - (parseFloat(getComputedStyle(li).paddingRight) || 0);
      return { cardLeft: card.left, cardRight: card.right, cardTop: card.top, cardW: card.width, tagLeft: tag.left, rowContentRight, listRight: list.right, listLeft: list.left, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, liBottom: li.getBoundingClientRect().bottom, actionsBottom: actions.bottom, display: getComputedStyle(actionsEl).display, radius: getComputedStyle(cardEl).borderRadius };
    }, path);
    expect(Math.abs(g.cardLeft - g.tagLeft)).toBeLessThanOrEqual(1);
    expect(g.cardRight).toBeLessThanOrEqual(g.listRight);
    expect(g.cardLeft).toBeGreaterThanOrEqual(g.listLeft);
    expect(Math.abs(g.cardRight - g.rowContentRight), `card right vs row content right: ${JSON.stringify(g)}`).toBeLessThanOrEqual(1);
    if (width >= 1100) expect(g.cardW, `card fills the row: ${JSON.stringify(g)}`).toBeGreaterThan(340);
    expect(g.radius, "Primer card radius").toBe("6px");
    expect(g.scroll).toBeLessThanOrEqual(0);
    expect(g.cardTop).toBeGreaterThanOrEqual(g.liBottom - 1);
    if (g.display !== "none") expect(g.cardTop).toBeGreaterThanOrEqual(g.actionsBottom - 1);
  });
}

test("the panel is not read as a row: findRow and the next scan ignore it", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/1475").click();
  await page.waitForTimeout(500);
  await expect(page.locator(".ghnt-tag")).toHaveCount(8);
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  expect(await page.locator("li.notifications-list-item").count()).toBe(9);
});

test("the sibling li is the panel's place on current markup (no fallback inside the row)", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/1482").click();
  expect(await rowOf(page, "pull/1482").locator(".ghnt-why").count()).toBe(0);
  expect(await panelOf(page, "pull/1482").count()).toBe(1);
});

test("clicks and keys inside the panel never reach GitHub's handlers; j/k skip the panel li", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  const card = panelOf(page, "pull/204").locator(".ghnt-why-card");
  await card.click({ position: { x: 4, y: 4 } });
  await panelOf(page, "pull/204").locator(".ghnt-why-link").focus();
  for (const k of ["j", "k", "x", "?"]) await page.keyboard.press(k);
  expect(await rec(page)).toEqual([]);
  expect(await page.locator(".ghnt-why.js-navigation-item, .ghnt-why[class*='Box-row']").count()).toBe(0);
});

test("click, Enter, Space and ? on the tag never reach GitHub's handlers; ? and j/k elsewhere do", async ({ context, page }) => {
  await boot(context, page);
  const tag = tagIn(page, "pull/1482");
  await tag.click();
  await page.keyboard.press("Escape");
  await tag.focus();
  for (const k of ["Enter", "Escape", " ", "Escape", "?", "Escape", "j", "k", "x"]) await page.keyboard.press(k);
  expect(await rec(page)).toEqual([]);
  // Elsewhere GitHub still hears everything.
  await rowOf(page, "pull/311").locator("input[type=checkbox]").focus();
  await page.keyboard.press("?");
  await page.keyboard.press("j");
  const heard = await rec(page);
  expect(heard).toContain("c:key:?");
  expect(heard).toContain("b:key:j");
  await page.evaluate(() => (window.__rec.length = 0));
  await rowOf(page, "pull/311").click({ position: { x: 2, y: 2 } });
  expect(await rec(page)).toContain("c:click-row");
  // The checkbox is untouched by the tag.
  expect(await rowOf(page, "pull/1482").locator("input[type=checkbox]").isChecked()).toBe(false);
});

test("Tab reaches the tag; Enter and ? open it; Esc closes it and restores focus", async ({ context, page }) => {
  await boot(context, page);
  await rowOf(page, "pull/1482").locator("input[type=checkbox]").focus();
  let hops = 0;
  const tag = tagIn(page, "pull/1482");
  while (!(await tag.evaluate((n) => n === document.activeElement)) && hops++ < 6) await page.keyboard.press("Tab");
  await expect(tag).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(tag).toBeFocused();
  await page.keyboard.press("?");
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(page.locator(".ghnt-why")).toHaveCount(1);
});

// --- live updates, switch --------------------------------------------------------

test("a reason that changes updates the tag without a reload and highlights the row for 3 s", async ({ context, page }) => {
  await boot(context, page);
  const tag = tagIn(page, "pull/1475");
  await expect(tag).toHaveText("Mention");
  const li = rowOf(page, "pull/1475");
  await expect(li).not.toHaveClass(/ghnt-hl/);
  await tag.click();
  // Every text the tag shows while it changes: it must never flash "Unverifiable".
  await page.evaluate(() => {
    window.__seen = [];
    const t = document.querySelector("li a[href*='pull/1475']").closest("li").querySelector(".ghnt-tag");
    new MutationObserver(() => window.__seen.push(t.textContent)).observe(t, { childList: true, subtree: true, characterData: true });
  });
  await page.evaluate(() => window.__fx.setLabel("pull/1475", "review requested"));
  await expect(tag).toHaveText("Direct review request");
  expect(await page.evaluate(() => window.__seen)).not.toContain("Unverifiable");
  await expect(li).toHaveClass(/ghnt-hl/);
  // Visible over GitHub's !important row rules and the active (focused) state, on the panel too.
  const HL_BG = "rgb(255, 248, 197)";
  await expect.poll(() => li.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(HL_BG);
  await expect.poll(() => panelOf(page, "pull/1475").evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(HL_BG);
  await expect(page.locator(".ghnt-why-card")).toContainText("A review request for you is pending");
  await expect(li).not.toHaveClass(/ghnt-hl/, { timeout: 6000 });
  expect(await li.locator(".ghnt-tag").count()).toBe(1);
});

test("a tag line added or removed above the reader does not move the row they read, even without scroll anchoring", async ({ context, page }) => {
  await boot(context, page, { height: 320 });
  for (const path of ["pull/1482", "pull/77"]) await expect(tagIn(page, path)).toBeVisible();
  // Triage's Grouped sections turn the browser's scroll anchoring off on the list.
  await page.evaluate(() => { document.querySelector("ul.list").style.overflowAnchor = "none"; document.documentElement.style.overflowAnchor = "none"; });
  const top = () => rowOf(page, "pull/77").evaluate((li) => li.getBoundingClientRect().top);
  await rowOf(page, "pull/77").evaluate((li) => window.scrollTo(0, window.scrollY + li.getBoundingClientRect().top - 2));
  const before = await top();
  // The first row loses its tag: its line, 24px above the reader, goes away.
  await page.evaluate(() => window.__fx.setLabel("pull/1482", "commented"));
  await expect(tagIn(page, "pull/1482")).toHaveCount(0);
  expect(Math.abs((await top()) - before), `row top ${before} -> ${await top()}`).toBeLessThanOrEqual(1);
  // And comes back: the line is added above the reader again.
  await page.evaluate(() => window.__fx.setLabel("pull/1482", "mention"));
  await expect(tagIn(page, "pull/1482")).toBeVisible();
  expect(Math.abs((await top()) - before), `row top ${before} -> ${await top()}`).toBeLessThanOrEqual(1);
});

test("the first tag a row gets after loading is not a change", async ({ context, page }) => {
  await boot(context, page);
  expect(await page.locator("li.ghnt-hl").count()).toBe(0);
});

test("switch off or Native inbox: the page is identical to GitHub's; turning it off live removes everything", async ({ context, page }) => {
  await boot(context, page, { storage: { ...TOKENS, ghntModules: { reasonTags: false } }, wait: false });
  await page.waitForTimeout(1200);
  expect(await page.locator("[class*='ghnt-']").count()).toBe(0);
  const native = await page.evaluate(() => document.documentElement.outerHTML);
  await seedStorage(context, { ghntModules: { reasonTags: true } });
  await expect(page.locator(".ghnt-tag").first()).toBeVisible();
  await tagIn(page, "pull/1482").click();
  await seedStorage(context, { ghntModules: { reasonTags: false } });
  await expect(page.locator("[class*='ghnt-']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(native);
  await seedStorage(context, { ghntModules: {}, ghntNativeInbox: true });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(native);
  await seedStorage(context, { ghntNativeInbox: false });
  await expect(page.locator(".ghnt-tag").first()).toBeVisible();
  await seedStorage(context, { ghntNativeInbox: true });
  await expect(page.locator("[class*='ghnt-']")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(native);
});

test("the tokens link opens Settings → GitHub tokens in a new tab", async ({ context, page }) => {
  await boot(context, page);
  await tagIn(page, "pull/204").click();
  const pop = page.locator(".ghnt-why-card");
  await expect(pop).toContainText("Reading this needs Pull requests: Read");
  const opened = context.waitForEvent("page");
  await pop.getByRole("button", { name: "Open GitHub tokens settings" }).click();
  const tab = await opened;
  expect(tab.url()).toMatch(/^chrome-extension:\/\/[a-z]+\/options\/options\.html#tokens-section$/);
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
  expect(await rec(page)).toEqual([]);
});

// --- navigation ------------------------------------------------------------------

test("A → inbox → A → back: tags appear on arrival and leave with the page", async ({ context, page }) => {
  await boot(context, page, { url: "https://github.com/acme-labs/atlas-web", wait: false });
  await page.waitForTimeout(800);
  expect(await page.locator("[class*='ghnt-']").count()).toBe(0);
  await page.locator("#bell").click();
  await expect(page.locator(".ghnt-tag").first()).toBeVisible();
  await tagIn(page, "pull/1482").click();
  await page.goBack();
  await expect(page.locator("[class*='ghnt-']")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".ghnt-tag").first()).toBeVisible();
  await expect(page.locator(".ghnt-why")).toHaveCount(0);
});

test("/notifications/subscriptions has no tags", async ({ context, page }) => {
  await boot(context, page, { url: "https://github.com/notifications/subscriptions", wait: false });
  await page.waitForTimeout(1200);
  expect(await page.locator("[class*='ghnt-']").count()).toBe(0);
});

// --- contrast --------------------------------------------------------------------

async function contrasts(page) {
  return page.evaluate(() => {
    const parse = (s) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
    const lum = (c) => {
      const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    const page = bodyBg[3] === 0 ? [255, 255, 255] : over(bodyBg, [255, 255, 255]);
    const out = {};
    for (const t of document.querySelectorAll(".ghnt-tag")) {
      const cs = getComputedStyle(t);
      out[t.dataset.ghntTag] = ratio(parse(cs.color).slice(0, 3), over(parse(cs.backgroundColor), page));
    }
    return out;
  });
}

for (const [name, hash, transform] of [
  ["light", "", undefined],
  ["dark", "#dark", undefined],
  ["fallbacks only (no Primer variables)", "", (html) => html.replace(/:root \{[^}]*\}/, "").replace(/:root\[data-color-mode="dark"\] \{[^}]*\}/, "")],
]) {
  test(`contrast >= 4.5:1 for every tag and the panel text: ${name}`, async ({ context, page }) => {
    await boot(context, page, { url: `${INBOX}${hash}`, transform });
    await expect(page.locator(".ghnt-tag")).toHaveCount(8);
    const c = await contrasts(page);
    expect(Object.keys(c).length).toBeGreaterThanOrEqual(6);
    for (const [id, ratio] of Object.entries(c)) expect(ratio, `${id} ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(4.5);
    await tagIn(page, "pull/311").click();
    const text = await page.locator(".ghnt-why-card").evaluate((card) => {
      const parse = (s) => {
        const p = s.match(/rgba?\(([^)]+)\)/)[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p[3] ?? 1];
      };
      const lum = (c) => {
        const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const bgCs = getComputedStyle(card).backgroundColor;
      const bg = parse(bgCs).slice(0, 3);
      const out = {};
      for (const el of card.querySelectorAll(".ghnt-why-title, .ghnt-why-mark, .ghnt-why-rule, .ghnt-why-line > span:last-child, .ghnt-why-link")) {
        out[`${el.className}:${el.textContent.slice(0, 12)}`] = ratio(parse(getComputedStyle(el).color).slice(0, 3), bg);
      }
      return { out, bgCs };
    });
    expect(Object.keys(text.out).length).toBeGreaterThan(4);
    for (const [k, r] of Object.entries(text.out)) expect(r, `${k} on ${text.bgCs}`).toBeGreaterThanOrEqual(4.5);
  });
}

test("hover darkens and keyboard focus shows a ring", async ({ context, page }) => {
  await boot(context, page);
  const tag = tagIn(page, "pull/1482");
  expect(await tag.evaluate((n) => getComputedStyle(n).filter)).toBe("none");
  await tag.hover();
  await expect.poll(() => tag.evaluate((n) => getComputedStyle(n).filter)).toMatch(/brightness\(0\.95\)/);
  await tag.evaluate((n) => n.blur());
  await page.keyboard.press("Tab");
  await tag.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  expect(await tag.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe("solid");
});
