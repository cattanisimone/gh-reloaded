// Shared helpers for the "Split diff: one column" specs. The fixtures are built
// here from the markup captured live on 2026-11-24 (signed in, Split, a playground
// repository with fictional data): the three diff markups GitHub serves today and
// the file headers around them, with the real class names (hash suffixes kept)
// and a CSS mirror of the layout measured on the live pages (header heights, the
// 8px gap, the Viewed button, the 767px label breakpoint, the 561px view-buttons
// breakpoint, 40px number columns). Nothing here reads github.com.
//
//   kind "hashed"   pull request Files changed (React, Name__hash classes, data-diff-cell)
//   kind "unhashed" single commit (React, diff-text-cell, empty-diff-line, no data-diff-cell)
//   kind "classic"  compare (table.diff-table.file-diff-split, blob-num / blob-code)
//
// A file is { path, rows, viewed?: false, unified?: true, noAnchor?: true }. A row is one of
//   { t: "hunk", text }                        a hunk header
//   { t: "ctx", l, r, text }                   a context line (both numbers)
//   { t: "add", r, text }                      an added line (left half empty)
//   { t: "del", l, text }                      a deleted line (right half empty)
//   { t: "mod", l, r, del, add }               a modified line (both halves changed)
// plus optional { thread: { side: "left"|"right", text }, bar: "left"|"right", nonl: "left"|"right" }
// on a line row, and { t: "expander" } / { t: "inline", side, text } for the classic markup.
import fs from "node:fs";
import path from "node:path";
import { FIXTURES_DIR, seedStorage } from "./extension.js";

