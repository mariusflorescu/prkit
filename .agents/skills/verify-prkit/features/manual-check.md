# How to check it

A guide says how a person sees the change working by hand: up to five steps, each with what to do and what they should see, and on at least one what to watch for, with an optional setup line and the chapter each step exercises. It is labelled as the agent's suggestion, since the agent read the code and ran nothing. A change with nothing to check by hand (a refactor, docs or tests alone) gets one quiet line with the reason. The reader ticks steps as they go; ticks live in prkit, survive a relaunch, carry into a new revision for every step whose action and expected result read the same, and never reach GitHub. Guides written before plans show nothing.

## Sub-features

- `manual-check-card` - the "How to check it" card on the Overview under the summary: the suggestion line, the setup line, numbered steps with "You should see" and "Watch for", each step's chapter number opening its chapter, and the "n of m checked" progress.
- `manual-check-ticks` - a checkbox per step (`Checked step <n>`), saved by the server, kept across a relaunch, carried into the next revision for unchanged steps, unticked for reworded ones, and kept per revision when you switch back.
- `manual-check-nothing` - "Nothing to check by hand." with the agent's reason, and no boxes.
- `manual-check-errors` - a refused save toasts "Couldn't save your tick" and leaves the box as it was; ticks that don't load show "Your ticks didn't load" with Retry and no boxes.
- `manual-check-outside` - `read_guide` and `read_guide_revision` (`prkit guide read`, `prkit guide revision`) carry the plan and `manualCheckTicked`; `tick_manual_check_steps` (`prkit guide tick --revision <n> --steps <n>`, `--no-ticked`) sets ticks by step number, and an open window follows it at once.
- `manual-check-agent` - real Claude writes concrete steps for the fixture pull request and nothing to check by hand for a refactor (`agent` tag).

## How to get to it (user POV)

- Open a pull request's Guide tab after a guide was written: the card sits under the summary and the before/after.

## Driving it with e2e

Preconditions: `pnpm build`.

- **Default journey.** `pnpm e2e run tests/manual-check.e2e.ts` reads only the fake GitHub (`startFakeGitHub`, PR 9 behind `outsideGit`), so it needs no fixture lock. The stand-in agent writes the plan `claude.manualCheck(...)` sets. It ticks step 1 (one row in `manual_check_ticks` for the account's subject), opens a step's chapter, relaunches with `--keep-home`, reads and ticks through the CLI (`guide read`, `guide tick`, again with nothing changed, `--no-ticked`, a step that doesn't exist), writes r2 with step 1 reworded only in its caution, step 2 reworded and a new step 3 ("1 of 3 checked"), switches to r1 ("All 2 checked"), refuses a save with a trigger, hides the table across a restart for the read error and Retry, checks the card at 640 wide, and writes r3 with nothing to check by hand. Screenshots `manual-check-*`, light and dark where it matters.
- **Real Claude.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/manual-check.e2e.ts --tag agent` runs two guides. The fixture one generates on `<fixture>#1` through the shared instance, so wrap it in the fixture lock; it checks 2 to 5 steps, chapters that are the guide's own, at least one "Watch for", steps that mention the stats or clicks and the rejected URL, and the prompt's `manual-check` section in the log, opens each step's chapter and ticks step 1. The refactor one (`--grep refactor`, fake GitHub, no lock) renames `addLink` and expects nothing to check by hand. Stored guides go to `.e2e/evidence/manual-check/`.

## Gotchas

- The tick follows a step's `action` and `expect`, whitespace aside. A reworded caution or chapter keeps it; any other rewording starts the step unticked. Two steps with the same action and expect are refused by validation.
- The agent journeys spend the Claude subscription, a few minutes each.
