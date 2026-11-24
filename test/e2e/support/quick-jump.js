// Helpers shared by the Quick jump specs: pages built in the shape of github.com's (the head metas the
// recorder reads, the real quick search button of the signed-in and signed-out headers, a few editable
// fields), the API mocks of the three reads, and a way to send the browser command to a tab.
import { backgroundWorker, routeApi, seedStorage } from "./extension.js";

export const TOKENS = { githubTokens: [{ id: "d", name: "Work laptop", token: "ghp_default", owner: "" }], defaultTokenId: "d", ghqjEnabled: true };
export const MAPPED = { githubTokens: [{ id: "d", name: "Work laptop", token: "ghp_default", owner: "" }, { id: "o", name: "Acme org", token: "ghp_org", owner: "acme" }], defaultTokenId: "d" };

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();
export const issue = (number, repo, mins, title = `Issue ${number}`, extra = {}) => ({ number, title, updated_at: iso(mins), repository_url: `https://api.github.com/repos/${repo}`, ...extra });
export const repoRow = (full_name, mins) => ({ full_name, pushed_at: iso(mins) });

export const DEFAULT_DATA = {
  assigned: [issue(54, "acme/web", 6000, "Sort by oldest ignores saved items"), issue(412, "acme/billing-api", 8600, "Fix rounding in invoice totals")],
  review: { total_count: 1, items: [issue(61, "acme/web", 5700, "Retry the upload when the worker times out")] },
  repos: [repoRow("acme/web", 120), repoRow("acme/billing-api", 1500), repoRow("octo-fixture/dotfiles", 4300)],
};

// handlers for routeApi; `data` overrides per list, a value may be { status, headers } for a failure or a function.
export function apiHandlers(data = {}, log = []) {
  const d = { ...DEFAULT_DATA, ...data };
  const one = (name, match, body) => ({
    match,
    status: () => (d[name]?.status ? d[name].status : 200),
    json: () => {
      log.push(name);
      return d[name]?.status ? { message: d[name].message || "x" } : body();
    },
  });
  return [
    one("assigned", /^\/issues$/, () => d.assigned),
    one("review", /^\/search\/issues$/, () => d.review),
    one("repos", /^\/user\/repos$/, () => d.repos),
  ];
}

// The signed-out header as github.com renders it (class names with their hash kept): a fixed-width search
// button in the searchSlot, then "Sign in", "Sign up" and the menu button, all pushed to the right edge.
function liveSignedOut(signInWidth) {
  return `<style>@media (max-width:1011px){.ctaContainer__XiXTge{display:none!important}}</style><header class="Header" style="display:flex;align-items:center;height:64px;padding:0 16px;box-sizing:border-box"><a class="logo__bX9RKh" href="/" aria-label="Homepage" style="width:32px"><svg class="octicon octicon-mark-github" width="32" height="32"></svg></a><div class="ctaContainer__XiXTge" style="margin-left:auto;display:flex;align-items:center"><div class="searchSlot__PLyIP2" style="width:200px"><button type="button" class="Primer_Brand__Button-module__Button___scH9Z" style="width:200px;height:32px;display:flex;justify-content:space-between;box-sizing:border-box"><span class="label__Axw9pp">Search</span><span>/</span></button></div><div class="signInWrap___-hg2x" style="width:${signInWidth}px"><a href="/login" style="display:block;margin-left:8px">Sign in</a></div><a href="/signup" style="display:block;width:80.2px;margin-left:8px">Sign up</a><button type="button" aria-label="Menu" style="width:32px;height:32px;margin-left:8px"></button></div></header>`;
}

const HEADERS = {
  "signed-in": `<header class="AppHeader"><div class="AppHeader-globalBar"><a href="/" aria-label="Homepage"><svg class="octicon octicon-mark-github" width="32" height="32"></svg></a><div class="AppHeader-search"><button type="button" aria-label="Open quick search dialog, type / to search" class="search-button"><span>Type / to search</span></button></div></div></header>`,
  "signed-out": liveSignedOut(83.3),
  "signed-out-narrow": liveSignedOut(77.05), // a font or locale that makes "Sign in" 6.25px narrower: the search button follows
  "signed-out-legacy": `<header class="Header"><div class="Header-globalBar"><a href="/" aria-label="Homepage"><svg class="octicon octicon-mark-github" width="32" height="32"></svg></a><div class="Header-search"><button type="button" aria-label="Open quick search dialog, type / to search" class="search-button"><span>Type / to search</span></button></div></div></header>`,
};

