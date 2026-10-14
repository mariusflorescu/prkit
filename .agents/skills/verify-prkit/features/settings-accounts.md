# Settings > Accounts

Settings lists each discovered GitHub host/login with its config directory, avatar and status. Each account the machine's gh config dirs hold shows as a Ready row. Users can add a directory, remove directories they added, and refresh account credentials. Saved directories survive a server restart.

## Sub-features

- `accounts-list` lists each host/login once; the first discovered directory binds its credentials.
- `accounts-status` shows `ready`, or `error` with the reason in plain words.
- `accounts-add-dir` adds a gh config dir the scan did not find.
- `accounts-remove-dir` removes a saved directory from discovery without changing its gh files.
- `accounts-states` has a loading skeleton, an empty state for a machine with no gh login, and an error state with a retry.

## How to get to it (user POV)

- Open Settings through the entry point in [Shell](./shell.md); Accounts is the first section, at `/settings/accounts`.

## Driving it with e2e

The journey in `tests/accounts-inbox.e2e.ts` checks both Ready accounts, directory validation, API errors, success toasts, and add/remove through the UI.

Preconditions:

- Signed in through `openUrl`.
- Every gh config dir is logged in. Check each with the real gh binary, not the mise shim: `GH_CONFIG_DIR=~/.config/gh-<name> "$(mise which gh)" auth status` names that dir's login.

- **List.** Open Settings. One row per account, each with its host and its config dir.
- **Status.** Every row reads Ready; none reads `Needs attention`.
- **Validation.** Tap `screen.getByRole("button", "Add directory")` with an empty field. The form asks for a directory. Fill `screen.getByRole("textbox", "Add gh config directory")` with a nonexistent absolute path; the field explains that it cannot be read. Submit an existing directory without `hosts.yml`; the field explains which file is missing.
- **Add and remove.** Submit a new directory containing `hosts.yml`, kept under `.e2e/`. Check the success toast, restart with `--keep-home`, and check the saved directory before tapping its Remove button. Default directories have no Remove button.
- **Broken directory.** On the fake GitHub, a directory whose login the fake refuses reads `Needs attention` with the reason and `Retry`, and the Inbox shows it beside the other account's rows. See Account error in [Inbox](./inbox.md).
- **Proof.** A screenshot of the rows, plus the same list after `stop --keep-home` and `start` under the same name.

## Gotchas

- `gh` on this machine's PATH is a mise shim, and mise exports `GH_CONFIG_DIR=~/.config/gh`. Through the shim, `GH_CONFIG_DIR=~/.config/gh-<name> gh auth token` returns the `~/.config/gh` account's token. Two rows with the same login mean the server ran the shim.
- Tokens must never appear on screen, in a screenshot, in a log, or in a trace.
- The active host user uses `gh auth token --hostname <host>` without `--user`. A stale per-user token for that login must not override a valid active token. Non-active logins use `--user`; there is no credential fallback.
