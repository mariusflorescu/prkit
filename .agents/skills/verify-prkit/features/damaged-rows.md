# Damaged rows at startup

A stored row prkit can't read, because a newer prkit wrote it or it was damaged, fails alone. prkit starts, the item says what's wrong where the user meets it, and everything else works. A review whose state can't be read stops at a failed guide with Retry, its guide still readable. A fix whose state can't be read is left exactly as it was. A question, a tab or a list row that can't be read steps aside, and the server log says which and why. Nothing is deleted or restarted on the strength of a row prkit couldn't read.

## Sub-features

- `damaged-review` is a pull request's or a local review's `reviews.status` that isn't JSON or isn't a state prkit knows. Startup moves it to `failed(damaged)`: `alert "prkit couldn't read this guide's record"` with Retry above the guide, and `The guide couldn't be updated` in the status bar. Retry writes the guide again, a local review's on its latest run's snapshot. Nothing restarts it by itself.
- `damaged-attempt` is an unfinished attempt prkit can't read. It ends, its agent is left alone, and its review stops the same way.
- `damaged-fix` is a fix turn whose state prkit can't read. It stays as it was (quoted if it isn't JSON), and its pull request's Fixes tab says `prkit read a damaged fix record. Try again.` While it is unfinished, the fixes queued behind it wait, since its agent may still be in the checkout. A session whose own record can't be read keeps its checkout.
- `damaged-question` is a question that doesn't decode. It steps aside in the Ask dock and the review's other questions show.
- `damaged-tab` is an open tab row that doesn't decode. It steps aside, the other tabs open, and it stays stored until its pull request is opened again, which replaces it.
- `damaged-list-row` covers the review feed, the local reviews list, the watcher and the fix feed. Each leaves a row it can't read out and logs `Left out a stored row prkit can't read`.

## How to get to it (user POV)

- Launch prkit after a newer version wrote state this one doesn't know, or after a crash or an edit damaged a row. Then open the pull request, local review, Fixes tab or Ask dock the row belongs to.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/startup-damaged-rows.e2e.ts` starts its own instance on the fake GitHub with the stand-in Claude and `outsideGit`, so it needs no fixture repository or lock.

- **Setup.** Outside agents on, a local review from the CLI, guides for #4 and #6 from the Inbox row action, two answered questions on #6, a comment sent to the fix agent on #6 while `claude.hold()` keeps it running and a second one queued behind it, and tabs for #3 and #9.
- **Damage while closed.** `stopFakeInstance(..., { keepHome: true })`, then write the home's `prkit.sqlite` with `node:sqlite`: #4's and the local review's status `garbage`, #6's status a JSON state prkit doesn't know, #6's running fix turn status `garbage` (after `claude.release()`), the first question's scope `not json`, and #3's tab position `first`.
- **Start.** The instance starts and the Inbox lists every row. On main it doesn't start: the log ends in `SqlError ... malformed JSON` and `server exited (1)`.
- **Each item.** #4 and #6 show the alert with Retry, #6 with its r1 guide and only its second question; #6's Fixes tab shows the damaged fix record and its second fix is still queued; #3's tab is gone and #6 and #9 are still open; the local page shows the alert, and Retry makes it `Ready`; #4's Retry writes r2; a guide for #1 works.
- **Relaunch.** The damaged rows are stored as they were (the fix turn quoted), #6 is still stopped with no new attempt and its second fix still queued, the log names each, and opening #3 again stores its tab whole.
- **Proof.** `pnpm e2e run tests/startup-damaged-rows.e2e.ts --output .e2e/proof/<name>` saves `damaged-review` in light, dark and at 600 px, `damaged-review-with-guide` and `damaged-local-light`.

## Gotchas

- `open_pull_requests.key` is the target of `workspace.active_key`'s foreign key, and `node:sqlite` enforces foreign keys, so damage a tab's position, not its key.
- After a relaunch the app restores the last active tab, not the Inbox; wait for `link "Inbox"` before navigating.
- The local page's header shows the work tree's temporary path; crop it before filing a frame.
