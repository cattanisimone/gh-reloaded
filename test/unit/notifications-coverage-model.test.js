// The one place that words why a notification is limited (#131): the status of
// Triage and Tags and of "Beyond this page", the notes and action lines of the
// Triage panel's Coverage section, and the inbox line. Both surfaces read this
// model, so they cannot contradict each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const g = loadGlobals(["features/notifications/coverage-model.js"]);
const C = g.GHNT_COVERAGE;
const plain = (v) => JSON.parse(JSON.stringify(v));

const API = ["not-tried", "ok", "missing-scope", "unavailable", "rate-limited"];
const OWNER = ["ok", "no-token", "denied", "unavailable", "rate-limited"];
const base = { active: true, phase: "ready", triageOn: true, tagsOn: true, rateLimited: false, retryAt: null, fmtTime: () => "14:05" };
const run = (caps, over = {}) => plain(C.describe({ ...base, ...over, caps }));
const ids = (r) => r.notes.map((n) => n.n);
const rowOf = (r, id) => r.rows.find((x) => x.id === id);
const FORBIDDEN = /\bscope\b|fine-grained|capability|replace your (default )?token|switch to a classic/i;

test("normalizeApi: refused and no-answer read as unavailable", () => {
  assert.equal(C.normalizeApi("refused"), "unavailable");
  assert.equal(C.normalizeApi("no-answer"), "unavailable");
  assert.equal(C.normalizeApi("ok"), "ok");
  assert.equal(C.normalizeApi(undefined), "not-tried");
});

test("status matrix: five api states x (no owner, owners in each of five states) x switches gives exactly one result", () => {
  for (const api of API) {
    for (const owner of [null, ...OWNER]) {
      for (const [triageOn, tagsOn] of [[true, true], [true, false], [false, true], [false, false]]) {
        const caps = { "api:notifications": api, ...(owner ? { "pr:acme": owner } : {}) };
        const r = run(caps, { triageOn, tagsOn });
        const label = `${api}/${owner}/${triageOn}/${tagsOn}`;
        const beyond = r.rows.filter((x) => x.id === "beyond");
        assert.equal(beyond.length, 1, label);
        assert.ok(["Full", "Limited", "Not in use", "Off"].includes(beyond[0].status), label);
        const feat = r.rows.filter((x) => x.id !== "beyond");
        assert.ok(feat.length === 1 || feat.length === 2, label);
        assert.deepEqual(feat.map((x) => x.id), feat.length === 1 ? ["triage-tags"] : ["triage", "tags"], label);
        if (!triageOn && !tagsOn) assert.equal(beyond[0].status, "Off", label);
        else if (api === "rate-limited") assert.equal(beyond[0].status, "Limited", label);
        else if (api === "ok") assert.equal(beyond[0].status, "Full", label);
        else assert.equal(beyond[0].status, "Not in use", label);
        // Off follows the feature's own switch, never anything else.
        for (const f of feat) {
          const on = f.id === "triage" ? triageOn : f.id === "tags" ? tagsOn : triageOn || tagsOn;
          if (!on) assert.equal(f.status, "Off", label);
          else assert.notEqual(f.status, "Off", label);
        }
      }
    }
  }
});

test("status matrix: no token and no owner recorded is Full / Not in use with note 5 only (named case)", () => {
  const r = run({ "api:notifications": "not-tried" });
  assert.equal(rowOf(r, "triage-tags").status, "Full");
  assert.equal(rowOf(r, "triage-tags").desc, "Work on every loaded notification.");
  assert.equal(rowOf(r, "beyond").status, "Not in use");
  assert.deepEqual(ids(r), [5]);
  assert.equal(r.notes[0].text, "No default GitHub token is set, so only the loaded notifications are covered.");
  assert.deepEqual(r.actions, []);
});

test("rows: descriptions and merged versus split rows", () => {
  const ok = run({ "api:notifications": "ok" });
  assert.deepEqual(ok.rows.map((x) => [x.id, x.label, x.status]), [["triage-tags", "Triage and Tags", "Full"], ["beyond", "Beyond this page", "Full"]]);
  assert.equal(rowOf(ok, "beyond").desc, "Counts also cover notifications outside this page.");
  const rate = run({ "api:notifications": "rate-limited" });
  assert.equal(rowOf(rate, "beyond").desc, "Counts outside this page wait for GitHub's rate limit.");
  assert.equal(rowOf(rate, "triage-tags").desc, "Sorting still works for everything GitHub shows here. Some review requests wait for GitHub's rate limit.");
  const none = run({ "api:notifications": "missing-scope" });
  assert.equal(rowOf(none, "beyond").desc, "Optional. Counts cover this page only.");
  const split = run({ "api:notifications": "ok" }, { tagsOn: false });
  assert.deepEqual(split.rows.map((x) => [x.id, x.label, x.status]), [["triage", "Triage", "Full"], ["tags", "Tags", "Off"], ["beyond", "Beyond this page", "Full"]]);
  assert.equal(rowOf(split, "tags").desc, "");
  const off = run({ "api:notifications": "ok" }, { triageOn: false, tagsOn: false });
  assert.deepEqual(off.rows.map((x) => [x.id, x.status]), [["triage-tags", "Off"], ["beyond", "Off"]]);
});

