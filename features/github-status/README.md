# GitHub Status

A status badge on the GitHub logo's corner, a details panel and a contextual incident pill, fed by githubstatus.com. See the Features section of the root `README.md` for what users see.

- `relevance.js` — pure rules: dot state (unknown after 15 minutes), route to components, wide incidents, notice and dismissal. Unit-tested.
- `content.js`, `content.css` — anchors (logo link, header search control), the dot overlaid on the logo by CSS anchor positioning with a ring read from the header's background, native popover panel, pill, SPA re-scan. No fallback container: a missing anchor means nothing is inserted until the next scan.
- `../../background/github-status.js` — the one shared, cached, anonymous `summary.json` fetch (message `GITHUB_STATUS_GET`).