// A github.com-shaped page. `nwo` null leaves the repository meta out (the header-link-only variant).
export function page({ title = "acme/web", nwo = "acme/web", variant = "signed-in", dark = false, primer = false, body = "", head = "", repoHeader = false, userMeta = true } = {}) {
  const meta = [userMeta ? `<meta name="user-login" content="${variant === "signed-in" ? "mira" : ""}">` : "", nwo ? `<meta name="octolytics-dimension-repository_nwo" content="${nwo}">` : ""].join("");
  const vars = primer
    ? dark
      ? `html{--bgColor-default:#0d1117;--fgColor-default:#f0f6fc;--fgColor-muted:#9198a1;--borderColor-default:#3d444d;--bgColor-inset:#010409}`
      : `html{--bgColor-default:#ffffff;--fgColor-default:#1f2328;--fgColor-muted:#59636e;--borderColor-default:#d1d9e0;--bgColor-inset:#f6f8fa}`
    : "";
  const repo = repoHeader && nwo ? `<div id="repository-container-header"><a href="/${nwo}">${nwo.split("/")[1]}</a></div>` : "";
  return `<!doctype html><html lang="en" data-color-mode="${dark ? "dark" : "light"}" data-light-theme="light" data-dark-theme="dark"><head><meta charset="utf-8">${meta}<title>${title}</title><style>body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",sans-serif;color:${dark ? "#f0f6fc" : "#1f2328"};background:${dark ? "#0d1117" : "#fff"}}${vars}</style>${head}</head><body>${HEADERS[variant]}${repo}<main id="main"><h1>${title}</h1><a id="plain" href="/acme/web/issues/9">issue nine</a><p>content</p>${body}</main></body></html>`;
}

export const EDITABLES = `<input id="field" type="text" aria-label="field"><textarea id="comment" aria-label="comment"></textarea><div id="editor" contenteditable="true" role="textbox" aria-label="editor">x</div><button id="btn" type="button">button</button>`;

// Serves one page per path: pages = { "/acme/web": { title, nwo, ... } }; unknown paths get a plain page.
export async function routePages(context, pages, defaults = {}) {
  const handler = (route) => {
    const req = route.request();
    if (req.resourceType() !== "document") return route.abort();
    const u = new URL(req.url());
    const spec = pages[u.pathname] ?? pages["*"] ?? {};
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page({ ...defaults, ...spec }) });
  };
  await context.route("https://github.com/**", handler);
}

export async function setup(context, { storage = TOKENS, data, pages = { "*": {} }, defaults, log = [], reqs = [], handlers } = {}) {
  // Quick jump is off by default: specs that exercise it switch it on, unless they set ghqjEnabled themselves.
  await seedStorage(context, "ghqjEnabled" in storage ? storage : { ...storage, ghqjEnabled: true });
  await routeApi(context, handlers || apiHandlers(data, log));
  context.on("request", (r) => {
    if (r.url().startsWith("https://api.github.com")) reqs.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await routePages(context, pages, defaults);
  return { reqs, log };
}

// The browser command cannot be pressed by Playwright: send the message the background sends to the tab.
export async function toggle(context, page) {
  const worker = await backgroundWorker(context);
  const url = page.url();
  await worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u || x.pendingUrl === u) || tabs[0];
    await chrome.tabs.sendMessage(t.id, { type: "GHQJ_TOGGLE" });
  }, url);
}

export const panel = (page) => page.locator(".ghqj-panel");
export const input = (page) => page.locator(".ghqj-input");
export const rows = (page) => page.locator(".ghqj-row");
export const selected = (page) => page.locator(".ghqj-row.ghqj-sel");
export const group = (page, id) => page.locator(`#ghqj-g-${id}`).locator("xpath=..");

export async function openPanel(context, page, url = "https://github.com/acme/web") {
  if (url) await page.goto(url);
  await page.locator("#main").waitFor();
  // the content script reads the state asynchronously: retry the toggle until the panel appears
  for (let i = 0; i < 20; i++) {
    await toggle(context, page);
    if (await panel(page).count()) return;
    await page.waitForTimeout(150);
  }
}

export async function recent(context) {
  const worker = await backgroundWorker(context);
  return worker.evaluate(async () => (await chrome.storage.local.get("ghqjRecent")).ghqjRecent || []);
}
