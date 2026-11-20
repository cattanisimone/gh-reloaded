// E2E: recording of visited issues, pull requests and repositories (the Recent list).
import { test, expect } from "./support/extension.js";
import { backgroundWorker } from "./support/extension.js";
import { setup, recent, TOKENS, page as buildPage } from "./support/quick-jump.js";

const T = (n, t) => `${t} · Issue #${n} · acme/web`;
const P = (n, t) => `${t} by mira · Pull Request #${n} · acme/web`;

async function visit(context, page, url, pages) {
  await page.goto(url);
  await page.locator("#main").waitFor();
  await page.waitForTimeout(900);
  return recent(context);
}

test("an issue page, with any sub-path, query or anchor, records the issue", async ({ context, page }) => {
  await setup(context, { pages: { "/acme/web/issues/7/foo": { title: T(7, "Retry upload") } } });
  const list = await visit(context, page, "https://github.com/acme/web/issues/7/foo?x=1#c");
  expect(list.map((i) => [i.key, i.kind, i.url, i.title, i.repo, i.number])).toEqual([["acme/web#7", "issue", "https://github.com/acme/web/issues/7", "Retry upload", "acme/web", 7]]);
  expect(Object.keys(list[0]).sort()).toEqual(["at", "key", "kind", "number", "repo", "title", "url"]);
});

test("pull request pages (files, commits, checks) record the pull request; a repository page the repository", async ({ context, page }) => {
  await setup(context, { pages: { "/acme/web/pull/3/files": { title: P(3, "Fix it") }, "/acme/web/actions": { title: "Actions · acme/web" } } });
  let list = await visit(context, page, "https://github.com/acme/web/pull/3/files");
  expect(list.map((i) => [i.kind, i.url, i.title])).toEqual([["pull", "https://github.com/acme/web/pull/3", "Fix it"]]);
  list = await visit(context, page, "https://github.com/acme/web/actions");
  expect(list.map((i) => i.key)).toEqual(["acme/web", "acme/web#3"]);
  expect(list[0].url).toBe("https://github.com/acme/web");
});

test("pages that are not recorded: notifications, pulls, search, a profile, Settings, not found, sign in", async ({ context, page }) => {
  await setup(context, {
    pages: {
      "/notifications": { title: "Notifications", nwo: "" }, "/pulls": { title: "Pull requests", nwo: "" }, "/search": { title: "Search", nwo: "" }, "/acme": { title: "acme", nwo: "" },
      "/settings/profile": { title: "Your profile", nwo: "" }, "/acme/web/issues/404": { title: "Page not found · GitHub", nwo: "" }, "/login": { title: "Sign in to GitHub · GitHub", nwo: "" },
    },
  });
  for (const p of ["/notifications", "/pulls", "/search", "/acme", "/settings/profile", "/acme/web/issues/404", "/login"]) {
    expect(await visit(context, page, `https://github.com${p}`)).toEqual([]);
  }
});

test("a redirect counts at its final page", async ({ context, page }) => {
  await setup(context, { pages: { "/acme/web/pull/7": { title: P(7, "Now a pull request") } } });
  // the hop GitHub makes server side, drawn as a document that moves on at once: only the final page counts
  await context.route("https://github.com/acme/web/issues/7", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta http-equiv="refresh" content="0;url=/acme/web/pull/7"><title>Redirecting</title>` }));
  const list = await visit(context, page, "https://github.com/acme/web/issues/7");
  expect(list.map((i) => [i.key, i.kind])).toEqual([["acme/web#7", "pull"]]);
});

test("in-page navigation, back/forward and reload each count as a visit; A → B → A keeps one entry per item, newest first", async ({ context, page }) => {
  await setup(context, { pages: { "/acme/web/issues/1": { title: T(1, "One"), body: `<a id="go2" href="#">go</a>` } } });
  await page.goto("https://github.com/acme/web/issues/1");
  await page.waitForTimeout(900);
  const nav = async (path, title) => {
    await page.evaluate(([p, t]) => { history.pushState({}, "", p); document.title = t; }, [path, title]);
    await page.waitForTimeout(900);
  };
  await nav("/acme/web/issues/2", T(2, "Two"));
  expect((await recent(context)).map((i) => i.key)).toEqual(["acme/web#2", "acme/web#1"]);
  await nav("/acme/web/issues/1", T(1, "One"));
  expect((await recent(context)).map((i) => i.key)).toEqual(["acme/web#1", "acme/web#2"]);
  await nav("/notifications", "Notifications");
  expect((await recent(context)).length).toBe(2);
  await page.goBack();
  await page.waitForTimeout(900);
  const t = (await recent(context))[0].at;
  await page.reload();
  await page.waitForTimeout(900);
  const after = await recent(context);
  expect(after.length).toBe(2);
  expect(after[0].at).toBeGreaterThan(t);
});

test("the header-link-only variant (no repository meta) is recorded; a title that does not name the item is not", async ({ context, page }) => {
  await setup(context, { pages: { "/acme/web/issues/5": { title: T(5, "Five"), nwo: null, repoHeader: false, body: "" }, "/acme/web/issues/6": { title: "Something else", nwo: "acme/web" } } });
  await context.route("https://github.com/acme/web/issues/5", (route) => route.fulfill({ status: 200, contentType: "text/html", body: buildPage({ title: T(5, "Five"), nwo: "", body: "" }).replace("<main", '<div id="repository-container-header"><a href="/acme/web">web</a></div><main') }));
  expect((await visit(context, page, "https://github.com/acme/web/issues/5")).map((i) => i.key)).toEqual(["acme/web#5"]);
  expect((await visit(context, page, "https://github.com/acme/web/issues/6")).map((i) => i.key)).toEqual(["acme/web#5"]);
});

test("no token or switched off: nothing is recorded; stored items are deleted when switching off", async ({ context, page }) => {
  await setup(context, { storage: { ghqjEnabled: true }, pages: { "/acme/web/issues/7": { title: T(7, "Seven") } } });
  expect(await visit(context, page, "https://github.com/acme/web/issues/7")).toEqual([]);
  const worker = await backgroundWorker(context);
  await worker.evaluate((t) => chrome.storage.local.set(t), TOKENS);
  await page.waitForTimeout(400);
  expect((await visit(context, page, "https://github.com/acme/web/issues/7")).length).toBe(1);
  await worker.evaluate(() => chrome.storage.local.set({ ghqjEnabled: false }));
  await page.waitForTimeout(400);
  expect(await recent(context)).toEqual([]);
  expect(await visit(context, page, "https://github.com/acme/web/issues/7")).toEqual([]);
  await worker.evaluate(() => chrome.storage.local.set({ ghqjEnabled: true }));
  await page.waitForTimeout(300);
  await worker.evaluate(() => chrome.storage.local.set({ githubTokens: [] }));
  await page.waitForTimeout(300);
  expect(await recent(context)).toEqual([]);
});

test("the recorder uses no CSS-module class", async () => {
  const fs = await import("node:fs");
  for (const f of ["content.js", "panel.js", "content.css", "model.js"]) {
    expect(fs.readFileSync(`features/quick-jump/${f}`, "utf8")).not.toMatch(/-module__|__[A-Za-z0-9]{5,}["'\]]/);
  }
});
