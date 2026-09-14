# Contributing

## Adding a new feature

Every feature is two loosely-coupled halves:

**`features/<name>/`** — the content-script side. Runs in the page's isolated world on whichever `github.com` pages it targets. Typically:

- `content.js` — finds where on the page to hook in, injects DOM, renders, re-runs on GitHub's SPA navigations
- anything else it needs: a `layout.js`, a `content.css`, etc.

It's a self-contained IIFE, not an ES module — content scripts don't support `import`. If it needs data from GitHub, it messages the background rather than fetching directly (see below).

**`background/<name>.js`** — the feature's server-side logic, if it has any. An ES module (the service worker runs with `"type": "module"`) that exports:

```js
export const MESSAGE_TYPE = "MY_FEATURE_FETCH_X"; // unique across features
export async function handleMessage(payload) {
  // ... talk to GitHub via lib/github-api.js, compute whatever ...
  return { someKey: result }; // spread into the response the content script gets
}
```

Import it in `background.js` and add it to the `FEATURES` array — the generic message router in there takes care of the rest (dispatch by `MESSAGE_TYPE`, token-presence flag, error shape). A feature with no background logic at all just skips this half.

**`lib/github-api.js`** is shared: auth, request caching, and generic REST/GraphQL helpers. Add a genuinely reusable helper there (not feature-specific parsing) if more than one feature needs it.

**`manifest.json`**: add your content script's files to a `content_scripts` entry — reuse the existing one if your `matches` overlap with another feature's, add a new entry otherwise.

## Design notes worth keeping in mind

- **No remotely-hosted code.** Chrome Web Store policy disallows it for MV3, and it's also just simpler: no CDN scripts, everything bundled in the repo.
- **Read from the environment, don't hardcode conventions.** e.g. a sub-issue's "done-ness" is GitHub's own issue `state`, not a guess at what a board's terminal Status column is *named* — every board can call it whatever it wants.
- **Degrade gracefully.** A feature that depends on Projects v2, org-level custom fields, or issue dependencies should still render something useful when that data is absent (wrong token permissions, feature not enabled on that repo/org, etc.) rather than failing outright.
- **Anchor on visible text over specific selectors when injecting into GitHub's own DOM.** GitHub's markup churns across redesigns; a heading's visible text is more likely to survive that than a class name or `data-testid`.

## Local testing

No build step. `chrome://extensions` → Developer mode → Load unpacked → reload the extension (and the GitHub page) after each change.
