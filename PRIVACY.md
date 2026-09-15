# Privacy Policy

**GH Reloaded** doesn't collect, sell, or share any data. Everything it stores stays in your own browser, and the only network calls it makes are directly from your browser to `api.github.com`, using your own GitHub token — never to a server this project runs or controls.

## What's stored, and where

Stored locally via the browser's `chrome.storage.local` (never synced, never sent anywhere on its own):

- **GitHub token** — the personal access token you paste into Settings, used to authenticate requests to `api.github.com`.
- **Quick-create shortcuts** — the label, URL, icon, color, and project scope of each shortcut you configure.
- **Feature toggles** — which features are turned on or off.
- **UI preferences** — small display choices for the dependency graph (column alignment, how much external context to show).

None of this leaves your browser except the token itself, which is sent — over HTTPS, directly — only to `api.github.com`, only when a feature you've enabled needs to read issue, sub-issue, dependency, or Projects data. GitHub's own [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) covers what GitHub does with that request.

## What it reads from GitHub pages

To render its features, the extension reads issue titles, labels, status, sub-issue and dependency relationships, and Projects v2 field values — from the GitHub page you're on and from the GitHub API — and displays that information back to you, in your own browser. None of it is transmitted anywhere else, logged, or retained beyond what's listed above.

## What it doesn't do

- No analytics, telemetry, or usage tracking.
- No advertising, and no data sale or transfer to any third party.
- No remotely-hosted code — everything the extension runs ships in the extension package itself.

## Removing your data

Uninstalling the extension removes everything it stored. To clear it without uninstalling, remove the GitHub token from Settings, or clear the extension's storage from `chrome://extensions`.

## Contact

Questions about this policy or the extension's data handling: open an issue at [github.com/cattanisimone/gh-reloaded](https://github.com/cattanisimone/gh-reloaded/issues).
