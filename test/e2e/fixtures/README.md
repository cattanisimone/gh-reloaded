# E2E fixtures

These are the saved GitHub pages the end-to-end tests run against. Serving them locally (see `../support/extension.js`) is what makes the suite deterministic and network-free: the content scripts inject into these instead of into a live, progressively-rendered, auth-gated github.com page.

## What each fixture is

| File | Page it stands in for | Features exercised |
| --- | --- | --- |
| `issue.html` | An issue with a "Sub-issues" section | dependency-graph |
| `board.html` | A Projects v2 **Board** (kanban) view | quick-create, board-dependencies, full-width-board, standup-mode |
| `pr-files.html` | A pull request "Files changed" page with one changed `.html` file | html-preview (PR globe button) |
| `blob.html` | A single-file blob page for an `.html` file | html-preview (blob Preview tab) |
| `pr-files-lazy.html` | A "Files changed" page whose file path is not yet resolvable | html-preview #16 regression |

## Capture date and how these were produced

**Last synced against github.com's live markup: 2026-10-01.**

These are **trimmed, hand-maintained** representations, not raw `Save As` captures. Two reasons the tests can't use literal captures:

- The pages these features target — Projects boards, the redesigned PR diff viewer, blob pages — are authenticated single-page-app shells that render their real DOM client-side after a sequence of API calls. A saved HTML file of one is an empty skeleton; the markup the content scripts anchor on only exists after that JS runs.
- The suite must be deterministic and runnable with no GitHub token (an acceptance criterion of #18). A fixture frozen to just the anchors each content script keys on gives that; a live page would not.

So each fixture keeps only the structure the content scripts actually look for — and deliberately follows the same "anchor on visible text, not on churny selectors" rule the features themselves follow (see `AGENTS.md`). Where a feature *does* match a CSS-module class by prefix (e.g. `[class*="Board-module__boardContainer"]`), the fixture carries that class with GitHub's build-hash suffix dropped, mirroring what the content script matches. Each file starts with an HTML comment listing the anchors it must preserve.

## How to refresh them

When GitHub ships a redesign that moves one of these anchors, a feature breaks in the wild but its e2e test keeps passing against the stale fixture — so the fixture is what needs re-syncing. For the affected page:

1. Open the real page on github.com (signed in, with a project/PR that matches the scenario — e.g. an issue that has sub-issues, a board in Board layout, a PR that changes an `.html` file).
2. In DevTools → Elements, find the region the feature anchors on (its code comments name it — the "Sub-issues" heading, the view-tabs bar and a board card, the PR header's `/tree/` links and a file header, the Code/Blame toggle). Right-click the enclosing node → **Copy** → **Copy outerHTML**.
3. Paste it into the fixture, then trim it down to just the anchors listed in that fixture's top comment. Strip build-hash suffixes from any `*-module__*` class the content script matches by prefix. Keep it self-contained — no external scripts, fonts, or images (the harness aborts github.com sub-resource requests).
4. Update the "Last synced" date above and run `npm test`.

A fixture should stay as small as it can while still reproducing the anchors — a smaller fixture is easier to re-sync and makes it obvious which structure the test depends on.
