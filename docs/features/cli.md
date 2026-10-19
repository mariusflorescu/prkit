# Command line

Settings > Outside agents > Command line installs the CLI for terminals, scripts and coding agents. The command palette also offers **Install command line tool**. Open prkit and turn Outside agents on before using it. Read only permits reads; Read and start work also permits guides (of pull requests and of local changes), fix turns, local tabs and drafts, reviewed-file marks, questions about a guide, saved inbox filters and PR-scope guide settings.

The CLI calls the existing `/mcp/outside` tools. It uses the bridge's trusted discovery-file reader and sends **prkit CLI** as its client name. Work appears in the app as **Started from prkit CLI**. It never starts the app, opens the database or takes the home lock. The MCP bridge remains available separately.

## Installation

The server writes its owner-only launcher at `$PRKIT_HOME/bin/prkit` on every launch. The installed link follows that launcher across app updates. In a packaged app the launcher uses the app's own Electron binary in Node mode, with the server entry's `cli` fast path.

On macOS the link goes in `/usr/local/bin/prkit` when that directory is owned by the current user, writable without administrator access, and reached through trusted folders. Otherwise it goes in `$HOME/.local/bin/prkit`. `PRKIT_CLI_INSTALL_PATH` overrides the complete destination path, which must be absolute and end in `prkit`. The same checks apply to the override's folder. A missing folder is created with mode 0755 and checked again. Verification always sets this override inside a temporary HOME.

One check protects both the install folder and `$PRKIT_HOME/bin`. Every folder component must be owned by root or the current user, without group or other write access. Root-owned sticky directories are allowed. Only root-owned symlinks are followed, and their targets are checked too. The final folder must be owned by and writable by the current user. Unsafe launcher folders leave the app running; Settings shows the problem in both setup blocks and refuses installation until the folder is fixed and prkit restarted.

These checks protect against planted entries and write access held by other local users. Processes already running as the same user are outside this boundary.

prkit checks its process PATH and macOS's `/etc/paths`; it never executes a shell or reads startup files for this check. A terminal with a customized PATH may differ. When the folder is missing from both, Settings shows the exact `export PATH=...` line with Copy. Add it to your own shell profile and open a new terminal. prkit never edits profiles or requests administrator access.

An existing file, directory or foreign link is shown and left alone. Uninstall moves the entry aside and checks it again before deleting only a link targeting this home's launcher. If the entry changed, prkit restores regular files or symlinks without replacing anything at the original path. A blocked restore or another entry type stays at the recovery path; the error names both paths and gives the exact `mv` command for manual recovery. Uninstalling the command leaves the app and its data in place.

## Commands

Run `prkit --help` or help on any subcommand for the installed version's flags. `prkit --version` and `prkit --completions zsh` work while the app is closed; completion shells are bash, zsh, fish and sh. The [skill's command reference](../../skills/prkit-cli/references/commands.md) covers every outside tool, including less common reads and JSON settings inputs.

