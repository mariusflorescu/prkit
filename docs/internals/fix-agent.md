# The fix agent

The guide agent only reads. The fix agent writes: it fixes review comments and resolves merge conflicts on a PR's branch, and the owner decides what reaches GitHub. Both use the same providers (Claude Code or Codex on the user's own login) and the same agent picker, but they are separate sessions with separate checkouts, so a guide never sees a half-made fix and a fix never edits the guide's checkout.

## Sessions and turns

`Fixers` owns one session per PR (`fixers`, unique on the PR key). It stores the account the PR was opened through, the agent instance and model, and the provider's native session id, which every turn resumes. Each turn records the instance it ran on. Picking an instance in another conversation group (another kind, or another config folder; see [Agents](../features/agents.md)) starts a new conversation, and the send form says so; an instance in the same group keeps it. A turn whose instance was turned off or removed runs on its kind's default instance, else the default agent. A session ends when the PR is merged or closed (the fix watcher), or when the owner stops it.

Work arrives as turns (`fixer_turns`), queued per PR:

- `fix`: a batch of comments, prkit's drafts or GitHub review threads, captured as the agent sees them (`c1`, `c2`, ...).
- `conflicts`: merge the base into the head (the default), or rebase onto it.
- `revert`: undo a pushed merge with a revert commit. No agent runs.

```
queued ──> preparing ──> running ──> ready ──> pushing ──> pushed
              │             │          │  │       │
              │             │          │  └─ ask the agent to change ─> running (same turn)
              │             │          │          └─ branch moved ─> discarded(moved) + a redo turn
              └─ failed <───┘          └─ discarded (owner, resolved outside, upstream, PR ended)
                            └─> unchanged (the agent changed nothing)
```

Only one turn per PR is past `queued` and not yet ended. `ready` counts as holding the checkout: a second batch sent while fixes wait for Push queues behind them and starts after Push or Discard. So a fix and a conflict resolution never edit the checkout together, and every ready result is one commit (or one rebased head) on top of the branch as GitHub had it. Starting the next turn is one transaction that checks the queue and moves the oldest turn to `preparing`, so two callers never start two turns. Fix turns share the app's two agent slots with guide attempts.

Every state change is a compare-and-set on the turn's current state. A late write from a turn that moved on, such as an agent finishing after the owner discarded it, changes nothing.

## The checkout

Each session has its own worktree under `$PRKIT_HOME/fixes/<fixerId>`, apart from the review worktrees, so neither cleanup removes the other's. A turn fetches the PR head and base through the PR's own account, prefetches every blob it needs (the head tree; the base and merge-base trees for a merge; every PR commit for a rebase), resets the checkout to the head, and then runs offline.

prkit, never the agent, merges, commits and pushes. It commits with `commit-tree`, so no hook, editor or signing config in the user's or the PR's repository runs, as the PR's account with GitHub's noreply address. A change request re-commits on the same parents, so asking for a change replaces the result instead of stacking commits. A ready commit is kept reachable under `refs/prkit/fixes/<turnId>` until it is pushed or discarded.

## What the agent may do

A fix turn gets a write profile (`TurnInput.access`): edits under the checkout, read-only commands, and, on a trusted pull request, the repository's check scripts.

### Check scripts are the PR author's code

A check script's command comes from the PR head's `package.json`, so `npm test` runs whatever the PR's author wrote, on the owner's machine, with the owner's files in reach (the child environment allowlist aside, and under Claude the instance's own variables too: docs/features/agents.md, Environment). prkit runs them only when it trusts the author (`decideScripts` in `fixers/scriptAccess.ts`):

