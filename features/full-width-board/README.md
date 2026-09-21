# Full-width board

On a GitHub Projects **Board** (kanban) view, stretches the board to the full window width instead of sitting inside the page's normal centered, padded column — more room for columns before they need to scroll horizontally.

On by default (unlike Board dependency arrows, which is opt-in). No in-page control — this is a layout default you either want or don't, toggled once from Settings, not something to flip per session.

![Full-width board mockup](../../screenshots/full-width-board.svg)

_Mockup illustrating the layout — not a literal screenshot._

## What it does

- Detects a Board view the same way Board dependency arrows does (the selected view tab's own icon), and while enabled:
  - Stretches the board's own container to reach the viewport's right edge, starting from wherever it actually sits — measured live off its own `getBoundingClientRect()` rather than assumed via a fixed viewport-centered offset, since a slice-by panel (or anything else occupying real space to the board's left) would otherwise throw that assumption off. A `ResizeObserver` on the slice-by panel keeps the measurement live while it's dragged wider or narrower.
  - Zeroes out the columns row's own `min-width` (GitHub sets it inline, computed as columnCount × each column's configured width — sized to always fit every column at full width no matter how much room the page actually gives it) and turns each column into a flexible, shrinkable flex item with a 140px floor, instead of a fixed-width one.

## Known limitations

- Column shrinking has a 140px floor per column — a board with enough columns that they'd need to go narrower than that to all fit keeps a (smaller) horizontal scrollbar, same as without this feature, just later.
- Targets class names (`Board-module__boardContainer`, `Board-module__horizontalGroupAreaContainer`, `column-frame-module__Box__`, `slicer-items-module__SlicerPanel`, …) read off a live board's DOM. GitHub's Projects app (internally "memex") doesn't publish stable class names — CSS-module hashes regenerate on every deploy, but the un-hashed prefixes this matches on have been stable across the redesigns checked so far.
- Forcing columns to a different width than GitHub itself computed could visually glitch mid-drag if you resize or reorder a column while this is active — GitHub's own drag-and-drop math is built around its own configured widths, not this override.
