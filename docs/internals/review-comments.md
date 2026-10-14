# Review comments

Comments the user writes on a diff are prkit's own until the review is finished. GitHub's pending reviews are not used: a draft must survive restarts, and the next step is handing drafts to the user's agent instead of GitHub.

## Drafts

`pending_comments` holds one row per draft, keyed by PR and account. A draft has:

- an anchor: the path and the first and last diff row, each a side (`old` is GitHub's LEFT, `new` its RIGHT) and a line number as GitHub numbers it;
- the snippet: those diff rows as text, each with its `+`, `-` or space marker;
- the head commit of the diff it was written on;
- a state: `draft`, `published`, `sent-to-agent` or `resolved-by-agent`. A submitted review publishes its drafts. Sending drafts to the fix agent marks them `sent-to-agent`; Push marks those its fix addressed `resolved-by-agent` and gives the rest back as drafts ([fix-agent.md](./fix-agent.md)).

Line numbers alone go stale when commits land, so a draft is placed by its rows, not its numbers. `anchorHolds` in `packages/contracts/src/diffRows.ts` says whether the anchor still reads the same snippet in a given patch. When it does not, the draft is outdated. `findSnippet` looks for the same rows elsewhere in the file, which is the "Move to line N" offer. The same functions run in the browser for display and on the server before posting, so both agree on what is outdated.

## Finishing a review

`ReviewComments.submit` reads the PR's files at its current head, keeps the drafts whose anchors hold, and posts them as one REST review (`POST /pulls/{n}/reviews`) with `commit_id` set to that head. GitHub takes or refuses the review whole. Outdated drafts stay drafts and the result says how many. If every draft is outdated and there is no summary, the submission is refused before anything is sent.

A crash between sending and recording must not post a review twice. Before sending, a `review_submissions` row is written and the drafts it carries get its `submission_id`, in one transaction. The send and the recording of its result are uninterruptible, so a caller going away cannot strand one. A submission row without a GitHub review id that is found while the PR's gate is free was cut off by a crash: the account's reviews on the PR are read, and a review by that login with the same verdict and body, submitted after the row started (minus ten minutes of clock skew), publishes its drafts. Otherwise the drafts are offered again.

All draft writes, submissions and reconciliation for one PR and account go through one semaphore.

## Review threads

Threads are read with GraphQL through the PR's bound account, with the head GitHub numbered them against. The web places a thread only on a diff of that head, and reads the threads again when the diff moves on; on an older guide revision no threads are shown. A reply or a resolve first checks that the thread is one of this PR's, so a thread id from elsewhere can never be written through this PR's account.

## Writing on a diff

Pierre draws the diff in a shadow root and shows prkit's annotations, comment fields included, through slots it adds on its next render. A field mounted by React has no box until then, so `autoFocus` finds nothing to focus; `CommentForm` takes focus once the field has a box. Pierre has no keyboard handling, so `lineKeys.ts` adds it after each render: each gutter of line numbers is one tab stop, and its keys call the same `onSelect` as a click on the comment button. Assistive tech presses a line number with a click that has no pointer behind it (`detail` 0), which comments like Enter; a mouse click, `detail` 1 or more, is Pierre's line selection. A redraw (highlighting landing, a push, new comments) replaces every gutter node, so the line that had focus gets it back after the redraw.

A push must not cost the user a comment half written. The Files tab keeps the files it shows while the new head's files load, for the same PR and account only, and a file card remounts when the base moves, not the head. With the same base, a file whose patch is unchanged is the same file; a base move can change the lines around a hunk, which expanded context would show stale.
