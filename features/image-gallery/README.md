# Image gallery

Browse the images of the current folder in a lightbox from a repository image file page. The user-facing description lives in the root README's Features section.

- `model.js` — pure rules (routes, supported extensions, the folder set, listing-state precedence, wording, href encoding), shared with the unit tests.
- `content.js` — the Gallery button and its notice in the file header, the lightbox, keyboard handling, SPA navigation and cleanup.
- `content.css` — Primer-native button and a light/dark lightbox, a full-screen sheet at 767px and below.
- `../../background/image-gallery.js` — the `GHIG_LIST`, `GHIG_PROBE`, `GHIG_SUPPRESS` and `GHIG_CONSUME` messages (Contents API through the shared client, and the memory-only one-navigation suppression).

Settings keys: `ghigEnabled` and `ghigAutoOpen`, both on by default. Tests: `test/unit/image-gallery-*.test.js`, `test/e2e/image-gallery*.spec.js`.
