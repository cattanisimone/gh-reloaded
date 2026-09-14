# Quick-create button

A small floating button (or stack of buttons) on every GitHub Projects board view, each linking straight to "new issue" for a repo you've configured — handy when the repo you actually file work into isn't the one the board itself lives in (e.g. a triage board that spans several repos, or a board where requests go to a different tracker entirely).

## Configuring it

Settings → **Quick-create shortcuts**. Each shortcut is:

- **Label** — the button text (e.g. "New Request")
- **URL** — where it opens, in a new tab (e.g. `https://github.com/owner/repo/issues/new/choose`, or a specific issue template's URL)
- **Project** — optional. Leave blank to show the shortcut on every Projects board; set it to `owner/number` (the org or user, and the project number — both visible in the board's own URL, `.../orgs/<owner>/projects/<number>/...`) to show it only there.
- **Color** — pick from a small fixed palette, not a full color spectrum, so shortcuts stay visually consistent with each other.

Nothing is preset — this feature doesn't know or assume anything about any specific repo, org, or project. Add as many shortcuts as you want; any that match the current board (unscoped, or scoped to it specifically) show up stacked.

## Known limitations

- Project scoping is a single `owner/number` match, not a list — a shortcut meant for several (but not all) boards needs one entry per board today.
- Floating rather than injected into GitHub's own toolbar, on purpose: Projects board markup isn't a stable place to anchor on, and this sidesteps that entirely at the cost of not looking quite as "native".
