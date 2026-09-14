# Quick-create button

A small floating button (or stack of buttons) on every GitHub Projects board view, each linking straight to "new issue" for a repo you've configured — handy when the repo you actually file work into isn't the one the board itself lives in (e.g. a triage board that spans several repos, or a board where requests go to a different tracker entirely).

## Configuring it

Settings → **Quick-create shortcuts**. Each shortcut is:

- **Label** — the button text (e.g. "New Request")
- **URL** — where it opens, in a new tab (e.g. `https://github.com/owner/repo/issues/new/choose`, or a specific issue template's URL)
- **Color** — whatever helps it stand out from the rest

Nothing is preset — this feature doesn't know or assume anything about any specific repo, org, or project. Add as many shortcuts as you want; they all show up, stacked, on every Projects board view (org- or user-owned).

## Known limitations

- No per-board scoping yet — a configured shortcut shows on every Projects board view, not just a specific one. If that turns out to matter, the config shape has room to grow (e.g. an optional "only on this project" match) without changing how existing shortcuts behave.
- Floating rather than injected into GitHub's own toolbar, on purpose: Projects board markup isn't a stable place to anchor on, and this sidesteps that entirely at the cost of not looking quite as "native".