test("one owner unreadable with a default token names the owner; otherwise the general text", () => {
  const one = run({ "api:notifications": "ok", "pr:acme": "no-token" });
  assert.equal(rowOf(one, "triage-tags").status, "Limited");
  assert.equal(rowOf(one, "triage-tags").desc, "Sorting still works for everything GitHub shows here. Some of this owner's review requests can't be confirmed.");
  const two = run({ "api:notifications": "ok", "pr:acme": "no-token", "pr:northwind": "denied" });
  assert.equal(rowOf(two, "triage-tags").desc, "Sorting still works for everything GitHub shows here. Some review requests can't be confirmed.");
  const noDefault = run({ "api:notifications": "not-tried", "pr:acme": "no-token" });
  assert.equal(rowOf(noDefault, "triage-tags").desc, "Sorting still works for everything GitHub shows here. Some review requests can't be confirmed.");
  // never Limited when all owners are ok
  assert.equal(rowOf(run({ "api:notifications": "not-tried", "pr:acme": "ok", "pr:northwind": "ok" }), "triage-tags").status, "Full");
});

test("notes: order, single rate-limit note, one note per owner capped at 3 then 'and N more'", () => {
  const caps = { "api:notifications": "missing-scope", "pr:a1": "no-token", "pr:a2": "denied", "pr:a3": "no-token", "pr:a4": "no-token", "pr:a5": "unavailable", "pr:a6": "rate-limited" };
  const r = run(caps, { retryAt: 1 });
  assert.deepEqual(ids(r), [1, 3, 3, 3, 3, 4, 6, 8]);
  assert.equal(r.notes.filter((n) => n.n === 1).length, 1);
  const more = r.notes.find((n) => n.more);
  assert.equal(more.text, "and 1 more");
  assert.equal(r.notes[0].text, "GitHub's rate limit was reached: classifications update at 14:05.");
  assert.equal(r.notes[1].text, "No token that can read a1: its notifications are shown as “Unverifiable”.");
  assert.equal(r.notes.at(-1).text, "Changed a token? Reload this page.");
  const noTime = run({ "api:notifications": "rate-limited" });
  assert.equal(noTime.notes[0].text, "GitHub's rate limit was reached: classifications update when it resets.");
  assert.deepEqual(ids(noTime), [1, 8]);
});

test("note 2 replaces notes 3 and 5 when no default token and every owner has none; the Settings link is the one action", () => {
  const r = run({ "api:notifications": "not-tried", "pr:acme": "no-token", "pr:northwind": "no-token" });
  assert.deepEqual(ids(r), [2, 8]);
  assert.equal(r.notes[0].text, "No default GitHub token is set, so some notifications can't be told apart and show as “Unverifiable”.");
  assert.deepEqual(r.actions.map((a) => a.segs.map((s) => s.label || s.v).join("")), ["Add a token in Settings → GitHub tokens ›"]);
  assert.equal(rowOf(r, "triage-tags").status, "Limited");
});

test("note 5 adds its second sentence only when some owner is ok; never 'No GitHub token is set' for owner tokens", () => {
  const r = run({ "api:notifications": "not-tried", "pr:acme": "ok", "pr:northwind": "no-token" });
  assert.deepEqual(ids(r), [3, 5, 8]);
  assert.equal(r.notes.find((n) => n.n === 5).text, "No default GitHub token is set, so only the loaded notifications are covered. Owners with their own token are read normally.");
  const allOk = run({ "api:notifications": "not-tried", "pr:acme": "ok", "pr:northwind": "ok" });
  assert.deepEqual(ids(allOk), [5, 8]);
  assert.match(allOk.notes[0].text, /Owners with their own token are read normally\.$/);
  assert.equal(rowOf(allOk, "triage-tags").status, "Full");
  assert.equal(rowOf(allOk, "beyond").status, "Not in use");
  for (const n of allOk.notes) assert.doesNotMatch(n.text, /No GitHub token is set/);
});

