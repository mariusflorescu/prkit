# Review watcher

A review stays awake until its PR is done. The server's watcher reads every running or watching review every 60 seconds, and every failed one every 15 minutes, through the review's own account. When new commits land on a watched PR, prkit writes the next guide revision by itself: the Guide tab keeps the last guide readable under a status bar that says what is happening, and a revision switcher shows every revision with its head and trigger. A force-push gets a fresh guide (`rewritten`). Pushes during an update collapse into one follow-up. When the PR is merged or closed, the review ends: any running attempt stops, its checkout is removed, the revisions stay readable, and the review glyph shows a check.

## Sub-features

- `watch-tick` reads state, head and base of up to 50 PRs per GraphQL request, grouped by account; per-PR read problems show in the status bar and are retried next tick; a refused token after one re-read fails the review's account.
- `update-new-commits` starts an attempt with trigger `new-commits` when the head moved and descends from the last revision's head; the agent resumes its session and gets the commit list, the diff since that head, and the previous guide.
- `update-rewritten` starts a fresh guide (trigger `rewritten`) when the new head doesn't descend from the last revision's head.
- `update-collapse` waits for a running attempt to end before reading a newer head, so several pushes become one attempt.
- `update-bar` keeps the latest guide visible while updating: `Updating for N new commits`, `Rewritten history, writing a fresh guide`, `Writing the guide again`, the progress (`3 of 5 files`, `Writing chapter 2 of 3`), the elapsed time, a thin determinate bar and Stop. Once the update shares a draft, `combobox "Guide revision"` offers `rN · draft, being written` on top, which shows the draft until it is accepted. The agent's narration is the status line's title.
- `revision-switcher` picks any accepted revision (`r<n> · <sha> · <trigger>`); each renders with its own diff.
- `review-done` ends the review on merge or close: `PR merged · review closed` / `PR closed · review closed`, checkout removed, review check, the PR header read again.
- `review-glyph` on the open PR tab: idle dot while watching, spinner only while preparing or writing, check when done, warning when failed.

## How to get to it (user POV)

- Generate a guide on a PR (see [guide-generation.md](./guide-generation.md)), then change the PR on GitHub: push, force-push, close, reopen.
- The Guide tab's status bar (`status "Guide status"`) and switcher (`combobox "Guide revision"`); the review glyph on open PR tabs.

## Driving it with e2e

Preconditions:

- Everything [guide-generation.md](./guide-generation.md) needs, and the fixture PR open on GitHub.
- A short tick: `pnpm verify:app start --name <name> --detach --watch-interval 10000 --e2e` (sets `PRKIT_WATCH_INTERVAL_MS`). `e2e.config.ts` starts every run with `--watch-interval 5000`.
- The scripted journeys push through `gh api` to fixture PRs of their own (`createReviewFixture(stamp, "<journey>")` in `tests/reviewFixture.ts`) and close them, branch included, when they end. The steps still made by hand need a writable clone of `<fixture>` outside the repo's tracked files (for example `.e2e/fixture`). Push only to `feat/validate-and-count`; `backup/validate-and-count` holds its original head.

