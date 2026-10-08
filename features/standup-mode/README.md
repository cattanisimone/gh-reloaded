# Standup mode

On a GitHub Projects **Board** (kanban) view, adds a **Standup** button to the view-tabs bar that turns the board into a compact, screen-sharing-friendly presentation of the whole board — and flags the cards a standup should talk about.

On by default; switchable from Settings. The button only appears on Board views — switch to a Table or Roadmap view and it withdraws itself.

![Standup mode mockup](../../screenshots/standup-mode.svg)

_Mockup illustrating the layout — not a literal screenshot._

## What it does

- **Reclaims space.** While presenting, GitHub's global header, the project's header actions and the view-tabs bar are hidden and a slim bar (project name, view name, signal summary, **Exit**) takes their place. When the Full-width board feature is off the columns are also fitted to the window width; when it is on, that feature owns the width and standup mode stays out of its way.
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
- **No stale marks.** Badges are re-applied idempotently after board re-renders, and exiting (or turning the feature off, or leaving the Board view) removes everything it added.

## Known limitations

- The rules are heuristics over what a board exposes: a "blocked" status is recognized by a label or column name, and an explanation by keywords in the last few comments.
- The header, view-tabs and filter chrome are hidden by matching GitHub's own class names by prefix; if a redesign renames them, the chrome simply stays visible (the board and signals still work).
- Like the other board features, it anchors on class-name prefixes read off a live board's DOM (`Board-module__boardContainer`, `board-view-column`, `view-navigation-module__ViewNavigationContainer`).
