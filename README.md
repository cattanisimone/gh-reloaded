# GH Reloaded

A Chrome extension that injects small, focused UI enhancements into github.com — the same "add a widget to a page you don't own" idea as Keepa on Amazon, aimed at making GitHub itself more pleasant to use. It's a collection of independent features, not a single-purpose tool: each one lives in its own folder and can be added, removed, or shipped on its own.

## Features

### Dependency graph ([features/dependency-graph](features/dependency-graph))

On a GitHub issue page (or a Projects board's issue-preview side panel) that has sub-issues, injects a left-to-right dependency graph below the sub-issues list.

- Fetches the issue's direct sub-issues, their "blocked by" / "blocking" relationships, Projects v2 Status, and the org-level Team / Business Value / Effort custom fields (when available).
- Lays the graph out left → right, colored by each card's real board status, with dependencies outside the sub-issue set shown as dimmed, dashed "external" nodes.
- Highlights the critical path (longest chain by total Effort — unestimated stories are assumed to cost the median of whatever else in the feature is sized, so a couple of missing estimates don't distort it) and lets you toggle how much of that external context to show, and how columns are aligned.

More features will land as their own folders under `features/` (and `background/` for anything they need server-side). See [CONTRIBUTING.md](CONTRIBUTING.md) for the shape a new one takes.

## Install (unpacked, for now)

This isn't on the Chrome Web Store yet.

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repo folder.
4. Click the extension's toolbar icon → it opens **Settings**.
5. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new), scoped to the repositories you want to use this on, with:
   - **Issues: Read-only** (sub-issues, dependencies, org-level custom fields)
   - **Projects: Read-only** (Projects v2 Status) — for an organization-owned project this may need the token's resource owner set to that organization, or an SSO authorization step, depending on the org's PAT policy.
6. Paste the token into Settings, **Save**, then **Test connection**.

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
