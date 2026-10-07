// test/e2e/support/extension.js — Playwright fixtures and helpers for
// driving the real extension, loaded unpacked, against saved HTML
// fixtures of the GitHub pages each feature targets.
//
// How it stays deterministic and network-free:
//  - The extension is loaded from the repo root exactly as "Load
//    unpacked" would (manifest.json and the paths it references).
//  - Every request to github.com is fulfilled with a local fixture;
//    every request to api.github.com is fulfilled with a canned JSON
//    response (see routeApi). Nothing leaves the machine, and no GitHub
//    token is involved.
//  - chrome.storage.local is seeded through the background service
//    worker, so feature toggles are in place before a page is loaded.
//
// Chromium only loads extensions in a persistent context, and only the
// full build (channel "chromium") does so under the new headless mode —
// the default bundled headless shell can't. Hence the manual launch here
// rather than Playwright's stock browser fixture.
import { test as base, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const FIXTURES_DIR = path.resolve(here, "../fixtures");

export const test = base.extend({
  // A fresh persistent context per test, with the extension loaded. The
  // empty userDataDir makes Playwright mint a throwaway profile each time,
  // so storage and injected DOM never leak between tests.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${REPO_ROOT}`,
        `--load-extension=${REPO_ROOT}`,
      ],
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});

export { expect };

// The MV3 background service worker starts on launch to register its
// top-level listeners; wait for Playwright to see it so we can drive
// chrome.storage through it.
export async function backgroundWorker(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  return worker;
}

// Seed chrome.storage.local before navigating, so feature toggles (and
// anything else a content script reads on load) are already in place.
export async function seedStorage(context, data) {
  const worker = await backgroundWorker(context);
  await worker.evaluate((d) => chrome.storage.local.set(d), data);
}

// Serve one saved fixture as the document for every github.com
// navigation. Sub-resource requests to github.com are aborted rather
// than hitting the network — fixtures are self-contained, and the
// extension's own pages load from chrome-extension:// URLs, not from
// here.
export async function routeGithub(context, fixtureFile) {
  const html = fs.readFileSync(path.join(FIXTURES_DIR, fixtureFile), "utf8");
  await context.route("https://github.com/**", (route) => {
    if (route.request().resourceType() === "document") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    return route.abort();
  });
}

// Mock the extension's GitHub API boundary. `handlers` is an ordered list
// of { method?, match, json?, status? }; `match` is a RegExp tested
// against the pathname, or a (pathname, url) => boolean. The first match
// wins. Unmatched REST paths default to an empty array (safeDeps /
// safeFields degrade to "no data"), and GraphQL defaults to an issue with
// no project items (safeStatus → null) — the graceful-degradation shapes,
// so a handler is only needed for the data a test actually asserts on.
// `status` and `json` may each be a (url) => value function so a handler
// can vary its reply per call (e.g. succeed once, then fail); `status` is
// evaluated before `json`, so a counter kept in `status` is already
// current when `json` reads it.
export async function routeApi(context, handlers = []) {
  await context.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    for (const h of handlers) {
      if (h.method && h.method !== method) continue;
      const matched =
        typeof h.match === "function" ? h.match(pathname, url) : h.match.test(pathname);
      if (!matched) continue;
      const status = typeof h.status === "function" ? h.status(url) : h.status;
      const body = typeof h.json === "function" ? h.json(url) : h.json;
      return route.fulfill({
        status: status || 200,
        contentType: "application/json",
        body: JSON.stringify(body ?? {}),
      });
    }

    if (pathname === "/graphql") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { repository: { issue: { projectItems: { nodes: [] } } } },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}
