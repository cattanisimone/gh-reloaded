# Privacy Policy

**GH Reloaded** doesn't collect, sell, or share any data. Everything it stores stays in your own browser, and the only network calls it makes are directly from your browser to `api.github.com`, using your own GitHub token(s), and, for the GitHub Status feature, one anonymous request to `www.githubstatus.com` (GitHub's official status page) — never to a server this project runs or controls.

## What's stored, and where

Stored locally via the browser's `chrome.storage.local` (never synced, never sent anywhere on its own):

- **GitHub tokens** — the personal access token(s) you paste into Settings: one default token, plus an optional token per repository owner (an organization or personal account) that needs its own credential. Each request uses the token mapped to the repository it's about, falling back to the default. Once saved, a token is never displayed again in full — only its last 4 characters.
- **Quick-create shortcuts** — the label, URL, icon, color, and project scope of each shortcut you configure.
- **Feature toggles** — which features are turned on or off.
- **Standup mode thresholds** — how many days a card may sit in a review-like column before it is flagged, and the status keywords that count as review-like.
- **UI preferences** — small display choices: the dependency graph's column alignment, how much external context to show, whether transitive dependencies are hidden and the automatic-refresh interval, whether the My Issues dashboard shows the native list or the grouped-by-project view (`ghmiView`), whether its left sidebar is collapsed to an icon rail (`ghmiSidebar`), whether the My Issues feature is switched on (`ghmiEnabled`), and the optional minimum and maximum width of its Project tiles (`ghmiTileMin`, `ghmiTileMax`), whether PR triage on a repository's Pull requests page is switched on (`ghprtEnabled`), and for GitHub Status whether it is switched on (`ghgsEnabled`), whether its incident notice is shown (`ghgsNotice`) and which incident notices you dismissed, as incident ids with the time of the update you dismissed (`ghgsDismissed`; entries for resolved incidents are removed). Which Project tiles are collapsed is kept in memory only and never stored.

The public status data the GitHub Status feature reads (overall indicator, affected components, open incidents and their latest update) is kept in `chrome.storage.session`, in memory only, for a few minutes and cleared when the browser closes. It is not personal data and is never synced.

**Verify access** (Settings → GitHub tokens) sends the token of the card you use to `api.github.com`, only when you click **Run checks**, for the repository, issue, project and file you name; the answers are shown on that page and nothing is stored.

None of this leaves your browser except the token itself, which is sent — over HTTPS, directly — only to `api.github.com`, only when a feature you've enabled needs to read issue, sub-issue, dependency, or Projects data, or when you click **Run checks** in Verify access. GitHub's own [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) covers what GitHub does with that request.

## The status request

The GitHub Status feature asks `https://www.githubstatus.com/api/v2/summary.json` for GitHub's public status, from the extension's background service worker, at most once every 5 minutes while a github.com tab is open and visible. When a request fails it retries sooner, after 30, 60, 120 and 240 seconds, and returns to every 5 minutes once it succeeds or the delay reaches that interval. The request has no query string, no cookies or credentials, no referrer and no token, and carries nothing about you, the page you are on or your repositories. It needs no extra permission. Switching the feature off in Settings stops the requests.

## What it reads from GitHub pages

To render its features, the extension reads issue titles, labels, comments, status and when it last changed, sub-issue and dependency relationships, the issues assigned to you (when you open your My Issues dashboard) together with which Projects they belong to and their issue type, and Projects v2 field values, and, for the pull requests listed on a repository's Pull requests page, who is asked to review, each reviewer's latest review verdict, the head commit and the checks result — from the GitHub page you're on and from the GitHub API — and displays that information back to you, in your own browser. None of it is transmitted anywhere else, logged, or retained beyond what's listed above.

## What it doesn't do

- No analytics, telemetry, or usage tracking.
- No advertising, and no data sale or transfer to any third party.
- No remotely-hosted code — everything the extension runs ships in the extension package itself.

## Removing your data

Uninstalling the extension removes everything it stored. To clear it without uninstalling, remove your GitHub tokens from Settings, or clear the extension's storage from `chrome://extensions`.

## Contact

Questions about this policy or the extension's data handling: open an issue at [github.com/cattanisimone/gh-reloaded](https://github.com/cattanisimone/gh-reloaded/issues).
