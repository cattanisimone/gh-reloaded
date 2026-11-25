// Unit tests for features/viewed-folders/model.js: the route, counting by path
// prefix, the merge of the two sources, the folder states and the exact copy of
// every variant of the plan's copy table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHVF_MODEL: M } = loadGlobals(["features/viewed-folders/model.js"]);

const exact = (c, o = {}) => M.describe({ unknown: 0, notViewed: 0, viewed: 0, ...c }, { proven: true, loading: false, ...o });

test("route: the new Files changed page of a pull request only", () => {
  assert.deepEqual({ ...M.parseRoute("/acme/web/pull/7/files") }, { owner: "acme", repo: "web", number: 7 });
  assert.equal(M.isRoute("/acme/web/pull/7/changes"), true);
  assert.equal(M.isRoute("/acme/web/pull/7/files/"), true);
  for (const p of ["/acme/web/pull/7", "/acme/web/pull/7/commits", "/acme/web/pull/7/files/abc..def", "/acme/web/pull/7/changes/abc123", "/acme/web/pull/7/commits/abc", "/acme/web/issues/7/files", "/acme/web/pull/x/files", "/", "", undefined]) {
    assert.equal(M.isRoute(p), false, String(p));
  }
});

test("counter text parses with thousands separators and the singular", () => {
  assert.deepEqual({ ...M.parseCounter("0 of 210 files viewed") }, { viewed: 0, total: 210 });
  assert.deepEqual({ ...M.parseCounter("1 of 1 file viewed") }, { viewed: 1, total: 1 });
  assert.deepEqual({ ...M.parseCounter("12 of 1,234 files viewed") }, { viewed: 12, total: 1234 });
  assert.equal(M.parseCounter("0 / 210 viewed"), null);
  assert.equal(M.parseCounter(""), null);
});

test("counts all descendants, at any depth, by path prefix", () => {
  const paths = ["server/api/src/a.rs", "server/api/src/b.rs", "server/api/c.rs", "server/d.rs", "top.md", "other/e.rs"];
  const viewed = new Set(["server/api/src/a.rs", "server/d.rs"]);
  const m = M.countFolders(paths, (p) => viewed.has(p));
  assert.deepEqual({ ...m.get("server") }, { n: 4, viewed: 2, notViewed: 2, unknown: 0 });
  assert.deepEqual({ ...m.get("server/api") }, { n: 3, viewed: 1, notViewed: 2, unknown: 0 });
  assert.deepEqual({ ...m.get("server/api/src") }, { n: 2, viewed: 1, notViewed: 1, unknown: 0 });
  assert.equal(m.has("top.md"), false, "a file is not a folder");
  assert.equal(m.get("other").n, 1);
});

test("a compacted folder row (features/quick-jump) counts the files below that exact prefix", () => {
  const m = M.countFolders(["features/quick-jump/a.js", "features/quick-jump/b.js", "features/other.js"], () => false);
  assert.equal(m.get("features/quick-jump").n, 2);
  assert.equal(m.get("features").n, 3);
  assert.equal(m.get("feature"), undefined, "a prefix is a whole path segment");
});

test("an undefined file state is unknown and counted as such", () => {
  const m = M.countFolders(["a/x", "a/y", "a/z"], (p) => (p === "a/x" ? true : p === "a/y" ? false : undefined));
  assert.deepEqual({ ...m.get("a") }, { n: 3, viewed: 1, notViewed: 1, unknown: 1 });
});

test("merge: the read decides a file the page showed before it started; a later change on the page wins", () => {
  const api = { seq: 10, states: new Map([["a", true], ["b", false]]) };
  const page = new Map([["a", { viewed: false, seq: 5 }], ["b", { viewed: true, seq: 12 }], ["c", { viewed: true, seq: 3 }]]);
  assert.equal(M.fileState("a", api, page), true, "page seen before the read: the read decides");
  assert.equal(M.fileState("b", api, page), true, "page changed after the read started: the page decides");
  assert.equal(M.fileState("c", api, page), true, "a file the read did not return: the page decides");
  assert.equal(M.fileState("d", api, page), undefined, "neither source: unknown");
  assert.equal(M.fileState("c", null, page), true, "no read: the page only");
  assert.equal(M.fileState("a", { seq: 1, states: new Map() }, null), undefined);
});

test("states: viewed, partial, to view", () => {
  assert.equal(exact({ n: 4, viewed: 4 }).state, "viewed");
  assert.equal(exact({ n: 7, viewed: 3, notViewed: 4 }).state, "partial");
  assert.equal(exact({ n: 3, notViewed: 3 }).state, "toview");
  assert.equal(exact({ n: 7, viewed: 3, notViewed: 4 }).fraction, 3 / 7);
});

test("any unknown file → unknown part, never viewed or to view", () => {
  for (const c of [{ n: 4, viewed: 3, unknown: 1 }, { n: 4, notViewed: 3, unknown: 1 }, { n: 4, unknown: 4 }]) {
    const d = exact(c);
    assert.equal(d.state, "unknown", JSON.stringify(c));
    assert.doesNotMatch(d.text, /^All /);
    assert.doesNotMatch(d.text, /^0 of /);
  }
});

