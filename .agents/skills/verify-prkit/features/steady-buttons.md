# Steady buttons

A button whose words change with what it is doing (Save, Saving…, Retry) keeps one size the whole time, so nothing beside it moves while a save waits or after it fails. Every such button, about forty of them, puts its words in `ButtonLabel` (`apps/web/src/components/ui/button-label.tsx`): all of them sit in one grid cell, only the shown one is painted, and the button's name is the shown words alone.

## Sub-features

- `settings-save` is Settings > Guides > Global guidance: `Save guidance` reads `Saving…` while the save waits, and `Discard` beside it stays put before, during and after a failed save.
- `fixes-push` is a ready fix on the Fixes tab: `Push` reads `Pushing…`, and `Ask the agent to change`, `Copy patch` and `Discard` stay put.
- `local-remove` is a local review's Remove dialog: `Remove` reads `Removing…`, then `Try again` after a failure, with the error below the buttons, and `Cancel` stays put through all three.

## How to get to it (user POV)

- Press any button that saves, sends, stops or removes something, and watch its neighbours while it works and after it fails.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/steady-buttons.e2e.ts` starts its own instances on the fake GitHub (the Fixes test with the stand-in Claude and `outsideGit`, the local review through the CLI), so it needs no fixture repository or lock.

- **Hold a save.** `holdWrites(home)` (`tests/sqliteFaults.ts`) takes SQLite's write lock from the test, so the tapped button's save waits in flight. prkit's 5 second busy timeout then fails it, and the alert says why.
- **Measure.** `rowOf` reads the box of every button in the pressed button's row, found by a neighbour whose words never change. The journey waits for running animations to end (the dialog opens with a scale), then reads the row before the tap, while the pending words show, and after the failure. All three must be equal.
- **Honest words.** While pending, `getByRole("button", <pending words>)` is disabled and `getByRole("button", <idle words>)` finds nothing: the reserved words are not read out.
- **Themes and widths.** Each test runs the held save in light at its window width, then again in dark at 760 px, where rows wrap, from the failed state, which also checks a retry.
- **Proof.** `pnpm e2e run tests/steady-buttons.e2e.ts --output .e2e/proof/<name>` saves `<test>-<light|narrow-dark>-<before|pending|failed>` for each test. For a main frame, build main's `apps/web` and run the same journey: it fails on the first comparison and keeps the frames taken before it.

## Gotchas

- While the test holds the write lock, prkit's server waits in SQLite and answers nothing, for up to 5 seconds. Read only the page then.
- The local review page's header shows the work tree's temporary path; crop it before filing a frame. The dialog frames don't show it.
