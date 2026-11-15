// Unit tests for features/actions-log-shortcuts/model.js: routes, status
// parsing, attempt reading and the gh command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobals } from "../support/load-global.js";

const { GHALS_MODEL: M } = loadGlobals(["features/actions-log-shortcuts/model.js"]);

test("parseRoute reads run, attempt and job routes only", () => {
  assert.deepEqual({ ...M.parseRoute("/acme/web/actions/runs/11") }, { owner: "acme", repo: "web", run: "11", job: null, attempt: null, kind: "run" });
  assert.equal(M.parseRoute("/acme/web/actions/runs/11/attempts/2").attempt, "2");
  const j = M.parseRoute("/acme/web/actions/runs/11/job/22");
  assert.equal(j.kind, "job");
  assert.equal(j.job, "22");
  for (const p of ["/acme/web/actions", "/acme/web/actions/runs/11/usage", "/acme/web/actions/runs/11/workflow", "/acme/web/actions/runs/x", "/acme/web/actions/runs/11/job/22/extra", "/acme/web/pull/1/checks", "/acme/web/commit/abc/checks/22/logs", "/acme/web/actions/workflows/a.yml"]) {
    assert.equal(M.parseRoute(p), null, p);
  }
});

test("readJobStatus tolerates every whitespace shape of the header text", () => {
  assert.equal(M.readJobStatus("failed  in 29s"), "failed");
  assert.equal(M.readJobStatus("  failed \n  Nov 13, 2026  in 29s "), "failed");
  assert.equal(M.readJobStatus("failed Nov 13, 2026\nin 29s"), "failed");
  assert.equal(M.readJobStatus("Started 3 minutes ago"), "running");
  assert.equal(M.readJobStatus("succeeded Nov 13, 2026 in 1m 4s"), "success");
  assert.equal(M.readJobStatus("cancelled Nov 3, 2026 in 45m 33s"), "cancelled");
  assert.equal(M.readJobStatus("queued"), "running");
  assert.equal(M.readJobStatus(""), "unknown");
  assert.equal(M.readJobStatus("Something else"), "unknown");
});

test("readRunStatus uses the header icon label, then the Status value", () => {
  assert.equal(M.readRunStatus("failed: ", ""), "failed");
  assert.equal(M.readRunStatus("currently running: ", ""), "running");
  assert.equal(M.readRunStatus("", "Failure"), "failed");
  assert.equal(M.readRunStatus("", "Cancelled"), "cancelled");
  assert.equal(M.readRunStatus("", "Success"), "success");
  assert.equal(M.readRunStatus("", ""), "unknown");
});

test("flagFor is a whitelist: only failed gets --log-failed", () => {
  assert.equal(M.flagFor("failed"), "--log-failed");
  for (const s of ["cancelled", "success", "timed out", "unknown", "running", "skipped"]) assert.equal(M.flagFor(s), "--log", s);
});

test("isConcluded is false only for running and unknown", () => {
  assert.equal(M.isConcluded("failed"), true);
  assert.equal(M.isConcluded("success"), true);
  assert.equal(M.isConcluded("cancelled"), true);
  assert.equal(M.isConcluded("running"), false);
  assert.equal(M.isConcluded("unknown"), false);
});

test("readAttempt takes only the sidebar Summary link of the same run", () => {
  const r = M.parseRoute("/acme/web/actions/runs/11/job/22");
  const link = (text, href, hidden = false) => ({ text, href, hidden });
  assert.equal(M.readAttempt([link(" Summary ", "/acme/web/actions/runs/11/attempts/2")], r), "2");
  assert.equal(M.readAttempt([link("Summary", "/acme/web/actions/runs/11")], r), null);
  assert.equal(M.readAttempt([link("Summary", "/acme/web/actions/runs/12/attempts/2")], r), null);
  assert.equal(M.readAttempt([link("Summary", "/other/web/actions/runs/11/attempts/2")], r), null);
  assert.equal(M.readAttempt([link("Attempt 1", "/acme/web/actions/runs/11/attempts/1")], r), null);
  assert.equal(M.readAttempt([link("Summary", "/acme/web/actions/runs/11/attempts/1", true)], r), null);
  assert.equal(M.readAttempt([], r), null);
});