```sh
prkit status --json
prkit accounts --json
prkit agents --json
prkit inbox --reason review-requested --account github.com/octocat --json
prkit inbox --reason authored --repo acme/widgets --json
prkit inbox --reason review-requested --sort waiting --json
prkit inbox --sort size --json
prkit inbox --reason review-requested --sort risk --json
prkit inbox filters save --search "" --account null --repo null --sort waiting --json
prkit repos list --json
prkit repos prs acme/widgets --account github.com/octocat --json
prkit tabs list --json
prkit pr read acme/widgets#42 --json
prkit pr files acme/widgets#42 --limit 20 --json
prkit pr files acme/widgets#42 --limit 20 --cursor '<nextCursor>' --json
prkit pr file acme/widgets#42 --path src/a.ts --side new --json
prkit pr reviewed acme/widgets#42 --json
prkit pr reviewed set acme/widgets#42 --head-sha <headSha> --paths src/a.ts --paths src/b.ts
prkit pr reviewed set acme/widgets#42 --head-sha <headSha> --paths src/a.ts --no-reviewed
prkit guide tick acme/widgets#42 --revision 2 --steps 1 --steps 3
prkit pr threads acme/widgets#42 --json
prkit pr checks acme/widgets#42 --json
prkit pr stack acme/widgets#42 --json
prkit guide generate acme/widgets#42 --agent <instance> --model <model> --option effort=high --stack this
prkit wait acme/widgets#42 --for guide --timeout 600
prkit guide read acme/widgets#42 --json
prkit guide revisions acme/widgets#42 --json
prkit questions ask acme/widgets#42 --question 'Why does the retry stop after three tries?' --request-id ask-42
prkit questions wait acme/widgets#42 --question-id <question-id> --timeout 600
prkit questions list acme/widgets#42 --json
prkit questions pin acme/widgets#42 --question-id <question-id> --pinned
prkit pr diff acme/widgets#42 --attempt-id <attempt-id> --json
prkit comments list acme/widgets#42 --json
prkit comments add acme/widgets#42 --path src/a.ts --line 42 --head-sha <headSha> --body 'Handle an empty list' --request-id comment-42
prkit fix send acme/widgets#42 --request-id fix-42
prkit wait acme/widgets#42 --for fix --timeout 600
prkit fix read acme/widgets#42 --json
prkit fix diff acme/widgets#42 --turn-id <turn-id> --json
prkit fix change acme/widgets#42 --instructions 'Keep the existing name' --request-id change-42
prkit fix resolve acme/widgets#42 --strategy merge
prkit pr open acme/widgets#42 --no-focus
prkit tabs focus acme/widgets#42
prkit local guide --description 'Raise the limit and add a flag for it'
prkit local wait --timeout 600
prkit local read --json
prkit local guide --path ~/code/widgets --branch feature/limits --base main
prkit local questions ask --question 'Why is the limit read at startup?' --request-id ask-limit
prkit local questions wait --question-id <question-id> --timeout 600
prkit local questions list --json
prkit local questions pin --question-id <question-id> --pinned
```

The command tree covers all 70 tools: status, accounts, agents, settings, inbox (and filters save), repos list/prs, pr read/files/file/timeline/threads/checks/conversation/stack/candidates/diff/open/reviewed (and reviewed set), guide list/read/generate/stop/revisions/revision/progress/duration/settings/scope/repositories/repository/tick, guide settings save, questions list/ask/wait/stop/pin, fix list/read/turn/diff/patch/access/send/change/stop/retry/resolve, comments list/add/edit/move, tabs list/close/focus/reorder, local guide/read/wait/stop/list, local questions list/ask/wait/stop/pin, and wait.

PRs accept HTTPS URLs or `owner/repo#number`, with `--host` for an Enterprise short form. Repository commands take `owner/repo`. `--account` selects the account when prkit asks for one; never switch accounts to work around a failure. Inbox `--repo owner/repo` selects a repository on github.com; quoted JSON with `host`, `owner` and `name` selects an Enterprise repository. Inbox also accepts reason, state, draft, checks, search and stacks selectors, and `--sort updated|waiting|size|risk` for the order of each section (`updated` when omitted). These read filters do not change the app's saved filters. `prkit inbox filters save` replaces the saved search, account, repository and sort together, so it needs all four.

Pick a ready, enabled agent instance from the paged `prkit agents --json` result, an unblocked model's slug, and only the option ids and values that model advertises. Repeated `--option id=value` flags select options; `true` and `false` are booleans. Repeated `--draft-ids` and `--thread-ids` select comments for fix send. Repeated `--paths` name the files for `pr reviewed set`, which marks them reviewed or, with `--no-reviewed`, not reviewed; repeating it changes nothing. Its `--head-sha` is the `headSha` that `prkit pr reviewed --json` returned. If the PR moved since, nothing is marked and it fails with `conflict`. The marks stay in prkit and never reach GitHub. `guide tick` ticks steps of a guide revision's manual check plan by number, read from `prkit guide read --json` or `prkit guide revision --json`, or unticks them with `--no-ticked`; repeating it changes nothing.

