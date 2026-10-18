# Review comments

Comments the user writes on a diff are prkit's own until the review is finished. GitHub's pending reviews are not used: a draft must survive restarts, and the next step is handing drafts to the user's agent instead of GitHub.

## Drafts

`pending_comments` holds one row per draft, keyed by PR and account. A draft has:

- an anchor: the path and the first and last diff row, each a side (`old` is GitHub's LEFT, `new` its RIGHT) and a line number as GitHub numbers it;
- the snippet: those diff rows as text, each with its `+`, `-` or space marker;
- the context: up to three rows above the first row and three below the last, inside their hunk, counting only rows on that end's side of the diff;
- the head commit of the diff it was written on;
- a state: `draft`, `published`, `sent-to-agent` or `resolved-by-agent`. A submitted review publishes its drafts. Sending drafts to the fix agent marks them `sent-to-agent`; Push marks those its fix addressed `resolved-by-agent` and gives the rest back as drafts ([fix-agent.md](./fix-agent.md)).

Line numbers go stale when commits land, and a snippet alone doesn't save a generic line. After a push, a lone `+}` or a blank line can read the same at the same number on a different line. So a draft is placed by its rows and the rows around them. `capture` in `packages/contracts/src/diffRows.ts` cuts both from the diff the user clicked, and it is the only way to build a placement, so adding and moving a draft both store fresh ones. `place` reads a draft against one diff at one head. When its rows and the rows around them read the same at its own numbers, it is kept. When they read the same in exactly one other place, it goes there and its card says `Moved` and the line it was written on. Anything else makes it outdated, and an outdated draft is never sent until the user puts it on a line. For an outdated draft, `place` also names the one place where the draft's own rows alone still read the same, if there is exactly one. That is the "Move to line N" or "Keep on line N" offer, and the user confirms it.

Only rows on the draft's own side count. A new line sits in the new file, and a deletion beside it says nothing about where that line is. An added line beside a removed one says nothing about the old file either. `place` compares only as many rows as the draft stored, so a hunk that grew doesn't outdate it. One case fails closed. A draft with no rows at all around it on its side (a file of a line or two) stays put only where nothing is around it now either, because otherwise its numbers alone would decide.

Placing writes nothing. The browser places drafts against the diff on screen to draw them. The server places them against GitHub's head before it posts a review, against GitHub's files when it sends drafts to the fix agent, and the same way for `list_review_comments`. All of them run the same `place`, so a draft on screen goes where a submission would post it. A moved draft keeps the lines it was written on, and says `Moved` on later heads too, until the user moves it. Editing a draft changes its words only. The diff on screen can be a guide revision for an older head, or the previous head while the new one loads, and its lines would tie the draft to code the PR moved past.

Drafts written before prkit kept the context have none (`context` is NULL). Such a draft is placed by its own rows only on the head it was written on, and only on the new side. The same head means the same new file, so line N is still the line the user clicked. The old side is the merge base, which can change under the same head when a stack's lower layer merges or the base is retargeted. Anywhere else the draft is outdated with copy of its own, because without its neighbours prkit can't tell one `}` from another, and GitHub doesn't serve an older head's diff to recover them. Confirming the offered line or picking a new one stores fresh lines, and it is an ordinary draft from then on.

## Drafts from guide notes

A question or risk note on the Guide tab can start a draft. The composer opens under the note holding the note's words, and nothing is stored until the user adds it. A plain note explains the change to the reviewer, so it has no such action.

The draft keeps a `note_key`, the note's file, side, diff row and words as `noteKey` in `packages/contracts/src/diffRows.ts` builds it. It names the remark, not the revision, so a later revision with the same words on the same code finds the draft and the note says what became of it. New code under the note, or new words, is a new remark. A note makes one draft in any state, published and fixed ones included, so the same remark never posts twice; deleting the draft frees the note. The check runs under the PR's semaphore and a partial unique index backs it. A second window's add gets an error, not the list, so the words in its field stay.

A note is numbered by its revision's local diff, which can be for an older head than GitHub's. `reviewComments.addFromNote` takes where the note is and the user's words, never a placement. The server finds the note, captures it on its revision's diff, reads GitHub's head and files as a submission does, and places it there like any draft. A note that would be outdated there is refused. The browser runs the same two functions on the click, so a line that changed is refused before anyone types, but the server's run is the one stored, at GitHub's head, and the draft is an ordinary one from then on.

While a note's composer is open, the Guide tab keeps that revision on screen, so a revision the watcher accepts meanwhile doesn't remount the diff and take the user's words. Once it closes, the tab follows the newest revision again. Leaving the Guide tab closes a note's composer, because its words go with the tab and the hold would protect nothing.

## Finishing a review

`ReviewComments.submit` reads the PR's files at its current head, places every draft, and posts the kept and moved ones as one REST review (`POST /pulls/{n}/reviews`) with `commit_id` set to that head, each on the lines `place` found. GitHub takes or refuses the review whole. Outdated drafts stay drafts. The result counts them, and the posted drafts that went where their lines moved. If every draft is outdated and there is no summary, the submission is refused before anything is sent.

A crash between sending and recording must not post a review twice. Before sending, a `review_submissions` row is written and the drafts it carries get its `submission_id`, in one transaction. The send and the recording of its result are uninterruptible, so a caller going away cannot strand one. A submission row without a GitHub review id that is found while the PR's gate is free was cut off by a crash: the account's reviews on the PR are read, and a review by that login with the same verdict and body, submitted after the row started (minus ten minutes of clock skew), publishes its drafts. Otherwise the drafts are offered again.

All draft writes, submissions and reconciliation for one PR and account go through one semaphore.

## Review threads

Threads are read with GraphQL through the PR's bound account, with the head GitHub numbered them against. The web places a thread only on a diff of that head, and reads the threads again when the diff moves on; on an older guide revision no threads are shown. A reply or a resolve first checks that the thread is one of this PR's, so a thread id from elsewhere can never be written through this PR's account.

## Writing on a diff

Pierre draws the diff in a shadow root and shows prkit's annotations, comment fields included, through slots it adds on its next render. A field mounted by React has no box until then, so `autoFocus` finds nothing to focus; `CommentForm` takes focus once the field has a box. Pierre has no keyboard handling, so `lineKeys.ts` adds it after each render: each gutter of line numbers is one tab stop, and its keys call the same `onSelect` as a click on the comment button. Assistive tech presses a line number with a click that has no pointer behind it (`detail` 0), which comments like Enter; a mouse click, `detail` 1 or more, is Pierre's line selection. A redraw (highlighting landing, a push, new comments) replaces every gutter node, so the line that had focus gets it back after the redraw.

A push must not cost the user a comment half written. The Files tab keeps the files it shows while the new head's files load, for the same PR and account only, and a file card remounts when the base moves, not the head. With the same base, a file whose patch is unchanged is the same file; a base move can change the lines around a hunk, which expanded context would show stale.
