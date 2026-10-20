// Unit tests for features/linked-pr-status/signal.js: the per-PR signal and
// its priority, the aggregate for several PRs, and the modal wording. A
// content-script global (no ES module), so it is evaluated in a fresh context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = {};
context.globalThis = context;
vm.runInNewContext(readFileSync("features/linked-pr-status/signal.js", "utf8"), context);
const { signalOf, summarize, nextStep, checksText, reviewText } = context.GHLPS_SIGNAL;

const pr = (over = {}) => ({ ok: true, state: "OPEN", merged: false, isDraft: false, reviewDecision: null, checks: null, ...over });
const label = (over) => signalOf(pr(over)).label;

test("priority: changes requested beats failed checks, review pending, running checks and approval", () => {
  assert.equal(label({ reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE" }), "Changes requested");
  assert.equal(label({ reviewDecision: "APPROVED", checks: "FAILURE" }), "Checks failed");
  assert.equal(label({ reviewDecision: "REVIEW_REQUIRED", checks: "ERROR" }), "Checks failed");
  assert.equal(label({ reviewDecision: "REVIEW_REQUIRED", checks: "PENDING" }), "Review pending");
  assert.equal(label({ reviewDecision: "APPROVED", checks: "PENDING" }), "Checks pending");
  assert.equal(label({ reviewDecision: "APPROVED", checks: "EXPECTED" }), "Checks pending");
  assert.equal(label({ reviewDecision: "APPROVED", checks: "SUCCESS" }), "Approved");
});

test("null reviewDecision and null rollup are plain Open, never a verdict", () => {
  assert.equal(label({}), "Open");
  assert.equal(label({ checks: "SUCCESS" }), "Open");
  assert.equal(signalOf(pr()).tone, "neutral");
});

test("draft, merged and closed come first and are neutral", () => {
  const bad = { reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE" };
  assert.equal(label({ ...bad, isDraft: true }), "Draft");
  assert.equal(label({ ...bad, state: "CLOSED" }), "Closed");
  assert.equal(label({ ...bad, state: "MERGED", merged: true }), "Merged");
  for (const o of [{ isDraft: true }, { state: "CLOSED" }, { state: "MERGED" }]) assert.equal(signalOf(pr({ ...bad, ...o })).attention, false);
});

test("an unreadable PR is Status unavailable, neutral", () => {
  for (const p of [null, undefined, { ok: false }]) {
    const s = signalOf(p);
    assert.equal(s.label, "Status unavailable");
    assert.equal(s.tone, "neutral");
    assert.equal(s.attention, false);
  }
});

test("only the first two ranks need attention", () => {
  const att = (o) => signalOf(pr(o)).attention;
  assert.equal(att({ reviewDecision: "CHANGES_REQUESTED" }), true);
  assert.equal(att({ checks: "FAILURE" }), true);
  assert.equal(att({ reviewDecision: "REVIEW_REQUIRED" }), false);
  assert.equal(att({ checks: "PENDING" }), false);
  assert.equal(att({ reviewDecision: "APPROVED" }), false);
});

test("every signal has a glyph and visible text", () => {
  for (const o of [{}, { isDraft: true }, { state: "CLOSED" }, { state: "MERGED" }, { reviewDecision: "APPROVED" }, { checks: "FAILURE" }]) {
    const s = signalOf(pr(o));
    assert.ok(s.glyph && s.label);
  }
});

test("summarize: none, one, several without a verdict", () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize(null), null);
  const one = summarize([pr({ checks: "FAILURE" })]);
  assert.equal(one.kind, "one");
  assert.equal(one.signal.label, "Checks failed");
  const many = summarize([pr({ checks: "FAILURE" }), pr({ reviewDecision: "APPROVED", checks: "SUCCESS" })]);
  assert.equal(many.kind, "many");
  assert.equal(many.text, "2 linked PRs · 1 needs attention");
  assert.equal(summarize([pr(), pr(), pr()]).text, "3 linked PRs");
  assert.equal(summarize([pr({ checks: "FAILURE" }), pr({ reviewDecision: "CHANGES_REQUESTED" })], { compact: true }).text, "2 PRs · 2 needs attention");
});

test("no output string ever says ready or mergeable", () => {
  const all = [];
  for (const rd of [null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]) {
    for (const checks of [null, "SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]) {
      for (const o of [{}, { isDraft: true }, { state: "CLOSED" }, { state: "MERGED", merged: true }]) {
        const p = pr({ reviewDecision: rd, checks, ...o });
        all.push(signalOf(p).label, nextStep(p), checksText(p), reviewText(p));
      }
    }
  }
  all.push(nextStep({ ok: false }), summarize([pr(), pr()]).text);
  for (const s of all) assert.doesNotMatch(s, /ready to|mergeable|merge-ready|safe to merge/i, s);
});

test("modal wording keeps checks and review apart", () => {
  const p = pr({ reviewDecision: "CHANGES_REQUESTED", checks: "SUCCESS" });
  assert.equal(checksText(p), "Passing");
  assert.equal(reviewText(p), "Changes requested");
  assert.equal(nextStep(p), "Address the review feedback.");
  assert.equal(nextStep(pr({ reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE" })), "Address the review feedback and fix the failing checks.");
  assert.equal(checksText(pr()), "None reported");
  assert.equal(checksText({ ok: false }), "Unavailable");
});
