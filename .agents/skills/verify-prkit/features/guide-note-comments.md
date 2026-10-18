# Guide note comments

On the Guide tab, every question and risk line note in a chapter's diff has an `Add as comment` button. It opens the usual inline composer under the note, holding the note's words with the caret at the end and one muted line, "Starts as the guide's note. Edit it before you add it." Nothing is stored until the user adds it, and nothing reaches GitHub until the review is finished. Once a note has made a draft, the button gives way to a status line that follows the draft: "In your review.", "With the agent.", "Posted on GitHub." or "Fixed by the agent." A note on a revision written for an older head lands where its code is now, says so, or is refused with a toast; it never lands on a line that only looks like its own. How placement and the one-draft-per-note rule work is in [review-comments.md](../../../../docs/internals/review-comments.md).

## Sub-features

- `note-action` puts `button "Add as comment, question on line 3"` (`risk on old line 2` on the old side) under question and risk notes. Plain notes have none. While the click reads GitHub's files the button reads `Checking...`; a failed read toasts `Couldn't read the latest code` with the server's words and the button stays ready.
- `note-composer` opens `textbox "Comment on line 3"` under the note, prefilled and focused. Escape or Cancel stores nothing. `Add review comment` or Cmd+Enter adds the draft, whose card shows under the note as `article "Pending comment on src/limits.ts line 3"`.
- `note-status` replaces the button with `status` text once a draft exists, in any state, across reloads, restarts and later revisions that keep the same words on the same code. New code under a note, or new words, gets the button again. Deleting the draft brings the button back.
- `note-duplicate` refuses a second add of the same note, from another window or after a lost answer, with `You already added this note to your review.` under the field. The field keeps its words, and the note shows its status.
- `note-moved` places a note on a revision for an older head against GitHub's diff now. It lands in place when the note's row and three rows on each side read the same, at the one other place they read the same (`textbox "Comment on line 7, where this line is now"`, then `In your review, on line 7 of the latest code.`), or nowhere, with the toast `This line changed after the guide was written`. A file GitHub shows no diff for toasts `GitHub shows no diff for this file now`. The browser's check on the click is a courtesy; the server places the note again on Add, at GitHub's head, so a push between the click and Add gets `This line changed after the guide was written. ...` under the field, with the words kept and nothing stored.
- `note-held` keeps the Guide tab on the composer's revision while a note's comment is being written, so a revision the watcher accepts meanwhile doesn't wipe the words. After the add, the tab shows the newest revision. Leaving the Guide tab closes a note's composer, since its words go with the tab, so coming back shows the newest revision and the button.

## How to get to it (user POV)

- Open a PR with a guide, choose `Guide`, open a chapter, and click `Add as comment` under a question or risk note.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. The journeys start their own instances on the fake GitHub (`tests/fakeGitHub.ts`) with the stand-in Claude (`tests/fakeClaude.ts`) and the local git fixture (`tests/outsideGit.ts`), so they need no fixture repository and spend no subscription.
- `claude.notes({ "src/limits.ts": [{ line, side, tone, text }] })` makes the stand-in's next guides carry those notes. `fake.gitHead(9, git.head(9))` makes GitHub's head the local one, so the guide is current. A journey that moves the code commits with `git.commit(9, { path: content })`, serves `fake.files(9, [...])` built from `git.patch(9, path)`, then posts `fake.gitHead`.

- **Add.** In `[data-path="src/limits.ts"] [data-guide-note][data-tone="question"]` filtered by the note's words, tap `button "Add as comment, question on line 3"`. `textbox "Comment on line 3"` has the note's words and focus. Edit the words and tap `button "Add review comment"`. The note's `status` reads `In your review.` and `sqlite3 -readonly <home>/prkit.sqlite "SELECT end_line, body, note_key FROM pending_comments"` shows the row with a key.
- **Escape.** Open a risk's composer and press Escape. No row is added.
- **Persist.** `browser.reload()`, or `stopFakeInstance(name, { keepHome: true })` and start again. The status lines stay the same.
- **Submit.** `button "Review, 2 pending"` > `button "Submit review"`. `fake.writes()` holds one `POST pulls/9/reviews` with each comment on its line and side (`RIGHT` for a question on an added line, `LEFT` for a risk on a deleted one) and the edited words. The notes read `Posted on GitHub.`
- **Second window.** Open the composer in the e2e page, then add the same note from a Playwright page of its own on the same `openUrl`. Adding in the e2e page shows the refusal under the field, keeps the words, and the note reads `In your review.` Press Escape and tap `button "Delete pending comment"` on the card. The button comes back. Open the composer again, go to Files and back: the composer is gone and the button is ready. Open it once more, fill it, commit a change to the noted line (`git.commit`, `fake.files`, `fake.gitHead`), and tap `Add review comment`: the server's refusal shows under the field, the words stay, and no row is added.
- **Older head.** Hold the stand-in, push code with four lines above and one noted line changed, and wait for Files to show the new stat. On revision 1, the risk lands in place, the changed line toasts, a `+}` note lands on its own `}` four lines down and never on the `}` now at its old numbers, the `src/change-0.ts` note toasts the no-diff text, and the moved question's composer names its new line. Release the stand-in while that composer holds edited words. Revision 2 lands in `review_revisions`, `combobox "Guide revision"` still reads `r1 · ` and the words are intact. After the add it reads `r2 · `.
- **Journey.** `pnpm e2e run tests/guide-note-comments.e2e.ts --trace=on --video=on` runs all four: add, edit, persist and submit; the second window; the older head; a new revision after an unrelated push. Each saves light and dark frames (`button`, `prefilled-composer`, `prefilled-composer-narrow`, `status-lines`, `posted`, `duplicate-refused`, `changed-line-toast`, `moved-composer`, `held-revision`, `revision-2`, `moved-status`, `revision-2-posted`).

## Gotchas

- e2e's roles have no `note`, so the journeys find a note by `[data-guide-note][data-tone]` under its file's `[data-path]` and filter by its words.
- Chapter diffs sit below the fold with `content-visibility: auto`, which reads as empty text until the note is scrolled into view (`scrollIntoView()` first).
- A diff's lines live in Pierre's shadow root, so a file card's `toContainText` sees only its header. Wait for a moved head by the card's stat (`+14 -1`), not by a line of code.
- The files cache follows the PR's head. Post `fake.files` before `fake.gitHead`, or the first read of the new head can get the old files.
- The success and warning toasts last five seconds; take a screenshot of one right after it appears.
