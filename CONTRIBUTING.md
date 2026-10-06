# Contributing

Thanks for wanting to improve GH Reloaded. Issues and pull requests are welcome.

All the conventions for changing this codebase — the shape of a feature, the design rules, how docs stay in sync, the definition of done, and the git/PR workflow — live in one place: **[AGENTS.md](AGENTS.md)**. It's written to be read by both people and coding assistants, so this file doesn't repeat it.

## Filing an issue

**New issue** offers two forms:

- **Feature** — Why, Proposed MVP, Acceptance criteria, and optional Open questions / Later ideas.
- **Bug** — what's wrong, steps to reproduce, expected behavior, the affected feature, and optional investigation notes.

Blank issues are also allowed for anything that doesn't fit either form.

## Opening a pull request

Read [AGENTS.md](AGENTS.md) first — it has the branch naming, PR title, and one-issue-per-PR conventions, plus the definition of done. Opening a PR pre-fills the [template](.github/pull_request_template.md); work through its checklist before requesting review.

Three things worth calling out, because they drive the release automation ([Release Please](https://github.com/googleapis/release-please)):

- **PR titles are [Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, …), enforced by a check. The title is what sets the next version, so make it accurate.
- **PRs are squash-merged**, with the title as the commit message — so each PR becomes exactly one conventional commit on `main`.
- **Don't bump the version by hand.** Regular PRs never change `manifest.json`'s `version`; the bot keeps a release PR up to date with the next version and the changelog, and merging that PR is the release. See the README's [Releasing](README.md#releasing) section.

## Local testing

No build step — load the extension unpacked. See [AGENTS.md](AGENTS.md#local-testing) for the exact steps.

## Running the tests

One command runs everything — unit tests plus the Playwright end-to-end suite — with no GitHub token:

```
npm install
npx playwright install --with-deps chromium   # first time only
npm test
```

See [AGENTS.md](AGENTS.md#running-the-tests) for what the suites cover and how to run a subset.
