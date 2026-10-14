# Inbox

The Inbox lists open pull requests across the machine's GitHub accounts in three groups: Needs your review, Yours, and Involved. Search, account and repository filters narrow the list; the filters row stays pinned when the list scrolls. The fixture `<fixture>#1`, "Validate links and count clicks", appears once in Yours through `github.com/<owner>`. An account's error stays beside the other accounts' rows.

## Sub-features

- `inbox-list` lists open PRs from every ready account, one row per PR.
- `inbox-reasons` shows why each PR needs the user: `review-requested`, `authored`, `involved`.
- `inbox-account` shows the account each PR was found through. With a single account, rows show no account and the Account filter is hidden; the repository filter stays.
- `inbox-dedupe` lists a PR found by two accounts once, under the account with the stronger reason.
- `inbox-account-error` shows one account's failure next to the other accounts' rows.
- `inbox-states` has a loading skeleton, an empty state, and an error state with a retry.
- `inbox-filters` searches titles, repositories, authors and numbers, and selects one account. A filter hides the groups it empties; unfiltered, every group shows with its count.
- `inbox-saved-filters` keeps the search, account and repository filters with the server's workspace, so a reload and a relaunch show them again. Typing is saved once it pauses (400 ms), other changes at once, and filters that didn't change are not saved again. An account removed since is let go on the next load. A saved repository filter drops out once a whole repository list read after the save and the inbox no longer have the repository.
- `inbox-repository` filters to one repository from a searchable list of every repository the accounts can see (kept a day, "Refresh list" reads it again), grouped by owner with each one's inbox count. A repository where nothing needs you offers "Show open pull requests in owner/repo", read through the first account that sees it.
- `inbox-header-collapse` scrolls the title row away and pins the filters row, which takes a Refresh icon; the PR view's collapsing header, shared.
- `inbox-refresh` reads every account again past the ten-minute cache. Window focus does not refetch; the server marks answers stale when GitHub changes.
- `inbox-truncation` reports the number shown and the search's total.
- `inbox-guide` marks rows `Guide ready` or `Writing guide` from the app-wide review feed, and offers `Generate guide` on hover or focus for a PR without a guide, in place of the row's size and age, which share its column. See [Guide generation](./guide-generation.md).

## How to get to it (user POV)

- Open `openUrl`; the Inbox is the first page.
- Return to the Inbox through the entry point in [Shell](./shell.md).

## Driving it with e2e

The journey in `tests/accounts-inbox.e2e.ts` checks the fixture's account and group, the second account's filter (when there is one), no matches, filter recovery, and account-bound navigation. `tests/inbox-filters.e2e.ts` checks the repository filter, the row action, the groups a filter empties, a PR merged while GitHub's search still finds it and the saved search and repository filter against the fake GitHub, the collapsing header against the real inbox and again on the fake's one account, and the saved account filter on an instance of its own with the real accounts.

Preconditions:

- Signed in through `openUrl`.
- `<fixture>#1` is open on GitHub (`gh pr view 1 -R <fixture> --json state`).

