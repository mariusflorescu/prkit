# Command line

Settings > Outside agents installs the app's CLI launcher link and offers the terminal installer for the prkit-cli skill. Shell commands use the same outside tools, discovery and access levels as MCP. The client never starts the server or writes to GitHub.

## Sub-features

- `cli.install`: safe link installation, missing PATH instructions, uninstall and foreign-file refusal.
- `cli.skill`: the build-matched, pinned skill command and a request to open Terminal.
- `cli.tools`: schema-derived help and flags, human output, JSON parity, exit codes and client provenance.
- `cli.sandbox`: loopback access with and without Codex sandbox network access.

## How to get to it (user POV)

- Settings (Cmd+,) > Outside agents > Command line > Install command line tool.
- Cmd+K > search `Install command line tool` > Enter.
- Settings > Outside agents > Teach your coding agent > Open skill installer in Terminal, or Copy.
- A terminal: `prkit --help`, `prkit status`, `prkit inbox`, then PR, guide, comments and fix commands.

## Driving it with e2e

Preconditions: `pnpm build`. All install journeys set `PRKIT_CLI_INSTALL_PATH` under their fake GitHub's temporary HOME. The terminal launcher is a stand-in. Never run npx or open Terminal during verification.

- **Install:** `pnpm e2e run tests/cli.e2e.ts --trace=on --output .e2e/proof/u71`. The journey opens `screen.getByRole("link", "Outside agents")`, then `screen.getByRole("button", "Install command line tool", { exact: true })`. The link resolves to this instance's `bin/prkit`; Settings reports `Installed · Not on PATH` and offers Copy for the PATH line.
- **Skill:** `screen.getByRole("button", "Open skill installer in Terminal")` produces a stand-in call containing the pinned npx command. No agent skill folder is written.
- **Commands:** the journey runs the launcher in a temporary HOME. Inbox JSON equals the MCP tool's structured result; `--reason review-requested` and `--reason authored` each return the requested group. Agent discovery and repository PR reads use the same fake account. A stand-in agent completes a guide with versioned focus and guidance JSON and `--stack this` from local git objects; draft comments go to a fix turn with `prkit CLI` provenance. Help, completions, invalid usage, closed/off access and read-only refusal are checked. The home lock is unchanged and fake GitHub writes are empty.
- **Paging:** `prkit pr files` with `--limit 1` matches MCP JSON, follows `nextCursor` to the second file and prints the continuation in human output. The journey runs that printed command through a shell with the PR target after `--` and checks the second file. A large conversation is read as response fragments using `nextResponseCursor`; joining their text by offset reconstructs the complete JSON without omissions.
- **Command and documentation parity:** `pnpm exec vp test --run apps/server/src/cli/commands.test.ts apps/server/src/cli/documentation.test.ts` checks all 52 real tools and validates every fenced or inline command in `skills/prkit-cli/**/*.md` and `docs/features/cli.md` against the shared command map and schema-derived flags. Failures name the file, line and unknown command or flag.
- **Argument regressions:** `pnpm exec vp test --run apps/server/src/cli/runtime.test.ts apps/server/src/cli/output.test.ts` rejects repeated stack selection and numbered stacks combined with layers before any connection. It executes printed page and response-fragment continuations through a shell and the real CLI parser, with and without a `--` terminator; output checks also preserve flag-shaped positional words.
- **Foreign file:** uninstall, create a regular file at the test's override, then `screen.getByRole("button", "Check again")`. `Another file uses this location` appears, Install is disabled, and the contents stay identical.
- **Unsafe launcher folder:** the same file has a journey with a planted `bin` symlink and two foreign launchers. The app starts, both setup blocks show the folder problem, Install is disabled, discovery remains available and both target files retain contents and modes. Screenshots `cli-unsafe-launcher-off` and `cli-unsafe-launcher-on` capture access off and on.
- **Filesystem regressions:** `pnpm exec vp test --run apps/server/src/cli/CliInstall.test.ts apps/server/src/outside/OutsideAgents.test.ts` checks owner-only folder selection, refusal of unsafe overrides, restoration of a file swapped in during uninstall, and atomic replacement of both planted launcher symlinks without touching their targets.
- **Trusted paths:** `pnpm exec vp test --run apps/server/src/trustedFolder.test.ts` covers ancestor checks before creation, root-owned sticky directories and system aliases, and final-folder ownership. Install regressions also check unsafe parents, user-owned ancestor links, exclusive restoration collisions and the recovery command.
- **Interruption:** `pnpm exec vp test --run apps/server/src/cli/signal.test.ts` sends SIGINT and SIGTERM to real CLI children waiting on a local HTTP peer. Requests are canceled, one session DELETE arrives, and the child exits 130. No guide or fix is stopped.
- **Sandbox:** opt in locally with `PRKIT_E2E_CLI_SANDBOX=1` before the same targeted command. Requires Codex installed; it executes only `codex sandbox`, without a login or a model. Raw outputs are saved under `.e2e/evidence/u71/sandbox-network-*.txt`.
- **Evidence:** screenshots before and after install and for a foreign file are in the run's screenshots folder; the complete shell transcript is `.e2e/evidence/u71/cli-transcript.txt`. A startup measurement is saved only with no active match and a one-minute load below 10.

## Gotchas

- No real HOME, agent configuration, system bin directory or shell profile belongs in an install test. Set the install override even when the temporary HOME would otherwise provide isolation.
- The fake GitHub's API has no git server. `tests/cliFixture.ts` creates real local objects and intercepts fetches in the test PATH; it refuses pushes and clones. The API's head is set to the same local commit.
- `--no-focus` keeps the Settings view available while opening a PR tab. A normal `pr open` brings the PR forward.
- `wait` succeeds when the tool answers, including an agent failure or timeout. Inspect its returned state before claiming the agent's work succeeded.
- Inbox reason filters and guide focus/stack flags follow the outside tool schemas. New tools need an entry in `apps/server/src/cli/commands.ts`; the parity test enforces that.
