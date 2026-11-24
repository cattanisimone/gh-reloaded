// E2E: Split diff, one column — diffs that change after load: a review thread or form that
// appears on the side to hide, rows added, a table that arrives late, GitHub re-rendering the
// file header, and the cost of all of it (a full pass only on a structural change).
import { test, expect } from "./support/extension.js";
import { setup, sampleFiles, reasons, modes, pageHtml } from "./support/split.js";

const KINDS = ["hashed", "unhashed", "classic"];
const measures = (page, name) => page.evaluate((n) => performance.getEntriesByName(n).map((e) => e.duration), name);
const count = async (page, name) => (await measures(page, name)).length;

// Mount a review thread inside the left (hidden) text cell of the first context line of table `i`.
function mountLeft(page, i, how = "append") {
  return page.evaluate(([i, how]) => {
    const t = document.querySelectorAll("table")[i];
    const cell = [...t.querySelectorAll("tbody > tr")].find((tr) => tr.children.length === 4 && tr.children[1].querySelector("code, .blob-code-inner") && !tr.querySelector("[data-diff-type=addition], .addition, .blob-code-addition"))
      .children[1];
    const thread = document.createElement("div");
    thread.className = "ReviewThreadContainer__late";
    thread.innerHTML = '<div class="review-thread"><p>Late comment</p><button type="button">Reply…</button></div>';
    if (how === "append") cell.appendChild(thread);
    else if (how === "replace") cell.replaceChild(thread, cell.firstElementChild); // same child count
    else if (how === "nested") (cell.querySelector("code") || cell).appendChild(thread);
    else if (how === "text") (cell.querySelector("[data-diff-text-inner], .diff-text-inner, .blob-code-inner")).textContent += " (edited)";
    return true;
  }, [i, how]);
}

const OUT = ["additions", "deletions", null, null, "additions"];

