# Board dependency arrows

On a GitHub Projects **Board** (kanban) view, draws an arrow directly between any two currently-rendered cards where one blocks the other — so a dependency reads at a glance without opening either issue.

Off by default. An icon button in the filter row, just left of GitHub's **View** button — shown only while the selected view is actually a Board, since an arrow between two points doesn't mean much anywhere else — turns it on/off, and the choice is remembered (and can also be flipped from Settings).

![Board dependency arrows mockup](../../screenshots/board-dependencies.svg)

_Mockup illustrating the layout and colors — not a literal screenshot._

## What it does

- Finds every issue/PR link currently in the DOM — card discovery itself is layout-agnostic (just "any issue/PR link on the page right now"), but the button that turns the feature on only appears on a Board view, detected from the selected view tab's own icon.
- Asks the background for "blocked by" / "blocking" relationships ([Issue Dependencies](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)) among exactly those issues, and draws an arrow for every pair where **both** ends are currently on screen. A dependency pointing at an issue that isn't rendered on the board at all is simply not drawn — unlike the issue-page dependency graph, there's no placeholder "external" node here.
- Colors each arrow by whether the two cards' columns are in the order they should be: **gray** when the blocker's column is at or ahead of the card it blocks (or they're in the same column), **red** when the blocker is actually behind the card it's blocking — a sign that card is moving before its own blocker is resolved.
- Hides an arrow when **both** ends are done: a card's own state icon (Closed / Merged) when it shows one, otherwise the issue `state` the dependency API already returns. A pair with one open end is still drawn. Never decided from a column's name.
- Routes arrows around the cards: a same-column pair gets a bracket in the column's side padding, neighbouring columns meet in the gap between them, and a longer route runs in the gap before the target column with the cards it passes cut out of the line, so it reads as passing behind them. Arrows attach to the middle of a card's side, spread out when several share one.
- Draws with GitHub's own muted grey and danger red variables (so light, dark and high-contrast themes follow), a 2px stroke with a halo in the column colour and a 10px head; dark red uses a shade that keeps 3:1 against the card border.
- Hover or keyboard focus on a card highlights its own arrows and fades the others. The overlay sits under GitHub's menus and side panel.
- Skips an end that is scrolled out of its column.
- Recomputes arrow positions on scroll, resize, and any DOM change (drag-and-drop, column collapse, filtering) so arrows track cards as they move; re-fetches the dependency data only when the set of visible cards actually changes.

## Known limitations

- If a Projects view virtualizes off-screen cards (removes them from the DOM entirely rather than just hiding them), a dependency to/from one of those cards can't be drawn until it's scrolled into view.
- The red/gray coloring reads column order from each card's on-screen horizontal position, not from the Status field's configured order directly — accurate for a standard left-to-right Board, but meaningless on a layout that doesn't lay columns out that way.
- Swimlane headers (Group by) are not cut out of a route: a vertical run in a gap can cross one.
- Card anchoring climbs from the issue link to the nearest ancestor that isn't obviously wider than one card; resilient to most markup churn, but can occasionally anchor a little loosely on an unfamiliar layout.
- Every visible card costs two API calls (blocked-by, blocking), same as the issue-page dependency graph; the shared 60s response cache in `lib/github-api.js` keeps a burst of re-renders (scrolling, dragging) from re-hitting the API each time.