test("buildCommand: run and job forms, flag, attempt, no token", () => {
  const run = M.parseRoute("/acme/web/actions/runs/11");
  assert.equal(M.buildCommand(run, "--log-failed", null), "gh run view 11 --log-failed --repo acme/web");
  assert.equal(M.buildCommand(run, "--log", "2"), "gh run view 11 --log --attempt 2 --repo acme/web");
  const job = M.parseRoute("/acme/web/actions/runs/11/job/22");
  assert.equal(M.buildCommand(job, "--log-failed", null), "gh run view --log-failed --job 22 --repo acme/web");
  assert.equal(M.buildCommand(job, "--log", "1"), "gh run view --log --job 22 --attempt 1 --repo acme/web");
  const viaAttempt = M.parseRoute("/acme/web/actions/runs/11/attempts/3");
  assert.equal(M.buildCommand(viaAttempt, "--log", null), "gh run view 11 --log --attempt 3 --repo acme/web");
});

test("showCopy hides the button for runs and jobs in progress or unknown", () => {
  assert.equal(M.showCopy("failed"), true);
  assert.equal(M.showCopy("success"), true);
  assert.equal(M.showCopy("cancelled"), true);
  assert.equal(M.showCopy("running"), false);
  assert.equal(M.showCopy("unknown"), false);
});

// --- Failed steps (#134) ---------------------------------------------------

test("failedSteps keeps only failures, in execution order, one per step number", () => {
  const steps = [
    { number: "13", name: "Tests", conclusion: "failure" },
    { number: "2", name: "Set up", conclusion: "success" },
    { number: "8", name: "  Build   all ", conclusion: "failure" },
    { number: "8", name: "Build all", conclusion: "failure" },
    { number: "9", name: "Skipped", conclusion: "skipped" },
    { number: "5", name: "Cancelled", conclusion: "cancelled" },
  ];
  assert.deepEqual(
    Array.from(M.failedSteps(steps), (s) => ({ ...s })),
    [
      { number: "8", name: "Build all" },
      { number: "13", name: "Tests" },
    ],
  );
});

test("failedSteps keeps DOM order for equal or unreadable numbers and names an empty step", () => {
  const out = M.failedSteps([
    { number: "x", name: "B", conclusion: "failure" },
    { number: "", name: "", conclusion: "failure" },
    { number: "x2", name: "C", conclusion: "failure" },
  ]);
  assert.deepEqual(Array.from(out, (s) => s.name), ["B", "Step 2", "C"]);
  assert.equal(M.failedSteps([]).length, 0);
  assert.equal(M.failedSteps(null).length, 0);
});

test("labelFor gives the full and the short label, and none without a failure", () => {
  assert.equal(M.labelFor(0, false), null);
  assert.equal(M.labelFor(1, false), "Go to failed step");
  assert.equal(M.labelFor(1, true), "Go to failure");
  assert.equal(M.labelFor(2, false), "Failed steps: 2");
  assert.equal(M.labelFor(12, true), "Failed: 12");
  assert.equal(M.fullLabel(1), "Go to failed step");
  assert.equal(M.fullLabel(3), "Failed steps: 3");
});

test("PLACES is the issue's order: name, subtitle, short name, short subtitle, bottom edge", () => {
  assert.deepEqual(
    Array.from(M.PLACES, (p) => `${p.id}${p.short ? ":short" : ""}`),
    ["name", "subtitle", "name:short", "subtitle:short", "edge"],
  );
});

const base = () => ({
  header: { top: 0, bottom: 80, height: 80, covered: 88 },
  lines: [1, 1],
  overflow: [0, 0, 0, 0],
  texts: [
    { left: 24, top: 22, right: 300, bottom: 40 },
    { left: 24, top: 44, right: 200, bottom: 58 },
  ],
});
const trialOf = (over = {}) => ({ ...base(), ctrl: { left: 800, top: 26, right: 921, bottom: 54 }, win: { w: 1280, h: 900 }, ...over });