for (const kind of KINDS) {
  test.describe(kind, () => {
    test("a thread mounted later in the hidden half returns the file to Split; resolving it applies one column again", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      await mountLeft(page, 0);
      await expect.poll(async () => (await modes(page))[0]).toBeNull();
      expect((await reasons(page))[0]).toBe("content-on-hidden-side");
      await expect(page.locator("table").first().locator("[data-ghsoc-control]")).toHaveCount(0);
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(2);
      await page.evaluate(() => document.querySelector("table .ReviewThreadContainer__late").remove());
      await expect.poll(async () => (await modes(page))[0]).toBe("additions");
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(3);
    });

    test("a thread that replaces a child without changing any count, and one nested in a wrapper, are seen", async ({ context, page }) => {
      for (const how of ["replace", "nested"]) {
        const { url } = await setup(context, kind, sampleFiles());
        await page.goto(url);
        await expect.poll(() => modes(page)).toEqual(OUT);
        await mountLeft(page, 0, how);
        await expect.poll(async () => (await modes(page))[0], how).toBeNull();
        expect((await reasons(page))[0], how).toBe("content-on-hidden-side");
        await context.unrouteAll();
      }
    });

    test("a changed text on the hidden copy of a context line returns the file to Split", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      await mountLeft(page, 0, "text");
      await expect.poll(async () => (await modes(page))[0]).toBeNull();
      expect((await reasons(page))[0]).toBe("content-on-hidden-side");
    });

    test("a thread added later on the visible side keeps one column", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      const rows0 = await count(page, "ghsoc:row");
      await page.evaluate(() => {
        const t = document.querySelectorAll("table")[0];
        const isAdd = (td) => td.matches(".blob-code-addition") || !!td.querySelector("[data-diff-type=addition], .addition");
        const cell = [...t.querySelectorAll("tbody > tr")].find((tr) => tr.children.length === 4 && isAdd(tr.children[3])).children[3];
        const th = document.createElement("div");
        th.innerHTML = '<div class="review-thread"><p>Visible-side comment</p></div>';
        cell.appendChild(th);
      });
      await expect.poll(() => count(page, "ghsoc:row")).toBe(rows0 + 1);
      expect((await modes(page))[0]).toBe("additions");
    });

    test("a hover bar on the would-be-hidden side does not keep the file in Split, in either direction", async ({ context, page }) => {
      const files = sampleFiles();
      files[0].rows[1].bar = "left"; // GitHub's text-free "Add comment" / "More actions" bar, there at load
      const { url } = await setup(context, kind, files);
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      expect((await reasons(page))[0]).toBe("additions-only");
      // mounted and removed later
      await page.evaluate(() => {
        const cell = document.querySelectorAll("table")[1].querySelector("tbody > tr:nth-child(2)").children[3 - 1 + 0];
        const bar = document.createElement("div");
        bar.className = "addCommentButton__late";
        bar.innerHTML = '<button type="button" aria-label="Add comment"></button>';
        (cell || document.body).appendChild(bar);
        setTimeout(() => bar.remove(), 50);
      });
      await page.waitForTimeout(400);
      expect((await modes(page))[1]).toBe("deletions");
    });

    test("a file in Split because of a thread on the hidden side switches to one column when that thread goes", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => reasons(page)).toContain("content-on-hidden-side");
      await page.evaluate(() => document.querySelectorAll("table")[3].querySelector(".review-thread").closest("div:not(.review-thread)").remove());
      await expect.poll(async () => (await modes(page))[3]).toBe("additions");
      await expect(page.locator("table").nth(3).locator("[data-ghsoc-control]")).toHaveCount(0);
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(4);
    });

    test("a table that arrives later (Load diff) is evaluated by the same rules; Unified then Split re-evaluates", async ({ context, page }) => {
      const files = sampleFiles();
      const { url } = await setup(context, kind, files.slice(0, 1));
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(["additions"]);
      const late = pageHtml(kind, files.slice(1, 3));
      await page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const f of doc.querySelectorAll("main > *")) document.querySelector("main").appendChild(document.importNode(f, true));
      }, late);
      await expect.poll(() => modes(page)).toEqual(["additions", "deletions", null]);
      // Split -> Unified (the table is replaced by a three-column one), then back
      const unified = pageHtml("hashed", [{ ...files[0], unified: true }]);
      const split = await page.locator("table").first().evaluate((t) => t.outerHTML);
      await page.evaluate((html) => {
        const t = document.querySelector("table");
        const d = new DOMParser().parseFromString(html, "text/html");
        t.replaceWith(document.importNode(d.querySelector("table"), true));
      }, unified);
      await expect.poll(async () => (await reasons(page))[0]).toBe("already-one-column");
      await expect(page.locator("[data-ghsoc-control]")).toHaveCount(1); // the other file only
      await page.evaluate((html) => {
        const t = document.querySelector("table");
        const w = document.createElement("div");
        w.innerHTML = html;
        t.replaceWith(w.firstElementChild);
      }, split);
      await expect.poll(async () => (await modes(page))[0]).toBe("additions");
    });

    test("GitHub resetting a reduced colspan re-applies it; the extension's own writes start no evaluation", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      const hunk = () => page.evaluate(() => document.querySelectorAll("table")[0].querySelector("tbody > tr").lastElementChild.colSpan);
      const original = await page.evaluate(() => Number(document.querySelectorAll("table")[0].querySelector("[data-ghsoc-colspan]").getAttribute("data-ghsoc-colspan")));
      expect(await hunk()).toBe(original - 1);
      const full0 = await count(page, "ghsoc:full");
      await page.evaluate((n) => { document.querySelectorAll("table")[0].querySelector("[data-ghsoc-colspan]").colSpan = n; }, original);
      await expect.poll(() => count(page, "ghsoc:full")).toBe(full0 + 1);
      await expect.poll(hunk).toBe(original - 1);
      // idle: nothing evaluates
      const row0 = await count(page, "ghsoc:row");
      await page.locator("[data-ghsoc-control]").first().click();
      await page.locator("[data-ghsoc-control]").first().click();
      await page.waitForTimeout(500);
      expect(await count(page, "ghsoc:row")).toBe(row0);
      expect(await count(page, "ghsoc:full")).toBe(full0 + 1);
    });

    test("a GitHub record queued before our colspan write is still handled", async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      // in one task: a hidden-side thread is mounted and the reduced colspan is reset
      await page.evaluate(() => {
        const t = document.querySelectorAll("table")[0];
        const cell = [...t.querySelectorAll("tbody > tr")].find((tr) => tr.children.length === 4 && tr.children[1].querySelector("code, .blob-code-inner") && !tr.querySelector("[data-diff-type=addition], .addition, .blob-code-addition")).children[1];
        const th = document.createElement("div");
        th.innerHTML = '<div class="review-thread"><p>Queued</p></div>';
        cell.appendChild(th);
        t.querySelector("[data-ghsoc-colspan]").colSpan = 4;
      });
      await expect.poll(async () => (await modes(page))[0]).toBeNull();
      expect((await reasons(page))[0]).toBe("content-on-hidden-side");
      expect(await page.evaluate(() => document.querySelectorAll("table")[0].querySelectorAll("[data-ghsoc-colspan]").length)).toBe(0);
    });
  });
}