test("exact strings of the copy table, singular and plural", () => {
  assert.equal(exact({ n: 4, viewed: 4 }).text, "All 4 files viewed");
  assert.equal(exact({ n: 1, viewed: 1 }).text, "1 of 1 file viewed");
  assert.equal(exact({ n: 7, viewed: 3, notViewed: 4 }).text, "3 of 7 files viewed");
  assert.equal(exact({ n: 7, viewed: 3, notViewed: 4 }).count, "3/7");
  assert.equal(exact({ n: 3, notViewed: 3 }).text, "0 of 3 files viewed");
  assert.equal(exact({ n: 3, notViewed: 3 }).count, "0/3");
  assert.equal(exact({ n: 1, notViewed: 1 }).text, "0 of 1 file viewed");
  assert.equal(exact({ n: 4, viewed: 4 }).count, "");
});

test("loading copy: with and without a proven total, only while the folder is not exact", () => {
  const c = { n: 108, viewed: 0, notViewed: 0, unknown: 108 };
  const d = M.describe(c, { proven: true, loading: true });
  assert.deepEqual({ state: d.state, count: d.count, text: d.text }, { state: "loading", count: "", text: "Reading viewed state of 108 files" });
  assert.equal(M.describe({ ...c, n: 1, unknown: 1 }, { proven: true, loading: true }).text, "Reading viewed state of 1 file");
  assert.equal(M.describe(c, { proven: false, loading: true }).text, "Reading viewed state");
  assert.equal(M.describe({ n: 2, viewed: 2, notViewed: 0, unknown: 0 }, { proven: true, loading: true }).state, "viewed", "an exact folder stays exact while the read is in flight");
});

test("unknown part, total proven: k+/N, 0+/N, ?/N", () => {
  let d = exact({ n: 108, viewed: 2, notViewed: 7, unknown: 99 });
  assert.deepEqual({ state: d.state, count: d.count, text: d.text }, { state: "unknown", count: "2+/108", text: "At least 2 of 108 files viewed; the state of 99 files cannot be read" });
  d = exact({ n: 108, viewed: 0, notViewed: 9, unknown: 99 });
  assert.deepEqual({ count: d.count, text: d.text }, { count: "0+/108", text: "None of the 9 readable files viewed; the state of 99 files cannot be read" });
  d = exact({ n: 108, unknown: 108 });
  assert.deepEqual({ count: d.count, text: d.text }, { count: "?/108", text: "The viewed state of 108 files cannot be read" });
  assert.equal(exact({ n: 2, viewed: 1, unknown: 1 }).text, "At least 1 of 2 files viewed; the state of 1 file cannot be read");
  assert.equal(exact({ n: 2, notViewed: 1, unknown: 1 }).text, "None of the 1 readable file viewed; the state of 1 file cannot be read");
  assert.equal(exact({ n: 1, unknown: 1 }).text, "The viewed state of 1 file cannot be read");
});

test("unknown part, total not proven: k+/? and ?", () => {
  let d = M.describe({ n: 40, viewed: 2, notViewed: 3, unknown: 35 }, { proven: false, loading: false });
  assert.deepEqual({ state: d.state, count: d.count, text: d.text }, { state: "unknown", count: "2+/?", text: "At least 2 files viewed; the number of changed files in this folder cannot be read" });
  d = M.describe({ n: 40, viewed: 1, notViewed: 0, unknown: 39 }, { proven: false, loading: false });
  assert.equal(d.text, "At least 1 file viewed; the number of changed files in this folder cannot be read");
  d = M.describe({ n: 40, viewed: 0, notViewed: 3, unknown: 37 }, { proven: false, loading: false });
  assert.deepEqual({ count: d.count, text: d.text }, { count: "?", text: "Viewed state unknown; the number of changed files in this folder cannot be read" });
  assert.equal(M.describe(undefined, { proven: false, loading: false }).state, "unknown");
});

test("a folder the list does not know (n = 0) is unknown, never an exact state", () => {
  assert.equal(M.describe(undefined, { proven: true, loading: false }).state, "unknown");
  assert.equal(M.describe({ n: 0, viewed: 0, notViewed: 0, unknown: 0 }, { proven: true, loading: false }).state, "unknown");
});

test("no string of an unknown-part variant says 'All' or '0 of'", () => {
  const variants = [
    exact({ n: 108, viewed: 2, notViewed: 7, unknown: 99 }),
    exact({ n: 108, viewed: 0, notViewed: 9, unknown: 99 }),
    exact({ n: 108, unknown: 108 }),
    M.describe({ n: 40, viewed: 2, notViewed: 0, unknown: 38 }, { proven: false, loading: false }),
    M.describe({ n: 40, viewed: 0, notViewed: 0, unknown: 40 }, { proven: false, loading: false }),
  ];
  for (const v of variants) {
    assert.equal(v.state, "unknown");
    assert.doesNotMatch(v.text, /\bAll\b/);
    assert.doesNotMatch(v.text, /\b0 of\b/);
  }
});

test("bidi marks around a heading path are stripped", () => {
  assert.equal(M.cleanPath("‎background/quick-jump.js‎"), "background/quick-jump.js");
});

test("contrast helper: the Primer colours of the indicator meet 3:1 on the rows, light and dark", () => {
  const tokens = {
    light: { rows: ["#ffffff", "#f1f2f4"], fg: ["#1a7f37", "#59636e", "#818b98"] },
    dark: { rows: ["#0d1117", "#1c2128"], fg: ["#3fb950", "#9198a1", "#656c76"] },
  };
  for (const { rows, fg } of Object.values(tokens)) {
    for (const row of rows) for (const color of fg) assert.ok(M.contrast(color, row) >= 3, `${color} on ${row}: ${M.contrast(color, row).toFixed(2)}`);
  }
});
