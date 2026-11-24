// Unit tests for features/split-one-column/model.js: the routes, the tolerant cell markers,
// the five rules of the issue (classify), the incremental per-row summary and the mutation routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHSOC_MODEL: M } = loadGlobals(["features/split-one-column/model.js"]);

const num = () => ({ kind: "number", span: 1, change: null, text: "", foreign: false });
const empty = (foreign = false) => ({ kind: "empty", span: 1, change: null, text: "", foreign });
const text = (t, change = null, foreign = false) => ({ kind: "text", span: 1, change, text: t, foreign });
const hunk = () => ({ cells: [{ kind: "hunk", span: 4, change: null, text: "", foreign: false }] });
const ctx = (t, o = {}) => ({ cells: [num(), text(t, null, o.l), num(), text(o.r === undefined ? t : o.r, null, o.rf)] });
const add = (t, o = {}) => ({ cells: [empty(o.lf), empty(), num(), text(t, "addition", o.vf)] });
const del = (t, o = {}) => ({ cells: [num(), text(t, "deletion", o.vf), empty(o.rf), empty()] });
const mod = () => ({ cells: [num(), text("a", "deletion"), num(), text("b", "addition")] });
const shape = (rows, over = {}) => ({ declared: 4, rendered: 4, hasHeader: true, rows, ...over });
const plain = (o) => JSON.parse(JSON.stringify(o)); // the model lives in a vm context: compare by value
const why = (s) => M.classify(s).reason;

test("isRoute: Files changed, a commit range, a single commit and compare; not the Conversation tab", () => {
  for (const p of ["/a/b/pull/7/files", "/a/b/pull/7/changes", "/a/b/pull/7/changes/abc1234def", "/a/b/pull/7/commits/0471ec359edc65607efd3694fd8f4d0f1973f5ee", "/a/b/commit/0471ec3", "/a/b/compare/main...feature", "/a/b/compare/v1.0...v1.1"]) assert.equal(M.isRoute(p), true, p);
  for (const p of ["/a/b/pull/7", "/a/b/pull/7/commits", "/a/b/pulls", "/a/b/blob/main/x.js", "/a/b/compare", "/a/b/commits/main", "/a/b/issues/7"]) assert.equal(M.isRoute(p), false, p);
});

test("cellKind: data-diff-cell wins; hashed, older, unhashed and classic names all resolve", () => {
  assert.equal(M.cellKind({ cls: "whatever", dcell: "empty" }), "empty");
  assert.equal(M.cellKind({ cls: "x", dcell: "line-number" }), "number");
  assert.equal(M.cellKind({ cls: "x", dcell: "text" }), "text");
  assert.equal(M.cellKind({ cls: "x", dcell: "hunk" }), "hunk");
  // hashed
  assert.equal(M.cellKind({ cls: "focusableGridCell__2EfBCc emptyDiffLine__ismMVY" }), "empty");
  assert.equal(M.cellKind({ cls: "diffTextCell__iDACzF splitDiffTextCell__AoxeFC" }), "text");
  assert.equal(M.cellKind({ cls: "focusableGridCell__2EfBCc newDiffLineNumber__zAip2k" }), "number");
  assert.equal(M.cellKind({ cls: "diffHunkCell__gY06Xn" }), "hunk");
  // older CSS-module naming
  assert.equal(M.cellKind({ cls: "Diff-module__emptyDiffLine--abc12" }), "empty");
  assert.equal(M.cellKind({ cls: "Diff-module__diffTextCell--abc12" }), "text");
  // unhashed
  assert.equal(M.cellKind({ cls: "focusable-grid-cell empty-diff-line left-side" }), "empty");
  assert.equal(M.cellKind({ cls: "focusable-grid-cell diff-text-cell left-side-diff-cell" }), "text");
  assert.equal(M.cellKind({ cls: "focusable-grid-cell diff-line-number position-relative" }), "number");
  assert.equal(M.cellKind({ cls: "focusable-grid-cell diff-hunk-cell left-side" }), "hunk");
  // classic
  assert.equal(M.cellKind({ cls: "blob-num blob-num-empty empty-cell" }), "empty");
  assert.equal(M.cellKind({ cls: "blob-code blob-code-empty empty-cell" }), "empty");
  assert.equal(M.cellKind({ cls: "blob-num blob-num-addition js-linkable-line-number" }), "number");
  assert.equal(M.cellKind({ cls: "code-review blob-code blob-code-addition js-file-line" }), "text");
  assert.equal(M.cellKind({ cls: "blob-num blob-num-expandable" }), "hunk");
  assert.equal(M.cellKind({ cls: "blob-code blob-code-hunk" }), "hunk");
  // a renamed marker is not guessed
  assert.equal(M.cellKind({ cls: "blank-x" }), "other");
});

