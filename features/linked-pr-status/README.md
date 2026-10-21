# Linked PR status

On a GitHub Projects **Board** view, an issue card with explicitly linked pull requests gets a thin status row: `PR #N` plus one text signal, or a neutral aggregate for several. A modal gives the details per PR.

![Linked PR status mockup](../../screenshots/linked-pr-status.svg)

_Mockup illustrating the layout and colors — not a literal screenshot._

## What it does

- Reads each visible issue's Development links (`closedByPullRequestsReferences`) through one aliased GraphQL query per 20 issues, only for cards near the viewport.
- Signal for an open PR: `Changes requested` > `Checks failed` > `Review pending` > `Checks pending` > `Approved`. Draft, merged and closed are neutral; unreadable data is `Status unavailable`. An open PR with no review or checks signal shows only the PR link, no chip. No "ready to merge" is ever shown.
- Row click, Enter or Space opens a `<dialog>`; the row never starts a card click, and a drag from the row still drags the card.
- With no token, a refused token or a rate limit, a dismissible hint (`role=status`) names the cause (Pull requests: Read) and opens Settings; the token hints are remembered once dismissed (`ghlpsHintDismissed`).
- Files: `signal.js` (pure rules, unit-tested), `content.js` / `content.css` (cards, row, dialog), `background/linked-pr-status.js` (GraphQL).

## Known limitations

- A pull request the token cannot read is not returned by GitHub, so it cannot be shown.
- The markup of GitHub's native *Linked pull requests* field on a card is detected by its label or a pull request link in the `Fields` list; it has not been verified on a signed-in board.
