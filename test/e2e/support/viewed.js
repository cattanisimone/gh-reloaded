// Shared helpers for the "Viewed per folder" specs. github.com is served from
// the pr-files-tree.html fixture, api.github.com is mocked at the extension's
// boundary (every request is logged), nothing leaves the machine.
import { routeGithub, seedStorage } from "./extension.js";

export const FILES = "/acme/web/pull/7/files";
export const TOKEN = { githubTokens: [{ id: "t1", name: "Default", token: "ghp_viewedtest", owner: "" }], defaultTokenId: "t1" };

// The viewed-state read, as GraphQL answers it: pages of 100 files.
// `states` is { path: "VIEWED" | "UNVIEWED" | "DISMISSED" }.
export async function routeViewedApi(context, { states = {}, delay = 0, status = 200, log = [], body } = {}) {
  await context.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const entry = { url: req.url(), method: req.method(), post: req.postData() };
    log.push(entry);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (status !== 200) return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message: "denied" }) });
    let json;
    if (body !== undefined) json = body;
    else {
      const vars = JSON.parse(req.postData() || "{}").variables || {};
      const all = Object.entries(states).map(([path, viewerViewedState]) => ({ path, viewerViewedState }));
      const from = vars.after ? Number(vars.after) : 0;
      const nodes = all.slice(from, from + 100);
      const end = from + nodes.length;
      json = { data: { repository: { pullRequest: { files: { totalCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes } } } } };
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  return log;
}

// Opens the fixture page. `query` is the fixture's own option string (see the fixture header).
export async function openFiles(context, page, { query = "", path = FILES, token = false, storage = {}, api } = {}) {
  const log = [];
  await routeGithub(context, "pr-files-tree.html");
  if (api) await routeViewedApi(context, { ...api, log });
  else await routeViewedApi(context, { status: 404, log });
  await seedStorage(context, { ...(token ? TOKEN : {}), ...storage });
  await page.goto(`https://github.com${path}${query ? "?" + query : ""}`);
  return log;
}

// Every folder row's indicator text, by folder path: "3/7", "✓" for the viewed check, "…" for loading.
export function indicators(page) {
  return page.evaluate(() => {
    const out = {};
    for (const li of document.querySelectorAll('#tree li[aria-expanded]')) {
      const ind = li.querySelector(":scope > .row-container .ghvf-ind");
      out[li.id] = ind ? { state: ind.dataset.state, count: ind.querySelector(".ghvf-count").textContent, text: ind.querySelector(".ghvf-desc").textContent } : null;
    }
    return out;
  });
}

// Waits until no folder row is missing an indicator and none is loading.
export async function settled(page) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("#tree li[aria-expanded]")];
    return rows.length > 0 && rows.every((li) => { const i = li.querySelector(":scope > .row-container .ghvf-ind"); return i && i.dataset.state !== "loading"; });
  });
}
