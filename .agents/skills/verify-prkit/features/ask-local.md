# Ask about local changes

A local review's page (`/local/$key`) has the same Ask dock as a PR's Guide tab (see [ask.md](./ask.md)), worded for the user's own changes: the dock is `region "Ask about these changes"`, the whole scope's chip reads `All changes`, and the empty history reads `Ask the agent that wrote this guide. It already read all of these changes.` Nothing on the page says "pull request". The guide's agent answers in a read-only fork of the guide's session, in its own checkout of the revision's snapshot under `<home>/asks/`, never in the user's work tree. Since a local review has no review comments, picking lines in a chapter's diff goes straight into the dock.

## Sub-features

- `dock`, `cards`, `links`, `pins` and `states` read as in [ask.md](./ask.md), with the local words above. The chip's remove button is `button "Ask about all the changes instead"`. A draft being written (the switcher's draft entry) shows no dock, pins or chapter button.
- `lines` are picked by a drag across line numbers, the hover button `button "Ask about this line"` (`[data-ask-line-button]`, in the diff card's light DOM), or Enter/Space on a focused line number, whose gutter label reads `Ask about line N` / `Ask about old line N`. The dock opens on `<path> <start>-<end>` with focus in the field, and those lines stay highlighted (`[data-selected-line]` in the diff's shadow root) while they are the dock's scope. Opening the dock shrinks the guide's scroll area, and the lines stay in view as in ask.md's `lines in view`. While lines are picked, Pierre keeps the hover Ask button on their last line, so hovering another line doesn't move it; a tap on that line's number picks it instead. A range outside one hunk toasts `Pick lines inside one part of the diff` and leaves the dock alone.
- `outside` is five tools on the local target (`key`, or `path` + `branch`): `read_local_questions`, `wait_for_local_question` (waits for the named question), `ask_about_local_changes` (with `clientRequestId`), `stop_local_question`, `pin_local_answer`; and `prkit local questions list|wait|ask|stop|pin` from the repository folder. A question asked there shows `Asked by prkit CLI` in the dock.
- `removal` of the local review deletes its questions, and an answer being written stops: its agent's process exits and its `asks/` folders go.

## How to get to it (user POV)

- Start a local guide from a repository folder (`prkit local guide`), open its tab, and click the question field at the bottom.
- Click `Ask about this chapter` under a chapter's narration.
- Drag across line numbers in a chapter's diff, or hover a line number and click its Ask button.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/ask-local.e2e.ts` uses the fake GitHub only (local reviews read none of it), the stand-in Claude and `tests/localRepoFixture.ts`, so it spends no subscription and needs no fixture lock.
- Outside agents at Read and start work (`switchOn` in `tests/localGuideSession.ts`), since local guides start from the CLI.
- The instance launches with `CLAUDE_CONFIG_DIR=<fake home>/.claude`, so the stand-in saves sessions and answers fork them.
- The fixture's `*.ts` clean filter leaves `src/limits.ts` and `src/flags.ts` out of the snapshot. Pick lines in `docs/handbook.md`, which the journey changes on lines 15 and 16.
- `claude.writingAnswers(true)` has the stand-in write `made-by-agent.txt` where it runs and `git add` it, as an agent past every guard would.

- **Ask, stream, link, chapter, lines, stop, fail, pin.** As in ask.md, on the local page. `claude.runs()` records each turn's `cwd`, which starts with `<home>/asks/checkouts/`.
- **Lines in view.** `tests/ask-dock-lines.e2e.ts` picks `docs/handbook.md` 15-16 as ask.md's **Lines in view** does, on the local page, and checks that a tap on line 18's number, with 15-16 picked, makes line 18 the scope and moves the Ask button there. It runs the placements again in split view on a pick from old line 16 to new line 15 (chip `docs/handbook.md old 16-15`), whose start sits below its end.
- **Containment.** With `writingAnswers(true)`, ask: the card reads `It wrote made-by-agent.txt and staged it.`, yet `fixture.fingerprint()` (every file of `.git`) and `fixture.workTree()` (every file outside it) are unchanged, `made-by-agent.txt` isn't in the repository, and the repository's filter never ran.
- **CLI.** `prkit local questions list --json` lists every question with its scope (`local-changes`, `chapter`, `lines`); `ask --question ... --request-id cli-1 --json` twice returns the same `questionId`; `wait --question-id <id> --timeout 120 --json` returns `finished: true` with the answer; `pin --pinned true|false` shows and hides the pin in the open page.
- **Relaunch.** Stop the instance with `keepHome: true` (the dock says `Couldn't keep your questions up to date`), start it again, open `/local/<key>`: pins and every card are back.
- **New revision.** Change the handbook and `prkit local guide`: r2 lands, earlier cards read `Asked on r1`, and their link switches back to r1 and focuses the line.
- **Removal.** Hold an answer, Remove the local review from `More local review actions`: the answer's `agent_pid` exits, `<home>/asks/` is empty, `ask_questions` is empty.
- **Waiting.** `claude.hold()`, start guides of two other repositories until both attempts have an `agent_pid`, then ask on the first: the card reads the waiting copy with Stop, and answers after `claude.release()`.
- **Journey.** `pnpm e2e run tests/ask-local.e2e.ts` copies its frames to `.e2e/evidence/ask-local/` (`01-dock-closed` to `22-waited-answered`, `13-dock-light`/`-dark`, `14-narrow-900`, `15-narrow-720`) with `cli-transcript.txt`.
- **Real agents.** `tests/ask-local-agents.e2e.ts` writes a real guide of a small shop's committed and uncommitted changes, then asks at each scope, follows a link, stops a walkthrough, asks the agent to write and stage `made-by-agent.txt`, pins and relaunches. It passes only when prkit refused the write (`canUseTool ... decision: 'deny'` for Claude, `Codex approval ... decision: 'decline'` for Codex, in the instance log), the repository's `.git` and work tree are unchanged, the guide's session file has the same sha256, and every answer has its own session. It runs an instance with the owner's own HOME (`startInstance`), since on the fake GitHub the server's HOME is the fake's and prkit would look for the guide's Claude session in the wrong folder, so every answer would start a new session. It touches no fixture repository, so it needs no fixture lock: `PRKIT_E2E_AGENT=1 pnpm e2e run tests/ask-local-agents.e2e.ts --tag agent`, then separately `PRKIT_E2E_CODEX=1 ... --tag codex`. Frames and `<agent>-evidence.txt` go to `.e2e/evidence/ask-local-agents/`.

## Gotchas

- The page header shows the repository's folder (a `/private/var/folders/...` temp path in journeys): crop the top ~122 px of a 1280 px frame before filing it.
- Run without `--output`, as for ask.md.
