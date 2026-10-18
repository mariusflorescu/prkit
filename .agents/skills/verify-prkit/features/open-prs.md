# Open PRs

PRs appear after the fixed Inbox tab in the horizontal title bar. Each tab has a state icon and number. Hover or focus swaps the icon for its close button. A tooltip shows the number first, then title, repository, account, and review progress. The server stores PR order, account bindings, and active PR, so they survive a relaunch.

## Sub-features

- `tabs-open` adds and focuses a PR opened from the Inbox, the palette, or a pasted URL.
- `tabs-binding` keeps the account a PR was opened through, even when a later URL names another account.
- `tabs-switch` selects Inbox with Cmd+1 and PRs with Cmd+2..9, and cycles with Ctrl+Tab, Ctrl+Shift+Tab and Cmd+Shift+[ or ].
- `tabs-close` closes the active PR with Cmd+W, a middle click, or the context menu (Close, Close others, Close to the right, Close all PRs), and Cmd+Shift+T reopens the last one. The fixed tab stays.
- `tabs-reorder` moves PR tabs by drag or Alt+Left/Right.
- `tabs-memory` keeps each PR's inner tab and scroll position, and closing the Settings tab returns to the same PR.
- `tabs-palette` searches by title, repository, number, head or base branch, author, or account. Every word must appear in some field, in any order. An exact `#number` or head branch is listed first. Each row shows its head branch after `owner/repo #number`, truncated from the middle when long; an open PR outside the inbox shows it once its detail has loaded.
- `tabs-progress` shows a running review's ring and a failed review's warning on its tab.
- `tabs-overflow` scrolls the strip horizontally, with a vertical wheel too, and reveals a selected tab.
- `tabs-reconnect` catches up after the window was offline (sleep, a network drop): tabs an outside agent or the CLI opened or closed meanwhile show up once it reconnects, after the user's own tabs, and the PR on screen stays the selected one.
- `tabs-background` keeps the selected tab and the page when an outside agent or the CLI opens a PR with `--no-focus`: the tab joins the end of the strip, the server's active PR stays, and a relaunch shows the same PR.

## How to get to it (user POV)

- Choose a PR from the inbox.
- Press Cmd+N or Cmd+T, or choose `button "Open a pull request"`, and search `searchbox "Find a pull request"`.
- Paste an HTTPS PR URL. Choose `button "Open through github.com/<login>"` to bind the account explicitly.
- Right-click or middle-click a PR tab.

## Driving it with e2e

Preconditions:

- `pnpm build`, and `.e2e/local.json` names the fixture. Run `pnpm e2e run tests/open-prs.e2e.ts --trace=on --video=on`. Everything after the fixture's Conversation needs a second account with a pull request of its own; the test skips there without one. The palette and relaunch tests below don't.

- **Open.** Search `prkit-fixtures` and choose `/#1 Validate links and count clicks/` in `region "Yours"`. `[data-open-pr]` identifies PR links; their accessible names include owner/repo and number. The strip is `navigation "Workspace tabs"`.
- **Binding.** Open another account's PR, then follow a URL naming a different account: the tab keeps its `data-account` and `[data-reading-account]`. The instance log (`run.log`) has an Info `GitHub request` entry per call, `accountId` first and the REST path in `operation`; every one under that PR's `/repos/<owner>/<repo>/pulls/<n>` names the second account.
- **Switch.** Cmd+1 selects Inbox. Cmd+2..9 selects PRs by position. Ctrl+Tab, Ctrl+Shift+Tab, and Cmd+Shift+[ or ] cycle with wraparound.
- **Close.** Cmd+W closes only the active PR; Cmd+Shift+T reopens it. Right-click a PR label: `menuitem` Close, Close others, Close to the right, and Close all PRs affect PR tabs only. Middle-click closes a PR; the journey dispatches the DOM `auxclick` because e2e has no middle-button action.
- **Reorder.** Drag the PR label to another PR label, then Alt+Left or Right on the focused tab. The order changes in `[data-open-pr]`.
- **Memory.** Cmd+, then Cmd+W (closing the Settings tab) returns to the same PR. Choose `link "Guide"`, switch away and back: it keeps `aria-current="page"`. Scroll a Conversation, switch away and back: `[data-pr-scroll]` keeps its offset. The journey saves `conversation-scroll-remembered`.
- **Palette.** A test of its own that needs only the fixture's account: `prkit validate`, `feat/valid` and `count clicks feat/validate` all find fixture #1, whose row shows `feat/validate-and-count`, and the exact head branch lists it first. It saves `palette-branch-search`.
- **Access error.** The second test opens a PR the account can't see: `alert` names the account, `button "Retry"` reads again, and the tab's close button returns to the Inbox.
- **Progress.** The stand-in guide journey in `tests/guide-generation.e2e.ts` checks the active tab while its agent is held: `[data-guide-progress="0"]` with no animation, no `[data-guide-warning]`, and the tab's tooltip `[data-tab-guide-progress]` reading `Writing guide · 0/5 files`; after the failed run the tab has `[data-guide-warning]`. By hand with a real agent: the static ring fills with files read, then chapters written, and moves only when one of them changes; the tooltip says `Writing guide · 3/5 files` or `Writing guide · chapter 2 of 3` (`Updating guide` for a later revision).
- **Reconnect.** `tests/workspace-reconnect.e2e.ts`, on the fake GitHub and a scratch repository, wraps the page's `WebSocket` so it can drop the window's socket and refuse new ones. Offline, the CLI opens `budget/fixtures#3` and a local review; back online, both tabs appear after `#1` and `#2` in one step, the page stays on #1, and #1 is the selected tab in the strip and in `prkit tabs list` (the offline `prkit tabs focus budget/fixtures#2` had made #2 the server's active PR, with a focus the window never heard). A second drop changes nothing. A `MutationObserver` on `navigation "Workspace tabs"` records every strip it showed: no skeleton, no tab twice, the user's tabs always first. It saves `reconnected-tabs`.
- **Background open.** `tests/workspace-background-open.e2e.ts`, on the fake GitHub: `prkit pr open budget/fixtures#1` shows #1 and selects its tab; `prkit pr open budget/fixtures#2 --no-focus` answers with #1 still active, adds #2 after it, and the page and `[data-active-tab="true"]` stay on #1, as does `prkit tabs list`. After `stopFakeInstance` with `keepHome: true` and a new start, the window comes back on #1 with #2 behind it. It saves `background-open` and `background-open-relaunched`.
- **Relaunch.** `tests/open-prs.e2e.ts` opens the fake GitHub's #5, #3 and #4, selects #3, clears the page's own storage, stops the instance with `--keep-home` and starts it again: `[data-open-pr]` reads `github.com/budget/fixtures#5`, `#3`, `#4` in that order, and #3 has `aria-current="page"`. For the desktop, two `pnpm dev:desktop` launches with one `PRKIT_HOME` get different ports and keep the same tabs; check the menu, a real middle click, and the drag regions there by hand.

## Gotchas

- Close history and inner tabs last only for the session. The Settings tab, its section and its return target last for the window's session too, in sessionStorage, so they survive a reload but not a relaunch. Visiting Inbox does not replace the server's remembered active PR.
- The empty title bar area is draggable in Electron and controls use no-drag regions, so a drag that starts on empty bar moves the window, not a tab.
- Journeys share one instance; close the tabs a journey opened before the next one asserts on the strip.
