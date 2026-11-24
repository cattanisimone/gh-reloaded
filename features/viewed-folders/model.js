// features/viewed-folders/model.js — pure rules of "Viewed per folder": the
// route, the counting of the changed files below every folder, how the two
// sources of a file's viewed state are merged, the state of a folder and the
// exact copy of every variant. No DOM, no chrome.*: unit-tested through
// globalThis.GHVF_MODEL.

(function () {
  // /owner/repo/pull/N/files and /changes are the new Files changed page.
  // A commit range or a single commit (/files/a..b, /changes/<sha>) has a
  // tree of another scope than the pull request's viewed state: no indicator.
  function parseRoute(pathname) {
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?$/.exec(pathname || "");
    return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
  }

  const isRoute = (pathname) => !!parseRoute(pathname);
  const keyOf = (r) => `${r.owner}/${r.repo}#${r.number}`.toLowerCase();

  const noun = (n) => (n === 1 ? "file" : "files");

  // "0 of 210 files viewed" (the toolbar's own screen-reader text).
  function parseCounter(text) {
    const m = /(\d[\d,]*)\s+of\s+(\d[\d,]*)\s+files?\s+viewed/i.exec(String(text || ""));
    if (!m) return null;
    return { viewed: Number(m[1].replace(/,/g, "")), total: Number(m[2].replace(/,/g, "")) };
  }

  // Strips the bidi marks GitHub puts around a path in a diff heading.
  const cleanPath = (s) => String(s || "").replace(/[‎‏‪-‮⁦-⁩]/g, "").trim();

  // Which source decides a file. `api` is { seq, states: Map<path, boolean> } of the
  // last finished read; `page` is Map<path, { viewed, seq }> of what the native
  // buttons showed, stamped when the button was first seen or last changed. A
  // button seen to change after the read started is newer than the read; one
  // that was already there is not.
  function fileState(path, api, page) {
    const p = page && page.get(path);
    const a = api && api.states && api.states.get(path);
    if (p && (!api || a === undefined || p.seq > api.seq)) return p.viewed;
    if (a !== undefined) return a;
    return undefined;
  }

  // Counts per folder prefix: every changed file below it, at any depth.
  // `stateOf(path)` answers true (viewed), false (not viewed) or undefined (unknown).
  function countFolders(paths, stateOf) {
    const out = new Map();
    for (const path of paths) {
      const s = stateOf(path);
      let at = path.indexOf("/");
      while (at > 0) {
        const prefix = path.slice(0, at);
        let c = out.get(prefix);
        if (!c) out.set(prefix, (c = { n: 0, viewed: 0, notViewed: 0, unknown: 0 }));
        c.n++;
        if (s === true) c.viewed++;
        else if (s === false) c.notViewed++;
        else c.unknown++;
        at = path.indexOf("/", at + 1);
      }
    }
    return out;
  }

  // The state of one folder.
  //   c        { n, viewed, notViewed, unknown } of the folder (n counts every file listed below it)
  //   proven   the list of changed files is known to be complete
  //   loading  the API read is in flight
  // Returns { state, count, text, fraction }:
  //   viewed | partial | toview   exact (the list is proven and every file below is known)
  //   unknown                     at least one file below cannot be read, or the list is not proven
  //   loading                     the read is in flight and the folder is not exact yet
  // A folder with an unknown file is never viewed or toview, and never counts only what is visible.
  function describe(c, { proven, loading }) {
    const n = c ? c.n : 0;
    const known = proven && n > 0;
    const exact = known && c.unknown === 0;
    if (exact) {
      if (c.viewed === n) {
        return { state: "viewed", count: "", fraction: 1, text: n === 1 ? "1 of 1 file viewed" : `All ${n} files viewed` };
      }
      if (c.viewed === 0) return { state: "toview", count: `0/${n}`, fraction: 0, text: `0 of ${n} ${noun(n)} viewed` };
      return { state: "partial", count: `${c.viewed}/${n}`, fraction: c.viewed / n, text: `${c.viewed} of ${n} files viewed` };
    }
    if (loading) {
      return { state: "loading", count: "", fraction: 0, text: known ? `Reading viewed state of ${n} ${noun(n)}` : "Reading viewed state" };
    }
    const k = c ? c.viewed : 0;
    if (known) {
      const u = c.unknown;
      if (k >= 1) {
        return { state: "unknown", count: `${k}+/${n}`, fraction: 0, text: `At least ${k} of ${n} ${noun(n)} viewed; the state of ${u} ${noun(u)} cannot be read` };
      }
      if (c.notViewed >= 1) {
        const r = c.notViewed;
        return { state: "unknown", count: `0+/${n}`, fraction: 0, text: `None of the ${r} readable ${noun(r)} viewed; the state of ${u} ${noun(u)} cannot be read` };
      }
      return { state: "unknown", count: `?/${n}`, fraction: 0, text: `The viewed state of ${n} ${noun(n)} cannot be read` };
    }
    if (k >= 1) {
      return { state: "unknown", count: `${k}+/?`, fraction: 0, text: `At least ${k} ${noun(k)} viewed; the number of changed files in this folder cannot be read` };
    }
    return { state: "unknown", count: "?", fraction: 0, text: "Viewed state unknown; the number of changed files in this folder cannot be read" };
  }

  // WCAG contrast of two #rrggbb colours (the unit test of the colour tokens uses it).
  function contrast(a, b) {
    const lum = (hex) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  globalThis.GHVF_MODEL = { parseRoute, isRoute, keyOf, parseCounter, cleanPath, fileState, countFolders, describe, contrast };
})();