- the PR comes from the base repository itself, not a fork, and
- its author is one of the owner's logins on that host, or GitHub's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`.

Anything else gets no scripts, a fork from one of the owner's own accounts included: read-only commands, Edit and Write only. Trusting the author is trusting more than their scripts: the agent can edit the files a script runs, so on a trusted PR whatever the agent writes runs too. With either agent it runs inside the turn's sandbox (see What a fix's commands can reach), so it never reads the owner's files or reaches the network. Per repository, **Run check scripts on any pull request** (`fixer_repository_settings.run_scripts_anywhere`, off by default) allows them on every PR there.

A turn decides once it has checked out the head, from the PR as that turn read it, and records the decision on the turn (`fixer_turns.scripts`): the scripts with their exact commands, or the reason there are none. A change request runs under its turn's decision. The Fixes tab says which way it goes in one line, from the same decision read for the panel (`fixers.scriptAccess`, GitHub's answer kept a minute), and the first turn of a session to run a given set of scripts lists them with their commands.

### Per provider

- **Claude**: Read, Grep and Glob inside the checkout and prkit's context directory; Edit and Write only under the checkout and never its `.git` (`checkoutPaths`, see Links); Bash only for the read-only allowlist or, when the PR's scripts may run, one of the repository's check scripts (`decideFixBash`: `test`, `lint`, `typecheck`, `check`, `format:check` and their `name:*` variants that exist in `package.json`, run through npm, pnpm, yarn or bun, optionally piped into read-only commands). Every command runs in Claude Code's sandbox with prkit's rules (`claudeSandbox.ts`). Only the fix tools are visible: the guide tools are disallowed.
- **Codex**: prkit's permissions profile (architecture doc, Agents), writing only the checkout (Codex keeps its `.git` read-only) and the turn's temp folder. Network off, only the fix tools enabled. When the PR's scripts may run, approval is `never` and the profile is the boundary: Codex runs any command inside it, and since it never asks, never one outside it. When the scripts may not run, approval is `untrusted`: Codex asks before every command and every edit, runs what prkit accepts inside the profile, and prkit answers (`codex/approvals.ts`). A request with a reason, which is how Codex marks a command the agent asked to run outside the profile, is declined, and the profile lists `/` as `none`, so one without a reason keeps the profile's reads (architecture doc, Agents). A command the read-only allowlist allows once its login-shell wrapper is unwrapped, run from inside the checkout, with file arguments that land inside the checkout from where it runs, and an edit whose files all land under the checkout and outside `.git`, are accepted. Anything else is declined and the turn carries on.

### What a fix's commands can reach

Every fix turn's commands, the PR's scripts included, run in a sandbox: Codex's under prkit's permissions profile (`codex/sandbox.ts`), Claude's under Claude Code's own sandbox with prkit's rules (`claudeSandbox.ts`). Both read the system's folders, the checkout, the turn's context folder (`fix-context/<turnId>`, read-only), the repository's git data and prkit's git config, and nothing else in the owner's home, `/tmp` or the temp folder. Both write only the checkout, never its `.git`, and the turn's temp folder, which is the commands' `TMPDIR`. Neither reaches the network.

When the PR's scripts may run, both also read what runs them (`commandReach.ts`): every install of `node`, `npm`, `pnpm`, `yarn` and `bun` on PATH, the folder each really is in, and for `<prefix>/bin/<tool>` the prefix, unless the prefix is the home folder, holds it, or is a folder directly in it (pnpm's standalone `~/Library/pnpm/pnpm` must not open `~/Library`). Version-manager shims are skipped, because the sandbox doesn't open their managers' config. The agent's PATH holds only the real folders the sandbox opens: on macOS a command lookup that meets a closed folder, or a link in one, fails with EPERM instead of moving on, so `npm test` couldn't even start `sh`.

The turn's temp folder is `/Users/Shared/prkit-<the turn id's first 6 hex digits>`, made private to the owner when the turn starts and removed with its context when it ends, or on the next start after a crash. It can't live in prkit's home or in `/tmp`. Measured on Claude Code 2.1.296: Claude gives its sandboxed commands `<CLAUDE_CODE_TMPDIR>/claude-<uid>` as `TMPDIR` only while that fits in 44 bytes, and otherwise the `/tmp/claude-<uid>` every Claude session of the owner shares; and it drops sandbox rules under `/tmp`. Claude also writes each command's working directory to a file there, so with that folder closed every command ends with exit code 1.

Claude's sandbox needs a few more things, all measured on 2.1.296:

