# Desktop app

The installable macOS app: `prkit.app` (or `prkit Nightly.app`) from `pnpm dist:desktop:artifact`, running the whole product from its bundle with no repository. How it is built, the flags and the environment are in [docs/operations/desktop-build.md](../../../../docs/operations/desktop-build.md).

## Sub-features

- `desktop-artifact` builds the DMG, zip, blockmaps and update manifest, and prints the JSON line.
- `desktop-channels` names, icons and update feed for stable and nightly.
- `desktop-packaged-run` the packaged app starts its server from `app.asar`, in the home folder, with gh, git, claude and codex found from a Dock launch.
- `desktop-one-per-home` a second app or dev run on the same home is refused with a message, and no second server listens.

## How to get to it (user POV)

- Open the DMG and drag the app to Applications, then open it from Launchpad or the Dock.

## Driving it

Preconditions: macOS, `pnpm install`. Each build takes about a minute and needs about 1 GB free on disk.

- **Stable.** `PRKIT_DESKTOP_UPDATE_REPOSITORY=octocat/prkit pnpm dist:desktop:artifact --arch arm64`: `release/` holds `prkit-<version>-arm64.dmg` and `.zip`, both blockmaps and `latest-mac.yml`, and the last stdout line is the JSON object. The app's `Contents/Resources/app-update.yml` names `owner: octocat`, `repo: prkit`, `releaseType: release`.
- **Nightly.** Add `--build-version 0.1.0-nightly.20261014.1`: `prkit Nightly.app`, `nightly-mac.yml`, `app-update.yml` with `channel: nightly` and `releaseType: prerelease`, the DMG volume `prkit Nightly <version>`, and `Contents/Resources/icon.icns` equal to `apps/desktop/build/icon-nightly.icns`.
- **No feed.** Without either repository variable the build prints one `No update feed` line and the app has no `app-update.yml`.
- **Signing.** `--signed` with nothing set exits 1 and names all seven variables.
- **Packaged run.** `hdiutil attach -nobrowse -readonly -mountpoint <dir> <dmg>`, `ditto` the app out, `hdiutil detach`, then `pnpm smoke:desktop --app <path to .app>`. It runs under `.prkit/smoke-app-home`, saves `.e2e/evidence/desktop-smoke-app.png`, and adds: `runs the packaged app`, `no MODULE_NOT_FOUND within 8s`, `<tool> resolves from the rebuilt PATH` for each tool, and `the packaged server runs in the home folder`.
- **One per home.** Start `node scripts/dev-runner.ts dev` (home `.prkit/`), then the packaged executable with `PRKIT_HOME=<checkout>/.prkit` and `--user-data-dir=<checkout>/.prkit/<dir>`: it prints `[desktop] could not start: Another prkit is already running with the data folder …` and shows it in a dialog, and its only server child is gone (`ps` shows it `<defunct>` or absent). The other way round, the dev runner prints `another prkit is already using …` and exits. Stop each process by the PID you started.
- **By hand.** Finder shows the two icons; drag-to-Applications from the DMG window; a second double-click focuses the running window.
