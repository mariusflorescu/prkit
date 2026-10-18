# Author pre-flight

On a pull request the reading account opened, the guide gets a short pre-flight that only that author sees, under "Before you ask for review": what a reviewer will probably ask, where the description and the code disagree ("Not in the description", "Not in the code", "Says otherwise", each claim with the description's own words), and tests that look missing. Every point opens its evidence: its chapter, and its `file:line` when it has one. An empty pre-flight says "Nothing to flag". From there the author can update the description from the accepted guide: prkit drafts it (the guide's section added after their text, or in place of it), shows the change as a diff, lets them edit the Markdown, and writes only on Save, through the pull request's own account, with the title left alone. The success toast's Undo writes the old text back. Someone else's pull request gets no pre-flight and no description action.

## Sub-features

- `preflight-section` - the section after the Risk card and the summary, its three lists, "Nothing to flag", and the note when the description changed since the guide or there is none.
- `preflight-evidence` - each point's "Open <chapter>" and `file:line` chip; a missing test's file with its counts.
- `description-update` - "Update the description from the guide" (or "Write the description from the guide" when there is none): Add a section / Replace it, Changes / Edit, Cancel, Save to GitHub, Retry, Undo.
- `preflight-agent` - real Claude on an own PR whose description leaves a change out and claims one nothing does, and on someone else's PR (`agent` tag).

## How to get to it (user POV)

- Open the Guide tab of a pull request you opened, after a guide was written: the section follows the summary.
- In the section, "Update the description from the guide".

## Driving it with e2e

Preconditions: `pnpm build`. `tests/author-preflight.e2e.ts` reads only the fake GitHub (`startFakeGitHub`, PR 9 backed by `cliFixture`), so it needs no fixture lock. `fake.describe(9, { author, body })` sets who opened PR 9 and its description; the fake account is `budget-test`.

- **The section and its evidence.** The stand-in agent (`setUpFakeClaude`) sends the JSON `claude.preflight(...)` holds when the prompt asks for a pre-flight, `{}` without one. The journey checks the prompt, the stored `preflight`, the lists (`region "Before you ask for review"`, `list "Reviewers will probably ask"`, `list "The description and the code"`, `list "Tests that look missing"`), opens a missing test's `file:line`, takes `preflight-wide` and `preflight-narrow` (720 px) in light and dark, and relaunches with `--keep-home`.
- **Someone else's pull request.** PR 9 opened by `outsider`: no pre-flight sentence in the prompt, `preflight` stored as null, no section and no description action.
- **The description update.** `form "Update the description"`. Cancel writes nothing. Edit shows the draft (`textbox "Description"`), Replace it swaps it, an edit holds the mode. A description changed on GitHub meanwhile is refused with "The description changed on GitHub after prkit read it..." and nothing written. `fake.fail("rest:pull-edit", 1, 422, "Validation Failed")` is refused and changes nothing on the fake; the text stays, Retry saves. `fake.writes()` holds exactly `PATCH pulls/9` with only `body`. Undo writes the old text back. Screenshots `description-changes`, `description-edit` (light and dark), `description-refused`, `description-saved`, `description-narrow`.
- **Real Claude.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/author-preflight.e2e.ts --tag agent` writes two guides on PR 9. On the own PR the stored pre-flight has a `missing-from-description` point and a claim quoting the trimming the description promises; on `outsider`'s it has none. It prints the stored pre-flight.

## Gotchas

- "Shown only to the author" is two checks: the attempt froze whether the reading account opened the PR (`config.preflight`), and the Guide tab shows the section only while the PR's author is the reading account.
- The description's diff renders inside the diff component's shadow root: assert on the Edit textarea and on `fake.writes()`, not on the diff text.
- The agent journeys spend the Claude subscription, about five minutes each.