- **List.** Open the Inbox. Fill `screen.getByRole("searchbox", "Search pull requests")` with `prkit-fixtures`; the row for `Validate links and count clicks` appears.
- **Account.** The fixture's account chip reads `<owner>` and its title is `github.com/<owner>`, never another account's.
- **Reason.** The fixture is inside `screen.getByRole("region", "Yours")`.
- **Filters.** Choose the second account with `chooseOtherAccount(screen, browser, FIXTURE_LOGIN)` from `tests/pickers.ts` (tap `combobox "Filter by GitHub account"`, read the `option` names, pick the first that is not `All accounts` or `<owner>`). Its rows have a chip with its login and the full account id in its title. Search for a unique nonsense string; `No matching pull requests` appears with `Clear filters`.
- **One account.** On the fake (one gh config dir, `github.com/budget-test`), `combobox "Filter by GitHub account"` is absent and no row has a `span[title="github.com/budget-test"]`.
- **Repository.** On the fake (`startFakeGitHub`), tap `button "Filter by repository: All repositories"`; `combobox "Search repositories"` lists `option "fixtures 6 in your inbox"` and `option "tools"` under the group label `budget`, never the archived `attic`. Pick `tools`: `heading "Nothing in budget/tools needs you"`, then `button "Show open pull requests in budget/tools"` shows `region "Open in budget/tools"` with `link /#1 Tools fixture 1/` (`data-account="github.com/budget-test"`). The fake counts `graphql:repositories` once until `button "Refresh list"`, and `graphql:repository-pulls` once.
- **Row action.** On the fake, hover `link /#1 Budget fixture 1/`: the row's sizes (`+1 -0` and the age) fade to opacity 0 and `button "Generate guide for budget/fixtures #1"` fades in where they were, inside the row and clear of the title. The row and the title keep their boxes. Hover away, focus the link: the button shows; `Tab` focuses it. Screenshots in light and dark (`emulateOsColorScheme`).
- **Empty groups.** On the fake, `region "Involved"` shows `0` unfiltered. Search `fixture 5`: only `region "Yours"` stays, and `Needs your review` and `Involved` are gone. A search that matches nothing shows `No matching pull requests` and no group.
- **Merged on GitHub.** On the fake, `fake.merge(1)` merges stack 900's bottom layer, and for 15 seconds its inbox search still finds it with the node's `state` `MERGED`, as GitHub's index does for a few seconds. Refresh: the fake's `mergedInSearch` is 1, `region "Needs your review"` has no `link /#1 Budget fixture 1/`, and `link /#2 Budget fixture 2 Stack 2\/2/` and `link /#3 Budget fixture 3/` stay.
- **Collapse.** Hover `[data-inbox-scroll]` and wheel down: `[data-collapse-pinned]` turns `data-collapsed="true"`, `[data-collapse-motion]` settles at `matrix(1, 0, 0, 1, 0, 0)`, the search, the filters and the icon-only `button "Refresh"` stay at one top. The account filter is in that row only when Settings > Accounts lists more than one account (`accountCount` in `tests/pickers.ts`); the journey runs once on the real inbox and once on the fake in a 420px-high window. Wheel back up: `-4px` and the header's `Refresh` returns.
- **Saved filters.** On the fake, fill `fixture 3` and pick `option /^fixtures/`: only `#3` shows, and `<home>/prkit.sqlite` `workspace.inbox_filters` holds the search and `budget/fixtures`. `browser.reload()` (the stored `savedAt` stays the same: restoring saves nothing), then `verify-app stop --keep-home` and `start` (a new port): the searchbox still reads `fixture 3` and the button is `Filter by repository: budget/fixtures`. Stop again, store filters naming a removed account `github.com/departed` (as the account filter and first reader of `budget/fixtures`) and start: the same filters show, and the stored ones no longer name it. Pick `tools`, archive it with the fake's `POST /__fake/archive?repo=tools`, open the filter and tap `Refresh list`: the button reads `Filter by repository: All repositories`, also after a reload.
- **Saved account.** With two accounts, an instance of the journey's own (`startInstance` in `tests/fakeGitHub.ts`) picks the other account with `chooseOtherAccount`; after a reload and a relaunch `combobox "Filter by GitHub account"` still names it and no row has another `data-account`. One account skips it.
- **Open.** Tap the fixture row; the path is `/pr/github.com/<fixture>/1` with `account=github.com%2F<owner>`. The PR Conversation opens with the account shown in `[data-reading-account]`.
- **Loading.** `tests/accounts-inbox.e2e.ts` sets the fake's `latency?ms=3000` before it opens the Inbox: `status "Loading pull requests"` with `aria-busy="true"`, then `link /#1 Budget fixture 1/` and no skeleton.
- **Account error.** The same journey adds a gh config dir whose `hosts.yml` names `ghost-user`, which the fake refuses (401). Settings > Accounts reads `Needs attention` and `gh has an expired token for ghost-user in <dir>. Run gh auth refresh with GH_CONFIG_DIR set to this directory, then refresh.`, and the Inbox shows the same sentence in `role="alert"` above budget-test's rows. Once that `hosts.yml` names `budget-third`, the alert's `Retry` clears it, Settings reads `Ready` for both, and `Remove` takes the directory away.
- **Proof.** A screenshot of the row with its account and reason, plus a second view after a reload.

## Gotchas

- The repository list is read only once the filter opens, or on a load with a saved repository filter, at most 10 pages of 100 per account; an account cut short says "the first 1,000 of N repositories". Until it is read whole after the filters were last saved, a saved repository filter stays: an older list may predate the repository.
- Filters persist in the shared e2e instance. `openInbox` clears them through the UI; a journey that opens the Inbox another way fills the search itself.
- The inbox answers from cache for ten minutes, then from cache at once while it reads GitHub again in the background. A PR opened on GitHub a moment ago needs Refresh.
- Real accounts can have many PRs. Assert on the fixture row by name, not on a row count.
- A row shown under the wrong account is the worst bug this app can have. Always assert the account, not only the title.
- `Showing 100 of N` means the search was truncated, not that the other PRs are absent from GitHub.
