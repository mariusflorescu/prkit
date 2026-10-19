# Local guides

A guide of a repository's changes before a pull request exists, asked for from a terminal or an outside agent. prkit snapshots the folder's working tree (the branch's commits since its base, plus staged, unstaged and untracked files) or a branch's last commit into a copy of its own, writes the guide with the review's agent, and never changes the repository, runs anything its config names, or reaches GitHub. In the app each local review has a tab after the PR tabs and a page at `/local/$key`; the CLI and the outside tools read them too.

## Sub-features

- `local.generate`: `prkit local guide` and `generate_local_guide`, from the working directory or `--path`, with `--branch`, `--base`, `--description`, `--regenerate` and the agent flags.
- `local.unchanged`: a run with nothing new since the latest revision answers `unchanged` and starts no agent.
- `local.refusals`: repository problems exit 1 with the catalogue's sentence before anything starts.
- `local.read`: `prkit local read`, `wait`, `list` and `stop`, by working directory, `--path`, `--branch` or `--key`.
- `local.restart`: a restart mid-attempt writes the guide from that attempt's own snapshot.
- `local.isolation`: no GitHub request or write, no change to the repository's `.git`, its clean filter never run, and the Inbox and `list_reviews` never show a local review.
- `local.tab`: `generate_local_guide` opens the review's tab without focus, after the PR tabs. The server keeps it (`open_local_reviews`), so a relaunch restores it; Remove drops the row with the review. Cmd+W and the tab's close button close it, Cmd+2..9 count PR tabs only.
- `local.page`: the header (folder and branch, "Local changes", base, head mode, folder, captured time, left-out files), progress, the guide with every revision's files openable in full, Run again (the agent picker in its popover), Stop, failed with Retry, Remove behind a confirmation, and the removed state at a stale link.
- `local.unreadable`: when prkit can't read a local review while its page is open, the page says so above what it read last (`alert "Couldn't read this local review"`, with prkit's words and Retry), keeps only a written guide, and offers no Run again, Stop or Retry of a run until it reads the review again. The tab shows the warning dot instead of the progress ring, and its tooltip says the same with a Retry. prkit tries again after 2 seconds, then less often, up to a minute apart.
- `local.palette`: the palette's "Local reviews" group, newest first, opening the tab.
- `local.scope`: the guide, its draft and its progress name the function, class, loop or branch above each hunk and show moved code, as a pull request's do. The new side comes from the review's own copy (`diffs.texts` with a `local` source), never the working tree.
- `local.notify`: "Guide ready" or "Guide updated" with `<name> · <branch> · N chapters` as a toast, and as a macOS notification whose click opens the page (`pnpm smoke:desktop`).

## How to get to it (user POV)

- A terminal inside a repository: `prkit local guide --description "..."`, then `prkit local wait` and `prkit local read`.
- Another folder: `prkit local guide --path <folder>`; a branch tip: `--branch <name>`.
- An outside MCP client: `generate_local_guide`, `wait_for_local_guide`, `read_local_guide`, `stop_local_guide`, `list_local_guides`.
- Settings (Cmd+,) > Outside agents must be on; starting and stopping need Read and start work.
- In the app: the local tab in the title bar strip, or the palette (Cmd+K) > Local reviews. Run again, Stop and the ⋯ menu's "Remove local review…" are in the page header.

## Driving it with e2e

Preconditions: `pnpm build`. The journey uses the fake GitHub and the stand-in Claude only, so it runs without the fixture lock: `pnpm e2e run tests/local-guides.e2e.ts`.

- **Setup:** the journey builds `tests/localRepoFixture.ts` in a temporary folder outside any repository, starts its own instance (`--claude <stand-in> --watch-interval 600000`), opens `screen.getByRole("switch", "Let my coding agents use prkit")` and `screen.getByRole("radio", "Read and start work")`, then resets the fake GitHub's stats.
- **First guide:** `prkit local guide --description ... --json` from the repository answers `started`; `prkit local wait` reaches `ready`, revision 1; `prkit local read --json` has the stand-in's summary, base `origin/main`, head `working-tree`. The attempt's saved snapshot (`review_attempts.snapshot`, read with `node:sqlite` read-only) is exactly `.gitattributes`, `src/limits.ts`, `src/retired.ts`; `src/flags.ts` and `src/limits.ts` are left out as `filtered`. The `.git` fingerprint is unchanged and the filter mark is absent.
- **Unchanged:** a second `prkit local guide` prints `Nothing changed since revision 1. The guide is current.` and the stand-in's `runs.log` gains no turn.
- **Next revision:** a new file, then `prkit local guide` from `src/`, gives the same key revision 2. `--branch feature/limits` gives revision 3 with head `branch`, nothing uncommitted, and only `src/limits.ts` in the snapshot.
- **Refusals:** a folder outside any repository, a repository with nothing changed, one with no base, and an orphan branch with `--base main` each exit 1 with the catalogue's sentence, and `prkit local list` still lists one review.
- **Access:** at `screen.getByRole("radio", "Read only")`, `prkit local guide` exits 4 and `prkit local read --json` exits 0.
- **Stop:** with the stand-in held (`claude.hold()`), `prkit local stop` prints `Stopped the guide of widgets · feature/limits. Its revisions stay readable.` and the review reads `stopped`.
- **Isolation:** the fake GitHub's request log is empty for the whole local block; `prkit guide list --json` and `prkit inbox --json` carry no `local:` key, and the Inbox shows no `widgets`. `fake.writes()` is empty at the end.
- **Restart:** with the stand-in held, a run starts, the instance stops (`stopFakeInstance` with `keepHome: true`), a file is added, and the instance starts again. The run finishes as revision 4; its interrupted attempt and the rerun carry the same capture `headSha`, the revision's head is that commit, and the added file is not in the snapshot.
- **Real Claude:** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/local-guides.e2e.ts --tag agent` writes a guide of a small discount change (one commit, two untracked files) with the user's Claude. It spends the subscription. The guide covers all three files, the repository's status is unchanged, and the fake GitHub saw no write. Transcripts go to `.e2e/evidence/local-guides/`.

### The tab and the page (`tests/local-guides-ui.e2e.ts`)

Fake GitHub and the stand-in Claude only, so no fixture lock: `pnpm e2e run tests/local-guides-ui.e2e.ts`. The fixture's `docs/handbook.md` gets one line changed in the middle, so its diff has unchanged lines to open.

- **Tab without focus:** with the stand-in held, `prkit local guide --json` from the repository; `screen.getByRole("link", "Open the local review of widgets · feature/limits")` appears while Settings > Appearance stays on screen.
- **Progress:** tapping the tab shows `screen.getByRole("heading", "widgets · feature/limits")`, the "Local changes" badge, `getByRole("status", "What the agent is doing")` with the stand-in's narration, and `getByRole("list", "Changed files")`.
- **Ready:** after `claude.release()`, the stand-in's summary, `getByRole("status", "Guide status")` saying Ready, "2 files left out of the snapshot", and no "watching" or "pull request" anywhere in `main`. `[data-path="docs/handbook.md"] [data-unmodified-lines]` loads `Line 1 of the handbook.` through `localReviews.fileContents`.
- **Run again:** `getByRole("button", "Run again")` with nothing new shows the toast "Nothing changed since revision 1" and adds no stand-in turn; after a change, `getByRole("combobox", "Guide revision")` reads `r2 · ...` and lists `r1 · first guide`.
- **Stop and failure:** held again, Run again, then the header's `Stop` makes the status line say Stopped. With `claude.failing(true)`, the alert "The agent stopped with an error" sits above the guide and its Retry brings Ready back.
- **Keys and palette:** Cmd+2 leaves the page alone (no PR tabs), Cmd+W closes the tab, Cmd+K and "widgets" list it under `getByRole("region", "Local reviews")`, and choosing it brings the tab back.
- **Relaunch:** `stopFakeInstance` with `keepHome: true` leaves one `open_local_reviews` row; the restarted instance shows the tab.
- **Toast:** from Settings > Appearance, a CLI run with a change raises "Guide updated" with `widgets · feature/limits · 1 chapter`, whose Open shows the page.
- **Remove:** ⋯ > "Remove local review…", then Remove in the `alertdialog`: the tab goes, the row goes, the palette shows no Local reviews group, and opening `/local/<key>` shows "This local review was removed" with Go to Inbox.
- **Evidence:** every frame is saved with `app.screenshot` and copied to `.e2e/evidence/local-guides-ui/` as `local-<state>-<theme>.png`, with the CLI transcript. It copies only this run's frames, from `.e2e/results` or from the `--output .e2e/proof/<name>` folder the run wrote them to. Frames avoid Settings > Outside agents and the Inbox footer, which print this machine's paths.

### A local review prkit can't read (`tests/local-review-feed.e2e.ts`)

Fake GitHub and the stand-in Claude only, so no fixture lock: `pnpm e2e run tests/local-review-feed.e2e.ts`. While the stand-in is held, the journey sets the run's `review_attempts.capture` to text that isn't JSON, then releases it: the run fails on the server, and the page's next read fails.

- **No guide yet:** `alert "Couldn't read this local review"` reads `prkit can't read this local review right now, because its record is damaged. Its run shows here again once it can.`, with no progress, no Stop and no Run again. The tab has `[data-guide-warning]` and no `[data-guide-progress]`, and its tooltip (`[role="tooltip"]`, on hover) says the same with Retry. Light, dark and 600 px.
- **Recovery:** with the record put back, the notice's Retry shows the failed run, whose own Retry writes the guide.
- **Under a guide:** held again, Run again after a change, the record damaged and the stand-in released. The guide stays, the notice adds "The guide below may be out of date until it can.", and there is no Stop, Run again, Retry of the run or "Writing" status. Put back, prkit's own next try clears the notice and shows the failed update.
- **Evidence:** `local-feed-failed-light`, `-dark`, `-narrow` and `-tab`, and `local-feed-stale-light` and `-dark`.

### Scope and moved code (`tests/local-diff-scope.e2e.ts`)

Fake GitHub and the stand-in Claude only, so no fixture lock: `pnpm e2e run tests/local-diff-scope.e2e.ts`. `localRepoFixture` takes the smarter-diff fixture's files (`tests/smarterDiffFixture.ts`): a long `Router` class changed in one line deep in `handle`, `normalizeUrl` moved into another file, and `formatRow` moved up its own file. The stand-in writes one chapter per file (`claude.split(true)`).

- **Scope:** on the page, `getByRole("region", "src/router.js")`'s separator reads `export class Router { › … › for (const route of this.routes) { › if (match) {` (`scopesOf` in `tests/diffRows.ts`), and its title names every opener.
- **Moved:** `src/report.js` has `button "Show src/report.js lines 1-6"` where `formatRow` landed.
- **Snapshot, not the working tree:** after the guide is written, the journey renames `handle` in the working tree and reloads. The separator still names `async handle(req, res) {`.
- **Evidence:** `local-scope-light`, `local-scope-dark`, `local-moved-light` and `local-moved-dark`.

### The snapshot is the change git shows (`tests/local-capture.e2e.ts`)

Fake GitHub and the stand-in Claude only, so no fixture lock: `pnpm e2e run tests/local-capture.e2e.ts`. Each repository is built in a scratch folder, guided once from the CLI, and its snapshot (`review_attempts.snapshot`) compared with what git shows the user: `git diff --name-status <merge base>` plus untracked files, read with optional locks off.

- **Read only:** around every run, the user's `.git/index` byte for byte, every entry of `.git` by size, mtime and mode, and every working file with its contents read the same before and after.
- **A plain branch:** a commit, then unstaged, staged, staged-then-edited, staged-then-undone, intent-to-add, deleted, untracked, ignored and executable changes. The snapshot is git's list exactly, and the staged-then-edited file carries its newest content.
- **Staged line endings:** CRLF files committed, then `.gitattributes` (`text=auto` and `text eol=lf`) and `git add --renormalize .`. The files on disk still hold HEAD's bytes; the snapshot has them modified, CRLF lines out and LF lines in. The same with `core.autocrlf=true` and no attributes.
- **Attributes and line endings from the index:** a CRLF file staged before `.gitattributes` (`text=auto`), the attributes staged, one file renormalized, then `.gitattributes` deleted from disk. The renormalized file is modified with LF and the staged one added with CRLF, as git shows them.
- **Executable bit with `core.fileMode` off:** `git update-index --chmod=+x` shows as `new mode 100755`.
- **A clean filter:** `git add --renormalize .` through a filter that leaves a mark. Alone, `prkit local guide` exits 1 naming the file and the filter; with a readable change too, the snapshot has only that change, the file is left out as `filtered`, and the mark is never made.
- **Evidence:** the CLI transcript at `.e2e/evidence/local-capture/cli-transcript.txt`.

## Gotchas

- Build every local repository outside the prkit checkout and outside the instance's home: a folder inside the checkout is read as prkit's own repository, and one inside the home is refused as prkit's checkout.
- The repository's `.gitattributes` names a filter for `*.ts`, so uncommitted `.ts` content is left out by design. Expect `filtered` entries, not a bug.
- `--branch` with the current branch names the same review as the working tree: the head mode is per run, not part of the key.
- Opening the Inbox revalidates GitHub reads. Take the request-log assertion before any Inbox navigation.
- Toast close buttons are outside the accessibility tree until the toast region is focused; the UI journey closes them through `[aria-label="Dismiss notification"]`.
