// Unit tests for features/resolved-conversations/model.js: the copy tables of
// the issue, the toggle rule, the status texts and when a "K of N" result is
// forgotten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHRC_MODEL: M } = loadGlobals(["features/resolved-conversations/model.js"]);

test("label: first row of the copy table, both columns", () => {
  assert.equal(M.label({ n: 7, open: 0, loadMore: false }), "7 resolved conversations");
  assert.equal(M.label({ n: 7, open: 3, loadMore: false }), "7 resolved conversations");
  assert.equal(M.label({ n: 7, open: 0, loadMore: true }), "7 loaded resolved conversations · more may be hidden");
});

test("label: all open", () => {
  assert.equal(M.label({ n: 7, open: 7, loadMore: false }), "7 of 7 resolved conversations expanded");
  assert.equal(M.label({ n: 7, open: 7, loadMore: true }), "7 of 7 loaded resolved conversations expanded · more may be hidden");
});

test("label: after an Expand in which some did not open", () => {
  assert.equal(M.label({ n: 40, open: 38, loadMore: false, result: 38 }), "38 of 40 resolved conversations expanded");
  assert.equal(M.label({ n: 40, open: 38, loadMore: true, result: 38 }), "38 of 40 loaded resolved conversations expanded · more may be hidden");
  assert.equal(M.label({ n: 40, open: 0, loadMore: false, result: 0 }), "0 of 40 resolved conversations expanded");
});

test("label: N = 1 uses the singular in every row", () => {
  assert.equal(M.label({ n: 1, open: 0, loadMore: false }), "1 resolved conversation");
  assert.equal(M.label({ n: 1, open: 1, loadMore: false }), "1 of 1 resolved conversation expanded");
  assert.equal(M.label({ n: 1, open: 0, loadMore: true }), "1 loaded resolved conversation · more may be hidden");
  assert.equal(M.label({ n: 1, open: 1, loadMore: true }), "1 of 1 loaded resolved conversation expanded · more may be hidden");
  assert.equal(M.label({ n: 1, open: 0, loadMore: false, result: 0 }), "0 of 1 resolved conversation expanded");
});

test("a result is ignored once everything is open", () => {
  assert.equal(M.label({ n: 3, open: 3, loadMore: false, result: 2 }), "3 of 3 resolved conversations expanded");
});

test("toggle rule: Expand while any loaded resolved conversation is closed, Collapse only when all are open", () => {
  assert.equal(M.allOpen(3, 3), true);
  assert.equal(M.allOpen(3, 2), false);
  assert.equal(M.allOpen(3, 0), false);
  assert.equal(M.allOpen(0, 0), false);
});

test("buttonText: the four labels and Expanding…", () => {
  assert.equal(M.buttonText({ allOpen: false, loadMore: false }), "Expand all resolved");
  assert.equal(M.buttonText({ allOpen: true, loadMore: false }), "Collapse all resolved");
  assert.equal(M.buttonText({ allOpen: false, loadMore: true }), "Expand loaded resolved");
  assert.equal(M.buttonText({ allOpen: true, loadMore: true }), "Collapse loaded resolved");
  assert.equal(M.buttonText({ allOpen: false, loadMore: true, busy: true }), "Expanding…");
  assert.equal(M.buttonText({ allOpen: true, loadMore: false, busy: true }), "Expanding…");
});

test("status: every cell of the announcement table", () => {
  assert.equal(M.status({ kind: "expanded", n: 7, k: 7, loadMore: false }), "7 resolved conversations expanded");
  assert.equal(M.status({ kind: "expanded", n: 7, k: 7, loadMore: true }), "7 loaded resolved conversations expanded, more may be hidden");
  assert.equal(M.status({ kind: "expanded", n: 7, k: 5, loadMore: false }), "5 of 7 resolved conversations expanded");
  assert.equal(M.status({ kind: "expanded", n: 7, k: 5, loadMore: true }), "5 of 7 loaded resolved conversations expanded, more may be hidden");
  assert.equal(M.status({ kind: "collapsed", n: 7, loadMore: false }), "7 resolved conversations collapsed");
  assert.equal(M.status({ kind: "collapsed", n: 7, loadMore: true }), "7 loaded resolved conversations collapsed, more may be hidden");
  assert.equal(M.status({ kind: "expanded", n: 1, k: 1, loadMore: false }), "1 resolved conversation expanded");
  assert.equal(M.status({ kind: "collapsed", n: 1, loadMore: true }), "1 loaded resolved conversation collapsed, more may be hidden");
});

test("keepResult: a result survives only while nothing changed since the Expand ended", () => {
  const r = { k: 2, sig: "1o|2o|3c" };
  assert.equal(M.keepResult(r, "1o|2o|3c"), true);
  assert.equal(M.keepResult(r, "1o|2c|3c"), false, "manual close");
  assert.equal(M.keepResult(r, "1o|2o|3o"), false, "late open");
  assert.equal(M.keepResult(r, "1o|2o|3c|4c"), false, "set changed");
  assert.equal(M.keepResult(null, "x"), false);
});

test("isRoute: only the Conversation tab of a pull request", () => {
  for (const p of ["/acme/web/pull/7", "/acme/web/pull/7/"]) assert.equal(M.isRoute(p), true, p);
  for (const p of ["/acme/web/pull/7/files", "/acme/web/pull/7/changes", "/acme/web/pull/7/commits", "/acme/web/pull/7/checks", "/acme/web/issues/7", "/acme/web/pulls", "/acme/web/pull/x", "/"]) {
    assert.equal(M.isRoute(p), false, p);
  }
});

test("boundMs: a positive integer override, otherwise the measured default", () => {
  assert.equal(M.BOUND_MS, 6000);
  assert.equal(M.boundMs(undefined), 6000);
  assert.equal(M.boundMs("600"), 600);
  assert.equal(M.boundMs("0"), 6000);
  assert.equal(M.boundMs("abc"), 6000);
});
