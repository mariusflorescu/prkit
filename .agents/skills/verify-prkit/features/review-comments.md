# Review comments

Line and range comments on any diff, kept by prkit as drafts per PR and account until the user finishes the review on GitHub as Comment, Approve or Request changes. GitHub's review threads sit on their lines with replies, reactions and Resolve. Drafts whose lines change after a push are listed under their file as outdated, with a way to move them.

## Sub-features

- `comment-gutter` shows a comment button on the hovered line. Clicking it, or dragging across line numbers, opens an inline composer for that line or range. Lines outside the diff's hunks are refused with a toast.
- `comment-keyboard` makes each gutter of line numbers one tab stop, a `button "Comment on line N"` (`"Comment on old line N"` on the old side) with a visible ring. Arrows, Home and End move along it, Shift+arrows highlight a range, Enter or Space opens the composer, Escape or leaving the line numbers drops the range, and focus returns to the line when the composer closes. A click with no pointer behind it (`detail` 0, as VoiceOver's VO+Space and Voice Control send) opens the composer like Enter; a mouse click stays Pierre's line selection. The gutter remembers the line focused last.
- `comment-drafts` stores drafts in `pending_comments` with their anchor, the diff rows they were written on, and the head commit. They survive reloads and restarts. Each draft can be edited or deleted.
- `comment-surfaces` puts the same layer on the Files tab and the guide's chapter diffs. GitHub's threads show in the guide only when the revision is the PR's current head.
- `comment-threads` reads review threads through the PR's account. Reply posts at once, Resolve and Unresolve toggle, and resolved threads fold to one line. Outdated threads fold into an `Outdated` group per file. The Conversation tab lists threads in time order with their code, each line comment once, inside its thread.
- `comment-outdated` marks a draft outdated when its rows no longer read the same at the current head. It shows the original rows, offers `Move to line N` when the same rows exist elsewhere, `Pick a new line`, and delete.
- `comment-review` is the header `Review` button with the draft count. Its popover takes a summary and a verdict. Approve and Request changes are disabled on the account's own PR. Submit posts one GitHub review with every current draft, marks them published, and leaves outdated drafts as drafts.
- `comment-recovery` refuses a submission when every draft is outdated at GitHub's current head, keeping the drafts. A submission cut off by a crash is matched against the account's reviews on the next read of that PR's drafts. A refused submission shows its error at once and keeps the drafts; GitHub's reads go on behind it.
- `comment-push` keeps the diffs, and a comment being written, when the PR's head moves: the Files tab shows the files it has until the new head's arrive, and a file card remounts only when the base moves or that file's own hunks change.

## How to get to it (user POV)

- Open a PR, choose Files, hover a line and click its comment button. From the keyboard, Tab into the line numbers and press Enter.
- Choose Guide on a PR with a guide and do the same inside a chapter's diff.
- Use the `Review` button next to the header actions.
- Read and answer threads on the Conversation tab, under Activity.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change and the instance passes `pnpm verify:app doctor`.
- `gh` on this machine is signed in as `<owner>`. The first journey opens its own PR on `<fixture>` with `tests/reviewFixture.ts` and closes it at the end, so fixture #1 never gets reviews. The other three read the fake GitHub (`tests/fakeGitHub.ts`) and need no fixture.

- **Gutter.** Hover `[data-path="src/limits.js"] [data-column-number="3"]` until `[data-path="src/limits.js"] [data-utility-button]` exists, then tap it. Pierre re-renders once highlighting lands, so retry the hover. After that the button stays under a still pointer while drafts, threads or the PR refresh. `textbox "Comment on line 3"` opens.
- **Range.** `line(15).dragTo(line(17))` on the same locators opens `textbox "Comment on lines 15 to 17"`.
- **Draft.** Fill the composer and press `Meta+Enter` or tap `button "Add review comment"`. `article "Pending comment on src/limits.js line 3"` appears and `button "Review, 1 pending"` counts it. `sqlite3 -readonly <home>/prkit.sqlite "SELECT * FROM pending_comments"` shows the row.
- **Persistence.** Reload the PR URL, or `pnpm verify:app stop --name <n> --keep-home` and start again. The drafts are still there.
- **Finish.** Tap `button "Review, 2 pending"` (use `.first()`: the compact header has one too). `dialog "Finish your review"` has `textbox "Review summary"` and radios `Comment`, `Approve`, `Request changes`; the last two are disabled on your own PR. `button "Submit review"` reads the drafts again, then closes the dialog with the button already reading `Review` and shows a toast `N comments posted on GitHub.` (plus `N outdated drafts stay in prkit.` when some were outdated). Reopened at once, the dialog says `No pending comments.` The drafts become `article "Thread by <owner> on src/limits.js line 3"` once the threads are read again. Check GitHub with `gh api repos/<fixture>/pulls/<n>/comments`.
- **Thread.** In the thread article tap `button "Reply"`, fill `textbox "Reply to <owner>"`, hover line 1 until its comment button shows, then press `Meta+Enter`. The reply lands and line 1 still has its button. Then `button "Resolve conversation"` and hover line 1 again; the article reads `Resolved · 2 comments` and line 1 keeps its button. `gh api graphql` on `reviewThreads` agrees.
- **Moved head.** Add drafts, push to the fixture branch (`pushOutdatingChange`), and submit without Refresh. The dialog says `Every draft is on lines that changed` and the drafts stay. After `button "Refresh"`, `region "Outdated comments on src/limits.js"` lists them with their rows. `button "Move to line 10"` re-anchors one. Submitting now posts it and keeps the other as an outdated draft; `button "Delete pending comment"` then removes that one.
- **Keyboard.** On the fake's PR 9 (`/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`), focus `region "src/limits.ts"` > `button "src/limits.ts"` and press Tab twice, past `checkbox "Reviewed src/limits.ts"`: `button "Comment on line 1"` is focused, with a `solid 2px` outline. `ArrowDown` twice reaches `button "Comment on line 2"` (past `"Comment on old line 2"`); Enter focuses `textbox "Comment on line 2"`; `Meta+Enter` adds the draft and focus returns to the line. `ArrowDown`, `Shift+ArrowDown` and Space open `textbox "Comment on lines 3 to 4"`; Escape closes it and focus is back on line 4. After `button "Split"`, Tab from the header (past the Reviewed box) reaches `"Comment on old line 1"`, and Tab again the new side's remembered line 4. With line 7 focused, `fake.push(9)` redraws the diff without a click (the instance runs a 5-second tick), and line 7 keeps focus. `Shift+ArrowUp`, Tab and Shift+Tab come back to line 6 with no range: Enter opens `textbox "Comment on line 6"`. A `click` dispatched on the focused line with `detail: 0` opens the same field.
- **Refused review.** On the fake's PR 7, `fake.limit("core", 600)` and `fake.latency(60_000, "graphql")`, then Review > Approve > `button "Approve"`. Within 15 seconds `dialog "Finish your review"` has `alert` `GitHub's limit for budget-test is used up until <time>. Your drafts are still here.` Before the fix it took 45 seconds, waiting for GraphQL reads to time out.
- **Push while writing.** On PR 9, tap `button "Comment on line 1"`, fill the composer, `fake.push(9)` and tap the tab row's `button "Refresh"`. Once the fake counts another `rest:files` read, the composer still holds the words and `Meta+Enter` adds the draft.
- **Guide.** `pnpm e2e run tests/guide-generation.e2e.ts --grep "stand-in agent fails"` writes a guide on `<fixture>#1` with the stand-in agent (no subscription), then taps the tab stop of `region "src/validate.js"` in the chapter (`button /^Comment on (old )?line \d+$/`), adds a draft, and finds `article "Pending comment on src/validate.js line 1"` there and again in Files. With a real agent, comment the same way in `[data-guide-chapter]`.
- **Journey.** `pnpm e2e run tests/review-comments.e2e.ts --trace=on --video=on` covers gutter, range, reload, submit, reopen, reply and resolve under a resting hover, the moved-head refusal, outdated move, a submit with an outdated draft, and delete, then the three fake journeys: the refused review, the keyboard path, and a push while writing. Add `--repeat-each 5` to run it again and again in one instance. On 12 Oct the file passed three runs in a row at loads 8.2, 6.3 and 9.3, about 50 GraphQL points each. The guide surface is proven by the stand-in guide journey in `tests/guide-generation.e2e.ts`.

## Gotchas

- GitHub's pulls API can lag a few seconds after a push. Poll `.head.sha` before expecting outdated drafts.
- GitHub accepts a review summary of 70,000 characters, so a long body is no way to force an error.
- The success toast lasts five seconds. On a loaded machine e2e can stop reading the screen for longer, so before Submit the journey puts a `MutationObserver` in the page (`browser.evaluate`) that records each toast's title and description and Review's label in the render that closes the popover, and asserts those texts. Under a load average near 100 on 10 cores, e2e can still miss a plain 5-second check, such as the dialog opening.
- GitHub's GraphQL `startLine` for a moved range can disagree with REST `start_line`. prkit shows GraphQL's.
- Posting on any repository other than `<fixture>` is never allowed from a journey.
