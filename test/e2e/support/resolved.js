// Shared helpers for the Resolved conversations specs: serve the fixture as the
// pull request page, answer GitHub's lazy content requests (/threads/<id>) the
// way a test asks, and log every other request so a test can show there is none.
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, seedStorage } from "./extension.js";

export const PR = "https://github.com/acme/web/pull/7";
export const bar = (page) => page.locator(".ghrc-bar");
export const button = (page) => page.locator(".ghrc-bar .ghrc-btn");
export const label = (page) => page.locator(".ghrc-bar .ghrc-label");
export const status = (page) => page.locator(".ghrc-bar [role=status]");
export const threads = (page) => page.locator("review-thread-collapsible");
export const resolvedThreads = (page) => page.locator('review-thread-collapsible[data-resolved="true"]');

// opts.fragment(id): "ok" (default) | "500" | "hang"; opts.delay: ms before a 200.
// opts.pages(url): html for a non-pull-request document (Files changed ...).
export async function setup(context, opts = {}) {
  const { storage, fragment = () => "ok", delay = 40, pages } = opts;
  if (storage) await seedStorage(context, storage);
  const html = fs.readFileSync(path.join(FIXTURES_DIR, "pr-conversation-resolved.html"), "utf8");
  const requests = [];
  const stats = { inflight: 0, maxInflight: 0 };
  await context.route("https://github.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.resourceType() === "document") {
      const other = pages && url.pathname !== "/acme/web/pull/7" ? pages(url) : null;
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: other || html });
    }
    requests.push(url.pathname + url.search);
    const m = /\/threads\/(\d+)/.exec(url.pathname);
    if (m) {
      const mode = fragment(Number(m[1]));
      if (mode === "hang") return; // never answered
      if (mode === "500") return route.fulfill({ status: 500, body: "error" });
      stats.maxInflight = Math.max(stats.maxInflight, ++stats.inflight);
      await new Promise((r) => setTimeout(r, delay));
      stats.inflight--;
      return route.fulfill({ status: 200, contentType: "text/html", body: `<div class="thread-content">Comment ${m[1]} (loaded)</div>` });
    }
    return route.abort();
  });
  const apiCalls = [];
  await context.route("https://api.github.com/**", (route) => {
    apiCalls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  return { requests, apiCalls, stats };
}

// Geometry of the bar against the first resolved thread, in CSS px.
export function measure(page) {
  return page.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    const bar = document.querySelector(".ghrc-bar");
    const thread = document.querySelector('review-thread-collapsible[data-resolved="true"]');
    const btn = bar && bar.querySelector(".ghrc-btn");
    const chev = thread.querySelector("button.review-thread-chevron");
    const lab = bar && bar.querySelector(".ghrc-label");
    const range = document.createRange();
    const walker = document.createTreeWalker(lab || document.body, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode();
    let glyph = null;
    if (t) { range.setStart(t, 0); range.setEnd(t, 1); glyph = range.getBoundingClientRect().left; }
    const cs = btn ? getComputedStyle(btn) : null;
    return {
      bar: bar && r(bar), thread: r(thread), btn: btn && r(btn), chev: r(chev), glyph,
      btnLabel: btn && r(btn.querySelector(".Button-label")),
      radius: cs && cs.borderTopLeftRadius, border: cs && cs.borderTopWidth,
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    };
  });
}
