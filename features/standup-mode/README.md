# Standup mode

On a GitHub Projects **Board** (kanban) view, adds a **Standup** button to the filter row (left of the dependency-arrows button and GitHub's **View** button, styled like GitHub's own buttons) that turns the board into a compact, screen-sharing-friendly presentation of the whole board — and flags the cards a standup should talk about.

On by default; switchable from Settings. The button only appears on Board views — switch to a Table or Roadmap view and it withdraws itself.

![Standup mode mockup](../../screenshots/standup-mode.svg)

_Mockup illustrating the layout — not a literal screenshot._

## What it does

- **Reclaims space.** While presenting, GitHub's global header, the project's own title row, the header actions, the view-tabs bar, the filter bar and the **View** button are hidden and a slim bar (project name, view name, the active filter as read-only text, signal summary, **Exit**) is the only header, with a small gap (8px) below it that follows the bar's measured height, sticky headers included. Controls that only edit or configure the board (such as the **Add item** footers) are hidden too, and everything is restored on exit. When the Full-width board feature is off the columns are also fitted to the window width; when it is on, that feature owns the width and standup mode stays out of its way.
- **Compact column headers.** Each column header is one row: the status dot and name on the left and a single metric pill on the right — the field-sum total (for example `Effort: 5`) when the column has one, else the card count, never both. Only those three parts are kept (an allowlist): the `...` menu, the description and anything else in the header, including bare text, are hidden. A header holding both a kept part and loose text has that text silenced with `font-size: 0` while the kept parts restore their own size, so GitHub's DOM is never rewritten. On a grouped board the swimlane header keeps its name, avatar and totals and drops the collapse chevron and menu.
- **Keeps the whole board visible.** There is no walk-through and no dimming: the board is just the board, read-only, with signals layered on the cards.
- **Summarizes what needs attention** in the bar ("2 stale in review", "1 orphan block", …). Each entry scrolls to the first matching card and pulses it; clicking again moves to the next one.
- **Marks the cards** with badges and a tint (details below), and outlines bottleneck columns.
- Exits with the **Exit** button, `Esc`, or by navigating away from the Board view, restoring the pre-entry scroll and focus as reasonably as possible.

## The signals

| Signal | Rule |
| --- | --- |
| **Stale in review** | An open card in a column whose visible name starts a word with one of the review-like keywords (default `review`, `qa`, `test`, `deploy`, `release`), whose Status has not changed for the stale threshold (default 3 days). |
| **Orphan block** | An open card marked blocked — it has a label containing `blocked`, or sits in a column named like Blocked — with no open blocking issue left and no recent comment mentioning a block, wait, dependency, hold or similar. |
| **Critical path at risk** | An open card on the board's effort-weighted critical path (the same computation the dependency graph uses, over the dependencies between cards on this board) that is past its Target date, or is directly blocked by an open card that has been in its status longer than the stale threshold. |
| **Bottleneck** | A column other than the leftmost (intake) one that holds at least 3 cards and at least 40% of the open cards on a board of three or more columns, or whose oldest card has been there at least twice the stale threshold and three times the board's median. |
| **Priority** | The Priority field as a chip; high/critical (`P0`, `P1`, `Critical`, `Urgent`, `High`) also tint the card. |
| **Age** | How many days the card has been in its current Status. |

Time in status is the moment the project item's Status field last changed. Fields are read by name from the project: `Status`, `Priority`, `Target date`, and `Effort` (a number field; unestimated cards get the median, as in the dependency graph).

## Settings

- **Stale after (days)** — the threshold used by Stale, Critical path at risk and Bottleneck. Default 3.
- **Review-like statuses** — comma-separated keywords matched at the start of a word in the column name. Default `review, qa, test, deploy, release`.

## Design notes

- **Read-only and local.** The mode only adds a bar, badges and CSS classes — it never mutates issues, Project fields, or card order. The "currently presenting" state lives in memory only (never in `chrome.storage`), so it stays local to the tab and never survives a reload. Only the feature's on/off switch and the two thresholds are stored.
- **GitHub API.** The signals come from `background/standup-mode.js`: one batched GraphQL request per repository owner (per 15 issues) reads state, labels, the last comments and the project item's fields, plus the issue-dependency lookups board-dependencies already makes. It uses the same token as the other features (Issues and Projects read access) and no extra manifest permission.
- **Degrades gracefully.** Without a token, or when Projects data is unavailable, the board still gets the space reclaim and two DOM-only signals — a priority chip (a short `P0`–`P3`/`Critical`/`High`/`Medium`/`Low` label on the card) and a "Blocked" label — and the bar says why the other signals are missing. Cards without a field value simply show no chip for it.
- **Says what actually went wrong.** The background half returns a machine-readable `reason` with `signals: null` (`no-items`, `no-token`, `no-access`, `graphql-error`, `no-data`) and, for failures, the first error message and HTTP status. The bar blames the token ("the token may lack Projects access") only for HTTP 401/403 or a "Resource not accessible"-style error; any other failure shows "Board signals could not be loaded" with the detail in the tooltip and `console.warn`; a board with no cards yet shows the loading note, and a board with columns but no cards says it is empty. The batched GraphQL reads opt in to partial results, so an error on one card (an archived or inaccessible repository) no longer discards the other cards in its request: they still get signals and the bar says some cards could not be read.
- **Lane bands.** On a board grouped by a field, GitHub writes each lane band's sticky `top` from the height of the column-header row before Standup compacts it, which would leave the band displaced over the cards. While presenting, Standup sets that offset itself (the header row's sticky top plus its current height, re-measured on resize and when the row changes size) and makes a lane that scrolls sideways on its own `overflow: visible`, so the board's scroller moves every lane together and the bands can stick. Both are undone on exit.
- **No stale marks.** Badges are re-applied idempotently after board re-renders, and exiting (or turning the feature off, or leaving the Board view) removes everything it added.

## Known limitations

- The rules are heuristics over what a board exposes: a "blocked" status is recognized by a label or column name, and an explanation by keywords in the last few comments.
- The header and view-tabs chrome are hidden by matching GitHub's own class names by prefix; the title row, filter bar, View button and column headers are found by structure and visible text (the page's first heading, the filter input's label, a button reading "View", whatever precedes a column's first card). None of this could be checked against live github.com while building it, only against the fixtures in `test/e2e/fixtures/`; if a redesign moves an anchor, that part of the chrome simply stays visible (the board and signals still work).
- Like the other board features, it anchors on class-name fragments read off a live board's DOM (`boardContainer__`): the local name followed by `__` (current naming), with the old `Board-module__<name>…` form listed as a fallback. Columns are `[data-board-column]` frames (the older `.board-view-column` is still recognised), and a column with no visible heading is named after that attribute.
