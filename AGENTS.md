# AGENTS.md

The rules for changing this codebase — for people and for coding assistants (Claude Code, Codex, and anything else that reads an `AGENTS.md`). Every convention lives here exactly once; other files point at this one rather than repeating it.

## What this project is

**GH Reloaded** is a Manifest V3 Chrome extension that injects small, focused UI enhancements into `github.com`. It's a collection of independent features, not a single-purpose tool: each one lives in its own folder and can be added, removed, or shipped on its own.

Layout:

```
manifest.json            MV3 manifest — wires content scripts and the background service worker
background.js            Service worker entry point: opens Settings, routes messages to feature modules
background/<feature>.js  One feature's server-side logic (GitHub calls, computation) + its MESSAGE_TYPE
features/<feature>/      One feature's content-script side: DOM injection, rendering, styling
lib/github-api.js        Shared GitHub REST/GraphQL client (auth, caching) used by every feature
options/                 Settings page (GitHub tokens, quick-create shortcuts, feature toggles)
icons/                   Toolbar/extensions-page icons
screenshots/             SVG mockups illustrating each feature's layout and colors
```

## The shape of a feature

Every feature is two loosely-coupled halves.

**`features/<name>/`** — the content-script side. Runs in the page's isolated world on whichever `github.com` pages it targets. Typically:

- `content.js` — finds where on the page to hook in, injects DOM, renders, re-runs on GitHub's SPA navigations;
- anything else it needs: a `layout.js`, a `content.css`, etc.

It's a self-contained IIFE, not an ES module — content scripts don't support `import`. If it needs data from GitHub, it messages the background rather than fetching directly.

**`background/<name>.js`** — the feature's server-side logic, if it has any. An ES module (the service worker runs with `"type": "module"`) that exports:

```js
export const MESSAGE_TYPE = "MY_FEATURE_FETCH_X"; // unique across features
export async function handleMessage(payload) {
  // ... talk to GitHub via lib/github-api.js, compute whatever ...
  return { someKey: result }; // spread into the response the content script gets
}
```

Import it in `background.js` and add it to the `FEATURES` array — the generic message router there takes care of the rest (dispatch by `MESSAGE_TYPE`, token-presence flag, error shape). A feature with no background logic just skips this half.

**`lib/github-api.js`** is shared: auth, request caching, and generic REST/GraphQL helpers. Add a genuinely reusable helper there (not feature-specific parsing) if more than one feature needs it.

**`manifest.json`**: add your content script's files to a `content_scripts` entry — reuse the existing one if your `matches` overlap with another feature's, add a new entry otherwise.

## Design rules

- **No remotely-hosted code.** Chrome Web Store policy disallows it for MV3, and it's also just simpler: no CDN scripts, everything bundled in the repo.
- **Read from the environment, don't hardcode conventions.** e.g. a sub-issue's "done-ness" is GitHub's own issue `state`, not a guess at what a board's terminal Status column is *named* — every board can call it whatever it wants.
- **Degrade gracefully.** A feature that depends on Projects v2, org-level custom fields, or issue dependencies should still render something useful when that data is absent (wrong token permissions, feature not enabled on that repo/org, etc.) rather than failing outright.
- **Anchor on visible text over specific selectors when injecting into GitHub's own DOM.** GitHub's markup churns across redesigns; a heading's visible text is more likely to survive that than a class name or `data-testid`.

## Keep docs in sync with features

When a feature is added or its behavior changes, in the **same pass** (not as a follow-up):

- Update `README.md`'s "Features" section — it is the source of truth for what each feature does and what permissions it needs.
- Refresh the feature's mockup under `screenshots/` when the change is visible (a new UI element, a moved or restyled control, a different layout) — a stale screenshot is worse than none, since it actively misleads. The screenshots are SVG mockups illustrating layout and colors, not literal captures; regenerate them in the same style rather than trying to capture a real page.
- Update `PRIVACY.md` when the change alters what data is stored or which permissions the extension requests.

## Markdown style

