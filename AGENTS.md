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
- [ ] Tests pass, if the repository has them. (An automated unit + e2e harness with a single documented command is being added in #18; run it once it lands.)
- [ ] `README.md`'s "Features" section is updated when a feature's behavior changes.
- [ ] The feature's `screenshots/` mockup is refreshed when the change is visible.
- [ ] `PRIVACY.md` is updated when stored data or requested permissions change.
- [ ] No remotely-hosted code is introduced.

## Git and pull request conventions

- **One issue → one branch → one pull request.** Keep a change to its issue's scope. Something else worth doing? List it under "Follow-ups" in the PR rather than widening the branch.
- **Branch name:** `<type>/<issue-number>-<short-slug>`, e.g. `docs/20-agents-md` or `fix/16-html-preview-race`. Types: `feat`, `fix`, `docs`, `chore`, `test`, `ci`, `refactor`. Recommended — some branches are named by the tool that created them; a descriptive name is preferred where you control it.
- **PR title:** [Conventional Commits](https://www.conventionalcommits.org/), e.g. `docs: consolidate contributor conventions in AGENTS.md`. PRs are squash-merged, so the title becomes the commit on `main`. (A title check and automated versioning arrive with #19.)
- **Link the issue:** end the PR body with `Fixes cattanisimone/gh-reloaded#<N>` so merging the PR closes the issue.
- **PR body:** use the [pull request template](.github/pull_request_template.md) — a summary, the linked issue, how the change was verified, and the definition-of-done checklist.
- **Version:** don't hand-edit `manifest.json`'s `version`. Today `require-version-bump.yml` enforces a bump on non-draft PRs; #19 replaces that with automated release PRs, after which regular PRs never touch the version.

## Local testing

No build step. `chrome://extensions` → Developer mode → **Load unpacked** → select the repo folder → reload the extension (and the GitHub page) after each change.
