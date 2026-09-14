# Full-width board

On a GitHub Projects **Board** (kanban) view, stretches the board to the full window width instead of sitting inside the page's normal centered, padded column — more room for columns before they need to scroll horizontally.

On by default (unlike Board dependency arrows, which is opt-in). No in-page control — this is a layout default you either want or don't, toggled once from Settings, not something to flip per session.

## What it does

- Detects a Board view the same way Board dependency arrows does (the selected view tab's own icon), and while enabled, pulls the board's own container out of whatever centered/max-width wrapper its ancestors put it in — a CSS "full-bleed" trick that works without needing to know or touch those ancestors' own class names.

## Known limitations

- This makes more *room* available; it doesn't force columns to shrink to fit. A board with enough columns to still overflow the (now wider) viewport keeps its normal horizontal scrollbar — same as without this feature, just later.
- Targets `[class*="Board-module__boardContainer"]`, read off a live board's DOM. GitHub's Projects app (internally "memex") doesn't publish stable class names — CSS-module hashes regenerate on every deploy, but the un-hashed prefix this matches on has been stable across the redesigns checked so far.
