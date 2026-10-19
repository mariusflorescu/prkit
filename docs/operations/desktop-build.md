# Building the desktop app

`pnpm dist:desktop:artifact` builds the installable macOS app: `prkit.app` in a DMG and a zip, their blockmaps, and the update manifest. The app runs the whole product from `/Applications` with no repository and no dev server.

```sh
pnpm dist:desktop:artifact                                    # unsigned, host arch, version from apps/desktop/package.json
pnpm dist:desktop:artifact --arch arm64 --build-version 0.1.0
pnpm dist:desktop:artifact --build-version 0.1.0-nightly.20261014.1   # "prkit Nightly"
```

## Flags

| Flag | Default | |
| --- | --- | --- |
| `--arch arm64\|x64` | the host's | |
| `--build-version <semver>` | `apps/desktop/package.json` | Stamped into the staged package.json only; nothing in the repository changes. |
| `--output-dir <dir>` | `release/` (gitignored) | |
| `--skip-build` | off | Package the existing `dist` output instead of running the desktop build (which builds server and web first). |
| `--signed` | off | Sign and notarize. Fails before building, naming every missing variable below. |
| `--mock-updates` | off | Read updates from the local mock feed instead of GitHub (see [Testing updates](#testing-updates)). Not with `--signed`. |
| `--release-notes <file.json>` | none | Write these notes into the update manifest as `releaseNotes`: what `scripts/release-version.ts manifest-notes` prints for this version. Needs an update feed. |
| `--keep-stage` | off | Keep the temporary stage directory and print its path. |
| `--verbose` | off | Stream the build and electron-builder output. |

Progress goes to stderr. The last line on stdout is one JSON object: `{"version","channel","arch","signed","files":[absolute paths]}`. `files` lists the DMG, the zip, their blockmaps and the update manifest. The app itself lands in `<output-dir>/mac-<arch>/` (`mac/` for x64), outside `files`. The exit code is non-zero on any failure.

## Channels

A version ending in `-nightly.<yyyymmdd>.<n>` builds the nightly; anything else builds stable.

| | Stable | Nightly |
| --- | --- | --- |
| App | `prkit.app` | `prkit Nightly.app` |
| Icon | `apps/desktop/build/icon.icns` | `apps/desktop/build/icon-nightly.icns` |
| Files | `prkit-<version>-<arch>.dmg`, `.zip` | `prkit-nightly-<version>-<arch>.dmg`, `.zip` |
| Update manifest | `latest-mac.yml` | `nightly-mac.yml` |
| Releases | GitHub release | GitHub prerelease, channel `nightly` |

Both share one bundle id and one data folder (`~/.prkit`). `pnpm --filter @prkit/desktop icon` and `icon:nightly` rebuild the two icons from the brand kit.

## Environment

Read at build time. None of these values goes into a tracked file.

| Variable | |
| --- | --- |
| `PRKIT_DESKTOP_APP_ID` | The bundle id. Required with `--signed`; unsigned builds default to `dev.prkit.local`. |
| `PRKIT_DESKTOP_MOCK_UPDATE_PORT` | The mock feed's port for `--mock-updates`, default `7357`. |
| `PRKIT_DESKTOP_UPDATE_REPOSITORY` | `owner/repo` of the update feed, else `GITHUB_REPOSITORY`. With neither, the app has no `app-update.yml`, no update manifest is written, and the build says so in one line. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | The Developer ID Application certificate (.p12, base64) and its password. |
| `APPLE_TEAM_ID` | The team the certificate belongs to. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | The App Store Connect API key (path to the .p8), its id and issuer. |

With `--signed`, the script imports the certificate into a keychain of its own (`scripts/desktop-artifact/keychain.ts`): electron-builder's temporary keychain unlocks its keys with the .p12's password instead of the keychain's, which macOS 26 rejects. electron-builder gets that keychain and the identity's SHA-1 (`CSC_KEYCHAIN`, `CSC_NAME`) and never the .p12. The keychain goes first in the user's search list for the build; afterwards the list is restored and the keychain and the .p12 are deleted, whatever happened. Then electron-builder signs the app with the hardened runtime, notarizes and staples it, and signs the DMG. The script then notarizes the DMG with `xcrun notarytool` (same key) and staples it. Stapling changes the DMG after electron-builder hashed it, so the script rebuilds its blockmap and rewrites its hash and size in the update manifest.

Without `--signed`, every `CSC_*` and `APPLE_*` variable is removed from electron-builder's environment and identity discovery is off, so nothing tries to sign. GitHub tokens never reach electron-builder: it publishes nothing (`--publish never`).

## What goes into the app

- The config is built in code (`scripts/desktop-artifact/config.ts`); there is no electron-builder.yml.
- The stage mirrors the repository: `apps/desktop/dist-electron`, `apps/server/dist` and `apps/web/dist`, without source maps, and no node_modules. The server bundle inlines everything but Node's builtins, and the build fails if it still imports a package that is not on `SERVER_EXTERNAL_ALLOWLIST` (empty). The Claude Agent SDK's platform binaries never ship: prkit runs the user's own `claude`.
- The server runs from inside `app.asar` on Electron's Node (`ELECTRON_RUN_AS_NODE`), so the RunAsNode fuse must stay enabled. The web UI is unpacked beside the archive (`app.asar.unpacked`), because Node's `fs.promises.access` can't check paths inside it. Packaged, the server's working directory is the home folder.
- Hardened runtime with `apps/desktop/build/entitlements.mac.plist` (JIT, unsigned executable memory, library validation off).

## One app per data folder

A second launch of the same app focuses the first one's window (`requestSingleInstanceLock`). Anything else on the same home (stable and nightly, the installed app and a dev run) is stopped by the server: it holds SQLite's exclusive lock on `<home>/prkit.lock` while it runs, and a second server prints a `home-in-use` line and exits before it opens the database or listens. Electron shows that as a message; `pnpm dev` stops with it. The operating system releases the lock when the process ends, so a crash never leaves the home locked.

A dev run keeps its Chromium profile in `prkit Dev`, apart from an installed app's.

## Checking a build

Mount the DMG without Finder (`hdiutil attach -nobrowse -readonly`), copy the app out, and run `pnpm smoke:desktop --app <path to .app>`. It launches the packaged app with its home and Chromium profile under `.prkit/smoke-app-home`, runs the usual smoke, and also checks that no module failed to load within 8 seconds, that gh, git, claude and codex resolve from the PATH main rebuilt from a Dock-like one, and that the server runs in the home folder.

## Updates

The installed app updates itself from the feed in `Resources/app-update.yml` (`apps/desktop/src/updates/`). It checks 15 seconds after launch and every 10 minutes, downloads only when you click **Update**, keeps an update on offer through later checks (a failed one, or one that finds nothing newer) unless a newer version replaces it, and installs only after you confirm **Restart to update**. Installing stops the server child first (SIGTERM, then 5 seconds before SIGKILL), then hands over to Squirrel.Mac, which quits, replaces and relaunches the app. If the install doesn't start, the server starts again and the error shows.

The track is Stable (`latest-mac.yml`) or Nightly (`nightly-mac.yml`, prereleases allowed). A build starts on its own track; Settings > Updates switches it, and the switch is kept in `desktop-settings.json` in the Chromium profile folder (userData), never in the prkit home. Switching allows a downgrade, so Nightly to Stable works, and it stays allowed while the older Stable version is on offer, until the download starts; and a version found on the other track is ignored. Release notes come from the manifest's `releaseNotes`: the offered release's body and those of up to 9 releases before it on its track ([docs/operations/release.md](release.md#release-notes-in-the-app)). The app keeps the versions newer than the running one, up to the offered one. A manifest without notes, from a release published before they went in, falls back to the release bodies in GitHub's releases feed (`fullChangelog`). Notes are parsed into groups and PR links, and are never rendered as HTML. When a download finishes its notes go into `update-notes.json`; the first launch on that version shows them once.

Updates are off, with the reason in Settings, when the app isn't packaged, when the build has no `app-update.yml`, or when `PRKIT_DISABLE_AUTO_UPDATE` is set. A plain browser on the dev server shows no update UI.

## Testing updates

Unsigned builds can't install an update: Squirrel.Mac checks the new app's signature. Everything up to **Restart to update** works unsigned against the mock feed.

```sh
pnpm dist:desktop:artifact --mock-updates --build-version 0.1.0-nightly.20261015.1 --output-dir release/a
pnpm dist:desktop:artifact --mock-updates --build-version 0.1.0-nightly.20261016.1 --output-dir release/b --skip-build
node scripts/mock-update-server.ts --root release/b --throttle 4096
```

`--mock-updates` writes a `generic` feed at `http://127.0.0.1:<PRKIT_DESKTOP_MOCK_UPDATE_PORT>` into the app, with the same manifest names. `scripts/mock-update-server.ts` serves a folder of release files: the manifests, the zips and their blockmaps. A manifest keeps the `releaseNotes` its build wrote with `--release-notes`. One with none gets fake notes in the release body format, or the ones in `--notes <file.json>` (`[{"version","note"}]`, newest first; `[]` for a release with no notes). `--throttle <KB/s>` slows downloads so the progress can be watched, `--latency <ms>` holds every answer so **Checking** stays on screen, and `/` lists the folder, which is where the app's "All releases" link points. To try the Stable track, put a `latest-mac.yml` in the same folder.

Run the older app from a copy outside the DMG, with its own home and profile, never `~/.prkit`:

```sh
PRKIT_HOME="$PWD/.prkit/update-test" "release/a/mac-arm64/prkit Nightly.app/Contents/MacOS/prkit Nightly" \
  --user-data-dir="$PWD/.prkit/update-test/electron"
```
