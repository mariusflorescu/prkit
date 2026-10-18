# Risk at a glance

A guide says how carefully to read the pull request and each chapter: low (nothing here needs a careful read), medium or high, never whether it is safe to merge. Every level comes with reasons, and every reason opens its evidence: a pull request reason opens the chapter that explains it and may open one line, a chapter reason opens one of the chapter's files or a line of it. Next to the level, "From the diff" shows prkit's own signals for the reviewed files (look-closely paths, migration, dependencies, CI config, fewer checks, no test files changed, large). "Always look closely at" paths are a guide setting at Global, Repository and pull request scope; a chapter holding a matching file is never rated low. Guides written before risk show none of it.

## Sub-features

- `risk-line` - the Risk card at the top of the Overview: level word with a three-dot meter, its meaning, the reasons, and the signal chips.
- `risk-evidence` - each reason's chapter number opens its chapter; its `file:line` chip selects the line; a chapter reason opens its file or line; a signal chip's popover opens each file.
- `risk-chips` - the quiet level chip on every roadmap row and chapter header, "Not reviewed" on prkit's skipped chapter.
- `look-closely` - "Always look closely at" paths at each scope, the composer's match preview, the signal and the medium floor.
- `risk-agent` - real Claude rates a docs-only change low, an ordinary feature medium and an auth change with a migration high (`agent` tag).

## How to get to it (user POV)

- Open a pull request's Guide tab after a guide was written: the Risk card is the first block of the Overview.
- Settings > Guides: the "Always look closely at" section at Global and for one repository.
- The guide setup (Guide tab before generating): the "Look closely: n files" chip in the settings line.

## Driving it with e2e

Preconditions: `pnpm build`. `tests/guide-risk.e2e.ts` reads only the fake GitHub (`startFakeGitHub`, PR 9 backed by `cliFixture`), so it needs no fixture lock.

- **Look-closely paths at every scope.** The default journey saves `src/auth/` in `screen.getByRole("form", "Global look-closely paths")` (`Add path`, textbox `Path 1`, `Save look-closely paths`), picks `budget/fixtures` and saves `db/migrations/` for the repository, then on PR 9's Guide opens the chip `getByRole("group", "Guide settings").getByRole("button", /^Look closely/)` ("Look closely: 2 files") and switches the inherited `db/migrations/` Off (`radiogroup "db/migrations/: inherit, on or off"`): "Look closely: 1 file". It seeds the fake's file list with `fake.files`, since the preview reads GitHub's list.
- **Signal and floor.** Generate with the stand-in agent (`setUpFakeClaude`), which writes `medium` when the prompt has a "- Look closely:" bullet. The attempt's `config.signals` is sensitive (with its rule and scope), migration and untested; `config.sensitive` records `db/migrations/` off at the pull request. The Risk card says `Risk: Medium`, and the `Look closely: 1 file` popover (`dialog "Look closely"`) opens `src/auth/session.ts`.
- **Real Claude.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/guide-risk.e2e.ts --tag agent` writes three guides on PR 9 (docs, feature, auth-migration; the last after a Global look-closely path) and checks the stored level, the signal tags, the prompt's `signals:` section, every reason's chapter (focus lands on `[data-chapter-id]`) and line (the gutter cell is selected), and every chapter reason, with screenshots `risk-<case>-overview`, `risk-<case>-chapter` (light and dark) and `risk-<case>-640`. The stored guides are kept in `.e2e/evidence/guide-risk/`.
- **DEV fixtures.** Levels, popovers, "Not reviewed", narrow widths and a revision stored before risk are covered without an agent in [Guide viewer](./guide-viewer.md).

## Gotchas

- The same `file:line` can be linked from the Risk card and from a chapter's reasons: scope the chip to its row (`lineOpener(screen, browser)(path, line, row)` in `tests/guideLines.ts`).
- The agent journeys spend the Claude subscription; three guides take about ten minutes. A session limit shows up as `failed` reviews with "You've hit your session limit" in the instance log: stop and rerun after the reset.
- Each journey stops its instance in `finally`; the WebSocket "connection refused" console lines that follow are from that teardown, not the app.
