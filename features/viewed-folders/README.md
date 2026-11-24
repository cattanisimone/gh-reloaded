# Viewed per folder

A read-only indicator at the right edge of every folder row of the file tree on the new **Files changed** page of a pull request: how many of the changed files below the folder you marked **Viewed** with GitHub's own checkbox. See the [README](../../README.md#viewed-per-folder--featuresviewed-folders--experimental) for what users see.

- `model.js` — pure rules, no DOM (`globalThis.GHVF_MODEL`): the route, counting by path prefix, the merge of the two sources of a file's state, the folder states and the exact copy of every variant. Unit-tested in `test/unit/viewed-folders-model.test.js`.
- `content.js` — finds the file tree (`role="tree"` named "File Tree"), remembers every file path it has shown (collapsing a folder unmounts its rows), reads GitHub's own "Viewed" buttons (`aria-pressed`) and the toolbar's "N of M files viewed", asks the background for the read, and renders. The indicator is the last child of the row's content element (the element the folder's `aria-labelledby` names); the class part `TreeViewItemContent` is the second choice only when that attribute gives no element, and no element means no indicator. Its text is the row's accessible description (our hidden node is added to GitHub's own `aria-describedby`), and a `MutationObserver` puts it back when React rewrites the attribute.
- `content.css` — the look, in Primer variables.
- `../../background/viewed-folders.js` — the read (`GHVF_FETCH`): the pull request's files with `viewerViewedState`, paginated, with the token mapped to the repository owner. No token, no request; any failure answers `{ files: null }` and the page falls back to the buttons.

Where a file's state comes from, newest wins: a button that changed after the read started beats the read, a button that was already there before it does not. A file neither source covers is unknown, and a folder with an unknown file never claims "all viewed" or "none viewed". The list of changed files is proven complete by the read, or by the tree's size matching the toolbar's total; otherwise every folder shows the dashed ring.

The extension never clicks a native control and never calls a write (`markFileAsViewed`) API.
