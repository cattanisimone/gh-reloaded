# Project notes for Claude

## Keep docs in sync with features

When a feature is added or its behavior changes, update `README.md`'s description of it in the same pass, not as a follow-up — the "Features" section is the source of truth for what each one does and what permissions it needs.

Also refresh the feature's mockup screenshot under `screenshots/` when the change is visible (new UI element, moved/restyled control, different layout) — a stale screenshot is worse than no screenshot, since it actively misleads. Screenshots are mockups illustrating layout and colors, not literal captures (see the note at the top of the README's Features section) — regenerate them in the same style rather than trying to capture a real page.

See `CONTRIBUTING.md` for the shape a feature takes.