- It reads `/` as closed except the folders above, `/private/var/select` (where `/bin/sh` reads which shell it is) and the device files Claude Code itself lists (`/dev/null`, `/dev/urandom` and the like): node aborts without `/dev/null`, and the owner's terminals (`/dev/ttys*`) stay closed.
- `xcode-select` reads its link through `/var`, a link a closed `/` refuses, so `DEVELOPER_DIR` names Xcode's folder and `/usr/bin/git` works. Each call then takes about a second and says it couldn't write its cache in the user's temp folder, which does no harm.
- Claude lets commands write a turn's additional directories, so the context folder is listed under `denyWrite`.
- `failIfUnavailable`: Claude refuses to run a command rather than run it unsandboxed.

Neither agent has a token: git commands that need the network fail instead of fetching with some identity. The agent reports through MCP: `finish_fixes({ summary, perComment })` or `finish_conflicts({ summary, perFile })`. The handler checks the report against what was asked (every comment or file once, nothing unknown, no conflict markers left in a resolved file) and answers with the problems, so the agent fixes them and calls again. A turn that ends without a valid report gets one nudge, then fails with `no-report`.

### Links

A pull request's author controls every file in the checkout, links included: `notes.md -> ~/.ssh/id_ed25519` would hand a secret to the model, and an edit through `src -> ~/.zshrc` would change the owner's files. Three rules keep a link inside:

- Every checkout prkit makes has `core.symlinks=false`, so a link is a small file holding the path it points at. Editing that file changes the link, never its target.
- Each Claude call and each Codex approval is judged where its paths really land, with links resolved (`checkoutPaths`): a link left in an older checkout, or made by a check script, still can't lead out. `..` and `~` are refused, and so are `git diff --no-index`, `git blame --contents`, `rg --follow` and pattern files. A fix whose scripts run asks nothing about its commands: with either agent, its sandbox reads and writes nothing outside the checkout and the turn's folders, links or not.
- prkit never commits a link the agent made or changed, nor a submodule (a gitlink, which makes git read another repository at its path). Before every commit and every rebase step it compares the staged links and gitlinks with the commits the result builds on (the parents; for a revert also the branch before the merge), with `--ignore-submodules=none` so a pull request's `.gitmodules` can't hide a changed gitlink, and fails the turn as `checks`, naming them. A change request that does this keeps the earlier result.

## Conflicts

For a merge, prkit runs `git merge --no-commit <base>` in the checkout and sorts the conflicted files. Lockfiles (they need an install, and the agent has no network), binary files, and files one side deleted are needs-human: prkit keeps the base side and leaves them for the owner. The agent resolves the text conflicts, with the commits on each side since the merge base, the PR description and the latest guide in its prompt, and may also mark a file needs-human. Before committing, prkit checks deterministically that no resolved file has conflict markers and that `git diff --check --ignore-submodules=all` is clean (without that flag git runs `git status` inside a submodule's checkout), then commits the merge with the head and base as parents.

A merge never rewrites history, so it is a normal push. A rebase is offered only on the viewer's own PRs; each commit that stops is resolved in the same session, and git goes on only with the plan it made (see Before prkit's own git). The result is pushed with `--force-with-lease`, always by a click.

## Turn end

prkit's own git runs right after a turn, so prkit first ends what it can tie to the turn. How the agents end a turn (measured with Claude Code 2.1 and Codex 0.162 on macOS 26):

- **Claude** runs in a process group of its own, which prkit kills when the turn ends (TERM, then KILL). Claude Code runs each Bash command in a new session led by the command's shell, so a job the command puts in the background (`&`, `nohup`, `setsid`) is in none of Claude's groups and outlives both the command and Claude.
- **Codex**'s app-server runs in a process group of its own, which prkit kills the same way. Codex runs each command as the leader of a new session and kills its group when the command ends, so `&` and `nohup` jobs end with it, but a job that starts a session of its own (`setsid`) outlives it.
- A job that outlives its turn keeps the turn's sandbox, which macOS never lifts, so it can still write wherever the turn could: the checkout and the turn's temp folder.