export const URLS = {
  hashed: "https://github.com/acme/web/pull/7/changes",
  unhashed: "https://github.com/acme/web/commit/0471ec359edc65607efd3694fd8f4d0f1973f5ee",
  classic: "https://github.com/acme/web/compare/main...feature",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const THREAD = (text) =>
  `<div class="ReviewThreadContainer__x7"><div class="review-thread">${text ? `<p>${esc(text)}</p>` : ""}<button type="button">Reply…</button><button type="button">Resolve conversation</button></div></div>`;
const BAR = `<div class="addCommentButton__p2"><button type="button" aria-label="Add comment"><svg width="12" height="12"></svg></button></div><div class="action-bar-position__q9"><button type="button" aria-label="More actions"><svg width="12" height="12"></svg></button></div>`;

// ---- rows ----------------------------------------------------------------

function reactRow(kind, r) {
  const H = kind === "hashed";
  const cls = {
    tr: H ? "diffLineRow__K43czL" : "diff-line-row",
    num: H ? "focusableGridCell__2EfBCc newDiffLineNumber__zAip2k diffLineNumberNeutral__r9aBDK" : "focusable-grid-cell diff-line-number position-relative diff-line-number-neutral left-side",
    txt: H ? "diffTextCell__iDACzF splitDiffTextCell__AoxeFC focusableGridCell__2EfBCc" : "focusable-grid-cell diff-text-cell left-side-diff-cell  border-right left-side",
    txtR: H ? "diffTextCell__iDACzF splitDiffTextCell__AoxeFC focusableGridCell__2EfBCc" : "focusable-grid-cell diff-text-cell right-side-diff-cell  ",
    empty: H ? "focusableGridCell__2EfBCc emptyDiffLine__ismMVY" : "focusable-grid-cell empty-diff-line left-side",
    hunk: H ? "diffHunkCell__gY06Xn focusableGridCell__2EfBCc" : "focusable-grid-cell diff-hunk-cell left-side",
    code: H ? "diffText__zi7oZU syntaxHighlightedLine__EXaUlS" : "diff-text syntax-highlighted-line",
    inner: H ? 'class="diffTextInner__YYVuoH" data-diff-text-inner="true"' : 'class="diff-text-inner"',
    marker: H ? 'class="diffTextMarker__-vA2jp" data-diff-text-marker="true"' : 'class="diff-text-marker"',
  };
  const dc = (v, side) => (H ? ` data-diff-cell="${v}" data-diff-side="${side}"` : "");
  const num = (n, side, add) => `<td class="${cls.num}"${dc("line-number", side)} data-line-number="${n}" role="gridcell" ${add ? 'data-changed="1"' : ""}>${H ? n : `<code>${n}</code>`}</td>`;
  const empty = (side) => `<td class="${cls.empty}"${dc("empty", side)} role="gridcell"></td>`;
  const extra = (side) => (r.thread && r.thread.side === side ? THREAD(r.thread.text) : "") + (r.bar === side ? BAR : "") + "";
  const nonl = (side) => (r.nonl === side ? '<span class="no-nl-icon" aria-label="No newline at end of file"></span>' : "");
  const text = (side, t, type, c) => {
    const code = `<code class="${cls.code}${!H && type ? " " + type : ""}"${H && type ? ` data-diff-type="${type}"` : ""}>${type ? `<span ${cls.marker}>${type === "addition" ? "+" : "-"}</span>` : ""}<div ${cls.inner}>${esc(t)}</div></code>`;
    return `<td class="${c}"${dc("text", side)} data-line-number="1" role="gridcell">${code}${nonl(side)}${extra(side)}</td>`;
  };
  if (r.t === "hunk") {
    return `<tr class="${cls.tr}"><td colspan="4" class="${cls.hunk}"${dc("hunk", "left")} role="gridcell"><div class="d-flex flex-row"><button class="Button Button--iconOnly expand-button-line__i06Y9x" aria-label="Expand file up" tabindex="-1"><svg width="16" height="16"></svg></button><code class="${H ? "diffHunkText__ekEQZU" : "diff-text-cell hunk"}"><div ${cls.inner}>${esc(r.text)}</div></code></div></td></tr>`;
  }
  if (r.t === "ctx") return `<tr class="${cls.tr}">${num(r.l, "left")}${text("left", r.text, null, cls.txt)}${num(r.r, "right")}${text("right", r.text, null, cls.txtR)}</tr>`;
  if (r.t === "add") return `<tr class="${cls.tr}">${empty("left")}${empty("left")}${num(r.r, "right", 1)}${text("right", r.text, "addition", cls.txtR)}</tr>`;
  if (r.t === "del") return `<tr class="${cls.tr}">${num(r.l, "left", 1)}${text("left", r.text, "deletion", cls.txt)}${empty("right")}${empty("right")}</tr>`;
  if (r.t === "mod") return `<tr class="${cls.tr}">${num(r.l, "left", 1)}${text("left", r.del, "deletion", cls.txt)}${num(r.r, "right", 1)}${text("right", r.add, "addition", cls.txtR)}</tr>`;
  return "";
}

function classicRow(r) {
  const nonl = (side) => (r.nonl === side ? '<div class="no-nl-marker">No newline at end of file</div>' : "");
  const thr = (side) => (r.thread && r.thread.side === side ? THREAD(r.thread.text) : "");
  const bar = (side) => (r.bar === side ? BAR : "");
  const num = (n, kind, id) => `<td class="blob-num blob-num-${kind} js-linkable-line-number" data-line-number="${n}" id="${id}"></td>`;
  const code = (side, kind, marker, t) =>
    `<td data-split-side="${side}" class="code-review blob-code blob-code-${kind} js-file-line"><span class="blob-code-inner blob-code-marker" data-code-marker="${marker}">${esc(t)}</span>${nonl(side)}${thr(side)}${bar(side)}</td>`;
  const emptyNum = `<td class="blob-num blob-num-empty empty-cell"></td>`;
  const emptyCode = (side) => `<td class="blob-code blob-code-empty empty-cell" data-split-side="${side}"></td>`;
  if (r.t === "hunk") return `<tr class="js-expandable-line js-skip-tagsearch"><td class="blob-num blob-num-hunk"></td><td class="blob-code blob-code-hunk" colspan="3">${esc(r.text)}</td></tr>`;
  if (r.t === "expander") return `<tr class="js-expandable-line js-skip-tagsearch"><td class="blob-num blob-num-expandable" colspan="1"><a href="#" class="js-expand" aria-label="Expand Up"><svg width="16" height="16"></svg></a></td><td class="blob-code blob-code-hunk" colspan="3"></td></tr>`;
  if (r.t === "inline") {
    const cell = (side, content) => (r.side === side ? `<td class="line-comments" colspan="1">${content}</td>` : `<td class="line-comments" colspan="1"></td>`);
    return `<tr class="inline-comments"><td class="blob-num"></td>${cell("left", THREAD(r.text))}<td class="blob-num"></td>${cell("right", THREAD(r.text))}</tr>`;
  }
  if (r.t === "ctx") return `<tr data-hunk="h">${num(r.l, "context", "L" + r.l)}${code("left", "context", " ", r.text)}${num(r.r, "context js-blob-rnum", "R" + r.r)}${code("right", "context", " ", r.text)}</tr>`;
  if (r.t === "add") return `<tr data-hunk="h">${emptyNum}${emptyCode("left")}${num(r.r, "addition js-blob-rnum", "R" + r.r)}${code("right", "addition", "+", r.text)}</tr>`;
  if (r.t === "del") return `<tr data-hunk="h">${num(r.l, "deletion", "L" + r.l)}${code("left", "deletion", "-", r.text)}${emptyNum}${emptyCode("right")}</tr>`;
  if (r.t === "mod") return `<tr data-hunk="h">${num(r.l, "deletion", "L" + r.l)}${code("left", "deletion", "-", r.del)}${num(r.r, "addition js-blob-rnum", "R" + r.r)}${code("right", "addition", "+", r.add)}</tr>`;
  return "";
}

// ---- tables and files -------------------------------------------------------

function unifiedRows(kind, rows) {
  // GitHub's own Unified: 3 columns. Enough for the "never touched" cases.
  return rows
    .map((r) => {
      if (r.t === "hunk") return `<tr><td colspan="3" class="diffHunkCell__gY06Xn" data-diff-cell="hunk">${esc(r.text)}</td></tr>`;
      const l = r.l != null ? r.l : "";
      const rr = r.r != null ? r.r : "";
      const t = r.text || r.add || r.del || "";
      return `<tr class="diffLineRow__K43czL"><td data-diff-cell="line-number" class="newDiffLineNumber__zAip2k">${l}</td><td data-diff-cell="line-number" class="newDiffLineNumber__zAip2k">${rr}</td><td data-diff-cell="text" class="diffTextCell__iDACzF"><code class="diffText__zi7oZU"><div data-diff-text-inner="true">${esc(t)}</div></code></td></tr>`;
    })
    .join("");
}

export function tableHtml(kind, file) {
  const rows = file.rows || [];
  if (file.unified) {
    return `<table aria-label="Diff for: ${esc(file.path)}" class="tab-size width-full diffLines__Iq8Z6r tableLayoutFixed__5FTnfJ"><colgroup><col width="40"><col width="40"><col></colgroup><tbody>${unifiedRows(kind, rows)}</tbody></table>`;
  }
  const body = rows.map((r) => (kind === "classic" ? classicRow(r) : reactRow(kind, r))).join("");
  if (kind === "classic") {
    return `<table class="diff-table js-diff-table tab-size file-diff-split js-file-diff-split" data-tab-size="4"><colgroup><col width="40"><col><col width="40"><col></colgroup><thead class="sr-only"><tr><th scope="col">Original file line number</th><th scope="col">Original file line</th><th scope="col">Diff line number</th><th scope="col">Diff line change</th></tr></thead><tbody>${body}</tbody></table>`;
  }
  const tcls = kind === "hashed" ? "tab-size width-full diffLines__Iq8Z6r tableLayoutFixed__5FTnfJ diffTargetable__jbrCub diff__GZFl4M" : "tab-size width-full tableLayoutFixed__jbqGYz position-relative";
  return `<table aria-label="Diff for: ${esc(file.path)}" class="${tcls}"><colgroup><col width="40"><col><col width="40"><col></colgroup><thead class="sr-only"><tr><th scope="col">Original file line number</th><th scope="col">Original file line</th><th scope="col">Diff line number</th><th scope="col">Diff line change</th></tr></thead><tbody>${body}</tbody></table>`;
}

const SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"></svg>';
const tip = (id, text) => `<span class="prc-TooltipV2-Tooltip-tLeuB" id="${id}" role="tooltip" aria-hidden="true" popover="auto">${text}</span>`;

function reactHeader(kind, file, i) {
  const viewed = kind === "hashed" && file.viewed !== false;
  const comment = kind === "hashed";
  const viewedBtn = viewed
    ? `<button data-component="Button" type="button" aria-pressed="false" aria-label="Not Viewed" class="prc-Button-ButtonBase-9n-Xk iconOnly__kjZ2po" data-size="small" data-variant="default"><span class="prc-Button-ButtonContent-Iohp5">${SVG}<span class="prc-Button-Label-FWkx3"><span class="hide-on-mobile__6ak-TF">Viewed</span></span></span></button>`
    : "";
  const commentBtn = comment ? `<button data-component="IconButton" type="button" aria-expanded="false" class="prc-Button-ButtonBase-9n-Xk prc-Button-IconButton-fyge7 hide-on-mobile__6ak-TF" data-size="small" data-variant="invisible" aria-labelledby="cm${i}">${SVG}</button>${tip("cm" + i, "Comment on this file")}` : "";
  const more = file.noAnchor
    ? ""
    : `<button data-component="IconButton" type="button" aria-haspopup="true" aria-expanded="false" class="prc-Button-ButtonBase-9n-Xk prc-Button-IconButton-fyge7" data-size="small" data-variant="invisible" aria-labelledby="mo${i}">${SVG}</button>${tip("mo" + i, "More options")}`;
  const group = file.noAnchor ? "" : `<div class="d-flex flex-items-center gap-2">${file.noAnchor ? "" : viewedBtn}${commentBtn}${more}</div>`;
  const add = (file.rows || []).filter((r) => r.t === "add").length;
  return `<div class="${kind === "hashed" ? "diffHeaderWrapper__INiK1j" : "diffHeaderWrapper__EHUZul"} header-wrap" data-diff-header-wrapper="true"><div class="diff-file-header__CV6GPS"><div class="d-flex flex-shrink-0"><button data-component="IconButton" type="button" class="prc-Button-ButtonBase-9n-Xk prc-Button-IconButton-fyge7" aria-labelledby="co${i}">${SVG}</button>${tip("co" + i, "Collapse file")}</div><div class="d-flex px-1 flex-items-center overflow-hidden file-path-section__ZYYNNI"><h3 id="heading-${i}" class="file-name__8GKEHg file-name-truncate__1IBLuh"><a class="Link--primary" href="#diff-${i}"><code>${esc(file.path)}</code></a></h3><button data-component="IconButton" type="button" class="prc-Button-ButtonBase-9n-Xk ml-2 flex-shrink-0 hide-on-mobile__MZF-2t" aria-label="Copy file name to clipboard">${SVG}</button></div><div class="d-flex flex-row flex-justify-end flex-items-center gap-2 flex-1"><div class="d-flex flex-justify-end flex-items-center"><div class="hide-on-mobile__MZF-2t"><span class="f6 fgColor-success text-bold">+${add}</span></div></div><ul aria-label="File view" class="prc-SegmentedControl-SegmentedControl-lqIXp hide-on-small__kkglR4"><li><button type="button" aria-pressed="true" aria-label="Display the source diff">${SVG}</button></li><li><button type="button" aria-pressed="false" aria-label="Display the rich diff">${SVG}</button></li></ul>${group}</div></div></div>`;
}

function classicHeader(file, i) {
  const menu = file.noAnchor
    ? ""
    : `<details class="js-file-header-dropdown dropdown details-overlay details-reset pr-2 pl-2"><summary class="height-full" aria-haspopup="menu" role="button"><div class="height-full d-flex flex-items-center Link--secondary">${SVG}</div></summary><details-menu class="dropdown-menu dropdown-menu-sw" role="menu"><label role="menuitemradio" class="dropdown-item" tabindex="0" aria-checked="true">Show comments</label><a href="/acme/web/blob/x/${esc(file.path)}" class="dropdown-item" role="menuitem">View file</a><button type="button" disabled role="menuitem" class="dropdown-item">Edit file</button></details-menu></details>`;
  return `<div class="file-header d-flex flex-md-row flex-column flex-md-items-center file-header--expandable js-file-header js-skip-tagsearch" data-path="${esc(file.path)}"><div class="file-info flex-auto min-width-0 mb-md-0 mb-2"><button type="button" class="btn-octicon js-details-target" aria-label="Toggle diff contents" aria-expanded="true">${SVG}</button><span class="Truncate"><a title="${esc(file.path)}" class="Link--primary Truncate-text" href="#diff-${i}">${esc(file.path)}</a></span></div><div class="file-actions pt-0 mb-md-0 mb-2 ml-md-2 flex-shrink-0 flex-md-justify-end"><div class="d-flex flex-justify-end">${file.noToggle ? "" : `<span class="BtnGroup min-width-0 flex-self-center"><form class="BtnGroup-parent"><button class="btn btn-sm BtnGroup-item selected" aria-current="true" aria-label="Display the source diff" type="submit">${SVG}</button></form><form class="BtnGroup-parent"><button class="btn btn-sm BtnGroup-item" aria-label="Display the rich diff" type="submit">${SVG}</button></form></span>`}${menu}</div></div></div>`;
}

export function fileHtml(kind, file, i) {
  const table = tableHtml(kind, file);
  if (kind === "classic") {
    return `<div id="diff-${i}" class="file js-file js-details-container show-inline-notes" data-tagsearch-path="${esc(file.path)}">${classicHeader(file, i)}<div class="js-file-content position-relative"><div class="data highlight js-blob-wrapper">${table}</div></div></div>`;
  }
  const wrap = kind === "hashed" ? "diff__GZFl4M" : "diff-wrap";
  return `<div id="diff-${i}" role="region" aria-labelledby="heading-${i}" class="file-region">${reactHeader(kind, file, i)}<div class="${wrap}">${table}</div></div>`;
}

const CSS = `
:root{--button-default-bgColor-rest:#f6f8fa;--button-default-borderColor-rest:#d1d9e0;--button-default-fgColor-rest:#25292e;--button-default-bgColor-hover:#eff2f5;--button-default-bgColor-active:#e6eaef;--button-default-shadow-resting:0 1px 0 rgba(31,35,40,.04);--focus-outlineColor:#0969da;--bgColor-default:#fff;--borderColor-default:#d1d9e0;--fgColor-default:#1f2328;--bgColor-muted:#f6f8fa;--add-num:#ccffd8;--add-line:#e6ffec;--del-num:#ffc1c0;--del-line:#ffebe9}
[data-color-mode=dark]{--button-default-bgColor-rest:#212830;--button-default-borderColor-rest:#3d444d;--button-default-fgColor-rest:#f0f6fc;--button-default-bgColor-hover:#262c36;--button-default-bgColor-active:#2a313c;--button-default-shadow-resting:0 0 transparent;--focus-outlineColor:#1f6feb;--bgColor-default:#0d1117;--borderColor-default:#3d444d;--fgColor-default:#f0f6fc;--bgColor-muted:#151b23;--add-num:#1b4721;--add-line:#12261e;--del-num:#5d0f12;--del-line:#25171c}
*{box-sizing:border-box}
body{margin:0;font:14px/21px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bgColor-default);color:var(--fgColor-default)}
main{padding:16px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.d-flex{display:flex}.flex-row{flex-direction:row}.flex-column{flex-direction:column}.flex-1{flex:1}.flex-shrink-0{flex-shrink:0}.flex-auto{flex:auto}
.flex-items-center{align-items:center}.flex-justify-end{justify-content:flex-end}.gap-1{gap:4px}.gap-2{gap:8px}.min-width-0{min-width:0}.overflow-hidden{overflow:hidden}.px-1{padding:0 4px}.ml-2{margin-left:8px}
.file-region,.file{border:1px solid var(--borderColor-default);border-radius:6px;margin:0 0 16px;background:var(--bgColor-default)}
.header-wrap{container-type:inline-size;position:sticky;top:0}
.diff-file-header__CV6GPS{display:flex;align-items:center;gap:8px;height:42px;padding:0 8px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default)}
.file-path-section__ZYYNNI{min-width:0;flex:0 1 auto}
.file-name-truncate__1IBLuh{font-size:12px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-name-truncate__1IBLuh a{color:inherit;text-decoration:none}
.prc-Button-IconButton-fyge7,.prc-Button-ButtonBase-9n-Xk{font:inherit}
.prc-Button-IconButton-fyge7{width:28px;height:28px;border:0;background:transparent;color:inherit;padding:0;display:inline-grid;place-items:center}
button.iconOnly__kjZ2po{height:28px;min-width:28px;padding:0 8px;border:1px solid var(--button-default-borderColor-rest);border-radius:6px;background:var(--button-default-bgColor-rest);color:var(--button-default-fgColor-rest);font-size:12px;font-weight:500;line-height:18px;box-shadow:var(--button-default-shadow-resting)}
.prc-Button-ButtonContent-Iohp5{display:inline-flex;align-items:center;gap:4px}
.prc-SegmentedControl-SegmentedControl-lqIXp{display:flex;list-style:none;margin:0;padding:0;gap:0}
.prc-TooltipV2-Tooltip-tLeuB{display:none}
@media (max-width:767.98px){.hide-on-mobile__MZF-2t,.hide-on-mobile__6ak-TF{display:none}}
@container (max-width:561px){.hide-on-small__kkglR4{display:none}}
.file-header{display:flex;align-items:center;gap:8px;min-height:41px;padding:0 8px;background:var(--bgColor-muted);border-bottom:1px solid var(--borderColor-default);font-size:12px}
.flex-md-row{flex-direction:column}.flex-md-items-center{align-items:stretch}
.file-info{flex:auto;min-width:0}.file-actions{flex-shrink:0}.mb-2{margin-bottom:8px}
@media (min-width:768px){.flex-md-row{flex-direction:row}.flex-md-items-center{align-items:center}.mb-md-0{margin-bottom:0}.ml-md-2{margin-left:8px}.flex-md-justify-end{justify-content:flex-end}}
.file-actions .BtnGroup{display:flex}.file-actions summary{list-style:none;display:flex;align-items:center;padding:0 8px;cursor:pointer}.file-actions details{position:relative}.file-actions .btn{height:28px;padding:0 8px;border:1px solid var(--button-default-borderColor-rest);background:var(--button-default-bgColor-rest)}
details-menu{position:absolute;right:0;z-index:5;background:var(--bgColor-default);border:1px solid var(--borderColor-default)}
details:not([open]) > details-menu{display:none}
table{width:100%;border-collapse:collapse;table-layout:fixed;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace}
td{padding:0 8px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}
td.newDiffLineNumber__zAip2k,td.diff-line-number,td.blob-num{padding:0 8px;text-align:right;color:#59636e;width:40px}
td.diffHunkCell__gY06Xn,td.diff-hunk-cell,td.blob-code-hunk,td.blob-num-hunk,td.blob-num-expandable{background:#ddf4ff;color:#59636e}
td.emptyDiffLine__ismMVY,td.empty-diff-line,td.empty-cell{background:var(--bgColor-muted)}
td[data-diff-type]{}
code{font:inherit;white-space:inherit}
tr:has(code[data-diff-type=addition]) td[data-diff-cell=text]:last-child,tr:has(code.addition) td.right-side-diff-cell,td.blob-code-addition{background:var(--add-line)}
tr:has(code[data-diff-type=addition]) td[data-diff-cell=line-number]:nth-child(3),tr:has(code.addition) td.diff-line-number:nth-child(3),td.blob-num-addition{background:var(--add-num)}
tr:has(code[data-diff-type=deletion]) td[data-diff-cell=text]:nth-child(2),tr:has(code.deletion) td.left-side-diff-cell,td.blob-code-deletion{background:var(--del-line)}
tr:has(code[data-diff-type=deletion]) td[data-diff-cell=line-number]:nth-child(1),tr:has(code.deletion) td.diff-line-number:nth-child(1),td.blob-num-deletion{background:var(--del-num)}
.border-right{border-right:1px solid var(--borderColor-default)}
.review-thread{border:1px solid var(--borderColor-default);border-radius:6px;margin:8px;padding:8px;white-space:normal;font-family:sans-serif}
.addCommentButton__p2,.action-bar-position__q9{display:inline-block;position:absolute;right:4px}
`;

export function pageHtml(kind, files, { dark = false, title = "" } = {}) {
  const body = files.map((f, i) => fileHtml(kind, f, i)).join("\n");
  return `<!doctype html><html lang="en" data-color-mode="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><title>${esc(title || "Diff")}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

// A representative page: one file of each outcome, with the real class names of the markup.
export function sampleFiles() {
  const long = "Each invoice lists one line per plan and the seat count, the unit price and the tax, and it can be downloaded as a PDF file from the billing page by every member of the finance team";
  return [
    { path: "docs/guide.md", rows: [{ t: "hunk", text: "@@ -6,6 +6,9 @@" }, { t: "ctx", l: 8, r: 8, text: long }, { t: "add", r: 9, text: "A plan line shows the seat count and the unit price." }, { t: "add", r: 10, text: "Taxes are shown in a separate line at the bottom." }, { t: "ctx", l: 9, r: 11, text: "Customers can download invoices as PDF files." }] },
    { path: "notes/legacy-setup.md", rows: [{ t: "hunk", text: "@@ -4,7 +4,4 @@" }, { t: "ctx", l: 4, r: 4, text: "Install the CLI." }, { t: "del", l: 5, text: "Run the legacy migration script." }, { t: "del", l: 6, text: "Restart the worker by hand." }, { t: "ctx", l: 7, r: 5, text: "Open the dashboard." }] },
    { path: "src/cart/totals.ts", rows: [{ t: "hunk", text: "@@ -1,3 +1,3 @@" }, { t: "ctx", l: 1, r: 1, text: "export const total = 1;" }, { t: "mod", l: 2, r: 2, del: "const a = 1;", add: "const a = 2;" }, { t: "add", r: 3, text: "const b = 3;" }] },
    { path: "docs/thread-left.md", rows: [{ t: "hunk", text: "@@ -1,2 +1,3 @@" }, { t: "ctx", l: 1, r: 1, text: "Intro line", thread: { side: "left", text: "Please reword this." } }, { t: "add", r: 2, text: "Added line" }] },
    { path: "docs/thread-right.md", rows: [{ t: "hunk", text: "@@ -1,2 +1,3 @@" }, { t: "ctx", l: 1, r: 1, text: "Intro line" }, { t: "add", r: 2, text: "Added line", thread: { side: "right", text: "Looks good." } }] },
  ];
}

// Serve `files` as the page for every github.com document request and log what else is asked.
export async function setup(context, kind, files, opts = {}) {
  const { storage, dark = false, url, html } = opts;
  if (storage) await seedStorage(context, storage);
  const doc = html || pageHtml(kind, files, { dark });
  const requests = [];
  await context.route("https://github.com/**", (route) => {
    const req = route.request();
    if (req.resourceType() === "document") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: doc });
    requests.push(req.url());
    return route.abort();
  });
  const api = [];
  await context.route("https://api.github.com/**", (route) => {
    api.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  return { requests, api, url: url || URLS[kind] };
}

export function writeFixture(name, html) {
  fs.writeFileSync(path.join(FIXTURES_DIR, name), html);
}

// The decision the extension left on each table, in order.
export const reasons = (page) => page.evaluate(() => [...document.querySelectorAll("table")].map((t) => t.getAttribute("data-ghsoc-reason")));
export const modes = (page) => page.evaluate(() => [...document.querySelectorAll("table")].map((t) => t.getAttribute("data-ghsoc")));
