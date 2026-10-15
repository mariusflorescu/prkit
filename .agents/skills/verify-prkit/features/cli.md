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
- **Commands:** the journey runs the launcher in a temporary HOME. Inbox JSON equals the MCP tool's structured result. A stand-in agent completes a guide from local git objects; draft comments go to a fix turn with `prkit CLI` provenance. Help, completions, invalid usage, closed/off access and read-only refusal are checked. The home lock is unchanged and fake GitHub writes are empty.
- **Foreign file:** uninstall, create a regular file at the test's override, then `screen.getByRole("button", "Check again")`. `Another file uses this location` appears, Install is disabled, and the contents stay identical.
- **Sandbox:** opt in locally with `PRKIT_E2E_CLI_SANDBOX=1` before the same targeted command. Requires Codex installed; it executes only `codex sandbox`, without a login or a model. Raw outputs are saved under `.e2e/evidence/u71/sandbox-network-*.txt`.
- **Evidence:** screenshots before and after install and for a foreign file are in the run's screenshots folder; the complete shell transcript is `.e2e/evidence/u71/cli-transcript.txt`. A startup measurement is saved only with no active match and a one-minute load below 10.

## Gotchas

- No real HOME, agent configuration, system bin directory or shell profile belongs in an install test. Set the install override even when the temporary HOME would otherwise provide isolation.
- The fake GitHub's API has no git server. `tests/cliFixture.ts` creates real local objects and intercepts fetches in the test PATH; it refuses pushes and clones. The API's head is set to the same local commit.
- `--no-focus` keeps the Settings view available while opening a PR tab. A normal `pr open` brings the PR forward.
- `wait` succeeds when the tool answers, including an agent failure or timeout. Inspect its returned state before claiming the agent's work succeeded.
- Inbox reason filters and guide focus/stack flags follow the outside tool schemas. New tools need an entry in `apps/server/src/cli/commands.ts`; the parity test enforces that.
