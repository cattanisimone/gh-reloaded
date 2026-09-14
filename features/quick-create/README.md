# Quick-create button

A button (or stack of buttons) on every GitHub Projects page, sitting in the project's own top bar between its last two button groups (Insights/Workflows, and Project details/"..."), each linking straight to "new issue" for a repo you've configured — handy when the repo you actually file work into isn't the one the board itself lives in (e.g. a triage board that spans several repos, or a board where requests go to a different tracker entirely). Falls back to a floating button if that top bar can't be found.

![Quick-create button mockup](../../screenshots/quick-create.svg)

_Mockup illustrating the layout and colors — not a literal screenshot._

## Configuring it

Settings → **Quick-create shortcuts**. Each shortcut is:

- **Label** — the button text (e.g. "New Request")
- **URL** — where it opens, in a new tab (e.g. `https://github.com/owner/repo/issues/new/choose`, or a specific issue template's URL)
- **Project** — optional. Leave blank to show the shortcut on every Projects board; set it to show it only on one — either `owner/number` directly, or just paste the board's own URL (`.../orgs/<owner>/projects/<number>/...`), either works.
- **Icon** — pick from a small fixed set (plus, issue, check, search, link), shown to the left of the label.
- **Color** — pick from a small fixed palette, not a full color spectrum, so shortcuts stay visually consistent with each other.

Nothing is preset — this feature doesn't know or assume anything about any specific repo, org, or project. Add as many shortcuts as you want; any that match the current board (unscoped, or scoped to it specifically) show up stacked.

## Known limitations

- Project scoping is a single `owner/number` match, not a list — a shortcut meant for several (but not all) boards needs one entry per board today.
- Anchors on the top bar's `index-module__topBarActions`/`index-module__ButtonGroup` class names, read off a live page — resilient to most markup churn, but breaks (falling back to floating) if GitHub renames them outright.
