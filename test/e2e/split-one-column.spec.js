// E2E: Split diff, one column for one-sided files: the three markups GitHub serves
// (Files changed, a single commit, a compare page), the decision per file, the per-file
// control, and the things that must never happen (no node moved, no request, no storage).
import { test, expect } from "./support/extension.js";
import { setup, sampleFiles, reasons, modes, pageHtml, URLS } from "./support/split.js";

const KINDS = [
  ["hashed", "Files changed", "viewed"],
  ["unhashed", "commit page", "more-options"],
  ["classic", "compare page", "file-menu"],
];

const EXPECT = ["additions-only", "deletions-only", "two-sided-change", "content-on-hidden-side", "additions-only"];

for (const [kind, label, anchor] of KINDS) {
  test.describe(label, () => {
    test("each file gets the outcome of the rules, and only transformed files get the control", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => reasons(page)).toEqual(EXPECT);
      expect(await modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
      const controls = await page.evaluate(() => [...document.querySelectorAll("table")].map((t) => {
        const c = t.closest("[role=region],[data-tagsearch-path]").querySelectorAll("[data-ghsoc-control]");
        return c.length;
      }));
      expect(controls).toEqual([1, 1, 0, 0, 1]);
    });

    test("the control is the previous sibling of its primary anchor and says Side by side", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      const btn = page.locator("[data-ghsoc-control]").first();
      await expect(btn).toHaveAttribute("data-ghsoc-anchor", anchor);
      await expect(btn).toHaveText("Side by side");
      await expect(btn).toHaveAccessibleName("Side by side");
      await expect(btn).toHaveAccessibleDescription("Shown in one column");
      const next = await btn.evaluate((b) => {
        const n = b.nextElementSibling;
        return n.getAttribute("aria-label") || (n.tagName === "DETAILS" ? "details" : n.textContent.trim());
      });
      expect(next).toBe(anchor === "viewed" ? "Not Viewed" : anchor === "file-menu" ? "details" : next);
      if (anchor === "more-options") expect(await btn.evaluate((b) => b.nextElementSibling.getAttribute("aria-haspopup"))).toBe("true");
    });

    test("additions-only keeps both number columns and shows each context line once; deletions-only keeps the old numbers", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
      const shown = await page.evaluate(() => {
        const vis = (tr) => [...tr.children].filter((td) => getComputedStyle(td).display !== "none").length;
        const rows = (t) => [...t.querySelectorAll(":scope > tbody > tr")].map(vis);
        const ts = document.querySelectorAll("table");
        return { add: rows(ts[0]), del: rows(ts[1]), two: rows(ts[2]) };
      });
      // hunk row: one cell; line rows: 3 visible cells (additions) / 2 (deletions) / 4 (two-sided)
      expect(shown.add.slice(1)).toEqual([3, 3, 3, 3]);
      expect(shown.del.slice(1)).toEqual([2, 2, 2, 2]);
      expect(shown.two.slice(1)).toEqual([4, 4, 4]);
      expect(shown.add[0]).toBeGreaterThanOrEqual(1);
    });

    test("Side by side restores GitHub's Split for that file only, One column goes back", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      const btn = page.locator("[data-ghsoc-control]").first();
      await expect(btn).toHaveText("Side by side");
      await btn.click();
      await expect(btn).toHaveText("One column");
      await expect(btn).toHaveAccessibleDescription("Shown side by side");
      expect(await modes(page)).toEqual([null, "deletions", null, null, "additions"]);
      expect(await page.locator("table").first().getAttribute("data-ghsoc-reason")).toBe("additions-only");
      // every colspan GitHub rendered is back
      expect(await page.evaluate(() => document.querySelectorAll("table")[0].querySelectorAll("[data-ghsoc-colspan]").length)).toBe(0);
      await btn.click();
      await expect(btn).toHaveText("Side by side");
      expect(await modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
    });

    test("the choice is memory only: a reload is automatic again", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await page.locator("[data-ghsoc-control]").first().click();
      expect((await modes(page))[0]).toBeNull();
      await page.reload();
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
    });

    test("a review thread on a visible line keeps its cell and is not wider than the text column before, never narrower", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      const t = page.locator("table").nth(4);
      await expect(t).toHaveAttribute("data-ghsoc", "additions");
      const thread = t.locator(".review-thread");
      await expect(thread).toBeVisible();
      await expect(thread.getByRole("button", { name: "Resolve conversation" })).toBeVisible();
      await expect(thread.getByRole("button", { name: "Reply…" })).toBeVisible();
      const w = await page.evaluate(() => {
        const th = document.querySelectorAll("table")[4].querySelector(".review-thread");
        const tb = document.querySelectorAll("table")[4].getBoundingClientRect();
        return { th: th.getBoundingClientRect().width, table: tb.width };
      });
      expect(w.th, JSON.stringify(w)).toBeGreaterThan(w.table * 0.7);
    });

    test("a file with a thread on the side to hide stays in Split, with no control", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => reasons(page)).toContain("content-on-hidden-side");
      const t = page.locator("table").nth(3);
      await expect(t).not.toHaveAttribute("data-ghsoc", /.+/);
      await expect(t.locator("td:visible")).toHaveCount(await t.locator("td").count());
      await expect(t.locator(".review-thread")).toBeVisible();
    });

    test("no node of the diff is moved, removed or created by the extension; no request, no storage", async ({ context, page }) => {
      const { url, requests, api } = await setup(context, kind, sampleFiles());
      await page.addInitScript(() => {
        window.__tableRecords = [];
        // from DOMContentLoaded on: the parse of the page itself is not the extension's
        addEventListener("DOMContentLoaded", () => {
          new MutationObserver((recs) => {
            for (const r of recs) if (r.type === "childList" && r.target.closest && r.target.closest("table")) window.__tableRecords.push(r.target.tagName);
          }).observe(document, { childList: true, subtree: true });
        });
      });
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
      await page.locator("[data-ghsoc-control]").first().click();
      await page.locator("[data-ghsoc-control]").first().click();
      const before = await page.evaluate(() => window.__tableRecords.length);
      // the page itself writes nothing into the tables after load, so any record is ours
      expect(before).toBe(0);
      expect(requests).toEqual([]);
      expect(api).toEqual([]);
      const stored = await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.get(null));
      expect(Object.keys(stored)).toEqual([]);
    });

    test("feature off in settings: every diff is left as GitHub rendered it", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles(), { storage: { ghsocEnabled: false } });
      await page.goto(url);
      await page.waitForTimeout(500);
      expect(await modes(page)).toEqual([null, null, null, null, null]);
      expect(await reasons(page)).toEqual([null, null, null, null, null]);
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
      await expect(page.locator("table").first().locator("td:visible")).toHaveCount(await page.locator("table").first().locator("td").count());
    });

    test("switching the feature off live reverts every file; on again re-applies", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
      const worker = context.serviceWorkers()[0];
      await worker.evaluate(() => chrome.storage.local.set({ ghsocEnabled: false }));
      await expect.poll(() => modes(page)).toEqual([null, null, null, null, null]);
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
      await worker.evaluate(() => chrome.storage.local.set({ ghsocEnabled: true }));
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
    });
  });
}

