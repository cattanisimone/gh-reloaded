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
