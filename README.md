<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="">
</p>

<h1 align="center">GH Reloaded</h1>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Manifest V3" src="https://img.shields.io/badge/manifest-v3-4285F4.svg">
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.0-orange.svg">
  <a href="CONTRIBUTING.md"><img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg"></a>
</p>

<p align="center">
A Chrome extension that injects small, focused UI enhancements into github.com — the same "add a widget to a page you don't own" idea as Keepa on Amazon, aimed at making GitHub itself more pleasant to use.
</p>

It's a collection of independent features, not a single-purpose tool: each one lives in its own folder under `features/` and can be added, removed, or shipped on its own. GitHub covers the fundamentals well; this is for the gaps that are easier to fill from the outside than to wait on.

## Install (unpacked, for now)

This isn't on the Chrome Web Store yet.

### 1. Load the extension

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the repo folder.
4. Open **Settings**: click the extension's toolbar icon, or from `chrome://extensions` → the extension's card → **Details** → **Extension options**.

### 2. Create a GitHub token

Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) (a **fine-grained** token, not classic) and set:

- **Repository access** → *Only select repositories* → pick the repo(s) you want this on.
- **Permissions** → **Repository permissions** → set both of these to **Read-only**:
  - **Issues** — sub-issues, dependencies, org-level custom fields (Team / Business Value / Effort)
  - **Projects** — Projects v2 Status
- Everything else stays at *No access*.
- Click **Generate token** and copy it immediately — GitHub shows it exactly once.

If the repo belongs to an organization with SSO enforced (or with a policy restricting personal access tokens), one more step: go to [github.com/settings/tokens](https://github.com/settings/tokens), find the new token, and click **Configure SSO** / **Authorize** next to the org's name. Without this, requests to that org's data can silently come back empty or `404`, since GitHub doesn't otherwise reveal that the resource exists.

### 3. Connect it

Back in the extension's Settings page: paste the token, **Save**, then **Test connection** — it should report the GitHub username the token authenticates as.

## Features

### Dependency graph — [features/dependency-graph](features/dependency-graph)

On a GitHub issue page (or a Projects board's issue-preview side panel) that has sub-issues, injects a left-to-right dependency graph below the sub-issues list.

- Fetches the issue's direct sub-issues, their "blocked by" / "blocking" relationships, Projects v2 Status, and the org-level Team / Business Value / Effort custom fields (when available).
- Lays the graph out left → right, colored by each card's real board status, with dependencies outside the sub-issue set shown as dimmed, dashed "external" nodes.
- Highlights the critical path (longest chain by total Effort — unestimated stories are assumed to cost the median of whatever else in the feature is sized, so a couple of missing estimates don't distort it) and lets you toggle how much of that external context to show, and how columns are aligned.

### Quick-create button — [features/quick-create](features/quick-create)

A small floating button (or stack of buttons) on a GitHub Projects board view, each linking straight to "new issue" for a repo you configure in Settings — handy when the repo you actually file work into isn't the one the board itself lives in. Fully user-defined (label, URL, color, and an optional "only on this board" project match); nothing is preset.

### Board dependency arrows — [features/board-dependencies](features/board-dependencies)

On a GitHub Projects board, draws an arrow directly between any two currently-visible cards where one blocks the other — no need to open either issue to see the dependency. Off by default; a toggle in the top-right corner of the page turns it on, and the choice is remembered (also switchable from Settings).

More features will land as their own entries here, each in its own folder under `features/` (and `background/` for anything they need server-side). See [Contributing](#contributing) for the shape a new one takes.

## Project layout

```
manifest.json                       MV3 manifest — wires content scripts and the background service worker
background.js                       Service worker entry point: opens Settings, routes messages to feature modules
lib/github-api.js                   Shared GitHub REST/GraphQL client (auth, caching) used by every feature
background/<feature>.js             One feature's server-side logic (GitHub calls, computation) + its MESSAGE_TYPE
features/<feature>/                 One feature's content-script side: DOM injection, rendering, styling
options/                             Settings page (GitHub token, quick-create shortcuts, feature toggles)
icons/                               Toolbar/extensions-page icons
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how a feature module is structured and how to add a new one. Issues and PRs welcome.

## License

[MIT](LICENSE)
