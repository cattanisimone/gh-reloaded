// features/split-one-column/model.js — pure rules of "Split diff: one column
// for one-sided files": which routes it runs on, how a cell and a row of a
// diff table are told apart across GitHub's three markups, the incremental
// per-row summary, and the five-rule decision (the issue's detection table).
// No DOM, no chrome.*: unit-tested through globalThis.GHSOC_MODEL. The content
// script reads the page into the plain shapes described below and applies the
// outcome.
//
// Shapes
//   cell  { kind: "number"|"text"|"empty"|"hunk"|"other", span, change: "addition"|"deletion"|null,
//           text: string, foreign: boolean }
//         `foreign` is true when the cell holds anything that is not the line itself: text outside
//         the line's code, or a form field. A text-free element subtree (GitHub's hover "Add comment"
//         bar) is an affordance, not content.
//   row   { inline?: true, cells: cell[] }   (inline: classic tr.inline-comments, cells carry { span, content })
//   contribution { unknown, hunks, lines, lChange, rChange, lEmpty, rEmpty, lBlock, rBlock }
//         what one row adds to the table's summary; the summary is their sum.

(function () {
  const HALVES = { left: [0, 1], right: [2, 3] };

  // Pull request Files changed (and a commit range inside it), a single commit, a compare page.
  function isRoute(pathname) {
    const p = String(pathname || "");
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)(\/.*)?$/.test(p)) return true;
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/commits\/[0-9a-f]{7,40}\/?$/i.test(p)) return true;
    if (/^\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}\/?$/i.test(p)) return true;
    if (/^\/[^/]+\/[^/]+\/compare\/[^/]+/.test(p)) return true;
    return false;
  }

  // The kind of a cell from its own classes and data-diff-cell, tolerant of the hashed
  // (Name__hash), older (X-module__name--hash), unhashed (diff-text-cell) and classic
  // (blob-num / blob-code) names. data-diff-cell wins when present. Never one class name.
  function cellKind({ cls, dcell }) {
    const c = String(cls || "");
    if (dcell) {
      if (dcell === "empty" || dcell === "hunk") return dcell;
      if (dcell === "line-number") return "number";
      if (dcell === "text") return "text";
    }
    if (/empty-?diff-?line|empty-cell/i.test(c)) return "empty";
    if (/hunk|expandable/i.test(c)) return "hunk";
    if (/line-?number|blob-num/i.test(c)) return "number";
    if (/text-?cell|blob-code/i.test(c)) return "text";
    return "other";
  }

  // addition / deletion from the code element's data-diff-type, its classes or the classic marker.
  function changeOf({ type, cls, marker }) {
    if (type === "addition" || type === "deletion") return type;
    for (const t of String(cls || "").split(/\s+/)) {
      const m = /(?:^|[-_])(addition|deletion)(?:[-_]|$)/.exec(t);
      if (m) return m[1];
    }
    if (marker === "+") return "addition";
    if (marker === "-") return "deletion";
    return null;
  }

  const ZERO = () => ({ unknown: 0, hunks: 0, lines: 0, lChange: 0, rChange: 0, lEmpty: 0, rEmpty: 0, lBlock: 0, rBlock: 0 });

  function sideState(a, b) {
    if (a.kind === "empty" && b.kind === "empty") return "empty";
    if (a.kind === "number" && b.kind === "text") return b.change ? "change" : "ctx";
    return null;
  }

  // What one row adds to the summary. `cols` is the declared column count (4 here: Split).
  function checkRow(row, cols) {
    const c = ZERO();
    const cells = row.cells || [];
    if (row.inline) {
      let at = 0;
      for (const cell of cells) {
        const span = cell.span || 1;
        const start = at;
        const end = at + span - 1;
        at += span;
        if (start <= HALVES.left[1] && end >= HALVES.right[0]) {
          c.unknown = 1; // a cell crossing the left/right boundary: never guessed
          continue;
        }
        if (!cell.content) continue;
        if (end <= HALVES.left[1]) c.lBlock++;
        else c.rBlock++;
      }
      return c;
    }
    const sum = cells.reduce((s, x) => s + (x.span || 1), 0);
    if (cells.length >= 1 && cells.length <= 2 && cells.every((x) => x.kind === "hunk") && sum === cols) {
      c.hunks = 1;
      return c;
    }
    if (cells.length !== 4 || cells.some((x) => (x.span || 1) !== 1)) {
      c.unknown = 1;
      return c;
    }
    const [a, b, d, e] = cells;
    const L = sideState(a, b);
    const R = sideState(d, e);
    if (!L || !R) {
      c.unknown = 1;
      return c;
    }
    c.lines = 1;
    if (L === "ctx" && R === "ctx") {
      const same = b.text === e.text;
      if (b.foreign || a.foreign || !same) c.lBlock = 1;
      if (e.foreign || d.foreign || !same) c.rBlock = 1;
    } else if (L === "empty" && R === "change") {
      c.lEmpty = 1;
      c.rChange = 1;
      if (a.foreign || b.foreign) c.lBlock = 1;
    } else if (L === "change" && R === "empty") {
      c.lChange = 1;
      c.rEmpty = 1;
      if (d.foreign || e.foreign) c.rBlock = 1;
    } else if (L === "change" && R === "change") {
      c.lChange = 1;
      c.rChange = 1;
    } else if (L === "empty" && R === "empty") {
      c.lEmpty = 1;
      c.rEmpty = 1;
    } else {
      c.unknown = 1; // empty next to context, a change next to context: not a shape GitHub renders
    }
    return c;
  }

  function add(sum, c, sign) {
    const s = sign || 1;
    for (const k in c) sum[k] += s * c[k];
    return sum;
  }

  function summarize(contribs) {
    const sum = ZERO();
    for (const c of contribs) add(sum, c, 1);
    return sum;
  }

  // Rules 1 to 5 of the issue. info: { declared, rendered, hasHeader }.
  function decide(info, s) {
    const out = (outcome, reason, hide) => ({ outcome, reason, hide: hide || null });
    if (info.declared === 3 || (info.rendered > 0 && info.rendered < 4 && info.declared === 4)) return out("untouched", "already-one-column");
    if (info.declared !== 4 || !info.hasHeader) return out("untouched", "anchor-missing");
    if (s.unknown > 0 || s.hunks === 0 || s.lines === 0) return out("untouched", "anchor-missing");
    if (s.lChange > 0 && s.rChange > 0) return out("untouched", "two-sided-change");
    if (s.lEmpty > 0 && s.rEmpty > 0) return out("untouched", "both-sides-empty");
    if (s.lEmpty === 0 && s.rEmpty === 0) return out("untouched", "no-empty-half");
    const left = s.lEmpty > 0;
    if ((left ? s.lBlock : s.rBlock) > 0) return out("split", "content-on-hidden-side");
    return out("one-column", left ? "additions-only" : "deletions-only", left ? "left" : "right");
  }

  // The whole pipeline over a shape: { declared, rendered, hasHeader, rows }.
  function classify(shape) {
    const sum = summarize((shape.rows || []).map((r) => checkRow(r, shape.declared)));
    return decide(shape, sum);
  }

  // Where a DOM record happened → what to do. rec: { type, where, ours, reduced, rowsOnly }
  //   where: "table" (table, colgroup, thead, col), "tbody", "row" (a tr), "cell" (inside a td),
  //          "header" (file header of a file that has our control), "outside"
  //   rowsOnly: a childList record of a tbody that added or removed only rows
  function route(rec) {
    if (rec.ours) return "ignore";
    const w = rec.where;
    if (w === "outside") return "ignore";
    if (w === "header") return "header";
    if (w === "table") return "table";
    if (rec.type === "attributes") return rec.reduced ? "table" : "row";
    if (w === "tbody") return rec.rowsOnly ? "rows" : "table";
    if (w === "row" || w === "cell") return "row";
    return "ignore";
  }

  const LABEL = { split: "Side by side", one: "One column" };
  const DESC = { one: "Shown in one column", split: "Shown side by side" };

  globalThis.GHSOC_MODEL = { isRoute, cellKind, changeOf, checkRow, add, summarize, decide, classify, route, zero: ZERO, LABEL, DESC };
})();