test.describe("the way back is kept present", () => {
  const ANCHOR = { hashed: "viewed", unhashed: "more-options", classic: "file-menu" };
  for (const kind of KINDS) {
    test(`${kind}: a header node replaced while transformed gets exactly one control back, before its anchor`, async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      const h0 = await count(page, "ghsoc:header");
      await page.evaluate(() => {
        const c = document.querySelector("table").closest("[role=region],[data-tagsearch-path]");
        const hdr = c.firstElementChild;
        hdr.replaceWith(hdr.cloneNode(true)); // a re-render: the old control goes with the old node
      });
      await expect.poll(() => count(page, "ghsoc:header")).toBeGreaterThan(h0);
      const info = await page.evaluate(() => {
        const c = document.querySelector("table").closest("[role=region],[data-tagsearch-path]");
        const ctrls = c.querySelectorAll("[data-ghsoc-control]");
        return { n: ctrls.length, anchor: ctrls[0] && ctrls[0].getAttribute("data-ghsoc-anchor"), connectedNext: ctrls[0] && !!ctrls[0].nextElementSibling };
      });
      expect(info).toEqual({ n: 1, anchor: ANCHOR[kind], connectedNext: true });
      expect((await modes(page))[0]).toBe("additions");
      // and it still works
      await page.locator("[data-ghsoc-control]").first().click();
      expect((await modes(page))[0]).toBeNull();
    });

    test(`${kind}: the user's Split survives a header re-render, the control still reads One column`, async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      await page.locator("[data-ghsoc-control]").first().click();
      await page.evaluate(() => {
        const c = document.querySelector("table").closest("[role=region],[data-tagsearch-path]");
        const hdr = c.firstElementChild;
        hdr.replaceWith(hdr.cloneNode(true));
      });
      await expect(page.locator("[role=region], [data-tagsearch-path]").first().locator("[data-ghsoc-control]")).toHaveText("One column");
      expect((await modes(page))[0]).toBeNull();
    });

    test(`${kind}: a header re-rendered without any anchor reverts the table (anchor-missing); a stray control is removed`, async ({ context, page }) => {
      const { url } = await setup(context, kind, sampleFiles());
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(OUT);
      await page.evaluate(() => {
        const c = document.querySelector("table").closest("[role=region],[data-tagsearch-path]");
        const hdr = c.firstElementChild;
        const next = hdr.cloneNode(true);
        next.querySelectorAll("[data-ghsoc-control]").forEach((x) => x.remove());
        next.querySelectorAll('button[aria-label$="Viewed"], button[aria-haspopup="true"], details').forEach((x) => x.remove());
        hdr.replaceWith(next);
      });
      await expect.poll(async () => (await modes(page))[0]).toBeNull();
      expect((await reasons(page))[0]).toBe("anchor-missing");
      await expect(page.locator("[role=region], [data-tagsearch-path]").first().locator("[data-ghsoc-control]")).toHaveCount(0);
    });
  }

  test("Files changed: Viewed toggled (the button is re-rendered) keeps one control", async ({ context, page }) => {
    const { url } = await setup(context, "hashed", sampleFiles());
    await page.goto(url);
    await expect.poll(() => modes(page)).toEqual(OUT);
    await page.evaluate(() => {
      const b = document.querySelector('button[aria-label="Not Viewed"]');
      const n = b.cloneNode(true);
      n.setAttribute("aria-label", "Viewed");
      n.setAttribute("aria-pressed", "true");
      b.replaceWith(n);
    });
    await expect.poll(() => page.locator("[data-ghsoc-control]").count()).toBe(3);
    expect(await page.evaluate(() => document.querySelector("[data-ghsoc-control]").nextElementSibling.getAttribute("aria-label"))).toBe("Viewed");
  });
});

