// Checks that release-please-config.json implements the versioning policy in
// AGENTS.md ("Picking the PR type"). The repository config is loaded through
// release-please's own loader and strategy factory, so the kebab-case keys are
// mapped exactly as in CI, then fed synthetic commits starting from 0.8.0.
// Nothing goes over the network.
//
// The deep imports below are not a public API, and release-please is pinned
// with `~17.9.0` in package.json so this stays on the version the
// release-please-action@v5 workflow runs. If an upgrade moves these modules,
// the test fails loudly at import time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Manifest } from "release-please/build/src/manifest.js";
import { buildStrategy } from "release-please/build/src/factory.js";
import { parseConventionalCommits } from "release-please/build/src/commit.js";
import { Version } from "release-please/build/src/version.js";

const CONFIG_FILE = "release-please-config.json";
const MANIFEST_FILE = ".release-please-manifest.json";
const files = {
  [CONFIG_FILE]: JSON.parse(readFileSync(CONFIG_FILE, "utf8")),
  [MANIFEST_FILE]: { ".": "0.8.0" },
};
const github = {
  repository: { owner: "cattanisimone", repo: "gh-reloaded", defaultBranch: "main" },
  getFileJson: async (path) => {
    if (!(path in files)) throw new Error(`not found: ${path}`);
    return files[path];
  },
};

const manifest = await Manifest.fromManifest(github, "main");
const strategy = await buildStrategy({
  ...manifest.repositoryConfig["."],
  github,
  path: ".",
  targetBranch: "main",
});
const latestRelease = {
  tag: { name: "v0.8.0", version: Version.parse("0.8.0"), sha: "0".repeat(40) },
  sha: "0".repeat(40),
  notes: "",
};

// The release PR release-please would open for these commit messages, or
// undefined when it would not open one.
async function releasePullRequest(...messages) {
  const commits = messages.map((message, i) => ({
    sha: String(i + 1).padStart(40, "0"),
    message,
  }));
  return strategy.buildReleasePullRequest(parseConventionalCommits(commits), latestRelease);
}

test("breaking change below 1.0 bumps the minor", async () => {
  const pr = await releasePullRequest("feat!: remove the old option\n\nBREAKING CHANGE: the option is gone");
  assert.equal(pr.version.toString(), "0.9.0");
  const fixPr = await releasePullRequest("fix!: rename a setting\n\nBREAKING CHANGE: saved settings reset");
  assert.equal(fixPr.version.toString(), "0.9.0");
});

test("feat bumps the minor, fix and perf bump the patch", async () => {
  assert.equal((await releasePullRequest("feat: add a thing")).version.toString(), "0.9.0");
  assert.equal((await releasePullRequest("fix: repair a thing")).version.toString(), "0.8.1");
  assert.equal((await releasePullRequest("perf: speed up a thing")).version.toString(), "0.8.1");
});

test("perf commits are listed under Performance", async () => {
  const pr = await releasePullRequest("perf: speed up the graph layout");
  const body = pr.body.toString();
  assert.match(body, /### Performance/);
  assert.match(body, /speed up the graph layout/);
  assert.doesNotMatch(body, /Performance Improvements/);
});

test("features and bug fixes keep their sections", async () => {
  const body = (await releasePullRequest("feat: add a thing", "fix: repair a thing")).body.toString();
  assert.match(body, /### Features/);
  assert.match(body, /### Bug Fixes/);
});

for (const type of ["refactor", "test", "docs", "ci", "chore", "build", "style"]) {
  test(`${type} commits are hidden and do not open a release PR alone`, async () => {
    assert.equal(await releasePullRequest(`${type}: internal change`), undefined);
  });
}

test("hidden types do not show up next to visible ones", async () => {
  const body = (await releasePullRequest("feat: add a thing", "docs: reword the readme", "chore: tidy up")).body.toString();
  assert.match(body, /add a thing/);
  assert.doesNotMatch(body, /reword the readme|tidy up/);
});
