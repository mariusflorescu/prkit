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
| `--keep-stage` | off | Keep the temporary stage directory and print its path. |
| `--verbose` | off | Stream the build and electron-builder output. |

Progress goes to stderr. The last line on stdout is one JSON object: `{"version","channel","arch","signed","files":[absolute paths]}`. The exit code is non-zero on any failure.

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
| `PRKIT_DESKTOP_UPDATE_REPOSITORY` | `owner/repo` of the update feed, else `GITHUB_REPOSITORY`. With neither, the app has no `app-update.yml`, no update manifest is written, and the build says so in one line. |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | The Developer ID Application certificate (.p12) and its password. |
| `APPLE_TEAM_ID` | The team the certificate belongs to. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | The App Store Connect API key (path to the .p8), its id and issuer. electron-builder notarizes when they are set. |

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