Write one paragraph per line: no line break in the middle of a sentence or paragraph. Keep line breaks only between paragraphs, between list items, around headings, and inside code blocks. Long lines are expected — let the editor soft-wrap them rather than hard-wrapping at a column. This keeps diffs to a paragraph readable as a single changed line.

## Definition of done

A change is ready to hand off when all of these hold:

- [ ] Every acceptance criterion in the issue is met, or the PR explains which one is not and why.
- [ ] Tests pass — `npm test` runs the unit and e2e suites (see [Running the tests](#running-the-tests)).
- [ ] `README.md`'s "Features" section is updated when a feature's behavior changes.
- [ ] The feature's `screenshots/` mockup is refreshed when the change is visible.
- [ ] `PRIVACY.md` is updated when stored data or requested permissions change.
- [ ] No remotely-hosted code is introduced.

## Git and pull request conventions

- **One issue → one branch → one pull request.** Keep a change to its issue's scope. Something else worth doing? List it under "Follow-ups" in the PR rather than widening the branch.
- **Branch name:** `<type>/<issue-number>-<short-slug>`, e.g. `docs/20-agents-md` or `fix/16-html-preview-race`. Types: `feat`, `fix`, `docs`, `chore`, `test`, `ci`, `refactor`. Recommended — some branches are named by the tool that created them; a descriptive name is preferred where you control it.
- **PR title:** [Conventional Commits](https://www.conventionalcommits.org/), e.g. `docs: consolidate contributor conventions in AGENTS.md`. A title check (`pr-title.yml`) enforces this on every PR. PRs are squash-merged, so the title becomes the commit on `main` — and that commit is what drives the next version.
- **Link the issue:** end the PR body with `Fixes cattanisimone/gh-reloaded#<N>` so merging the PR closes the issue.
- **PR body:** use the [pull request template](.github/pull_request_template.md) — a summary, the linked issue, how the change was verified, and the definition-of-done checklist.
- **Version:** don't touch `manifest.json`'s `version` in a regular PR. [Release Please](https://github.com/googleapis/release-please) owns it: it reads the conventional commits merged to `main` and keeps a single release PR open that bumps the version (a `feat` the minor, a `fix` the patch, a `!` the major, or the minor while below 1.0) and updates `CHANGELOG.md`. Merging that release PR cuts the `vX.Y.Z` tag, the GitHub Release, and the Chrome Web Store upload. See the README's [Releasing](README.md#releasing) section.

## Local testing

No build step. `chrome://extensions` → Developer mode → **Load unpacked** → select the repo folder → reload the extension (and the GitHub page) after each change.

## Running the tests

The test harness lives under `test/` and is dev-only — it is deliberately outside the paths the release workflow zips (`manifest.json`, `background.js`, `background`, `features`, `icons`, `lib`, `options`), so `package.json`, the fixtures, and the tests never ship in the extension. There is no bundler: the extension itself still loads unpacked, exactly as above.

One command runs everything, with no GitHub token:

```
npm install
npx playwright install --with-deps chromium   # first time only — the e2e browser
npm test
```

`npm test` runs two suites, and the same command runs in CI (`.github/workflows/ci.yml`) on every pull request:

- **Unit tests** (`npm run test:unit`) — Node's built-in test runner over the pure logic: the effort-weighted critical path in `background/dependency-graph.js`, per-owner token resolution and response caching in `lib/github-api.js`, and the path/URL helpers in `background/html-preview.js`. These import the real modules; a small `chrome` stub (`test/support/chrome-stub.js`) stands in for the extension storage API they touch at load. The only runtime source change this harness required was adding `export` to those already-existing pure functions so tests can import them — no behavior change.
- **End-to-end tests** (`npm run test:e2e`) — Playwright loads the extension unpacked into headless Chromium and drives it against saved fixtures of the GitHub pages each feature targets (`test/e2e/fixtures/`, see its README for how to refresh them). Every github.com page is served from a fixture and every api.github.com call is mocked at the extension's boundary, so the suite is deterministic and offline. Each feature has a main-path test and a disabled-state test.

The e2e suite needs the full Chromium build (Playwright's `channel: "chromium"`) — only it loads extensions headless; the default bundled headless shell can't.