prkit ends only processes it can tie to the turn (`agents/turnEnd.ts`), and leaves the owner's own programs alone, even when they work in the checkout:

- **The mark.** The agent starts with `PRKIT_TURN=<turn id>` in its environment, and both agents pass it to their commands. macOS shows another process's environment only for programs outside its own system folders: a detached `node` or `python` job shows the mark, a background `sleep` or `sh` doesn't. A process whose environment prkit couldn't see is checked again on every look, since what it runs can change. The mark shows where a process came from only as long as the turn's processes can't hand their environment to programs they don't own: a shared daemon that turn A started carries A's mark, and ends when A ends.
- **The agent's tree.** While the agent runs, prkit lists the processes every 250 ms and ties the agent and every process under it to the turn, with the process groups they lead. The agent is followed by its pid and start time, so a later process that gets the same pid is never taken for it. Each list takes about 20 ms on a machine running 760 processes.
- **The end.** Once the agent's group is gone, prkit ends every process started since the turn began that it tied to the turn, the processes those started, and the members of a group a tied process still leads: TERM, then KILL half a second later, and another look for jobs a dying one started, up to five rounds. A group whose leader prkit didn't tie to the turn, such as the owner's editor or a shell they opened, or whose leader is gone, doesn't count as the turn's. With something to end this takes about half a second.
- **When it can't finish.** If processes keep turning up after five rounds, or prkit can't list them now or couldn't while the agent ran, the fix stops at Needs you before any of prkit's git runs, with its checkout left as it is, a change request's too. The turn keeps why, and what prkit tied to it (`unfinished_end`). Before any later turn of that PR runs git, Retry included, prkit looks for those processes again and ends them; while that still can't finish, the new turn stops at Needs you with the same reason, and Discard and Stop leave the checkout as it is. A guide turn can't write its checkout, so its end is only logged.
- **After a crash.** A killed server ends nothing, so on startup prkit does the same for every fix turn that was preparing or running, by its mark and start time, before anything, Retry included, runs git in its checkout. The tree prkit listed while the agent ran is gone with the old server, so only processes showing the mark are found. If startup can't finish, the turn fails at Needs you and keeps its record, as above.

This narrows the window; it doesn't close it. A job that leaves the agent's tree between two lists without showing the mark isn't tied to the turn, and can still be running, with the turn's sandbox, when prkit's git starts. The checks below run right before each git step for that reason.

## Before prkit's own git

prkit's own git runs outside every sandbox, right after an agent had the checkout and prkit ended what it could tie to the turn (see Turn end). The sandboxes keep the agent's commands away from the checkout's git metadata and the repository cache, and `verifyCheckout` confirms the metadata prkit wrote is still there (architecture doc, Repository access). Right before each of its own steps, prkit also checks what an agent could still have left in reach of git. When a check fails, the turn fails as `checks` with a message that starts "prkit stopped and needs you" and says why, and nothing is committed or pushed.

