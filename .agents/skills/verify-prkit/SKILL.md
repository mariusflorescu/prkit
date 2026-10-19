---
name: verify-prkit
description: Launch an isolated prkit instance (the built server serving the built web UI), check it is worth driving, drive it like a user with e2e (live over `e2e mcp`, or scripted with `pnpm e2e run`), and keep screenshots, videos and logs as evidence. Use before claiming any prkit UI or server change works, when asked to verify, screenshot, record or demo prkit, when a feature needs a new e2e journey, or when an Electron-only change needs the desktop smoke.
---

# Verify prkit

The Electron window, a browser and the e2e browser all load the same page: the web UI that the prkit server serves. This skill runs that page from the build, in a home of its own, drives it with [e2e](https://e2e.tester.army/docs), and keeps the proof. `pnpm exec e2e guide <topic>` prints e2e's reference (`mcp`, `writing-tests`, `running`, `debugging`). This file says only what is true of prkit.

- `scripts/verify-app.ts` starts, checks and stops instances. An instance has a name, a home at `.e2e/homes/<name>`, a server log at `.e2e/logs/<name>.log`, and a run file at `.e2e/run/<name>.json` holding `name`, `pid` (the supervisor), `serverPid`, `port`, `url`, `openUrl`, `token`, `home` and `log`.
- `e2e.config.ts` has one target, `web`. Its app command is the supervisor with `--name e2e-{port} --rm`, so every `pnpm e2e run` and every MCP session gets a fresh instance that is deleted when it stops.
- `tests/*.e2e.ts` hold the scripted journeys. [features/README.md](features/README.md) maps what to drive.

## Launch

The supervisor builds nothing. It refuses to start until `apps/server/dist/bin.mjs`, `apps/server/dist/build.json`, and `apps/web/dist/index.html` exist.

```bash
pnpm build
```

`pnpm e2e run` and `open_session` start and stop their own instance; skip to Drive. Start one by hand for curl, your own browser script, a look inside the home, or a restart check:

```bash
pnpm verify:app start --name verify --detach
```

It returns once `GET /health` answers and prints `ready: http://127.0.0.1:<port>/?token=<token>`, the run file, both pids and the log path. Without `--detach` it stays in the foreground until Ctrl-C. `--rm` starts from an empty home and deletes it on exit. Without `--rm` the home survives a stop and start under the same name, which is how you prove state survives a restart (`stop --keep-home`, then `start` again).

The UI needs `openUrl` (`/?token=...`) on its first load. It keeps the token in sessionStorage and strips it from the address bar. A page opened at `url` alone shows the missing-token error in the footer.

- Instances never share a port or a home, so several run side by side (`--name a`, `--name b`). `start` refuses a name whose recorded processes are still alive.
- Verification state lives only under `.e2e/`. Never point an instance at `~/.prkit` or the worktree's `.prkit/`.
- The server reads the real GitHub accounts on this machine (`~/.config/gh` and every `~/.config/gh-*`). Never drive an action that writes to GitHub outside the fixture repository.
- The fixture repository is yours, so it lives in the gitignored `.e2e/local.json` as `{ "fixtureRepo": "<owner>/<name>" }`, never in tracked files. A linked worktree reads the main checkout's copy. Journeys that drive it skip with that hint when the file is missing; the fake-GitHub journeys run anyway. Accounts are never named either: a journey that needs a second one picks it from the Inbox's account filter (`chooseOtherAccount` in `tests/pickers.ts`, which first counts the accounts in Settings > Accounts) and skips when there is only one.
- `pnpm check:private` (part of `pnpm lint`) fails on any login of a gh account on this machine, any name in the gitignored `.private-names`, or your home path in a file of the repository. It prints only file, line and category. `node scripts/check-private.ts <file>` checks just that file, such as a PR body draft. `pnpm exec vp hooks enable` runs it before every commit, on the working tree and on the message.
- The supervisor drops `PRKIT_*`, `GH_TOKEN` and `GITHUB_TOKEN` from the server's environment, so a token in your shell cannot switch accounts.

## Doctor

Run it before driving and whenever something looks off.

```bash
pnpm verify:app doctor --name verify   # one instance
pnpm verify:app doctor                 # every run file in .e2e/run/, MCP session instances included
pnpm exec e2e list                     # loads e2e.config.ts and the tests, starts nothing
```

Doctor exits 0 only when all of these hold:

- the supervisor and server pids from the run file are alive and still run `scripts/verify-app.ts` and `apps/server/dist/bin.mjs`;
- `GET /health` answers `ok` with the version in `apps/server/package.json`, this instance's home, and the embedded build id from `apps/server/dist/build.json`;
- `GET /` serves the built UI.

It also prints `openUrl` and the log path. A FAIL on a pid means a stale run file; run `stop` for that name. A wrong home means the port belongs to another instance. A missing UI means the build is absent. A build-id mismatch means the running server predates the bundle on disk. Stop it and start again after rebuilding. Doctor compares builds, not source edits that you have not built.

## Drive

**Live, over `e2e mcp`.** Use it to look around, check locators before writing them, and record a demo. `.mcp.json` registers the server for Claude Code. Elsewhere, register `node_modules/.bin/e2e mcp` with `DO_NOT_TRACK=1` (`claude mcp add e2e -e DO_NOT_TRACK=1 -- node_modules/.bin/e2e mcp`) and start a new session. Never register `pnpm exec e2e mcp`: pnpm can print install notices on stdout, which breaks the protocol.

1. `open_session` with no arguments. It starts an instance and answers with `App: http://127.0.0.1:<port>/.`, the catalog, and the first screen, which is the missing-token state.
2. `pnpm verify:app doctor` lists that instance as `e2e-<port>` with its `openUrl`. Then `call {tool: "navigate", args: {url: "<openUrl>"}}`.
3. `call {tool: "observe"}`, then act on node ids from the newest screen: `call {tool: "tap", args: {target: "n12006"}}`. Ids change with every screen.
4. `call {tool: "locate", args: {role: "button", name: "Refresh inbox"}}` before you write a locator. It prints the `screen.getBy...` call to use.
5. `call {tool: "screenshot"}` returns a 768x432 image to you and saves no file. Keep what you need in `.e2e/evidence/<unit>/`.
6. `call {tool: "start_recording", args: {name: "<slug>"}}`, act, then `call {tool: "stop_recording"}`. The video lands in `.e2e/videos/<session>/<n>-<slug>.webm`.
7. `close_session` stops the instance and deletes its home.

A live session and `pnpm e2e run` start separate instances, so both can run at once.

**Scripted, `pnpm e2e run`.** Use it for proof that must keep holding. Write `tests/<feature>.e2e.ts` and open the app signed in like this:

```ts
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";

test("the inbox lists the fixture PR", async ({ app, screen }) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
});
```

```bash
pnpm e2e run                                   # default journeys; agent tests skip
pnpm e2e run tests/shell.e2e.ts                # one file
pnpm e2e run tests/shell.e2e.ts --trace=on --video=on --output .e2e/proof/<name>
```

- `app.screenshot("<name>")` saves a named frame.
- No model is configured, so `agent.*` steps fail with `MODEL_UNAVAILABLE`. Use `screen` locators and `expect`. Never add a model or an API key.
- Real Claude journeys use `PRKIT_E2E_AGENT=1 --tag agent`; Codex uses `PRKIT_E2E_CODEX=1 --tag codex`; the timing runs use `--tag timing` with the flag of the agent they time. [features/README.md](features/README.md) names the journeys behind each tag. Put the environment flag before `pnpm e2e run`. Run each separately and reserve fixtures before any journey that writes to GitHub. The default suite sets no flag.
- The DEV Guide viewer requires `PRKIT_GUIDE_URL`; the built app excludes that route.
- `app.open` and `browser.reload` can return while the boot splash still shows. A locator step waits for its target, but a key press sent then goes nowhere and a `toHaveCount(0)` passes at once. Send app shortcuts with `pressShortcut(screen, browser, key)` from `tests/shortcut.ts`, which waits for the Inbox tab first.
- Names match exactly: `getByRole("button", "Refresh inbox")` misses `Refresh pull request`.
- `--trace` and `--video` read the next argument as their value. Write `--trace=on`, or put the files first.
- The first run downloads Chrome Headless Shell (about 95 MB) into `~/Library/Caches/ms-playwright`.

**Your own browser script.** For a flow e2e cannot express, start an instance by hand and open `openUrl` with Playwright. Launch Chrome for Testing (`~/.cache/puppeteer/chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`) with `--use-mock-keychain`, or macOS shows a keychain prompt. Keep such scripts in `.e2e/scripts/`.

**Desktop.** Only for what exists in Electron alone: the window, the preload bridge, the server child's lifecycle.

```bash
pnpm build && pnpm smoke:desktop
```

It launches the built app with `PRKIT_HOME=.e2e/smoke-home`, waits for the app and the server-info footer, saves `.e2e/evidence/desktop-smoke.png`, and checks that quitting stops the server child. `pnpm smoke:desktop --app <path to .app>` runs the same checks against a packaged app; see [Desktop app](./features/desktop-app.md).

## Evidence

| What                         | Where                                                                           | Kept until              |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------- |
| Named screenshots from tests | `.e2e/results/<test>/attempt-<n>/screenshots/`                                  | the next `pnpm e2e run` |
| Trace pages                  | `.e2e/results/<test>/trace.md`, failed tests only unless `--trace=on`           | the next `pnpm e2e run` |
| Run videos                   | `.e2e/results/<test>/attempt-<n>/video/`, failed tests only unless `--video=on` | the next `pnpm e2e run` |
| Run report                   | `.e2e/report.json`                                                              | the next `pnpm e2e run` |
| Live recordings              | `.e2e/videos/<session>/`                                                        | you delete them         |
| Server logs                  | `.e2e/logs/<name>.log`, and e2e's launch log `.e2e/logs/e2e-runner.log`         | you delete them         |
| Proof you keep               | `.e2e/evidence/<unit>/`, or a run with `--output .e2e/proof/<name>`             | you delete them         |

Every `pnpm e2e run` clears `.e2e/results/` when its tests start. Copy what you need into `.e2e/evidence/<unit>/` first, or run with `--output`.

- Drive the user's path: open PRs are tabs, then use the feature's button or route. Never call an RPC, edit SQLite, or set state from a test to get there.
- Capture the action and the state after it, not only the final screen: a screenshot on each side, or a recording.
- Check side effects as well as the screen. Server state is in `<home>/prkit.sqlite`; read it with `sqlite3 -readonly` before cleanup, or show it through a second view, such as the same screen after a restart with `--keep-home`.
- A UI change needs a screenshot. Motion or timing needs a recording.
- Name the feature from the map and the entry point used next to each artifact. An entry point you could not reach is reported as skipped, with the reason.

## Cleanup

```bash
pnpm verify:app stop --name verify               # stop it and delete .e2e/homes/verify
pnpm verify:app stop --name verify --keep-home   # stop it, keep the home to inspect
```

`stop` sends SIGTERM to the recorded supervisor, which stops its server; after 10 seconds it sends SIGKILL to whichever recorded pid is still alive. It signals a recorded pid only while `ps` shows it still runs the supervisor or the server bundle, so a reused pid is never touched. Running it twice is safe. `pnpm e2e run` and `close_session` clean up their own instances.

Never `pkill`, `killall`, or kill a pid you found by name. Cleanup never touches `.e2e/logs/`, `.e2e/evidence/`, `.e2e/videos/`, `.e2e/proof/` or `.e2e/results/`, because that is the proof.

## Helpers

- `pnpm verify:app start|doctor|stop [--name <name>] [--port <n>] [--rm] [--detach] [--keep-home]` runs `node scripts/verify-app.ts`. The default name is `verify`. `start --dev-web-origin <origin>` permits an isolated Vite preview; see [Guide viewer](features/guide-viewer.md). `--watch-interval <milliseconds>` sets the watcher tick for a verification instance; the server keeps it at 60 seconds or more unless `--e2e` is also given (only `e2e.config.ts` passes it). `--github-api <url> --gh-home <dir>` points an instance at `scripts/fake-github.ts` instead of the real accounts; see [GitHub budget](features/github-budget.md). `--claude <file>` runs that file as Claude Code; `tests/fakeClaude.ts` makes a stand-in that writes a guide with no subscription, see [Guide generation](features/guide-generation.md).
- `scripts/verify-run.ts` exports `runForUrl`, `readRun`, `listRuns`, `serverVersion`, and `serverBuildId` for tests and scripts.
- `pnpm e2e run|list|guide` runs the e2e CLI with telemetry off.

When a feature lands, add or update its file under `features/` in the same change. `/maintain-verification-skill` keeps the map honest.