test("notes 6 and 7: neutral, with the right links, and they carry no warning box", () => {
  const six = run({ "api:notifications": "missing-scope" });
  assert.deepEqual(ids(six), [6, 8]);
  assert.equal(six.notes[0].box, "neutral");
  assert.equal(six.notes[0].text, "Your token doesn't have the notifications permission, so only the loaded notifications are covered. This is optional.");
  assert.deepEqual(six.actions[0].segs.filter((s) => s.t === "link").map((s) => [s.kind, s.label]), [["settings", "Settings → GitHub tokens ›"], ["readme", "Permissions in the README ›"]]);
  const seven = run({ "api:notifications": "unavailable" });
  assert.deepEqual(ids(seven), [7, 8]);
  assert.equal(seven.notes[0].box, "neutral");
  assert.equal(seven.notes[0].text, "Only a classic default token with the notifications permission can read your full notifications list. GitHub didn't let yours, and didn't say why. Everything on the loaded page keeps working.");
  assert.deepEqual(seven.actions[0].segs.filter((s) => s.t === "link").map((s) => [s.kind, s.label]), [["settings", "Settings → GitHub tokens ›"]]);
  assert.equal(seven.actions[0].segs[0].v, "What each feature needs: ");
  for (const r of [six, seven]) for (const n of r.notes) assert.notEqual(n.box, "warning");
});

test("owner action lines win over the links of notes 2, 6 and 7; one line per shown owner", () => {
  const r = run({ "api:notifications": "missing-scope", "pr:acme": "no-token", "pr:northwind": "denied", "pr:zed": "unavailable" });
  assert.deepEqual(r.actions.map((a) => a.segs.map((s) => s.label || s.v).join("")), ["acme: can't be read. Add token for acme ›", "northwind: can't be read. Add or replace token ›", "zed: couldn't be read. Test in Settings ›"]);
  assert.deepEqual(r.actions.map((a) => [a.owner, a.ownerState]), [["acme", "no-token"], ["northwind", "denied"], ["zed", "unavailable"]]);
  // note 6's own links are not shown while an owner line is
  assert.ok(!r.actions.some((a) => a.segs.some((s) => s.kind === "readme")));
});

test("note 4 text and note 8 shows whenever any note shows", () => {
  const r = run({ "api:notifications": "ok", "pr:acme": "unavailable" });
  assert.deepEqual(ids(r), [4, 8]);
  assert.equal(r.notes[0].text, "We couldn't read acme's pull requests or issues, and GitHub didn't say why: its notifications show as “Unverifiable”.");
  assert.deepEqual(ids(run({ "api:notifications": "ok", "pr:acme": "ok" })), []);
});

test("engine off: only the hint, nothing else", () => {
  const r = plain(C.describe({ ...base, active: false, caps: { "api:notifications": "missing-scope" } }));
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.actions, []);
  assert.equal(r.hint.lead, "Tokens and permissions: ");
  assert.equal(r.hint.link, "Settings → GitHub tokens");
});