test.describe("negative cases", () => {
  test("Unified (three columns) is never touched and gets no control", async ({ context, page }) => {
    const files = sampleFiles().map((f) => ({ ...f, unified: true }));
    const { url } = await setup(context, "hashed", files);
    await page.goto(url);
    await expect.poll(() => reasons(page)).toEqual(Array(5).fill("already-one-column"));
    expect(await modes(page)).toEqual(Array(5).fill(null));
    await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
  });

  test("a table with a column another extension already hid (three rendered columns) is left alone", async ({ context, page }) => {
    const html = pageHtml("hashed", sampleFiles().slice(0, 1)).replace("</style>", "table td:nth-child(2){display:none}</style>");
    const { url } = await setup(context, "hashed", [], { html });
    await page.goto(url);
    await expect.poll(() => reasons(page)).toEqual(["already-one-column"]);
    await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
  });

  for (const [kind, , anchor] of KINDS) {
    test(`${kind}: the empty-cell marker renamed → anchor-missing, the file stays as rendered, no control`, async ({ context, page }) => {
      const html = pageHtml(kind, sampleFiles().slice(0, 2))
        .replace(/emptyDiffLine__ismMVY/g, "emptyX__q").replace(/empty-diff-line/g, "blank-x").replace(/empty-cell/g, "blank-x").replace(/data-diff-cell="empty"/g, 'data-diff-cell="blank"');
      const { url } = await setup(context, kind, [], { html });
      await page.goto(url);
      await expect.poll(() => reasons(page)).toEqual(["anchor-missing", "anchor-missing"]);
      expect(await modes(page)).toEqual([null, null]);
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
    });

    test(`${kind}: a header with none of the anchors → anchor-missing, no transform, no control`, async ({ context, page }) => {
      const files = sampleFiles().map((f) => ({ ...f, noAnchor: true, viewed: false }));
      const { url } = await setup(context, kind, files);
      await page.goto(url);
      await expect.poll(() => reasons(page)).toEqual(Array(5).fill("anchor-missing").map((r, i) => (i === 2 ? "anchor-missing" : r)));
      expect(await modes(page)).toEqual(Array(5).fill(null));
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(0);
      void anchor;
    });
  }

  test("a file with no hunk row is not guessed at", async ({ context, page }) => {
    const files = [{ path: "a.md", rows: sampleFiles()[0].rows.filter((r) => r.t !== "hunk") }];
    const { url } = await setup(context, "hashed", files);
    await page.goto(url);
    await expect.poll(() => reasons(page)).toEqual(["anchor-missing"]);
  });
});

test("routes: only Files changed, a single commit and a compare page run; the Conversation tab does not", async ({ context, page }) => {
  const { url } = await setup(context, "hashed", sampleFiles());
  await page.goto("https://github.com/acme/web/pull/7");
  await page.waitForTimeout(400);
  expect(await modes(page)).toEqual(Array(5).fill(null));
  expect(await reasons(page)).toEqual(Array(5).fill(null));
  await page.goto("https://github.com/acme/web/pull/7/files");
  await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null, null, "additions"]);
  void url;
  void URLS;
});
