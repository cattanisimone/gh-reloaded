# Board dependency arrows

On a GitHub Projects board, draws an arrow directly between any two currently-rendered cards where one blocks the other — so a dependency reads at a glance without opening either issue.

Off by default. A toggle button in the top-right corner of the page turns it on/off, and the choice is remembered (and can also be flipped from Settings).

## What it does

- Finds every issue/PR link currently in the DOM — not scoped to a particular view layout (board, table, …), since the card discovery is just "any issue/PR link on the page right now."
- Asks the background for "blocked by" / "blocking" relationships ([Issue Dependencies](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)) among exactly those issues, and draws an arrow for every pair where **both** ends are currently on screen. A dependency pointing at an issue that isn't rendered on the board at all is simply not drawn — unlike the issue-page dependency graph, there's no placeholder "external" node here.
- Recomputes arrow positions on scroll, resize, and any DOM change (drag-and-drop, column collapse, filtering) so arrows track cards as they move; re-fetches the dependency data only when the set of visible cards actually changes.

## Known limitations

- If a Projects view virtualizes off-screen cards (removes them from the DOM entirely rather than just hiding them), a dependency to/from one of those cards can't be drawn until it's scrolled into view.
- Card detection is a generic "closest row/gridcell/list-item ancestor of an issue link" heuristic, not tied to a specific layout's markup — it's resilient to most redesigns but can anchor a little loosely (e.g. to the link itself) on an unfamiliar layout.
- Every visible card costs two API calls (blocked-by, blocking), same as the issue-page dependency graph; the shared 60s response cache in `lib/github-api.js` keeps a burst of re-renders (scrolling, dragging) from re-hitting the API each time.
