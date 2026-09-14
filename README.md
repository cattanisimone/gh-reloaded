# GH Reloaded

A Chrome extension that injects small, focused UI enhancements into github.com — the same "add a widget to a page you don't own" idea as Keepa on Amazon, aimed at making GitHub itself more pleasant to use.

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

More features will land as their own entries here, each in its own folder under `features/` (and `background/` for anything they need server-side). See [Contributing](#contributing) for the shape a new one takes.

## Project layout

```
manifest.json                       MV3 manifest — wires content scripts and the background service worker
background.js                       Service worker entry point: opens Settings, routes messages to feature modules
lib/github-api.js                   Shared GitHub REST/GraphQL client (auth, caching) used by every feature
background/<feature>.js             One feature's server-side logic (GitHub calls, computation) + its MESSAGE_TYPE
features/<feature>/                 One feature's content-script side: DOM injection, rendering, styling
options/                             Settings page (GitHub token input + connection test)
icons/                               Toolbar/extensions-page icons
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how a feature module is structured and how to add a new one. Issues and PRs welcome.

## License

[MIT](LICENSE)