test("unavailable agrees: the panel and the inbox word an unexplained refusal the same way and imply no missing permission", () => {
  const r = run({ "api:notifications": "unavailable" });
  assert.equal(rowOf(r, "beyond").status, "Not in use");
  assert.doesNotMatch(r.notes[0].text, /doesn't have the notifications permission/);
  assert.match(r.notes[0].text, /didn't say why/);
  // an owner that cannot be read: the same words in the panel note and the inbox line
  const caps = { "api:notifications": "unavailable", "pr:acme": "unavailable" };
  const items = [{ section: "unverifiable", pending: false, inPage: true, owner: "acme" }];
  const line = plain(C.inboxLine({ items, caps }));
  assert.equal(line.text, "1 from acme are Unverifiable: we couldn't read acme.");
  assert.match(run(caps).notes.find((n) => n.n === 4).text, /couldn't read acme's pull requests or issues, and GitHub didn't say why/);
});

test("copy rules: restricted words only where allowed, no recommendation to replace a fine-grained default, no secrets", () => {
  const states = [];
  for (const api of API) for (const owner of [null, ...OWNER]) states.push({ "api:notifications": api, ...(owner ? { "pr:acme": owner, "pr:northwind": owner } : {}) });
  for (const caps of states) {
    const r = run(caps);
    const all = [...r.rows.map((x) => x.desc), ...r.notes.map((n) => n.text), ...r.actions.flatMap((a) => a.segs.map((s) => s.label || s.v))].join(" | ");
    assert.doesNotMatch(all, FORBIDDEN, JSON.stringify(caps));
    assert.doesNotMatch(all, /ghp_|github_pat_|organization (policy|forbids)/i);
  }
  // no two causes share a text: no token, permission missing, data incomplete
  const t = (caps) => run(caps).notes[0].text;
  const texts = [t({ "api:notifications": "not-tried", "pr:a": "no-token" }), t({ "api:notifications": "missing-scope" }), t({ "api:notifications": "unavailable" }), t({ "api:notifications": "not-tried" }), t({ "api:notifications": "ok", "pr:a": "denied" }), t({ "api:notifications": "ok", "pr:a": "unavailable" })];
  assert.equal(new Set(texts).size, texts.length);
});

// ---- the inbox line --------------------------------------------------------

const unv = (owner, extra = {}) => ({ section: "unverifiable", pending: false, inPage: true, owner, ...extra });
const line = (items, caps, noTokenLine = false) => plain(C.inboxLine({ items, caps, noTokenLine }));

test("inboxLine: texts by the owner states of the Unverifiable rows", () => {
  const n = (k, o) => Array.from({ length: k }, () => unv(o));
  assert.equal(line(n(3, "acme"), { "api:notifications": "not-tried", "pr:acme": "no-token" }).text, "3 are Unverifiable: no default GitHub token is set.");
  assert.equal(line(n(15, "acme"), { "api:notifications": "ok", "pr:acme": "no-token" }).text, "15 from acme are Unverifiable: no token can read acme.");
  assert.equal(line(n(15, "acme"), { "api:notifications": "ok", "pr:acme": "denied" }).text, "15 from acme are Unverifiable: no token can read acme.");
  assert.equal(line(n(15, "acme"), { "api:notifications": "ok", "pr:acme": "no-token" }).link, "How to fix this ›");
  assert.equal(line(n(2, "acme"), { "api:notifications": "ok", "pr:acme": "unavailable" }).text, "2 from acme are Unverifiable: we couldn't read acme.");
  assert.equal(line(n(2, "acme"), { "api:notifications": "ok", "pr:acme": "unavailable" }).link, "What this means ›");
  assert.equal(line([...n(1, "acme"), ...n(1, "zed")], { "api:notifications": "ok", "pr:acme": "rate-limited", "pr:zed": "rate-limited" }).text, "2 are Unverifiable: GitHub's rate limit was reached.");
  assert.equal(line([...n(1, "acme"), ...n(1, "zed")], { "api:notifications": "ok", "pr:acme": "no-token", "pr:zed": "denied" }).text, "2 are Unverifiable.");
  assert.equal(line([...n(1, "acme"), ...n(1, "zed")], { "api:notifications": "ok", "pr:acme": "no-token", "pr:zed": "unavailable" }).link, "What this means ›");
});

test("inboxLine: shown if and only if an Unverifiable loaded row has a limited owner", () => {
  const caps = { "api:notifications": "ok", "pr:acme": "no-token", "pr:ok": "ok" };
  assert.equal(C.inboxLine({ items: [], caps }), null);
  assert.equal(C.inboxLine({ items: [unv("ok")], caps }), null, "an ok owner is not a cause");
  assert.equal(C.inboxLine({ items: [{ section: "attention", pending: false, inPage: true, owner: "acme" }], caps }), null, "only Unverifiable rows");
  assert.equal(C.inboxLine({ items: [unv("acme", { inPage: false })], caps }), null, "only loaded rows");
  assert.equal(C.inboxLine({ items: [unv("acme", { pending: true })], caps }), null, "not while pending");
  // api states alone never show it
  for (const api of ["missing-scope", "unavailable", "rate-limited", "not-tried"]) assert.equal(C.inboxLine({ items: [unv("acme")], caps: { "api:notifications": api } }), null, api);
  // owner counted only for the rows that have a limited owner
  assert.equal(plain(C.inboxLine({ items: [unv("acme"), unv("ok"), unv("ok")], caps })).text, "1 from acme are Unverifiable: no token can read acme.");
  // owner names compare without case
  assert.equal(plain(C.inboxLine({ items: [unv("Acme")], caps })).text, "1 from Acme are Unverifiable: no token can read Acme.");
});

test("inboxLine: suppressed only for the 'no default token' text while the no-token coverage line shows", () => {
  const items = [unv("acme")];
  assert.equal(C.inboxLine({ items, caps: { "api:notifications": "not-tried", "pr:acme": "no-token" }, noTokenLine: true }), null);
  assert.ok(C.inboxLine({ items, caps: { "api:notifications": "not-tried", "pr:acme": "no-token" }, noTokenLine: false }));
  assert.ok(C.inboxLine({ items, caps: { "api:notifications": "ok", "pr:acme": "no-token" }, noTokenLine: true }));
});