`prkit local` writes guides of a repository's changes before a pull request exists. Every local command takes the working directory unless it gets `--key` or `--path`; the folder's repository and current branch name the review, so a subfolder or another worktree of the same branch finds the same one. `prkit local guide` snapshots the working tree (commits since the base, staged, unstaged and untracked files), or with `--branch` a branch's last commit, into a copy prkit owns, and starts the guide. It reads the repository without changing it or running anything its config names. A problem with the repository (not one, nothing changed, no base, no shared history, files changing mid-read) exits 1 with the reason before anything starts, and a run with nothing new since the last revision says so and starts no agent. Plain output says what happened in a line and which command follows it. `prkit local wait` has the same long timeout as `prkit wait`.

`prkit local questions` asks the guide's agent about local changes, from the same folder or with `--key` or `--path`. `prkit local questions ask --question '...'` answers about all the changes on the latest accepted guide revision, unless `--scope` names a chapter (`{"_tag":"chapter","chapterId":"..."}`, ids from `prkit local read --json`) or diff lines (`{"_tag":"lines","anchor":{...}}`, as for a pull request) or `--revision` another revision. It returns the question's id at once; one question per local review is answered at a time. `prkit local questions wait --question-id <question-id>` waits for that question until it is answered, stopped or failed, with the same long timeout as `prkit local wait`, and `prkit local questions list --json` reads the answers. `stop` keeps the text written so far, `pin` with `--pinned` or `--no-pinned` pins an answered question to its chapter in prkit, and asking again retries a stopped or failed question. A review with no guide yet fails with that reason. Removing the review in the app removes its questions.

For guides, read stack layers first. `--stack this` maps to this PR, `--stack all` to the whole stack, and `--stack 1,3` to chosen layer numbers. Use `--stack` once; numbered selection cannot be combined with `--layers`. The native values `this-pr`, `whole-stack` and `chosen-layers` also work, with repeated `--layers` for the last. `--regenerate` includes layers with guides. `--guidance` and `--focus` accept versioned JSON section edits, not plain strings. Read `prkit guide settings acme/widgets#42 --json` first and use the PR section's current version as `expectedVersion`; a stale version is refused. The command reference shows the full JSON shapes and the standalone PR settings save.

To ask the guide's agent about a PR, run `prkit questions ask acme/widgets#42 --question 'Why does the retry stop after three tries?'`. It answers about the whole pull request on the latest accepted guide revision, unless `--scope` names a chapter or diff lines, or `--revision` another revision. Chapter ids come from `prkit guide read acme/widgets#42 --json`.

```sh
prkit questions ask acme/widgets#42 --scope '{"_tag":"chapter","chapterId":"retries"}' --question 'Is the delay capped?'
prkit questions ask acme/widgets#42 --revision 1 --scope '{"_tag":"lines","anchor":{"path":"src/retry.ts","start":{"side":"new","line":12},"end":{"side":"new","line":18}}}' --question 'What happens at the last attempt?'
```

It returns the question's id at once. `prkit questions wait acme/widgets#42 --question-id <question-id>` follows that one question until it is answered, stopped or failed and returns it with its answer, and `prkit questions list acme/widgets#42 --json` reads them all. One question is answered at a time, so asking while another is being answered fails. `prkit questions stop acme/widgets#42 --question-id <question-id>` keeps the text written so far. `prkit questions pin` with `--pinned` or `--no-pinned` pins an answered question to its chapter in the guide, in prkit only. Asking again retries a stopped or failed question.

`apps/server/src/cli/commands.ts` is the command map. Flags and validation come from each outside tool's parameter schema; the parity test fails when a tool has no command or a command has no tool. As outside tools acquire filters or new options, their commands acquire those flags. A new tool needs a map entry.

The documentation drift test extracts command snippets from the public skill and its references, plus this document, then checks their command paths and flags against that map. Failures name the file, line and unrecognized command or flag.

## Paging and output

Paged reads take `--limit` from 1 to 100 and `--cursor`. Repeat the same command, target and filters with `nextCursor` verbatim until it is null. Plain output prints how to request the next page. File patch fragments for one path have `offset` and `complete`; join their text in offset order. File contents and fix patches are text pages joined by offset. A true `githubTruncated` or `threadsTruncated` means upstream data is missing even after local paging is finished. The current PR diff comes from PR files; PR diff with an attempt id is the immutable guide snapshot.

Flags go before a `--` terminator, as in `prkit pr files --limit 20 -- acme/widgets#42`. Printed continuation commands keep the cursor flag before it and preserve the positional target.