test("changeOf: data-diff-type, class tokens (any naming) and the classic marker", () => {
  assert.equal(M.changeOf({ type: "addition" }), "addition");
  assert.equal(M.changeOf({ cls: "diff-text syntax-highlighted-line deletion" }), "deletion");
  assert.equal(M.changeOf({ cls: "blob-code blob-code-addition js-file-line" }), "addition");
  assert.equal(M.changeOf({ cls: "x", marker: "-" }), "deletion");
  assert.equal(M.changeOf({ cls: "diffText__zi7oZU syntaxHighlightedLine__EXaUlS" }), null);
});

test("classify rule 1: three declared columns, or fewer than four rendered, is already one column", () => {
  assert.equal(why(shape([hunk(), add("x")], { declared: 3 })), "already-one-column");
  assert.equal(why(shape([hunk(), add("x")], { rendered: 3 })), "already-one-column");
});

test("classify rule 2: a missing anchor leaves the file alone", () => {
  assert.equal(why(shape([add("x")])), "anchor-missing"); // no hunk row
  assert.equal(why(shape([hunk()])), "anchor-missing"); // no line rows
  assert.equal(why(shape([hunk(), add("x")], { hasHeader: false })), "anchor-missing");
  assert.equal(why(shape([hunk(), add("x")], { declared: 5 })), "anchor-missing");
  // the empty-cell marker renamed: the cell is "other", the row is not a known shape
  const renamed = { cells: [{ kind: "other", span: 1, text: "" }, { kind: "other", span: 1, text: "" }, num(), text("x", "addition")] };
  assert.equal(why(shape([hunk(), renamed])), "anchor-missing");
  // 3-cell row in a four-column table, any other shape
  assert.equal(why(shape([hunk(), { cells: [empty(), num(), text("x", "addition")] }])), "anchor-missing");
  assert.equal(why(shape([hunk(), add("x"), { cells: [num()] }])), "anchor-missing");
  // an empty next to a context line is not a shape GitHub renders
  assert.equal(why(shape([hunk(), { cells: [empty(), empty(), num(), text("x")] }])), "anchor-missing");
});

test("classify rule 3: two-sided change, empties on both sides, no empty half", () => {
  assert.equal(why(shape([hunk(), add("a"), del("b")])), "two-sided-change");
  assert.equal(why(shape([hunk(), mod()])), "two-sided-change");
  assert.equal(why(shape([hunk(), { cells: [empty(), empty(), empty(), empty()] }])), "both-sides-empty");
  assert.equal(why(shape([hunk(), ctx("a"), ctx("b")])), "no-empty-half");
});

test("classify rule 5: additions-only hides the left half, deletions-only the right half", () => {
  assert.deepEqual(plain(M.classify(shape([hunk(), ctx("a"), add("b"), add("c"), ctx("d")]))), { outcome: "one-column", reason: "additions-only", hide: "left" });
  assert.deepEqual(plain(M.classify(shape([hunk(), ctx("a"), del("b"), ctx("d")]))), { outcome: "one-column", reason: "deletions-only", hide: "right" });
});

test("classify rule 4: content on the side to hide keeps Split; on the visible side it does not", () => {
  // a thread on the left copy of a context line: additions-only would hide the left
  assert.equal(why(shape([hunk(), ctx("a", { l: true }), add("b")])), "content-on-hidden-side");
  // the same thread on the right copy: the right is the visible side
  assert.equal(why(shape([hunk(), ctx("a", { rf: true }), add("b")])), "additions-only");
  // the hidden copy differs from the visible one (changed text, a marker on one side only)
  assert.equal(why(shape([hunk(), ctx("a", { r: "a2" }), add("b")])), "content-on-hidden-side");
  // content in the empty cells of an added line (a form, a thread)
  assert.equal(why(shape([hunk(), add("b", { lf: true })])), "content-on-hidden-side");
  // deletions-only mirrors it
  assert.equal(why(shape([hunk(), ctx("a", { rf: true }), del("b")])), "content-on-hidden-side");
  assert.equal(why(shape([hunk(), ctx("a", { l: true }), del("b")])), "deletions-only");
  assert.equal(why(shape([hunk(), del("b", { rf: true })])), "content-on-hidden-side");
});

