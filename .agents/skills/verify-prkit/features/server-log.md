# Server log

The installed app's server used to log only to stderr, which a Finder launch throws away. It now also keeps its log in `<home>/logs/server.log`, so a user can share what went wrong. The file rotates before it passes 5 MB (`server.log.1`, `server.log.2`, about 15 MB at most). Every line goes through one redaction before it is written, and no log statement carries a token, an `Authorization` header, prkit's own secrets or the user's code. The log names the user's repositories, GitHub logins and folders (the home, checkouts), and Settings > About says so.

## Sub-features

- `log-file` is `<home>/logs/server.log`: Effect's logfmt lines (`timestamp=... level=WARN fiber=#12 message="..." key=value`), the same entries stderr gets. Dev runs keep it in the worktree's `.prkit/logs/`, journeys in `.e2e/homes/<name>/logs/`.
- `rotation` moves `server.log` to `server.log.1` (and `.1` to `.2`) before a write that would take it past 5 MB.
- `about-log` is Settings > About's `heading "Server log"`: one line on what the log holds, `button "Show log file"` (the desktop app only, it reveals the file in Finder) and `button "Copy recent log"`, which puts the newest whole lines (about 256 KB) on the clipboard and toasts `Copied the recent log`.

## How to get to it (user POV)

- Settings > About, under the version.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. `tests/server-log.e2e.ts` starts its own instance on the fake GitHub, so it needs no fixture repository or lock.

- **Seed.** Before the start, the journey writes a `server.log` just under 5 MB of an earlier run's lines into the instance's home, the fake answers the first inbox read with a 502 and has a malformed pull request (#18).
- **File.** After Retry, `server.log` holds `prkit server listening`, the 502 request and `Left out a pull request prkit can't read` with its `path`; `server.log.1` holds the earlier lines whole; neither holds the fake's token (`fake-token-for-`), a GitHub token shape, an Authorization header, a bearer credential, a 64-hex secret or URL credentials.
- **Copy.** About's Copy recent log toasts and copies the same warning, whole lines, with none of those.
- **Proof.** `pnpm e2e run tests/server-log.e2e.ts --output .e2e/proof/<name>` saves `about-light`, `about-dark` and `about-narrow` (720 px, no sideways scroll).

## Gotchas

- The headless browser refuses clipboard writes; the journey stands in for `navigator.clipboard.writeText` with an init script, as `fix-agent` does.
- Show log file needs the desktop bridge, so the browser journey only checks it is absent; check it by hand in the packaged app.