test("classic: an inline-comments row mounted on the hidden side reverts the file; on the visible side it does not", async ({ context, page }) => {
  const { url } = await setup(context, "classic", sampleFiles());
  await page.goto(url);
  await expect.poll(() => modes(page)).toEqual(OUT);
  const mount = (side) =>
    page.evaluate((side) => {
      const t = document.querySelectorAll("table")[0];
      const tr = document.createElement("tr");
      tr.className = "inline-comments";
      const cell = (content) => `<td class="line-comments" colspan="1">${content ? '<div class="review-thread"><p>Inline</p></div>' : ""}</td>`;
      tr.innerHTML = '<td class="blob-num"></td>' + cell(side === "left") + '<td class="blob-num"></td>' + cell(side === "right");
      t.querySelector("tbody").insertBefore(tr, t.querySelector("tbody").lastElementChild);
      return tr.className;
    }, side);
  await mount("right");
  await page.waitForTimeout(300);
  expect((await modes(page))[0]).toBe("additions");
  await mount("left");
  await expect.poll(async () => (await modes(page))[0]).toBeNull();
  expect((await reasons(page))[0]).toBe("content-on-hidden-side");
});

// --- cost --------------------------------------------------------------------

function bigRows(n, kind) {
  const rows = [{ t: "hunk", text: "@@ -1,3 +1,2503 @@" }, { t: "ctx", l: 1, r: 1, text: "first context line" }];
  for (let i = 0; i < n; i++) rows.push(kind === "twosided" ? { t: "mod", l: i + 2, r: i + 2, del: "old " + i, add: "new " + i } : { t: "add", r: i + 2, text: "added line number " + i });
  rows.push({ t: "ctx", l: n + 2, r: n + 2, text: "last context line" });
  return rows;
}

