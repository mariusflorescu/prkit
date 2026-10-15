# Command line

Settings > Outside agents > Command line installs `prkit` for terminals, scripts and coding agents. The command palette also offers **Install command line tool**. Open prkit and turn Outside agents on before using it. Read only permits reads; Read and start work also permits guides, local draft comments and fix turns.

The CLI calls the existing `/mcp/outside` tools. It uses the bridge's trusted discovery-file reader and sends `prkit CLI` as its client name. Work appears in the app as **Started from prkit CLI**. It never starts the app, opens the database or takes the home lock. The MCP bridge remains available separately.

## Installation

The server writes its owner-only launcher at `$PRKIT_HOME/bin/prkit` on every launch. The installed link follows that launcher across app updates. In a packaged app the launcher uses the app's own Electron binary in Node mode, with the server entry's `cli` fast path.

On macOS the link goes in `/usr/local/bin/prkit` when that directory is owned by the current user, writable without administrator access, and reached through trusted folders. Otherwise it goes in `$HOME/.local/bin/prkit`. `PRKIT_CLI_INSTALL_PATH` overrides the complete destination path, which must be absolute and end in `prkit`. The same checks apply to the override's folder. A missing folder is created with mode 0755 and checked again. Verification always sets this override inside a temporary HOME.

One check protects both the install folder and `$PRKIT_HOME/bin`. Every folder component must be owned by root or the current user, without group or other write access. Root-owned sticky directories are allowed. Only root-owned symlinks are followed, and their targets are checked too. The final folder must be owned by and writable by the current user. Unsafe launcher folders leave the app running; Settings shows the problem in both setup blocks and refuses installation until the folder is fixed and prkit restarted.

These checks protect against planted entries and write access held by other local users. Processes already running as the same user are outside this boundary.

prkit checks its process PATH and macOS's `/etc/paths`; it never executes a shell or reads startup files for this check. A terminal with a customized PATH may differ. When the folder is missing from both, Settings shows the exact `export PATH=...` line with Copy. Add it to your own shell profile and open a new terminal. prkit never edits profiles or requests administrator access.

An existing file, directory or foreign link is shown and left alone. Uninstall moves the entry aside and checks it again before deleting only a link targeting this home's launcher. If the entry changed, prkit restores regular files or symlinks without replacing anything at the original path. A blocked restore or another entry type stays at the recovery path; the error names both paths and gives the exact `mv` command for manual recovery. Uninstalling the command leaves the app and its data in place.

## Commands

Run `prkit --help` or help on any subcommand for the installed version's flags. `--version` and `--completions bash|zsh|fish|sh` work while the app is closed.

```sh
prkit status --json
prkit inbox --account github.com/octocat --json
prkit open-prs
prkit pr read acme/widgets#42
prkit pr open acme/widgets#42 --no-focus
prkit guide generate acme/widgets#42 --agent claude --model MODEL --option effort=high
prkit wait acme/widgets#42 --for guide --timeout 600
prkit guide read acme/widgets#42
prkit comments list acme/widgets#42
prkit comments add acme/widgets#42 --path src/a.ts --line 42 --body 'Handle an empty list' --request-id comment-42
prkit fix send acme/widgets#42 --request-id fix-42
prkit wait acme/widgets#42 --for fix --timeout 600
prkit fix read acme/widgets#42 --json
prkit fix change acme/widgets#42 --instructions 'Keep the existing name' --request-id change-42
prkit fix resolve acme/widgets#42 --strategy merge
```

Also available: `guide stop`, `fix stop` and `fix retry`. PRs accept HTTPS URLs or `owner/repo#number`, with `--host` for an Enterprise host. `--account` selects the account when prkit asks for one. Repeated `--option id=value` flags select model options; `true` and `false` are booleans. Repeated `--draft-ids` and `--thread-ids` select particular comments for `fix send`.

`apps/server/src/cli/commands.ts` is the command map. Flags and validation come from each outside tool's parameter schema; the parity test fails when a tool has no command or a command has no tool. As outside tools acquire filters or new options, their commands acquire those flags. A new tool needs a map entry.

Plain output uses tables and labelled fields, without terminal color codes. `--json` returns the tool's structured result unchanged on stdout; failures go to stderr. Exit codes are 0 for success, 1 for a tool or protocol failure, 2 for invalid usage, 3 for a closed app, Outside agents off or an unreachable app (including a sandbox), 4 for insufficient access, and 130 for interruption by SIGINT or SIGTERM. Interruption cancels the HTTP request and closes the MCP session; it never stops guide or fix work. `wait` returning `finished: false` is a successful timeout, not a failed guide, and never stops work.

A disconnected action is never automatically replayed, since it may already have run. Use the same `--request-id` to retry `comments add`, `fix send` or `fix change` safely. Authentication rejections before dispatch may reconnect once using the new discovery file. Each CLI invocation closes its MCP session before exiting.

The CLI offers no push, merge, posting, thread resolution, account or agent setup, settings changes, discard or revert commands. Client-started fixes wait for Push in the app. The repository's existing opt-in automatic conflict watcher remains independent: when automatic resolution and automatic push are both on, the watcher may still resolve and push a conflicting PR it watches.

## The coding agent skill

The public skill is `skills/prkit-cli/SKILL.md`, separate from the repository's own verification skills. Settings shows a pinned `npx skills@1.7.2 add ... --skill prkit-cli` command and an **Open skill installer in Terminal** action. The terminal installer asks which agents should receive the skill. prkit itself writes no skill files and runs no package installer.

The skill URL takes the repository from `GITHUB_REPOSITORY` at build time, or the git origin remote. CI reads the checked-out git HEAD for the exact build commit, including stable promotions of an earlier nightly; development builds use `main`. No repository slug is hardcoded in source. If source metadata is unavailable, Settings explains that the skill command needs a release build or `GITHUB_REPOSITORY` during the build. Run the installer again to update the skill. The installed CLI's help is always authoritative for flags.

## Coding agent sandboxes

The CLI needs a loopback HTTP connection. Codex's workspace sandbox normally disables network, including loopback; allowing network for workspace commands keeps filesystem isolation. The legacy configuration is `[sandbox_workspace_write] network_access = true`; current permission profiles may govern network instead. See the [official Codex security documentation](https://learn.chatgpt.com/docs/security). A connection failure exits 3 and explains the sandbox requirement. Discovery must also be readable within the sandbox.

Claude Code Bash runs without its sandbox unless that feature is enabled. With sandboxing enabled, localhost connections may need permission under the sandbox's network settings or approval to run the command outside it. Allowing a local bind concerns listening sockets, not the CLI's outgoing connection. See [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing). prkit never changes either agent's configuration.

Verification uses only a temporary HOME and Codex's local `sandbox` command, without signing in or running a model. Current Codex versions use `codex sandbox COMMAND`; older versions used `codex sandbox macos COMMAND`. Raw results and the measured `prkit status` startup time belong in `.e2e/evidence/u71/` for the verification run, together with its `uptime` and one-minute load.
