# Desktop updates

The installed app looks for a newer release on its track 15 seconds after launch and every 30 minutes, shows the release notes before anything downloads, downloads on one click and installs and restarts on a second, after a confirm. Settings > Updates holds the version, the Stable or Nightly track, the status, and the notes. After an update, the first launch on the new version says so once, with the notes. Installing needs a signed build: unsigned, Squirrel.Mac refuses the new app and prkit says why. How the feed is built, and the mock flow, are in [docs/operations/desktop-build.md](../../../../docs/operations/desktop-build.md).

## Sub-features

- `updates-check` the startup and periodic checks, Check for updates in Settings, and the app menu's Check for Updates… with its native up-to-date and failure dialogs; a menu check during a running check waits for it. An update on offer stays through later checks unless a newer one replaces it.
- `updates-notes` What's new from the feed's release notes, newest first, one block per version since the running one, PR links, no HTML.
- `updates-titlebar` the title bar button: Update, download progress, Restart to update; hover or focus shows What's new.
- `updates-download` the download, its progress, the "Update downloaded" toast.
- `updates-install` the confirm dialog, the server stopped before Squirrel takes over, and restarted when the install fails.
- `updates-track` Stable or Nightly, stored in the profile, with a downgrade allowed when switching to Stable, kept while that older version is on offer.
- `updates-after` the "Updated to <version>" toast, once per version.
- `updates-disabled` a dev run, a build with no feed, or `PRKIT_DISABLE_AUTO_UPDATE` turns updates off with a reason; the web build shows no update UI.
- `updates-quit` SIGTERM to the app's main process quits it and its server child.

## How to get to it (user POV)

- Title bar, right edge: the update button, once an update is found.
- Settings > Updates (`/settings/updates`), desktop app only.
- App menu > Check for Updates….
- The toasts "Update downloaded" and "Updated to <version>", each with What's new.

## Driving it with e2e

Preconditions: macOS, `pnpm install`, about 3 GB free on disk for two builds. Build vA and vB with `--mock-updates` as in docs/operations/desktop-build.md "Testing updates", copy vA out of its DMG, and keep only vB's manifest, zip and blockmap. Drive the packaged vA with Playwright's `_electron.launch({ executablePath, args: ["--user-data-dir=<checkout>/.prkit/<dir>/profile"], env: { PRKIT_HOME: "<checkout>/.prkit/<dir>/home" } })`. Playwright pins `prefers-color-scheme` to light: for dark shots set `nativeTheme.themeSource` and call `page.emulateMedia({ colorScheme: "dark" })`.

- **Error with Retry.** No mock server running: after 15 s, `[role=status][data-update-status="error"]` reads "The last check didn't finish." and the alert says prkit couldn't reach the update server, with Retry.
- **Checking.** Start `node scripts/mock-update-server.ts --root <vB dir> --latency 3000`, click Retry: `data-update-status="checking"`, "Checking for updates…".
- **Available.** Then `available`, "<vB> is available.", a Download button and What's new with the mock's notes. The title bar shows `getByRole("button", { name: "Update to <vB>" })`; hovering it opens `getByRole("dialog", { name: "What's new" })`.
- **Track.** `getByRole("combobox", { name: "Track" })`, pick Stable: with a `latest-mac.yml` of a lower version in the folder, that version is offered (the downgrade), and stays on offer through the next polls. Pick Nightly again: vB is offered. `<profile>/desktop-settings.json` holds `{"updateChannel":"nightly"}`.
- **Download.** Click the title bar button with `--throttle 6144`: `downloading`, "Downloading <vB>: N%", and the title bar shows progress. Then `downloaded`, the "Update downloaded" toast, and `<profile>/update-notes.json` holds vB's notes with `"shown": false`.
- **Confirm.** Click `getByRole("button", { name: "Restart to update to <vB>" })`: `getByRole("alertdialog")` reads "Install <vB> and restart prkit?" and "Running guides and fixes will be interrupted." Install and restart on an unsigned build ends in the dialog's alert "macOS couldn't verify the downloaded update…", Try again, and the server answers `/health` again.
- **Up to date and the menu.** Serve a folder whose `nightly-mac.yml` names vA: `up-to-date`, "You're up to date." Click the menu item in the main process with `Menu.getApplicationMenu().getMenuItemById("check-for-updates").click()`: the native dialog says "You're up to date"; with the mock stopped, "Couldn't check for updates". To read a native dialog without screen recording, replace `dialog.showMessageBox` in `app.evaluate` and record its options.
- **After an update.** Write `<profile>/update-notes.json` with the running version and `"shown": false`, launch: one toast "Updated to <version>" with What's new, and the file then says `"shown": true`. A second launch shows no toast.
- **Disabled.** `electron.launch({ args: ["apps/desktop", "--user-data-dir=…"] })` after `pnpm build`: Settings > Updates reads "Updates work only in the installed app." and the title bar has no update button.
- **Web build.** `pnpm e2e run tests/updates.e2e.ts`: no `window.prkitDesktop`, no update button, no Updates link, and `/settings/updates` has no Updates section.
- **SIGTERM.** Spawn the packaged executable, record its PID and its descendants from `ps -A -o pid=,ppid=,command=` (the server child has `--web-dist`), send SIGTERM to the main PID: it exits with code 0 and none of the recorded PIDs is alive.

## Gotchas

- An unsigned app can't install: Squirrel.Mac checks the new app's signature against the running one. Prove the flow up to Restart to update, and the install path with `apps/desktop/src/updates/DesktopUpdates.test.ts`.
- electron-updater caches downloads in `~/Library/Caches/prkit-updater`, and Squirrel stages in `~/Library/Caches/<bundle id>.ShipIt`. Delete them after a run, or the next download finishes at once.
- A mock-updates build reads `http://127.0.0.1:7357` unless `PRKIT_DESKTOP_MOCK_UPDATE_PORT` was set at build time. The mock server reads the same variable.
- Never point a test run at `~/.prkit` or the default Electron profile: both `PRKIT_HOME` and `--user-data-dir` go inside the checkout.