- **A repository inside the checkout.** Before every git step that reads the checkout's files after a turn (staging, the conflict-marker check, a commit, `rebase --continue`, and putting files back to one side with `takeBase` or `checkoutFrom`), prkit walks the checkout (`repo/nestedRepos.ts`) without following a link or running git, and refuses when it finds an entry named `.git` in any case (a file, folder or link) below the root, a folder it can't list, or a folder that went away while it walked, naming the path. The walk reads a checkout of 200,000 files in 11,000 folders in about a quarter of a second. When git stages or diffs, it runs `git status` inside a repository at a submodule's path, with that repository's own config; an empty one anywhere else makes `git add` read it and fail. Retry rebuilds such a checkout, because `clean` leaves a repository at a submodule's path.
- **Links and submodules** the agent made are never committed (see Links).
- **The conflict-marker check** runs as `git diff --check --ignore-submodules=all`.
- **The rest of a rebase.** prkit starts a rebase with `GIT_SEQUENCE_EDITOR=true` and `--no-autosquash`, so its todo is git's own. At every stop it records a hash of git's rebase state (`repo/rebaseState.ts`: everything in `rebase-merge`, the todo, `done`, `onto`, `head-name` and the rest git reads to go on), which none of prkit's own steps at a stop changes, and compares it before `rebase --continue`. A different hash, or a file prkit can't read there, means something else may have changed the plan, where an `exec` line would run a command outside the sandbox. prkit then drops the rebase by removing that folder, so git never reads it, and the turn's reset puts the checkout back at the head. The walk runs after the hash check, and its refusal drops the rebase the same way. Every reset drops a rebase by removing the folder too, never with `rebase --abort`, which would read it.
- **The cache's config.** Before every fetch and push, guides' included, git lists the repository cache's config itself (`git config --file <cache>/config --no-includes --list -z`, so a quirk of the file's syntax can't hide a key), and prkit refuses unless it holds exactly what `git init --bare` and `ensureCache` wrote (`repo/cacheConfig.ts`): any other key, another value, a key twice, or one of prkit's gone. A planted `include.path`, `url.<base>.insteadOf` or filter driver could make git run a program or send the account's token to another server. Nothing is fetched or pushed; a Push stays ready with the reason, and the owner deletes the cache for prkit to make a fresh one.

## Push

Push is manual by default. Before pushing, prkit reads push access from GitHub (`pushAccessOf`: write access to the head repository, or for a fork, write access to the base and the author allowing maintainers to push). Without it, Push is disabled with the reason and Copy patch is offered. Then it runs `ls-remote` through the PR's account: if the branch is no longer at the head the turn was built on, prkit pushes nothing (see Races). If it already is the turn's commit, an earlier push landed and prkit records it. Otherwise it pushes, a plain push for commits and a lease for a rebase.

After a push, prkit invalidates the PR's cached reads, as a PR action does, so the new head shows at once. Drafts the agent fixed or partly fixed become `resolved-by-agent` and leave the diff; skipped ones go back to being drafts. GitHub threads in the batch get "Addressed in <sha>: <note>" when the owner asked for replies (the default on their own PRs). The review watcher sees the new head and writes the next guide revision; the guide's diff is computed from the merge base, so what a merge brought in from the base is not shown as the PR's change.

Per repository (`fixer_repository_settings`, all off by default), besides check scripts on any pull request (see What the agent may do):

- **Push fixes automatically** skips the click for fixes and merge resolutions. Never for a rebase, a revert, or a resolution with a needs-human file.
- **Resolve conflicts automatically** lets the fix watcher start a merge resolution when a PR in the repository starts to conflict, at most three in 24 hours per PR, never twice on the same head. Both count the PR's turns, so stopping its session resets neither. Past the limit the Fixes tab's conflict banner says the next one waits for a click; the snapshot's `autoResolvePaused` and the watcher read the same count.

## Races

- **The branch moved before Push.** prkit pushes nothing, discards the stale result, and queues a redo turn with the same request on the new head, in the same session. A conflict redo whose new head merges cleanly ends as resolved upstream.
- **The owner resolved the conflict outside prkit.** Every minute the fix watcher reads, for every PR with a session, the same fingerprint the review watcher reads, as background work under the budget's reserve, and hands it to `PullRequests` too so the read caches stay current. `mergeStateStatus` `DIRTY` means a conflict. When the PR merges cleanly again at a head that is not the turn's own, a queued, running or ready resolution is discarded as "Resolved outside prkit". Nothing is pushed over it.
- **The base moved again after a push.** The PR conflicts again, the header offers Resolve conflicts again, and automatic resolution counts against its daily limit.

## Restarts

On startup, before the fix watcher runs: an agent a killed server left behind is stopped if its PID and start time still match, and so is what prkit can still tie to its turn (Turn end); turns that were preparing or running become `failed(interrupted)` with their drafts returned and Retry offered, or `failed(checks)` with nothing reset when prkit couldn't end what the turn left; a change request that was cut off goes back to the result it was changing; a push that was cut off goes back to `ready`, and the next push checks whether it landed. Checkouts of ended sessions are removed, and so are every turn's context and temp folder, then queues advance. Running this twice changes nothing.
