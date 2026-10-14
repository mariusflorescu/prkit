# GitHub budget

prkit shares each account's GitHub limits with `gh` and the user's other tools. The Inbox and every PR read are answered from prkit's cache for ten minutes, then from cache at once while GitHub is read again in the background. Open PR tabs notice comments and pushes within a watcher tick through one cheap fingerprint query per account. When GitHub says the limit is used up, prkit sends nothing until the reset and says so: "GitHub's limit for <login> is used up. Showing what prkit fetched 4 minutes ago. Resets at 04:04." Settings > Accounts shows each account's GraphQL and REST remaining, reset time and what prkit spent in the last hour.

## Sub-features

- `updated-line`: the Inbox header says "Updated <time ago>" for the oldest account in view.
- `cache`: reloads, tab switches and refocus answer from cache; Refresh reads every account once, Retry reads one.
- `relaunch`: a relaunch renders the Inbox from `github_read_cache` before any GitHub answer.
- `change-detection`: a new comment or commit on an open tab shows up within one watcher tick, with only that tab's reads.
- `active-checks`: while a window is visible and a check of the active PR is pending, prkit asks with ETags every 15 seconds (a 304 is free); a check that finished before the first ask still counts. Nothing is asked while no check is pending or the window is hidden.
- `rate-limit`: a refused read pauses that account's resource; banners and the PR page say how old the data is and when it resets; Retry waits for the reset; actions fail with the same sentence.
- `budget-readout`: Settings > Accounts lists GraphQL and REST remaining, reset, and prkit's spend in the last hour.

## How to get to it (user POV)

- Open the Inbox and read the line next to Refresh; click Refresh.
- Open PRs from the Inbox, switch tabs, hide and show the window.
- Wait for GitHub to rate limit an account (or the fake's `limit` control), then click Refresh or open a PR.
- Settings > Accounts.

## Driving it with e2e

Preconditions: `pnpm build` after the last change. These journeys never read the real accounts: each starts `scripts/fake-github.ts` and an instance pointed at it (`verify-app start --github-api <url> --gh-home <dir>`) through `tests/fakeGitHub.ts`, and opens that instance's `openUrl`. The fake serves account `github.com/budget-test` and PRs `budget/fixtures#1` to `#6`, sends GitHub's rate limit headers, and counts requests and points at `GET <url>/__fake/stats`. Its `gh` prints a token for the login in `$GH_CONFIG_DIR/hosts.yml`, and `/user` answers any `budget-` login and refuses others with 401, as GitHub refuses an expired token. `startFakeGitHub(name, { secondAccount: true })` adds `github.com/budget-second` in `~/.config/gh-second`, which sees the same PRs. Its other controls are listed at the top of `scripts/fake-github.ts`.

- **Updated line and cache:** `tests/github-budget.e2e.ts` waits for `getByRole("link", /#1 Budget fixture 1/)`, then `getByText("Updated just now")`; reopening the page keeps `graphql:inbox` at 1; `getByRole("button", "Refresh")` makes it 2.
- **Rate limit:** the same file calls the fake's `limit?resource=graphql&seconds=25`, taps Refresh, and expects `[data-github-problem="rate-limited"]` to contain "GitHub's limit for budget-test is used up." and "Resets at", `getByRole("button", "Retry")` disabled, and the fake's `refused` count to stay 1 through another Refresh. Retry turns enabled at the reset; tapping it removes the banner with one more inbox read.
- **Relaunch:** stop with `--keep-home`, set the fake's `latency?ms=8000`, start again; the fixture row is visible within 4 seconds and the fake saw no inbox query.
- **Active checks:** `tests/github-budget.e2e.ts` sets the fake's `checks?pr=3&status=in_progress`, opens #3 on the default 60-second tick, and flips it to `completed` before prkit's first ask; `[data-checks-state="passing"]` shows within 20 seconds (`.e2e/evidence/github-budget/check-turned-green.json`). With nothing pending, the fake's `rest:check-runs`/`rest:statuses` counts stay flat for 35 seconds; on #4 (pending) they grow, stay flat while `document.visibilityState` is faked `hidden`, and grow again once visible.
- **Change detection:** `tests/github-budget.e2e.ts` starts a fake without stacks and an instance on a 5-second tick, opens #3, then `fake.comment(3)` and `fake.push(3)` (`POST <url>/__fake/comment?pr=3`, `push?pr=3`). `Comment <n> from the fake` and `Commit 1 from the fake` show within 20 seconds; the fake saw one `graphql:inbox` and three `rest:pull`.
- **Tab switching and idle spend.** The journey `five idle open tabs cost one point a tick, and switching between them reads nothing` opens the fake's #1 to #5 from the Inbox with a 5-second tick, resets the fake's stats, taps each `a[data-open-pr="github.com/budget/fixtures#<n>"]` twice, and waits for three fingerprints. The fake then counts only `graphql:fingerprint`, one point each, and no more than one a tick: the five tabs share one request. With a watching review as well, sample `GET <url>/__fake/stats` by hand every minute; the fake has no git repository for a guide.
- **Budget guard in process:** `node scripts/verify-github-limits.ts <TLS dir>` checks GitHub's own cost figure, the 10% reserve for background reads, and that a `RATE_LIMITED` 200 or a 403 limit pauses the resource with nothing sent.
- **Budget readout:** open Settings > Accounts on any instance; each account row has `ul[aria-label="GitHub limits for <account>"]` once prkit has read GitHub through it, and `role="status"` "No GitHub reads through this account since prkit started." before that.

## Gotchas

- The server keeps a 60-second floor on `--watch-interval` unless `--e2e` is passed; only `e2e.config.ts` passes it.
- A live check against real GitHub spends the owner's shared budget. Read each account's spend in Settings > Accounts before and after (prkit's own figure, from GitHub's response headers); `gh api rate_limit` can report another bucket for the same login. Keep it small, and prove timing and counts against the fake.
- The fake lives in the test's process tree; stop it and its instance in `finally`, by the recorded pid and `verify-app stop`.
- Headless Chrome is always visible. Simulate a hidden window by redefining `document.visibilityState` and dispatching `visibilitychange`.