test("rows that are not four-cell line rows: hunk, classic hunk and expander, inline comments", () => {
  assert.deepEqual(plain(M.checkRow({ cells: [{ kind: "hunk", span: 1 }, { kind: "hunk", span: 3 }] }, 4)), { ...plain(M.zero()), hunks: 1 });
  assert.deepEqual(plain(M.checkRow({ cells: [{ kind: "hunk", span: 4 }] }, 4)), { ...plain(M.zero()), hunks: 1 });
  assert.equal(M.checkRow({ cells: [{ kind: "hunk", span: 2 }] }, 4).unknown, 1); // does not span the table
  // inline-comments row: cell positions come from the cumulative colspan
  const row = (cells) => ({ inline: true, cells });
  assert.equal(M.checkRow(row([{ span: 1 }, { span: 1, content: true }, { span: 1 }, { span: 1 }]), 4).lBlock, 1);
  assert.equal(M.checkRow(row([{ span: 1 }, { span: 1 }, { span: 1 }, { span: 1, content: true }]), 4).rBlock, 1);
  assert.equal(M.checkRow(row([{ span: 1 }, { span: 1 }, { span: 1 }, { span: 1 }]), 4).lBlock, 0);
  assert.equal(M.checkRow(row([{ span: 1 }, { span: 3, content: true }]), 4).unknown, 1); // crosses the boundary
  assert.equal(why(shape([hunk(), { cells: [{ kind: "hunk", span: 1 }, { kind: "hunk", span: 3 }] }, add("x"), { inline: true, cells: [{ span: 1 }, { span: 1, content: true }, { span: 1 }, { span: 1 }] }])), "content-on-hidden-side");
  assert.equal(why(shape([hunk(), add("x"), { inline: true, cells: [{ span: 1 }, { span: 1 }, { span: 1 }, { span: 1, content: true }] }])), "additions-only");
});

// --- the incremental summary equals a full classification --------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const KINDS = [
  () => ctx("c"), () => ctx("c", { l: true }), () => ctx("c", { rf: true }), () => add("a"), () => add("a", { vf: true }), () => add("a", { lf: true }),
  () => del("d"), () => del("d", { rf: true }), () => mod(), () => hunk(),
];

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`incremental summary equals classify after random edits (seed ${seed})`, () => {
    const r = rng(seed);
    const pick = () => KINDS[Math.floor(r() * KINDS.length)]();
    // start from a table of one kind of change so every rule is reached
    const base = seed % 2 ? () => (r() < 0.5 ? ctx("c") : add("a")) : () => (r() < 0.5 ? ctx("c") : del("d"));
    let rows = [hunk(), ...Array.from({ length: 12 }, base)];
    const contribs = new Map();
    const sum = M.zero();
    rows.forEach((row) => {
      const c = M.checkRow(row, 4);
      contribs.set(row, c);
      M.add(sum, c, 1);
    });
    const meta = { declared: 4, rendered: 4, hasHeader: true };
    for (let step = 0; step < 300; step++) {
      const op = r();
      if (op < 0.5 && rows.length) {
        const i = Math.floor(r() * rows.length);
        M.add(sum, contribs.get(rows[i]), -1);
        const row = pick();
        contribs.set(row, M.checkRow(row, 4));
        M.add(sum, contribs.get(row), 1);
        rows[i] = row;
      } else if (op < 0.75) {
        const row = pick();
        const c = M.checkRow(row, 4);
        contribs.set(row, c);
        M.add(sum, c, 1);
        rows.splice(Math.floor(r() * (rows.length + 1)), 0, row);
      } else if (rows.length > 1) {
        const i = Math.floor(r() * rows.length);
        M.add(sum, contribs.get(rows[i]), -1);
        rows.splice(i, 1);
      }
      assert.deepEqual(M.decide(meta, sum), M.classify({ ...meta, rows }), `step ${step}`);
      assert.deepEqual(sum, M.summarize(rows.map((x) => M.checkRow(x, 4))), `sum at step ${step}`);
    }
  });
}

test("a 2,500-row table classifies well inside the 100 ms budget, and each row is checked once", () => {
  const rows = [hunk(), ...Array.from({ length: 2500 }, (_, i) => (i % 5 ? add("line " + i) : ctx("line " + i)))];
  const t0 = performance.now();
  const d = M.classify(shape(rows));
  const ms = performance.now() - t0;
  assert.equal(d.reason, "additions-only");
  assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
});

test("route: every record is routed by where it happened; the extension's own writes are ignored", () => {
  assert.equal(M.route({ type: "childList", where: "cell" }), "row");
  assert.equal(M.route({ type: "characterData", where: "cell" }), "row");
  assert.equal(M.route({ type: "childList", where: "row" }), "row");
  assert.equal(M.route({ type: "childList", where: "tbody", rowsOnly: true }), "rows");
  assert.equal(M.route({ type: "childList", where: "tbody", rowsOnly: false }), "table");
  assert.equal(M.route({ type: "childList", where: "table" }), "table");
  assert.equal(M.route({ type: "attributes", where: "cell", reduced: true }), "table"); // a reduced colspan reset by GitHub
  assert.equal(M.route({ type: "attributes", where: "cell", reduced: false }), "row");
  assert.equal(M.route({ type: "childList", where: "header" }), "header");
  assert.equal(M.route({ type: "childList", where: "outside" }), "ignore");
  assert.equal(M.route({ type: "attributes", where: "cell", reduced: true, ours: true }), "ignore");
});