- **Watching.** After the first guide, `status "Guide status"` contains `Watching for new commits · checked just now`, `combobox "Guide revision"` reads `r1 · <sha> · first guide`, the row glyph is `[data-review-status="watching"]`.
- **New commits.** The journey `a push writes revision 2 within two ticks, and a force-push starts a fresh guide` taps `button "Generate guide"` on its own fixture PR, waits for `Watching for new commits` and `r1 · `, then commits a change to `src/limits.js` on the PR's branch (`pushOutdatingChange`). Within two ticks of the push (10 s at the 5 s e2e tick) the active tab is `[data-active-tab="true"] :is([data-review-status="preparing"], [data-review-status="writing"])`, then the status contains `Updating for 1 new commit` with `heading "Overview"` still showing r1. Then `Watching for new commits` again, the switcher reads `r2 · <sha> · new commits`, and the PR's attempts are `first`/`accepted` and `new-commits`/`accepted`. Push to running took 4.1 s; push to accepted r2 took 35 s with a 10 s tick.
- **Switch revisions.** Tap `combobox "Guide revision"`, then `option /^r1 · /`. The guide re-renders r1 with its own diff (the new commit's lines are absent).
- **Force-push.** The same journey then amends the head (`amendHead`: a commit with the head's tree and parent, force-moved onto the branch, like `git commit --amend` and `git push --force`). Within two ticks the tab is running again, the status contains `Rewritten history, writing a fresh guide`, and the PR's latest attempt is revision 3 with trigger `rewritten`. The journey taps `button "Stop"` there; the fresh guide itself is what the first guide's journeys prove. Force-push to running took 4.7 s. Its timings and attempts go to `.e2e/evidence/review-watcher/push-and-force-push.json`.
- **Collapse.** Push once, wait for `Updating for 1 new commit`, push twice more. After that attempt, exactly one more runs: `Updating for 2 new commits`.
- **Done.** `gh pr close 1 -R <fixture>`. Within two ticks the status contains `PR closed · review closed`, the active tab's glyph is `[data-review-status="done"]`, `button "Generate again"` is hidden, the review's `<home>/worktrees/<reviewId>` is gone and its `reviews.status` is `{"_tag":"done","reason":"closed"}`. `gh pr reopen ...`, tap `button "Refresh"`, then `button "Generate again"`: the status contains `Writing the guide again` over the old guide, then `Watching for new commits`.
- **Restart mid-writing.** The journey `a server killed while writing marks the attempt interrupted, and its restart writes the guide` starts an instance of its own (`startInstance("restart-<stamp>", ["--watch-interval", "5000", "--e2e"])`, no `--rm`), taps `button "Generate guide"` on its own fixture PR, waits for the first `li[data-kind="tool"]` in `log "Agent activity"` and reads the attempt's `agent_pid`. It sends SIGKILL to the run file's `serverPid`, waits for the supervisor to exit (the home stays), and starts the same name again. The guide then reads `Watching for new commits` and `r1 · `, the PR's attempts are `first`/`failed`/`interrupted` then `retry`/`accepted`, nothing is left in the old agent's process group, and the log's second `Reconciled reviews` line has `interrupted: 1, restarted: 1`. When the agent outlived its server (it did on the fixture), the log also has `Stopped an agent the previous run left behind`. Evidence: `.e2e/evidence/review-watcher/kill-and-restart.json`. By hand, the same during an update re-runs as `new-commits`, and a further restart logs zeros and changes no row.
- **Scripted.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/review-watcher.e2e.ts --tag agent --video=on --output .e2e/proof/<name>` runs the push and force-push journey, the kill and restart journey, and close, done, reopen and Generate again. The first two open and close fixture PRs of their own; the last closes and reopens fixture #1, and reopens it even when it fails. `--grep "a push writes"`, `--grep "a server killed"` or `--grep "a closed PR"` runs one.
- **Proof in the database.** `sqlite3 -readonly <home>/prkit.sqlite "select revision, trigger, commits, head_sha, outcome from review_attempts order by rowid; select status, watch_problem from reviews;"`. Accepted heads stay under `refs/prkit/<reviewId>/r<n>` in `<home>/repos/github.com/<fixture>.git`, rewritten ones included.

## Gotchas

- Every push or force-push spends the Claude subscription once. Restore the fixture at the end: `git push --force origin backup/validate-and-count:feat/validate-and-count` brings back the original head, or leave a meaningful diff and the PR open.
- The PR header's state is cached for ten minutes by the server. The Guide tab reads it again past that cache when a review ends or gains a revision; after a reopen, tap `Refresh` before looking for `Generate again`.
- A graceful stop folds the WAL into `prkit.sqlite` and leaves `prkit.sqlite-wal` empty, so the rest of this note is about a kill. `sqlite3 -readonly` can't open the database of a stopped instance, and `immutable=1` ignores a `prkit.sqlite-wal` the server left behind (after a kill and restart it held every row, and `immutable=1` saw no tables). Copy `<home>/prkit.sqlite*` to a temporary directory and open the copy.
- A watcher tick also reads failed reviews, but only to end them on merge or close; a new head on a failed review waits for Retry.