for (const kind of ["hashed", "classic"]) {
  test.describe(`${kind}: cost on a 2,500-row table`, () => {
    test("additions-only: the whole table lands within 100 ms; the scroll adds no evaluation", async ({ context, page }) => {
      const { url } = await setup(context, kind, [{ path: "data/catalog.csv", rows: bigRows(2500, "add") }]);
      await page.goto(url);
      await expect.poll(() => modes(page)).toEqual(["additions"]);
      const full = await measures(page, "ghsoc:full");
      expect(full.length).toBe(1);
      expect(full[0], `full pass ${full[0].toFixed(1)} ms for 2,500 rows`).toBeLessThan(100);
      const before = (await page.evaluate(() => performance.getEntriesByType("measure").filter((m) => m.name.startsWith("ghsoc:")).length));
      for (let y = 0; y < 60000; y += 4000) await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => performance.getEntriesByType("measure").filter((m) => m.name.startsWith("ghsoc:")).length)).toBe(before);
    });

    test("two-sided: a thread, a typed reply, hover bars, 50 rows added and 50 removed cost no full pass; each row check ≤ 2 ms", async ({ context, page }) => {
      const { url } = await setup(context, kind, [{ path: "data/catalog.csv", rows: bigRows(2500, "twosided") }]);
      await page.goto(url);
      await expect.poll(() => reasons(page)).toEqual(["two-sided-change"]);
      expect(await count(page, "ghsoc:full")).toBe(1);
      await page.evaluate(() => {
        const rows = document.querySelectorAll("table tbody > tr");
        const text = (tr) => tr.children[3];
        const th = document.createElement("div");
        th.innerHTML = '<div class="review-thread"><textarea></textarea></div>';
        text(rows[500]).appendChild(th);
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const ta = document.querySelector("table textarea");
        ta.parentElement.appendChild(document.createTextNode("typed reply"));
        ta.parentElement.appendChild(document.createTextNode(" and more"));
      });
      await page.waitForTimeout(200);
      for (let i = 0; i < 20; i++) {
        await page.evaluate((i) => {
          const cell = document.querySelectorAll("table tbody > tr")[600 + i].children[3];
          const bar = document.createElement("div");
          bar.innerHTML = '<button type="button" aria-label="Add comment"></button>';
          cell.appendChild(bar);
          setTimeout(() => bar.remove(), 10);
        }, i);
      }
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const body = document.querySelector("table tbody");
        const proto = body.children[10];
        const added = [];
        for (let i = 0; i < 50; i++) {
          const c = proto.cloneNode(true);
          body.insertBefore(c, body.children[20]);
          added.push(c);
        }
        setTimeout(() => added.forEach((a) => a.remove()), 100);
      });
      await page.waitForTimeout(600);
      const info = {
        full: await count(page, "ghsoc:full"),
        rowMax: Math.max(0, ...(await measures(page, "ghsoc:row"))),
        rowsMax: Math.max(0, ...(await measures(page, "ghsoc:rows"))),
        rowN: await count(page, "ghsoc:row"),
        rowsN: await count(page, "ghsoc:rows"),
      };
      expect(info.full, JSON.stringify(info)).toBe(1);
      expect(info.rowN + info.rowsN, JSON.stringify(info)).toBeGreaterThan(0);
      expect(info.rowMax, JSON.stringify(info)).toBeLessThanOrEqual(2);
      expect(info.rowsMax, JSON.stringify(info)).toBeLessThanOrEqual(20); // a batch of 50 rows: 0.4 ms a row
      // a structural change (the colgroup replaced) gives exactly one more full pass
      await page.evaluate(() => {
        const t = document.querySelector("table");
        const cg = t.querySelector("colgroup");
        cg.replaceWith(cg.cloneNode(true));
      });
      await expect.poll(() => count(page, "ghsoc:full")).toBe(2);
    });

    test("one-sided with a hidden-side thread (Split by rule 4): cell changes still cost no full pass", async ({ context, page }) => {
      const rows = bigRows(2500, "add");
      rows[1].thread = { side: "left", text: "blocks" };
      const { url } = await setup(context, kind, [{ path: "data/catalog.csv", rows }]);
      await page.goto(url);
      await expect.poll(() => reasons(page)).toEqual(["content-on-hidden-side"]);
      await page.evaluate(() => {
        const cell = document.querySelectorAll("table tbody > tr")[900].children[3];
        const d = document.createElement("div");
        d.textContent = "x";
        cell.appendChild(d);
      });
      await page.waitForTimeout(300);
      expect(await count(page, "ghsoc:full")).toBe(1);
      expect(Math.max(0, ...(await measures(page, "ghsoc:row"))), "row check").toBeLessThanOrEqual(2);
    });
  });
}

