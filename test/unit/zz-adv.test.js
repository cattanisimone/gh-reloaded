// features/notifications/fill.js: the controller that reads more notifications
// on intent, with a fake clock, fake sends and a fake visibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/query.js", "features/notifications/collect.js", "features/notifications/classify.js", "features/notifications/fill.js"]);
const { GHNT_FILL: F, GHNT_COLLECT: C, GHNT_CLASSIFY: K, GHNT_QUERY: Q } = g;
const j = (v) => JSON.parse(JSON.stringify(v));

const pr = (n, reason = "subscribed", over = {}) => ({ id: `T${n}`, reason, unread: true, updated_at: "2026-11-01T10:00:00Z", subject: { url: `https://api.github.com/repos/acme/web/pulls/${n}`, type: "PullRequest", title: `Change ${n}` }, repository: { full_name: "acme/web" }, ...over });
const other = (id, type, title, over = {}) => ({ id, reason: "ci_activity", unread: true, subject: { url: null, type, title }, repository: { full_name: "acme/web" }, ...over });

// pages: array of item arrays (the REST pages after the baseline)
function rig({ pages = [], baseline = 1, apiPages, pageRows = [], me = "mira", counts = {}, facts = () => null, search = "/notifications", visible = { v: true }, limits } = {}) {
  const log = [];
  const clock = { t: 1_000_000 };
  const all = pages;
  const fill = F.createFill({
    now: () => clock.t,
    sleep: async (ms) => {
      log.push({ sleep: ms });
      clock.t += ms;
    },
    isVisible: () => visible.v,
    collect: C,
    query: Q,
    classify: K.classify,
    needsFacts: K.needsFacts,
    getPage: () => ({ rows: pageRows, me, counts }),
    limits,
    sendPage: async (p) => {
      log.push({ rest: p.page, at: clock.t, ims: p.ifModifiedSince });
      clock.t += 20;
      if (rig.nextPage) {
        const r = rig.nextPage(p);
        if (r) return r;
      }
      const items = all[p.page - 1] || [];
      return { ok: true, items, next: p.page < all.length, lastModified: "LM", pollInterval: 0 };
    },
    sendLookup: async ({ rows }) => {
      log.push({ lookup: rows.length, at: clock.t });
      clock.t += 20;
      return facts(rows) || { ok: true, facts: Object.fromEntries(rows.map((r) => [r.key, { ok: false, why: "pull request not readable" }])), capabilities: {}, rateLimited: false };
    },
  });
  fill.setQuery(Q.analyse(search));
  const baseItems = all.slice(0, baseline).flat();
  fill.seed({ state: "ok", key: Q.analyse(search).key, items: baseItems, pages: baseline, next: all.length > baseline, at: clock.t, lastModified: "LM" });
  return { fill, log, clock, restPages: () => log.filter((l) => l.rest).map((l) => l.rest) };
}
rig.nextPage = null;
test("ADV stale cache: refresh + 4 pages, spacing", async () => {
  const pages = Array.from({ length: 12 }, () => []);
  pages[0] = [pr(1, "unknown")];
  const r = rig({ pages, baseline: 1 });
  r.clock.t += 121_000;
  await r.fill.start({ category: "unverifiable" });
  const rest = r.log.filter((l) => l.rest);
  console.log(JSON.stringify(rest), JSON.stringify(r.log.filter((l) => l.sleep)));
});
test("ADV switching to an already-filled category leaves the other fill running", async () => {
  const pages = Array.from({ length: 12 }, () => []);
  pages[0] = [pr(1, "unknown")];
  const r = rig({ pages, baseline: 1 });
  await r.fill.start({ category: "informational" });
  const before = r.restPages().length;
  const p = r.fill.start({ category: "unverifiable", force: true });
  await Promise.resolve();
  const res = await r.fill.start({ category: "informational" });
  await p;
  console.log("second start:", res, "pages read by the first after switching:", r.restPages().length - before, r.fill.snapshot().runCategory);
});
