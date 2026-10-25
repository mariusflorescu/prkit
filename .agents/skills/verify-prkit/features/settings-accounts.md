# Settings > Accounts

Settings lists each discovered GitHub host/login with the config directory it was found in (from `~` when it is under the home folder), avatar and status. Each account the machine's gh config dirs hold shows as a Ready row. Users can add a directory, remove directories they added, and refresh account credentials. Saved directories survive a server restart.

## Sub-features

- `accounts-list` lists each host/login once, whatever case each directory spells it in; the first discovered directory binds its credentials and names the account.
- `accounts-locations` looks where gh does: `GH_CONFIG_DIR`, then `gh` in `XDG_CONFIG_HOME`, then `~/.config/gh`, each with the `gh-*` directories beside it. The desktop app started from Finder reads both variables from the login shell, and a launch that sets either keeps its own.
- `accounts-moves` reads an account's open pull requests again through the directory its login moves to, and sets aside a read that lands after the move. Every window, listening, reconnecting or shown after it was hidden, drops the tab statuses, inbox rows and pull request reads of the old directory at once and shows the tab's loading state until the new directory answers; the server never sends a status read through a directory the account left.
- `accounts-status` shows `ready`, or `error` with the reason in plain words.
- `accounts-add-dir` adds a gh config dir the scan did not find.
- `accounts-remove-dir` removes a saved directory from discovery without changing its gh files.
- `accounts-states` has a loading skeleton, an empty state for a machine with no gh login, and an error state with a retry.
- `accounts-unreadable-dir` keeps every other directory's accounts when prkit can't read one directory. The logins it listed last read `Needs attention` with its reason and get no token from any directory; a directory with no such account gets a row of its own with `Retry`, and the Inbox says the same above the rows.

## How to get to it (user POV)

- Open Settings through the entry point in [Shell](./shell.md); Accounts is the first section, at `/settings/accounts`.

## Driving it with e2e

`tests/accounts-discovery.e2e.ts` runs on the fake GitHub and its per-token, per-directory request log: two directories that spell one login in different case (one account, read through the first, which an unreadable first directory keeps across a relaunch), an open pull request read again through the directory its login moves to, a read held across a move that the server logs as set aside and keeps nowhere, tab statuses after a move in three windows (one listening, one that reloads or is hidden and shown, one opened hidden on the pull request) and after a move back with nothing changed on GitHub, and the built desktop app launched like Finder (launchd's PATH, no gh variables) with a stand-in login shell that exports `GH_CONFIG_DIR` and `XDG_CONFIG_HOME`, then again with a launch that sets its own `XDG_CONFIG_HOME`. It files Settings frames in light, dark and at 900 px under `.e2e/evidence/accounts-discovery/`, and the moved tab's tooltip before, during and after the read through the new directory under `.e2e/evidence/accounts-moved-statuses/`.

The journey in `tests/accounts-inbox.e2e.ts` checks both Ready accounts, directory validation, API errors, success toasts, and add/remove through the UI. `tests/accounts-config-dirs.e2e.ts` makes directories unreadable on the fake GitHub, mid-run and at launch, and repairs them.

Preconditions:

- Signed in through `openUrl`.
- Every gh config dir is logged in. Check each with the real gh binary, not the mise shim: `GH_CONFIG_DIR=~/.config/gh-<name> "$(mise which gh)" auth status` names that dir's login.

- **List.** Open Settings. One row per account, each with its host and its config dir.
- **Where gh keeps it.** With a stand-in login shell that exports `XDG_CONFIG_HOME=~/xdg` and `GH_CONFIG_DIR=~/custom/gh-own`, the desktop app finds `budget-third` in `~/custom/gh-own`, `budget-test` in `~/xdg/gh` (not `~/.config/gh`, which lists it too) and `budget-second` in `~/xdg/gh-second`, and the fake's log shows each login read only through its own directory.
- **Status.** Every row reads Ready; none reads `Needs attention`.
- **Validation.** Tap `screen.getByRole("button", "Add directory")` with an empty field. The form asks for a directory. Fill `screen.getByRole("textbox", "Add gh config directory")` with a nonexistent absolute path; the field explains that it cannot be read. Submit an existing directory without `hosts.yml`; the field explains which file is missing.
- **Add and remove.** Submit a new directory containing `hosts.yml`, kept under `.e2e/`. Check the success toast, restart with `--keep-home`, and check the saved directory before tapping its Remove button. Default directories have no Remove button. A remove that fails keeps the row, shows the error with Retry below the list without moving the rows, and Retry removes it again: `tests/settings-failed-saves.e2e.ts`, see Failed saves in [Settings](./settings.md). An error from Refresh shows under the header, beside its button.
- **Broken directory.** On the fake GitHub, a directory whose login the fake refuses reads `Needs attention` with the reason and `Retry`, and the Inbox shows it beside the other account's rows. See Account error in [Inbox](./inbox.md).
- **Unreadable directory.** On the fake with `secondAccount`, `chmod 000` `<fake home>/.config/gh-second` and tap Refresh: `budget-test` stays Ready, `budget-second` reads `prkit can't open ~/.config/gh-second, so it can't check budget-second.`, and the Inbox keeps rows 1 to 6 with that sentence and `Retry`. Opening #5 sends no request, and the fake's log (`login` and `dir` of each request's token) never shows a login read through another directory. The same for an unreadable `hosts.yml`, one cut off mid-write, and an empty one; a keyring-style `hosts.yml` (the user with no value) reads Ready. A new `gh-third` that can't be opened at launch shows its own row and Inbox notice with `Retry`. With both directories naming `budget-test`, locking `gh` leaves `budget-test` needing attention, and nothing reads through `gh-second`, before and after a relaunch.
- **Proof.** A screenshot of the rows, plus the same list after `stop --keep-home` and `start` under the same name.

## Gotchas

- `gh` on this machine's PATH is a mise shim, and mise exports `GH_CONFIG_DIR=~/.config/gh`. Through the shim, `GH_CONFIG_DIR=~/.config/gh-<name> gh auth token` returns the `~/.config/gh` account's token. Two rows with the same login mean the server ran the shim.
- Tokens must never appear on screen, in a screenshot, in a log, or in a trace.
- The active host user uses `gh auth token --hostname <host>` without `--user`. A stale per-user token for that login must not override a valid active token. Non-active logins use `--user`; there is no credential fallback.