test("fits accepts a control that changes nothing and keeps 8px from GitHub's text", () => {
  assert.deepEqual({ ...M.fits(base(), trialOf(), "name") }, { ok: true, reason: "" });
  // exactly 8px horizontally from the name text
  assert.equal(M.fits(base(), trialOf({ ctrl: { left: 308, top: 26, right: 429, bottom: 54 } }), "name").ok, true);
});

test("fits rejects a header that changed height or covered stack", () => {
  assert.equal(M.fits(base(), trialOf({ header: { top: 0, bottom: 106, height: 106, covered: 114 } }), "name").ok, false);
  assert.match(M.fits(base(), trialOf({ header: { top: 0, bottom: 80, height: 80, covered: 96 } }), "name").reason, /covered/);
});

test("fits rejects a re-wrap, an added ellipsis and a clipped line", () => {
  assert.match(M.fits(base(), trialOf({ lines: [2, 1] }), "name").reason, /lines/);
  assert.match(M.fits(base(), trialOf({ overflow: [18, 0, 0, 0] }), "name").reason, /overflow/);
  assert.match(M.fits(base(), trialOf({ overflow: [0, 0, 0, 20] }), "name").reason, /overflow/);
  // a name already cut natively stays as cut: the same overflow is not a change
  const cut = { ...base(), overflow: [30, 0, 0, 0] };
  assert.equal(M.fits(cut, { ...cut, ctrl: { left: 800, top: 26, right: 921, bottom: 54 }, win: { w: 1280, h: 900 } }, "name").ok, true);
});

test("fits rejects overlap and less than 8px from any text", () => {
  assert.match(M.fits(base(), trialOf({ ctrl: { left: 250, top: 26, right: 371, bottom: 54 } }), "name").reason, /text/);
  assert.match(M.fits(base(), trialOf({ ctrl: { left: 307, top: 26, right: 428, bottom: 54 } }), "name").reason, /text/);
  // diagonal distance counts: 6px right and 6px below is 8.48px away
  assert.equal(M.fits(base(), trialOf({ ctrl: { left: 306, top: 64, right: 427, bottom: 92 } }), "name").reason.includes("text"), false);
});

test("fits needs the header places to stay inside the header and the window", () => {
  assert.match(M.fits(base(), trialOf({ ctrl: { left: 800, top: 60, right: 921, bottom: 88 } }), "name").reason, /header/);
  assert.match(M.fits(base(), trialOf({ ctrl: { left: 1200, top: 26, right: 1300, bottom: 54 } }), "subtitle").reason, /window/);
});

test("fits for the bottom edge only needs the window", () => {
  const t = { ...base(), ctrl: { left: 1143, top: 864, right: 1264, bottom: 892 }, win: { w: 1280, h: 900 } };
  assert.equal(M.fits(base(), t, "edge").ok, true);
  assert.equal(M.fits(base(), { ...t, ctrl: { left: 1143, top: 880, right: 1264, bottom: 910 } }, "edge").ok, false);
});

test("landingDelta is how far the title is from the covered edge", () => {
  assert.equal(M.landingDelta(120, 88), 32);
  assert.ok(Math.abs(M.landingDelta(71.8, 88) + 16.2) < 1e-9);
  assert.equal(M.needsScroll(0.4), false);
  assert.equal(M.needsScroll(-1.2), true);
});

test("stepKey changes with the list, not with the order of reading", () => {
  const a = M.failedSteps([{ number: "8", name: "A", conclusion: "failure" }]);
  const b = M.failedSteps([{ number: "8", name: "A", conclusion: "failure" }, { number: "9", name: "B", conclusion: "failure" }]);
  assert.notEqual(M.stepKey(a), M.stepKey(b));
  assert.equal(M.stepKey(a), M.stepKey(M.failedSteps([{ number: "8", name: "A", conclusion: "failure" }])));
});
