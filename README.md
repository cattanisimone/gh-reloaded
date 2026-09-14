# GitHub Sub-Issues Dependency Graph

Chrome extension (MV3). On a GitHub issue page that has sub-issues, it injects a left-to-right dependency graph right below the "Sub-issues" list — the same "inject a widget into a page I don't own" idea as Keepa on Amazon, applied to GitHub issues.

## What it does

- Detects the "Sub-issues" section on `github.com/*/*/issues/*` pages.
- Fetches the issue's direct sub-issues via the GitHub REST API.
- For each sub-issue, fetches its "blocked by" relationships (GitHub's [Issue Dependencies](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) feature) and keeps only the edges that connect two sub-issues that are both in that list.
- Lays the graph out left → right (blockers on the left, the issues they block on the right) and renders it as inline SVG, themed to match GitHub's light/dark mode.
- Clicking a node opens that issue.

## v1 scope — known limitations

- **Only direct sub-issues** of the open issue become full "internal" nodes — no recursion into grand-children.
- **External dependencies** (an issue outside the sub-issue list that blocks — or is blocked by — one of them) are shown as dimmed, dashed nodes, further left/right of the internal columns, with only their team shown (not Status/Business Value, which are meaningless outside the feature).
- **Anchor detection is text-based** (it looks for a heading whose text starts with "Sub-issues"), not tied to a specific CSS class — more resilient to GitHub redesigns, but if GitHub ever renames the section, the graph won't be injected until the code is adjusted. Works the same way on a plain issue page and inside a GitHub Projects board's issue-preview side panel (`.../projects/{n}/views/{v}?pane=issue&issue=owner|repo|number`).
- Requires the repo/org to have the [Issue Dependencies](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) feature available for edges, Projects v2 for the Status color, and org-level custom fields for Team/Business Value. Any of these can be silently absent — the graph still renders with whatever data it got.
- No extension icons bundled yet (fine for local "load unpacked" testing; add before publishing).

## Install (for testing)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`github_dependencies`).
4. Click the extension's toolbar icon → it opens the **Settings** page.
5. Create a **fine-grained personal access token**: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new), scoped to the repositories you want to test with, permission **Issues: Read-only**.
6. Paste the token into Settings, click **Save**, then **Test connection** to confirm it works.

## Try it

Open an issue that has sub-issues (e.g. an epic in a repo where you use GitHub's sub-issues feature). Below the sub-issues list you should see a "Dependency graph" box:

- If it doesn't appear: the issue may have no sub-issues, or the page's "Sub-issues" heading text/structure doesn't match what the content script looks for (check the DevTools console on that page for `GHDG_FETCH_GRAPH` errors, or inspect around the sub-issues list for the actual heading text).
- If it shows "Set a GitHub token…": go back to Settings and save a token.
- If it shows nodes but no arrows between them: either there are no "blocked by" relationships among those sub-issues, or the Dependencies API isn't enabled for that repo.

## Project layout

```
manifest.json          MV3 manifest
background.js          Service worker — all GitHub API calls + caching
content/content.js     Finds the anchor, talks to background, renders the graph
content/layout.js      Dependency-free left-to-right DAG layout
content/content.css    Themed (light/dark) styling for the injected box
options/               Settings page (token input + connection test)
```

## Next steps (not in v1)

- Include blockers outside the direct sub-issue set (as dimmed "external" nodes).
- Recurse into nested sub-issues (up to GitHub's 8-level depth limit).
- Cache across page loads (currently in-memory only, cleared when the service worker sleeps).
- Extension icons + Chrome Web Store packaging.