Any large answer can be an outer `response-fragment`. Keep the logical page's cursor and arguments unchanged and use `nextResponseCursor` as `--response-cursor`. Join `text` fragments by `offset` and parse the complete JSON before following its `nextCursor`. The response cursor continues one encoded answer; the page cursor advances the list. `--json` preserves each response unchanged so clients can implement both continuations.

Plain output uses tables and labelled fields, without terminal color codes. `--json` returns the tool's structured result unchanged on stdout; failures go to stderr. Exit codes are 0 for success, 1 for a tool or protocol failure, 2 for invalid usage, 3 for a closed app, Outside agents off or an unreachable app (including a sandbox), 4 for insufficient access, and 130 for interruption by SIGINT or SIGTERM. Interruption cancels the HTTP request and closes the MCP session; it never stops guide or fix work. `wait` returning `finished: false` is a successful timeout, not a failed guide, and never stops work.

A disconnected action is never automatically replayed, since it may already have run. Use the same `--request-id` to retry `comments add`, `fix send`, `fix change` or `questions ask` safely. Authentication rejections before dispatch may reconnect once using the new discovery file. Each CLI invocation closes its MCP session before exiting.

The CLI offers no push, merge, posting, thread resolution, account or agent setup, Global or Repository settings changes, discard or revert commands. Reading settings, saving inbox filters and saving PR-scope guide sections are available. Client-started fixes wait for Push in the app. The repository's existing opt-in automatic conflict watcher remains independent: when automatic resolution and automatic push are both on, the watcher may still resolve and push a conflicting PR it watches.

## The coding agent skill

The public skill is `skills/prkit-cli/SKILL.md`, separate from the repository's own verification skills. Settings shows a pinned `npx skills@1.7.2 add ... --skill prkit-cli` command and an **Open skill installer in terminal** action. The terminal installer asks which agents should receive the skill. prkit itself writes no skill files and runs no package installer.

The action opens the user's default terminal. macOS has no setting by that name. It's the app that runs executables (`public.unix-executable`), which Ghostty's "Make Ghostty the Default Terminal" and iTerm2's "Make iTerm2 Default Term" change. prkit writes the command to an owner-only file in a fresh folder under `<home>/terminal/` for each click, which removes itself when it runs, and asks macOS to open it in that app if it's Terminal, Ghostty, iTerm2 or WezTerm, each of which runs an opened executable in the user's shell. Any other default, or one that won't open, gets Terminal, and when Terminal won't open either, Settings says to copy the command. So does a home path with control characters, since a terminal types the path into the shell, where they would act as keys. The toast names the app that opened.

The skill URL takes the repository from `GITHUB_REPOSITORY` at build time, or the git origin remote. CI reads the checked-out git HEAD for the exact build commit, including stable promotions of an earlier nightly; development builds use `main`. No repository slug is hardcoded in source. If source metadata is unavailable, Settings explains that the skill command needs a release build or `GITHUB_REPOSITORY` during the build. Run the installer again to update the skill. The installed CLI's help is always authoritative for flags.

## Coding agent sandboxes

The CLI needs a loopback HTTP connection. Codex's workspace sandbox normally disables network, including loopback; allowing network for workspace commands keeps filesystem isolation. The legacy configuration is `[sandbox_workspace_write] network_access = true`; current permission profiles may govern network instead. See the [official Codex security documentation](https://learn.chatgpt.com/docs/security). A connection failure exits 3 and explains the sandbox requirement. Discovery must also be readable within the sandbox.

Claude Code Bash runs without its sandbox unless that feature is enabled. With sandboxing enabled, localhost connections may need permission under the sandbox's network settings or approval to run the command outside it. Allowing a local bind concerns listening sockets, not the CLI's outgoing connection. See [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing). prkit never changes either agent's configuration.

Verification uses only a temporary HOME and Codex's local `sandbox` command, without signing in or running a model. Current Codex versions use `codex sandbox COMMAND`; older versions used `codex sandbox macos COMMAND`. Raw results and the measured `prkit status` startup time belong in `.e2e/evidence/u71/` for the verification run, together with its `uptime` and one-minute load.
