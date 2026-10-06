// playwright.config.js — dev-only. Drives the extension end-to-end
// against saved fixtures (see test/e2e/support/extension.js). Not shipped
// in the extension: the release workflow zips an explicit path list that
// excludes this file and everything under test/.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  // The extension runs in a single persistent context per test; keep the
  // suite serial so the headless Chromium stays predictable and the CI
  // run finishes in a couple of minutes.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    actionTimeout: 10_000,
  },
});
