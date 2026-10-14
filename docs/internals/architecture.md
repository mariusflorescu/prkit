# prkit architecture

prkit is a local desktop app for reviewing GitHub pull requests. It lists the PRs that need you across every GitHub account on your machine, lets you keep many of them open and jump between them, and with one click asks your own coding agent (Claude Code or Codex, on your own subscription) to write a guided review: an overview, a before/after flow diagram, and chapters that walk through the diff one idea at a time. The agent then keeps watching the PR and updates the guide when new commits land, until the PR is merged or closed. The same agent can also fix review comments and resolve merge conflicts on the PR's branch: prkit commits, and the user reviews the change before anything is pushed (see The fix agent).

It never runs in the cloud. GitHub tokens, agent sessions and repository clones stay on the user's machine, and agents run on the user's own Claude or Codex login.

The shape is deliberate: an Effect server that owns all real work, a thin React client, and an Electron shell that hosts both.

## Processes

```
Electron main (apps/desktop)
  └─ spawns ──> prkit server (apps/server, Node via ELECTRON_RUN_AS_NODE)
                  ├─ GET  /ws      typed RPC over WebSocket (effect/rpc)
                  ├─ /mcp          MCP tools for agent turns (effect/ai McpServer, streamable HTTP)
                  ├─ GET  /health  readiness + build info
                  └─ GET  /*       the built web UI (apps/web/dist)
                         └─ spawns ──> one agent process per turn (claude / codex) in a review worktree or a fix checkout
BrowserWindow ──loads──> http://127.0.0.1:<port>/?token=<token>
```

- The server is a child process. Electron main stays small: start the server, read its ready line, open the window, forward a few native capabilities through the preload bridge.
- The server also serves the UI, so the desktop window, a plain browser in dev, and the e2e test browser are the same surface.
- Dev mode runs the server and Vite separately; Vite proxies `/ws`, `/mcp` and `/health` to the server, so dev stays single-origin.
- Closing the window on macOS keeps the app and its server running, so reviews keep watching. Quitting stops the server; the next launch reconciles every review (see Restarts).

### Auth between UI and server

The server binds `127.0.0.1` only. It requires a per-launch token on the WebSocket upgrade (`/ws?token=`) and rejects upgrades whose `Origin` is not the server's own origin or the dev Vite origin. The UI takes the token from `?token=` on first load, keeps it in `sessionStorage`, and strips it from the address bar. Any web page can try to open a socket to localhost, so both checks matter even though nothing leaves the machine.

`/mcp` uses separate bearer tokens, one per agent attempt (see Agents).

### Child process environment

Every child process (agents, `gh`, `git`) gets an environment built from an allowlist (`HOME`, `USER`, `PATH`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM`) plus what that call needs. Nothing else is inherited. In particular:

- `GH_TOKEN`/`GITHUB_TOKEN` would beat the gh config dir we chose and pick the wrong account.
- `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`, `OPENAI_API_KEY` and similar would switch an agent from the user's subscription to API billing.
- `PRKIT_*` carries the server's own secrets.

## State

`PRKIT_HOME` (default `~/.prkit`; in a git worktree, the worktree's gitignored `.prkit/`) holds:

- `prkit.sqlite` - settings, guide settings per scope, open PRs and the Inbox's filters, reviews, attempts and their files, guide revisions, review activity, fix sessions with their turns and activity, and fix settings per repository.
- `repos/<host>/<owner>/<repo>.git` - one bare, blobless repository cache per repo.
- `worktrees/<reviewId>` - one detached checkout per review that is not done.
- `fixes/<fixerId>` - one checkout per fix session that has not ended, apart from the review worktrees (see The fix agent).
- `fix-context/<turnId>/` - what a running fix turn reads besides its checkout (the latest guide's overview for a conflict). Removed when the turn ends, with the turn's temp folder, which lives outside `PRKIT_HOME` in `/Users/Shared/prkit-<id>` (see Agents).
- `diffs/<attemptId>/` - what one running attempt hands its agent to read: the numbered diff, and on an update the diff since the last revision and that revision's guide. Removed when the attempt ends; startup removes any left by a crash.
- `gitconfig` - prkit's own git config, which only turns symlinks off (see Repository access).
- `codex/` - the Codex home prkit's Codex turns run in: `auth.json`, a link to the user's when the user's Codex keeps its login in that file, or else a `config.toml` that keeps prkit's own Codex login in the keychain, and what Codex keeps for those turns, their sessions included (see Agents).

SQLite goes through `effect/sql` with a small driver over `node:sqlite`, WAL mode, migrations as TypeScript files under `apps/server/src/persistence/Migrations/`.

Live PR data (titles, checks, comments, the current diff) is read from GitHub on demand and cached by the server; the last good answer of each read is also kept in `prkit.sqlite`, so a relaunch shows it before any network call (see GitHub reads). What prkit creates is persisted, including the exact diff each guide was written against, because a guide must keep rendering correctly after the PR moves on.

The open-PR list and the Inbox's search and filters are stored by the server too, not in `localStorage`: the window's origin includes the server port, and the port can change between launches. A load lets go of an account removed since the save, and a saved repository filter is dropped once every account's repository list was read whole after the save and neither it nor the inbox has the repository.

## Domain model

All of these are Effect Schemas in `packages/contracts`. Ids are branded strings.

**Account.** One GitHub login reachable through one gh config dir.

```ts
AccountId = `${host}/${login}`                  // "github.com/octocat"
Account = { id, host, login, name: string | null, avatarUrl: string | null, configDir: string,
            status: { _tag: "ready" } | { _tag: "error"; message: string } }
```

**Pull request reference.** Identity of a PR, independent of who looks at it.

```ts
PullRequestRef = { host, owner, repo, number }
PullRequestKey = `${host}/${owner}/${repo}#${number}`   // stable key for tabs, reviews, caches
```

A PR is always read *through* an account. The inbox records which account found each PR. Opening a PR stores that account with it, and a review stores its own account binding when it starts. Every later read for that PR (detail, files, contents, git fetches, the watcher) uses the stored account, even if the inbox later finds the same PR through another account. Nothing falls back to "whichever token works".

**Inbox entry.** `{ accountId, ref, title, url, state: "open" | "closed" | "merged", isDraft, author, headBranch, baseBranch, createdAt, updatedAt, additions, deletions, changedFiles, reviewDecision, checks: "passing" | "failing" | "pending" | null, labels, reasons: NonEmptyArray<"review-requested" | "authored" | "involved">, stack: StackMembership | null }` (see Stacks)

**Open PR.** `{ key, accountId, position }` plus one `activeKey`. Persisted by the server; the client keeps an optimistic copy.

**Review.** One per PR (`PullRequestKey` is unique). The guide-writing agent session and its lifecycle.

```ts
ReviewStatus =
  | { _tag: "preparing"; attemptId }                         // caching refs, prefetching, checking out
  | { _tag: "writing"; attemptId; revision: number }         // agent process running
  | { _tag: "watching"; headSha: string; baseRef?: string; checkedAt: Date }   // guide is current, nothing running
  | { _tag: "failed"; reason: FailureReason; message: string; attemptId: AttemptId | null }
  | { _tag: "done"; reason: "merged" | "closed" | "stopped" }
FailureReason = "account" | "github" | "repository" | "agent-auth" | "agent" | "no-guide" | "interrupted"
              | "settings"                                   // the ignore rules skip every changed file
Review = { id, key, accountId, provider: "claude" | "codex",
           model: string | null, modelOptions: Array<{ id, value }>,  // the agent selection
           sessionId: string | null, status: ReviewStatus, latestRevision: number | null,
           watchProblem: string | null, createdAt, updatedAt }
```

The review keeps the agent the user picked (provider, model and the model's own settings such as effort), and every later attempt, watcher updates included, runs with it. What the guide skips, answers and is told lives in the guide settings (see Guide settings), not on the review. `model` is null for reviews started before the model choice existed; those run on the agent's own default. Every setting the model takes is passed explicitly on each turn, so a resumed session never keeps a choice from an earlier attempt. A review also records its `origin`, `user` or `auto` (see The default agent and auto mode), and `watchProblem`, why the watcher's last read failed, cleared by the next good read.

**Attempt.** One try at producing one revision. Persisted *before* any process starts.

```ts
Attempt = { id: AttemptId, reviewId, revision, trigger: "first" | "new-commits" | "rewritten" | "retargeted" | "retry",
            provider, model, headSha, baseSha, baseRef, mergeBaseSha, snapshot: DiffSnapshot, changedLines,
            batch: string | null,                           // the stack batch it was started in
            config: AttemptConfig, configHash,              // the guide settings it froze
            phase, narration: string | null, draft: DraftGuide | null, draftVersion,
            startedAt, finishedAt: Date | null, outcome: "accepted" | "failed" | "superseded" | null }
DiffSnapshot = { files: Array<{ path, previousPath: string | null,
                                status: "added" | "modified" | "removed" | "renamed",
                                additions, deletions, patch: { _tag: "text"; patch: string }
                                                           | { _tag: "binary" }
                                                           | { _tag: "too-large"; lines: number } }> }
```

The snapshot comes from the local repository cache (`git diff --find-renames <mergeBase> <head>`), not the GitHub files API, which caps at 3,000 files and drops patches for large files. Validation and rendering of that revision both use this snapshot.

`provider`, `model` and `changedLines` let the guide setup show a typical time ("usually about 4 min for PRs this size"): the median of past accepted full guides by the same provider on diffs of half to double the size, shown only when at least two exist. `narration` is the agent's latest `report_progress` line, replaced each time. `draft` is every `submit_draft` call merged by chapter id, and `draftVersion` grows by one per accepted call, so the client refetches the draft only when it changed.

**Attempt files.** One row per reviewed file of the snapshot (the ignore rules' skipped files are left out), in diff order: `{ path, previousPath, status, additions, deletions, readAt, note }`. `readAt` is set from the agent's own tool calls once they return: a `Read` of a changed file, or a shell command that printed that file's whole part of the numbered diff. What the agent says it read never counts. `note` is its `note_file` line. The progress view checks files off from these rows.

**Guide revision.** Immutable. `{ reviewId, revision, attemptId, guide: Guide, createdAt }`, unique on `(reviewId, revision)` and on `attemptId`, read with its attempt's snapshot and frozen settings. `Guide` is the visualize-pr `guide.json` format plus two optional fields prkit owns, `focusAreas` and `guidanceNote` (see Guide settings); a revision stored before them decodes with none, so the skill and the app stay compatible.

**Fix session.** One per PR (`fixers`), with its own account binding, agent and native session id, and its work as queued turns (`fixer_turns`: a batch of comments, a conflict resolution or a revert) with their activity. See The fix agent.

**Review activity.** What the loading experience shows. `{ reviewId, attemptId, at, kind: "phase" | "tool" | "note" | "error", text, detail }`. Phases are fixed (`queued`, `preparing-code`, `reading-change`, `writing-guide`, `checking-guide`); tool lines are the agent's tool calls turned into short human labels ("Read `src/foo.ts`", "Searched for `isSnoozed`"), with the raw call in `detail` for the Details disclosure. Shell calls are labelled by parsing the command the way the Bash policy tokenizes it (`describeCommand`), unwrapping a login-shell wrapper, so Claude's and Codex's commands read the same. prkit's own progress tools stay out of this log; their effect shows in the Guide tab itself.

## The review lifecycle

The review is a state machine owned by `Reviews` on the server. It does not depend on any window being open.

```
          generate
 (none) ──────────> preparing(a1) ──> writing(a1, r1) ── process exits with an accepted guide ──> watching(head)
                         │                  │                                                    │     │
                         │ fails            │ exits without a guide (after one nudge),            │     │ PR merged/closed
                         ▼                  ▼ errors, or the server restarts                     │     ▼
                      failed(reason) <──────┘                                                    │  done(merged|closed)
                         │ retry                                                                 │
                         └──> preparing(a2) ...                       head changed (watcher) ────┘
                                                                     └──> preparing(a3) ──> writing(a3, r2) ──> watching(newHead)
 any non-done state ──stop──> done(stopped)
 done(any) or failed ──generate──> preparing(new attempt)   (same review, next revision number)
```

**What "done" means.** A review is done when its PR is merged or closed, or when the user stops it. Checks passing, approvals, or a quiet PR do not end it. Done means the watcher drops it, its worktree is removed, and its MCP tokens are revoked. Its revisions stay, so a merged PR's guide is still readable. Generate again on a done review (a reopened PR, or a stopped one the user wants back) starts a new attempt on the same review.

**Done is absorbing.** Every state change is a compare-and-set on the current attempt id. A late result from an older attempt (a submission, a process exit, a finished prefetch) is recorded on that attempt and changes nothing else.

**One attempt at a time.** A review never has two attempts in flight. An accepted `submit_guide` or `revise_guide` ends the turn: once that call's result is back, prkit stops reading the agent and ends its process, because the closing reply it would write adds nothing (Claude spent about 4 s on one, Codex about 3 s). The Claude SDK waits two seconds before its own SIGTERM, so prkit signals Claude's process group first. The guide is stored as the attempt's result, and the review moves to `watching` only after the agent process has exited and its process tree is gone. If new commits land meanwhile, the watcher sees them on its next tick after that and starts the next attempt; repeated pushes collapse into one.

**"Awake" without a running process.** Each attempt runs one short-lived agent process. Between attempts nothing runs except the watcher. The agent's conversation survives through the provider's native session id (`resume` for Claude, `thread/resume` for Codex), saved the moment the provider reports it, so a later attempt ("2 new commits landed, update the guide") continues the same conversation. If the provider no longer has that session, the attempt starts a fresh one with the full context and says so in the activity log.

**History rewrites.** Every accepted revision's head commit is kept under `refs/prkit/<reviewId>/r<n>` in the repository cache so it never gets garbage collected. If the new head does not descend from the last revision's head (a force-push or rebase), the attempt's trigger is `rewritten` and the agent writes the guide fresh instead of "update for the commits since".

**The watcher.** Every 60 seconds, for every review that is preparing, writing or watching (failed ones every 15 minutes), it reads each PR's fingerprint with aliased GraphQL fields, at most 50 PRs per request, grouped by each review's own account. The same request also covers open PR tabs (see GitHub reads). Each alias is handled on its own: merged or closed moves the review to `done`; a new head on a `watching` review starts the next attempt, and so does a new base branch (the layer below merged, see Stacks); a read error is logged on that review and retried next tick. An authentication failure re-reads the account's token once; if it still fails, the review becomes `failed(account)` with a message naming the account, and stays so until the user retries.

New comments do not wake the guide agent, and the guide does not talk about them. The user sends review comments to the fix agent instead.

**Restarts.** On startup, before the watcher runs: attempts with no `finishedAt` are marked `failed(interrupted)` and their reviews re-run from a new attempt; worktrees that belong to done reviews or to no review are removed; then the watcher resumes every review that is not done. Running this twice in a row changes nothing the second time.

**Orphaned agents.** An agent process can outlive a killed server and keep writing to the same session. Each attempt records the agent's PID, its start time, and the server boot's `run_id`. On startup prkit kills a recorded agent only if both its PID and start time still match, then reconciles; the `run_id` is how a boot tells its own attempts from earlier ones.

**Concurrency.** Repository cache mutations are serialized per repository. At most two agent processes run at once across the app, guide attempts and fix turns together (`Agents.slots`): a third review waits in `preparing` with a `queued` phase, and a third fix turn says it is waiting for another agent, until a slot frees up.

**The review feed.** `reviews.feed` streams every review's `{ key, accountId, status, latestRevision }` for the whole app: all of them first, then each change, and a `ready` notice when a guide the user asked for (first or retry, or started by auto mode) is accepted. Guides started together for a stack send one `stack-ready` instead, when the last of them finishes (see Stacks). Watcher updates are not announced. The client keeps it in the query cache for inbox marks, the tab ring and its tooltip, a "Guide ready" toast, and a macOS notification through the preload bridge that opens the Guide tab when clicked. Neither shows while the user is already reading that guide.

**The default agent and auto mode.** Settings > Agents stores a default agent (provider, model, settings) and Settings > Guides the accounts in auto mode, as JSON values in the `settings` table. The guide setup starts from the default; the inbox row action, the command palette, `Cmd+G` and auto mode use it as is, unless the review already has its own agent. `AutoGuides` checks every watcher interval, and at once when a setting changes: for each account in auto mode, the first open, non-draft PR that requests the user's review and has no review yet gets one, with `origin = auto`. One auto review runs at a time, and auto mode never starts a second attempt on an existing review.

## Accounts

`GitHubAccounts` builds the account list on startup and on demand:

1. Candidate config dirs: `$GH_CONFIG_DIR` if set, `~/.config/gh`, every `~/.config/gh-*` directory, plus dirs the user added in Settings. Keep the ones with a `hosts.yml`.
2. Each `hosts.yml` lists hosts and their users. Each (dir, host, login) is a candidate account.
3. The token comes from `gh auth token` run with `GH_CONFIG_DIR=<dir>` and the allowlisted environment: `--hostname <host>` alone for the host's active user (the `user:` field in `hosts.yml`, the same token `gh api` uses), and `--hostname <host> --user <login>` for the others. The active user gets no `--user` because `hosts.yml` can hold a stale per-user copy of the token next to a valid active one; this machine has exactly that. Then `GET /user` confirms the login. A failure marks the account `error` with a reason the user can act on ("gh has an expired token for octocat in ~/.config/gh; run `gh auth refresh`"); other accounts keep working. prkit never falls back from one token source to another.
4. prkit runs the real `gh` binary, resolved once at startup (`mise which gh` when mise is on PATH, else the first `gh` on PATH outside a version manager's shim dir, or `PRKIT_GH_PATH`). A mise shim re-exports `GH_CONFIG_DIR` computed from the current directory, overriding the one prkit passes; through the shim, every config dir answers as the `~/.config/gh` account.
5. Tokens stay in server memory. They never cross the RPC boundary and are never written to disk by prkit.

This matches how the user's machine is already set up: each repository can point `gh` at the right config dir with `git config gh.configdir`, and prkit reads the same dirs.

## GitHub reads

GitHub's limits are per user (5,000 GraphQL points and 5,000 REST requests an hour) and shared with `gh`, other coding tools and anything else the user runs. prkit answers from its cache whenever it honestly can, notices real changes cheaply, sends nothing while GitHub says the limit is used up, and always lets a click through.

`GitHubApi` is a small client over `effect/http` `HttpClient`: GraphQL `POST /graphql` and REST, authenticated per account, with a concurrency limit per account. `PullRequests` sits on top:

- `inbox()` - per account, one GraphQL request with three aliased searches (`is:pr is:open archived:false review-requested:@me`, `author:@me`, `involves:@me`), first 100 each, merged into entries with `reasons`. If a search has more, the result says how many were left out. A PR found by two accounts is listed once, under the account with the stronger reason (review-requested, then authored, then involved), then the first account by id. One account failing does not hide the others; each account row carries when its entries were fetched and why they weren't read again.
- `detail(key)` - title, body, state, draft, author, branches, head and base SHAs, mergeability, review decision, requested reviewers and latest reviews, checks, labels, issue comments, and its freshness (`fetchedAt`, `problem`).
- `files(key)` - `GET /pulls/{n}/files`, paginated, for the head the detail shows. It checks the head SHA after paging and reads once more if it moved. When `changedFiles` exceeds what the API returns, the tab says so.
- `fileContents(key, path, side)` - for expanding unchanged lines. The old side is `previousPath ?? path` at the merge-base, the new side is `path` at the head SHA, both read from the base repository (which can see fork heads through `refs/pull/<n>/head`). A side that does not exist (added or removed file) is empty.
- `timeline(key)`, `threads(key)` - GraphQL, paginated. Threads are kept only for the head the detail shows.
- `stack(key)` - the layers of the stack the detail says the PR is in, one GraphQL read (`pullRequest { stack { entries } }`, about one point) cached per stack, so every layer shares it (see Stacks).

**One read layer.** Every read goes through `makeReadCache` (`pullRequests/readCache.ts`): bounded by entries and bytes, keyed by account, gh config dir and key, one read per key at a time so concurrent callers share it. Inbox, detail, timeline, threads and files also write their last good answer to the `github_read_cache` table with `fetched_at`; the inbox answers from those rows before accounts are discovered, so a relaunch renders at once.

**Freshness.**

| Read | Fresh for | After that | Read again sooner when |
| --- | --- | --- | --- |
| Inbox, per account | 10 minutes | answered from cache at once, read again in the background | Refresh (every account), Retry (that account), a prkit write to one of its PRs |
| Detail, timeline, threads, files | 10 minutes | answered from cache at once, read again in the background | its fingerprint changed, a prkit write to it, the PR page's Refresh |
| Checks of the active PR | while a check is pending and a window is visible | REST with `If-None-Match` every 15 seconds, in a loop of its own; a 304 is free | a changed ETag, or a first answer for a head that differs from what the detail shows, marks the detail stale |
| File contents | forever (keyed by commit) | - | - |
| Repository list, per account | 24 hours | answered from cache at once, read again in the background | the repository filter's Refresh list |
| Open PRs of one repository | 10 minutes | answered from cache at once, read again in the background | - |

A read that is stale because something changed (an invalidated answer) goes to GitHub on the next read. If that read is refused or GitHub is unreachable, the old answer comes back with the reason, and the UI says how old it is. A PR the account lost access to is never answered from cache.

**Change detection.** The watcher reads one fingerprint per PR (`updatedAt`, `headRefOid`, `baseRefOid`, `baseRefName`, `state`, `isDraft`, `reviewDecision`, `mergeStateStatus`, comment and review totals, and on github.com the PR's `stack` and `stackEntry`; scalars, objects and two totals, so about one point per tick per account) for every open PR tab while a window is visible and every watched review always, closed and merged tabs every 15 minutes. A changed fingerprint marks that PR's answers stale and sends `changed` on `github.events`; the window reads again only what it shows. The window holds `github.events` open only while it is visible, and that is how the server knows. Background tabs never read their PR: their state comes from the fingerprint. The client never refetches on focus; staleness is the server's job.

**Budget.** Every response's `x-ratelimit-*` headers are recorded per account and resource (`core`, `graphql`); GraphQL queries also ask for their own `rateLimit { cost }`, so "points prkit spent" is GitHub's figure (mutations count one). Settings > Accounts shows each account's remaining, reset and prkit's spend in the last hour.

- Reads nobody clicked for (revalidation, fingerprints, ETag checks, auto guides) run `inBackground` and are refused locally while less than 10% of that resource remains, until the reset.
- A click (Refresh, Retry, opening a PR that isn't cached, an action) always goes while budget remains.
- A 200 with `RATE_LIMITED`, a 403 or 429 about the rate limit, or `x-ratelimit-remaining: 0` pauses that account's resource until `Retry-After` or the reset. During a pause prkit sends nothing for it, not even clicks; reads answer from cache and say "GitHub's limit for <login> is used up. Showing what prkit fetched 4 minutes ago. Resets at 04:04." Retry stays off until the reset, then reads only that account's inbox; `/user` is checked again only after GitHub refused a token.
- prkit's own writes mark exactly that PR's answers (and its account's inbox) stale; the read after a write goes to GitHub.

## Agents

`AgentProvider` is the boundary between prkit and a coding agent:

```ts
interface AgentProvider {
  readonly kind: "claude" | "codex"
  // Reports submit_guide's input while the agent writes it, so the agent needs no submit_draft.
  readonly streamsGuideInput: boolean
  // Checks the provider is installed and logged in with a subscription, without starting a turn.
  readonly check: Effect<ProviderStatus>
  // The models this login can use, each with the settings it advertises.
  readonly models: (state: ProviderStatus) => Effect<ReadonlyArray<AgentModel>>
  // Whether a saved session can still be resumed.
  readonly hasSession: (sessionId: string, cwd: string) => Effect<boolean>
  // One turn. The process lives exactly as long as the returned stream's scope.
  readonly runTurn: (input: {
    cwd: string                       // the review worktree
    readableDirs: string[]            // the attempt's diffs/ directory
    instructions: string              // the guide-writing rules
    prompt: string                    // this turn's task
    resumeSessionId: string | null
    model: string | null; options: Array<{ id, value }>
    mcp: { url: string; bearerToken: string }
    env: Record<string, string>       // prkit's isolated git config for the agent's own commands
    access: { _tag: "read-only" }     // a guide turn
          | { _tag: "write"; scripts: ScriptRuns }  // a fix turn: the PR's check scripts by name, or none and why
    tools: string[]                   // prkit's MCP tools this turn may call
  }) => Stream<AgentEvent, AgentError>
}
AgentEvent =
  | { _tag: "process"; pid: number }   // recorded with its start time for orphan cleanup
  | { _tag: "session"; sessionId: string }
  | { _tag: "mcp-ready" }              // prkit's MCP server connected; the turn fails fast without it
  | { _tag: "tool"; id: string; label: string; detail: string | null; reads: FileRead[] }
  | { _tag: "tool-done"; id: string; ok: boolean }  // a call's reads count only once it worked
  | { _tag: "composing-guide" }        // the agent started a submit_guide call
  | { _tag: "guide-input"; id: string; json: string }  // more of that call's input, as JSON text
  | { _tag: "text"; text: string }
  | { _tag: "finished"; outcome: "completed" | "failed" | "interrupted"; message: string | null }
```

`agents.catalog` reads every provider's login and models once and keeps them until Check again or until a turn finds the login changed. Claude's models are its bundled list checked against the installed Claude Code; Codex's come from its live `model/list` for the ChatGPT account. Each model lists the settings it takes (`ModelOptionDescriptor`), and a selection is checked against the catalog before a review is started with it.

- **Claude** uses `@anthropic-ai/claude-agent-sdk` `query()` with the user's installed `claude` and its existing login, the `claude_code` system prompt preset with prkit's instructions appended, `resume` when there is a session id, and prkit's MCP server as an `http` server with an `Authorization` header. With partial messages on, the SDK passes the model's stream through, including a tool call's `input_json_delta`s; `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` makes those arrive as the model writes them rather than buffered, so `submit_guide`'s input becomes `guide-input` events. `submit_draft` is in `disallowedTools`: Claude never sees it. A guide turn's tools are limited to `Read`, `Grep`, `Glob`, prkit's MCP tools, and `Bash` gated by `canUseTool` to read-only commands (`git diff|show|log|ls-files|rev-parse|merge-base|blame`, `rg`, `ls`, `wc`, `head`, `tail`, `cat`, `pwd`, and `sed -n '<from>,<to>p'`, which Codex uses to read part of a file). Each program takes only the flags `programs.ts` lists, in every spelling it accepts: any other flag, a prefix of one (git reads `--conten` as `--contents`), or a value its flag doesn't take is refused. The command is refused if the shell could read it as other words than prkit does: a backslash before a newline, a NUL or carriage return, a `~` after an unquoted `=` or `:` (bash 3.2 expands it). Every path a call names, a command's file arguments included, counts where it really lands with links resolved (`checkoutPaths`): outside the worktree and the attempt's directories, or through `..` or `~`, it is refused. A pattern the shell or the Glob tool expands, anywhere in a command, counts wherever a match could land: braces are expanded, its fixed start resolves like a path, and each folder the shell would read is listed with its links followed. It is refused if a match could be a link leading out, `..` (bash 3.2 matches `.*` to it), at the start of a relative pattern before `--`, a name the command would take as an option (`rg x *` beside a file named `--pre=sh`), or if checking it would list more than 20,000 entries. Every operand of git counts as a path, since `git diff /dev/null <file>` compares files outside the repository on its own; rg's search text counts as one only when a pattern comes at or before it and could move it. Everything else is denied. A fix turn's write profile is in The fix agent. Both turns' commands run in a sandbox (below), a guide's with the checkout read-only.
- **Codex** runs `codex app-server` and speaks its JSON-RPC (`thread/start` or `thread/resume`, then `turn/start`), with prkit's MCP server in the thread's `mcp_servers` config with the bearer header. `turn/completed` is mapped by its status, not taken as success. app-server reports an MCP call only once its arguments are complete (`item/mcpToolCall/progress` carries the server's progress messages, not arguments), so Codex drafts with `submit_draft`.
- **Codex runs in prkit's own Codex home.** Codex 0.162 gives every thread the user's global instructions, the `AGENTS.md` (or `AGENTS.override.md`) in its home, and no setting, thread parameter or variable turns that off. Those files are often personal. So `CODEX_HOME` is `$PRKIT_HOME/codex`. The user's config, hooks, MCP servers, skills and memories stay out of prkit's turns too. The thread's config turns the skills list off (`skills.include_instructions`), because Codex would still list `~/.agents/skills` and the pull request's own skills, and `project_doc_max_bytes: 0` drops the pull request's `AGENTS.md`. prkit refuses a thread whose `instructionSources` is not empty.
- **Where prkit's Codex gets its login** (`codex/login.ts`). Only a login file can be shared. Codex names a keychain login (`cli_auth_credentials_store` set to `keyring` or `auto`) after a hash of its home's resolved path, the same home it reads `AGENTS.md` from, and takes no setting for either, so any home that reaches the user's entry, a link to the user's home included, brings the instructions too. Every time prkit opens Codex it lays the home out again (`layOutHome`), safe to repeat. When the user's Codex home (`$CODEX_HOME`, else `~/.codex`) has an `auth.json`, prkit's home links to it. Codex writes refreshed tokens in place, through the link, so both stay signed in to the same login. A turn that outlives the user's own logout can write its tokens back through the link and recreate the user's file, as any two Codex processes sharing a home would; none starts on a dangling link, because the layout comes right before each start. Otherwise prkit's home has no link, because Codex would create a file in the user's home by writing through a link to nothing. Instead it has a `config.toml` holding only `cli_auth_credentials_store = "keyring"`, so prkit keeps a keychain login of its own under its own home's name, a `codex login` run there by hand included. That config also marks that prkit may hold such a login. Before linking the user's file again, prkit runs `codex logout` there pinned to the keychain, and drops the config only once that worked, so prkit's login never stays in the keychain with no Sign out. Every Codex process also gets `-c cli_auth_credentials_store=` `file` or `keyring` for the layout prkit chose (`storeOverride`): another check can lay the home out again before Codex reads its config, and a sign-out that read the user's file through the link would revoke the user's own login. When prkit's home has no login, prkit runs `codex login status` under the user's own `CODEX_HOME`, reading only the exit code. If the user's Codex is signed in, Settings > Agents and the model list say "Codex keeps its login in the keychain. Sign in once for prkit." (`keychain-login`) with a button, and the same sign-in as a terminal command, `CODEX_HOME='<prkit's Codex home>' codex login`, for when the browser one fails. The button runs `account/login/start` (ChatGPT) on `codex app-server` in prkit's home, opens the returned page in the browser, and waits for `account/login/completed`. That process lives as long as the `agents.signIn` stream, so Cancel or closing the window ends the sign-in and its login server, and Codex gives up after 10 minutes. A login prkit holds reads as `ownLogin`, and Sign out runs `account/logout` there, which removes only prkit's entry.
- **What a Codex turn can reach** (measured on Codex 0.162, whose own `readOnly` and `workspaceWrite` sandboxes read the whole disk). Every turn runs under prkit's permissions profile (`codex/sandbox.ts`), passed in the thread's config and checked in its response (`activePermissionProfile`): commands read the system's own directories (`/System`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/private/etc`, `/Library/Developer` and `/Library/Apple`, Xcode's license record in `/Library/Preferences`, and Homebrew's program folders under `/opt/homebrew` but not its `etc` and `var`), Codex's own install (every command's PATH starts with its `codex-path` folder), the checkout, the attempt's directories and the repository's git data (read only, and the checkout's `.git` entry read only inside the writable checkout, so an agent command can't change the metadata prkit's own git reads), and nothing in the owner's home, `/tmp` or the temp folder, which Codex opens unless the profile lists them as `none`. No network. The agent's PATH holds only the real folders the profile opens: on macOS a command lookup that meets a closed folder, or a link in one (mise's `node/24 -> 24.21.0`), fails with EPERM instead of moving on, so `npm test` couldn't even start `sh`. A guide turn also uses approval policy `untrusted`: Codex then asks before every command, and prkit answers (`codex/approvals.ts`). prkit accepts the read-only allowlist above, run from inside the checkout, with every file argument landing in the checkout or the attempt's directories, judged from where the command runs (`checkoutPaths`), and declines everything else, edits included; the turn carries on. Codex 0.162.1 runs an accepted command inside the profile (an accepted `ls /Volumes` gets `Operation not permitted`), except when the agent asked to run it outside (`sandbox_permissions: require_escalated`): then the approval request looks the same, field for field, but for the reason the agent may give, and an accepted command gets the whole disk but the profile's `none` folders. So prkit declines any request with a reason, and a turn whose commands it approves lists `/` itself as `none`: Codex then runs an approved escalation with exactly the profile's reads, and every folder the profile lists stays open, the more specific entry winning (measured: an escalated `ls /Volumes` is refused, an escalated `cat` in the checkout works). Codex's own `:minimal` set still opens `/Library/Preferences` to every command. On `prkit-fixtures#1` with GPT-6.1-Sol a guide asks four or five times. A fix turn's profile is in The fix agent.
- **What a Claude fix's commands can reach** (measured on Claude Code 2.1.296). A fix turn runs every command, the PR's scripts included, in Claude Code's sandbox with prkit's rules (`claudeSandbox.ts`): `/` closed for reading except the system's folders, the device files Claude Code itself lists, the turn's context folder, the repository's git data and git config, the checkout, the turn's temp folder, and when the scripts may run, where node and the package managers are installed (`commandReach.ts`, shared with Codex's profile); writes only to the checkout and the temp folder, never the repository's git data or the checkout's `.git` entry (`denyWrite`), which Claude's own allowance would otherwise leave open, so an agent command can't change the metadata prkit's own git reads; no network; and no command at all if the sandbox can't start. Claude gives sandboxed commands `<CLAUDE_CODE_TMPDIR>/claude-<uid>` as `TMPDIR` only while that fits in 44 bytes, falling back to the `/tmp/claude-<uid>` all the owner's Claude sessions share, and drops sandbox rules under `/tmp`. So a fix turn's temp folder, for both providers, is `/Users/Shared/prkit-<6 hex of the turn id>`, private to the owner. The agent's PATH holds only folders the sandbox opens, and `DEVELOPER_DIR` lets Xcode's `git` work without the `/var` link. Details and the other traps are in fix-agent.md. A Claude guide turn runs in the same sandbox, with the checkout under `denyWrite` and its own temp folder, `/Users/Shared/prkit-<6 hex of the attempt id>`, made and removed with the attempt's diffs. `canUseTool` still judges every command first; the sandbox holds one that a gap in that rule lets through.
- MCP config and a fresh bearer token are passed on every start and every resume; a resumed session never reuses an old token.
- Whether the stored session still exists is checked (`hasSession`) before the turn's prompt is chosen, so a follow-up never lands in an empty conversation.
- Claude Code approves reads inside the working directory and some shell commands without asking `canUseTool`, so every tool the turn has is also listed under `permissions.ask`; and `settingSources: []` with `strictMcpConfig` keeps a PR's own `.claude/` settings or `.mcp.json` from adding hooks or tools.
- The subscription check is `claude auth status --json` (logged in, `authMethod: claude.ai`, `apiProvider: firstParty`); a turn also aborts if its init message reports an API key source.

**The guide comes back through a tool, not a file.** prkit's MCP server exposes five tools to the attempt that owns the bearer token. Three feed the progress view and never become a revision: `report_progress(message)` replaces the attempt's one narration line, `note_file(path, note)` stores a line about one changed file, and `submit_draft(draft)` merges a partial guide into the attempt's draft by chapter id, checked leniently (every path, line note and reference must resolve, coverage is not required yet). Only a provider without `streamsGuideInput` is asked to draft. A call from an attempt that is no longer current is refused and told to end its turn. The fourth is `submit_guide(guide)`. The handler finds the attempt from the bearer token, decodes the guide with the `Guide` schema, then checks it against the files the attempt reviews (its `DiffSnapshot` without the files its ignore rules skipped) and its frozen settings: every file in exactly one chapter, every chapter and flow reference resolves, every line note lands inside a hunk of a file that has a text patch (notes on binary, rename-only or too-large files are errors). These are the checks `build_review.py` runs in the visualize-pr skill, ported to TypeScript, plus that last rule and the focus-area checks in Guide settings. prkit then appends its own "Skipped by your ignore rules" chapter when something was skipped and checks the result covers the full snapshot exactly once. Errors go back to the agent as the tool result, in the same plain wording ("`src/a.ts`: additions line 12 is outside the diff hunks. Visible additions lines: 40-58"), so it can fix the guide. prkit keeps the rejected guide for the running attempt, and the fifth tool, `revise_guide(patch)`, fixes it without writing it again: top-level fields it sends replace the rejected ones, each chapter it sends replaces the one with the same id, and the result is checked exactly like `submit_guide`. On `prkit-fixtures#1` with Claude Fable 5.1 Medium a revision took about 3 s and under 1 KB, where writing the guide again took 21-24 s. A valid guide is stored on the attempt and ends the turn (see One attempt at a time); the revision is committed when the process exits. One attempt's guide checks run one at a time, and a call that arrives once its guide is stored (a parallel call, or one racing the process's end) is refused and told to end its turn, unless it sends the stored guide again, which gets the same receipt. A turn that ends without a valid guide gets one follow-up turn asking for it; if that also ends without one, the attempt fails with `no-guide`.

**A streamed guide is its own draft.** When the provider streams `submit_guide`'s input, the agent writes the guide once and the reader watches it grow. `Reviews` feeds each call's `guide-input` into a scanner (`reviews/guideStream.ts`) that tracks JSON nesting and hands back a piece only once it has closed: a top-level field (`summary`, `background`, `steps`, `flow`, `focus`) or one chapter of `chapters`. Each piece is merged into the draft exactly like a `submit_draft` call, then checked leniently, with one difference: a flow node or focus item pointing at a chapter not written yet loses that link until the chapter lands (`withoutUnwrittenChapters`), because the flow is written before the chapters. A piece that fails the check is left out and logged, so the reader keeps the last good draft and the call's own check tells the agent what was wrong. Partial text never reaches the UI. While the chapter list is still open, the attempt's `DraftOutline.growing` is set (kept in memory for the running turn, like in-flight reads): the progress line says "Writing chapter n" without a total, the bar holds where it is, and chapters show no "of n". A second call (after a rejection) merges into the same draft in place and never marks it growing. The call itself is still what `submit_guide` checks and stores; nothing streamed becomes a revision.

Writing the guide once is the point. Measured on `prkit-fixtures#1` with Claude Fable 5.1 Medium, drafting first meant about 2,700 output tokens of drafts and then 2,300-2,700 again in `submit_guide`, about 25-30 s of writing twice. The cost moved to rejected calls: a draft caught a misplaced file one chapter at a time, while a rejected streamed call was written again whole, until `revise_guide` let it send only what changes.

**What the agent sees.** The worktree checked out at the head SHA, the merge-base so `git diff <mergeBase>...HEAD` works, the numbered diff (old and new line numbers on every line, like the visualize-pr skill's `diff.txt`) in the attempt's `diffs/` directory, and a prompt with the PR title, body, the reviewed files, the guidance blocks and focus areas of its frozen settings, and on later attempts the commits since the last revision, with the diff since that revision and its guide as files next to the numbered diff. The prompt also asks for the hand-over order: progress and file notes while reading, then for a streaming provider one `submit_guide` with its fields in reading order (`summary`, `background`, `steps`, `flow`, `chapters`, then `focus`, `focusAreas`, `guidanceNote`), and otherwise a draft of the overview and planned chapters, each chapter as it is written, then `submit_guide`; either way, `revise_guide` for the problems a rejection lists. The writing rules are the visualize-pr `SKILL.md` "How to write" and "Writing the guide" sections, kept in `apps/server/src/reviews/instructions.md`.

## Stacks

GitHub can group PRs into a stack: each PR (a layer) targets the branch of the one below it, and the bottom one targets the trunk. The `gh stack` extension makes and rebases them. A host without stacks (GitHub Enterprise Server) rejects a whole query that selects `stack` as `undefinedField`. `GitHubApi` remembers that host for the run and sends the inbox and fingerprint queries without stack fields from then on, so a PR there reads as unstacked; the REST detail's `stack` is optional anyway.

```ts
StackMembership = { number, size, position, base }   // position 1 is the bottom layer; base is the trunk
PullRequestStack = { number, base, layers: Array<{ position, number, title, state, isDraft,
                                                   headBranch, baseBranch, additions, deletions }> }  // bottom to top
```

- **Reads.** The inbox searches and the fingerprint select `stack { number size baseRefName } stackEntry { position }`, which cost nothing extra. The detail takes the REST pull's own `stack`. The layers come from `stack(key)`, keyed by account and `<host>/<owner>/<repo>/stacks/<number>`, through the PR's bound account; an answer that no longer lists the PR is read again. A fingerprint change in what the strip shows (title, state, draft, head, base branch, stack) marks that stack stale and sends `stack` on `github.events`; a new comment doesn't.
- **Inbox and PR view.** A stacked row shows "Stack 2/3", and the layers of one stack sit together in their group, bottom to top, where its most recently updated layer would be. Under the PR header a strip lists the layers with their state and guide (none, writing, ready); a layer opens as a tab bound to the account that read the stack, or the binding it already has.
- **Guides for several layers.** The guide setup of a stacked PR offers This PR, Whole stack (its open layers) or Choose layers; `Cmd+G` and the palette's "Generate guide" always mean this PR, and the palette also has "Generate guides for the whole stack". `reviews.generateStack` checks the chosen numbers against the stack it reads now, saves the setup's guidance on this PR and, when it isn't empty, on every chosen layer, and skips layers that are closed, running, or have a guide unless `regenerate`. It records a `guide_batches` row and starts one attempt per layer, bottom to top, with one agent selection, under the usual two agent slots. Each layer gets its own review: a new one is bound to the account that read the stack. Each started layer opens as a tab on its Guide, so its progress shows there.
- **One notice.** Batch attempts carry `batch_id` and send no `ready` of their own. When an attempt of a batch ends, however it ends, and none of the batch's attempts is unfinished, the batch claims `announced_at` once and sends `stack-ready` with the count of accepted and failed layers (from each review's latest attempt in the batch), which becomes one toast and one macOS notification ("Stack guides ready · 3 PRs") opening the PR it was started from. A restart reruns interrupted attempts in the same batch.
- **The prompt.** A stacked PR's prompt has a section after the description: its position, every layer with number, title and state, and the visualize-pr skill's stack rules. Its diff is only its own layer on top of the one below, so the guide covers only that layer's files; other layers are written `#123`; code a lower layer added is `unchanged` in the flow with "Added in #123". Validation stays per PR: coverage of its own reviewed files. In the guide viewer `#123` for a layer of the same stack opens that layer's Guide tab; other references open GitHub.
- **Rebases and merges.** `gh stack rebase` force-pushes every layer, so each layer's next attempt is `rewritten` and fresh, and a layer that only got new commits is updated. Each attempt stores the base branch it was written against, and `watching` carries it. When the layer below merges and the next one targets the trunk, the watcher sees the new `baseRefName` even if the head didn't move, and the attempt is `retargeted`: written fresh against the new base, never updated on top of a guide for the old one. A revision from before stacks has no base branch and is compared by head only.

## Guide settings

The reviewer shapes guides with three kinds of settings, each set in three scopes, least to most specific: **Global**, **Repository** and **Pull request**. Settings > Guides edits Global and Repository; the guide setup edits the pull request's own. A repository's settings are keyed by GitHub's repository id (`<host>/<databaseId>`), so a rename or transfer keeps them; Settings shows the name prkit last saw. A pull request's settings are keyed by its `PullRequestKey`, like its review, and exist before the first Generate.

- **Ignore rules** are repository-relative, case-sensitive patterns: `name` matches a file or folder at any depth, `folder/` everything inside folders with that name, a pattern with a `/` starts at the root, `*` stays in one folder and `**` crosses folders, `!pattern` keeps a file. The rules apply in one order, Global then Repository then Pull request, each in its list order, and the last matching rule that is on decides. Unlike git, a skipped folder doesn't hide its files from later rules, so `test/` then `!test/a.test.js` keeps that one file. A renamed file is decided on its old and its new path and skipped only when both are.
- **Focus areas** are questions the reviewer wants answered (`{ label, question }`). Every guide answers each active area once in `focusAreas`: `notable` with the chapter that explains it, `nothing-notable`, or `not-assessed` with the reason. This is structural coverage; prkit checks an answer exists, not that it is right.
- **Guidance** is one text block per scope. The agent gets every active block labelled by scope with the rule that the more specific scope wins, and may say how it settled a conflict in one advisory sentence, `guidanceNote`. A scope's block can `replace` instead of append, which drops the less specific blocks: the structural way to settle a known conflict. Guidance changes emphasis, never the guide format, the writing rules, the tools or the sandbox.

**Conflicts between scopes.** Items have ids that are never reused. A more specific scope can switch an inherited rule or area Inherit, On or Off, and the most specific explicit choice wins, so a pull request can switch back on a Global rule its repository switched off. To reword an inherited area, switch it off and add your own. An override whose item was deleted does nothing, is shown as a warning, and never attaches to a new item. Focus areas and guidance can't pull a skipped file back in; only an ignore rule can. If every changed file would be skipped, the guide setup blocks Generate and an attempt that finds the same fails with `settings`, both naming every rule that decided a file.

**Saving.** `guide_config` holds one row per scope and section (`ignore`, `focus`, `guidance`) with a JSON value and a version. A save sends the version its form loaded and is a compare-and-set on it, so a form opened before another save is refused ("these settings changed since you opened them") instead of overwriting newer edits or bringing back deleted items. A clean form follows the server; an edited one keeps its version.

**Frozen per attempt.** When an attempt has read its PR (which gives the repository id), it reads all three scopes in one query and resolves them into an `AttemptConfig`: every rule and area with its state and the scope that decided it, the active guidance, dangling overrides, and a hash of only what reaches the guide (active patterns in order, active areas, active blocks). After the diff is fetched it adds the skipped files with their deciding rules and stores the config with the full snapshot. Everything after reads that config: the numbered diff, the file list, the diff since the last revision and the previous guide given to the agent are filtered with it; drafts and `submit_guide` are checked against the reviewed files and its focus areas. Edits saved while an attempt runs apply to the next one. If the new hash differs from the last revision's, the attempt starts a fresh session and writes the guide over the whole filtered diff instead of updating the previous one; switching off an item doesn't change the hash. The Guide status bar shows the revision's settings ("Written with 2 focus areas · skipped 7 files", with the exact frozen config on click) and "Settings changed since this revision · Regenerate" when the pull request's current hash differs.

**Where it is.** Resolution, matching and the hash are pure functions in `packages/contracts` (`guideConfigResolve.ts`), shared by the guide setup's preview and the server, and covered by `packages/contracts/test/guideConfig.test.ts`. `GuideConfigStore` on the server owns the rows and the repository lookups.

## Repository access

`RepoCache` owns git, through one command builder (`gitRun.ts`) every call site uses. Every git command prkit runs uses `GIT_CONFIG_GLOBAL=$PRKIT_HOME/gitconfig` (a file prkit owns that sets only `core.symlinks=false`), `GIT_CONFIG_NOSYSTEM=1`, and `GIT_TERMINAL_PROMPT=0`, so the user's `insteadOf` rewrites, credential helpers, pagers and ssh keys never apply. The remote is always `https://<host>/<owner>/<repo>.git`.

- **prkit's git never trusts a checkout's metadata.** prkit's git runs outside every sandbox, so an agent that could change a checkout's git metadata could make it run a command. Three things stop that. First, every command carries `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` computed by prkit (the cache from the pull request's ref, the worktree's git dir as `<cache>/worktrees/<name>`), so git never reads the worktree's own `.git` file or its `commondir` to find them. Second, the safety flags pin the config keys that run a program off on the command line, where `-c` beats every file: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, empty `core.sshCommand`, `diff.external` and `credential.helper`, `core.pager=cat`, and `protocol.allow` narrowed to https; filter drivers are kept out by reading only prkit's own config. Third, before prkit builds a commit in a checkout an agent held, `verifyCheckout` confirms the worktree's `.git`, `commondir` and `gitdir` back-reference still name prkit's own dirs and no `config.worktree` was added; a mismatch fails the fix turn as needing the owner and nothing runs or commits. `ensureWorktree` rebuilds a worktree whose metadata changed instead of resetting it in place. The sandboxes also deny the agent those writes (see Agents), so this is defence in depth.

- **prkit's git looks for what an agent could plant.** After a turn, prkit ends the processes it can tie to the turn (by a per-turn mark in their environment and by watching the agent's process tree) before its own git runs, and runs none of its git in that checkout while it can't make sure they have ended. Right before each of its git steps it refuses what could make git run a program or read another repository: a repository inside the checkout (any entry named `.git` below its root, found by walking the files without git, since git would run `git status` there with that repository's own config), a link or submodule the agent made, a changed plan for the rest of a rebase (prkit starts every rebase with `GIT_SEQUENCE_EDITOR=true` and `--no-autosquash` and compares a hash of git's rebase state before `rebase --continue`), and, before every fetch and push, any key in the cache's config that prkit didn't write. The conflict-marker check runs with `--ignore-submodules=all`. A refusal stops the fix at Needs you with nothing committed or pushed. Both narrow the window in which something the turn left could reach git; neither closes it (fix-agent doc, Turn end and Before prkit's own git).

- Network commands pass the review account's token as a one-off `http.extraHeader` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` in that git process's environment, so it is not visible in `ps` either. The token is never written to a config file or a remote URL.
- The cache is a bare blobless clone (`--filter=blob:none`). An attempt fetches `refs/pull/<n>/head` and the base branch, and writes the guide for the head it actually fetched, even if the PR moved after the watcher chose it (the next tick picks up anything newer), computes the merge-base, then prefetches every blob of the head and merge-base trees before the agent starts. The prefetch asks for those blobs by id without naming any commit the cache has (`fetch.negotiationAlgorithm=noop`, as git's own lazy fetch does): a blobless cache lacks most blobs its commits reach, and GitHub, told it has those commits, may leave the asked-for blobs out of the pack or send them as deltas against blobs the cache never had. After that the agent works fully offline: its git commands carry no token, so anything that would need the network fails instead of fetching with the wrong identity.
- The worktree is detached at the head SHA and reset to it before each attempt, so nothing the agent did in a previous attempt carries over.
- A pull request's symlink is checked out as a small file holding its target (`core.symlinks=false`), so it never leads an agent outside the checkout. The diff is read from trees, so a link still shows as one line, the path it points at. A worktree made before prkit did this, which still holds real links, is made again on its next reset.

## The fix agent

The guide agent only reads. The fix agent writes, and the owner decides what reaches GitHub. Details, races included, are in [fix-agent.md](fix-agent.md); this is the shape.

- **Sessions.** `Fixers` keeps one fixer session per PR, bound to the account the PR was opened through, with the agent the user picked and the provider's native session id, which every turn resumes. The fix watcher ends it when the PR is merged or closed, or the user stops it.
- **Turn queue.** Work arrives as turns: a batch of comments (prkit's drafts or GitHub threads), a conflict resolution, or a revert. Only one turn per PR holds the checkout at a time, `ready` included, and every state change is a compare-and-set on the turn's state, so a late write from a turn that moved on changes nothing. Fix turns take the same two agent slots as guide attempts.
- **Writable profile.** A fix turn runs in its own checkout (`fixes/<fixerId>`), may edit files under it but never its `.git`, runs read-only commands, and runs the repository's check scripts only on a trusted PR (from the repository itself, by the owner, a member or a collaborator, or anywhere the repository opts in). Its commands, scripts included, run in a sandbox that reads and writes only the checkout and the turn's own folders besides the system's. No token and no network either way.
- **Commits by prkit.** The agent never commits, merges or pushes. prkit commits with `commit-tree` as the PR's account with GitHub's noreply address, so no hook or signing config runs, and keeps a ready commit reachable until it is pushed or discarded.
- **Push policy.** Push is a click by default. prkit checks push access on GitHub, pushes only while the branch is still where the turn found it (otherwise it redoes the work on the new head), and per repository may push fixes and merge resolutions without the click. A rebase's force-push with lease, a revert and a resolution with a file that needs a person are always a click.
- **Conflict resolution.** prkit merges the base (or rebases onto it on the user's own PR), keeps the base side of lockfiles, binary and deleted files for the owner, lets the agent resolve the text conflicts with both sides' history and the latest guide in its prompt, and checks for conflict markers and `git diff --check` before it commits.
- **Restart reconciliation.** On startup, before the fix watcher runs: an orphaned agent is stopped if its PID and start time match, turns that were preparing or running fail as interrupted with their drafts returned, a cut-off change request goes back to its earlier result, a cut-off push goes back to `ready` and the next push checks whether it landed, and checkouts of ended sessions are removed. Running it twice changes nothing.

## Client

React 19, TanStack Router, TanStack Query, Tailwind v4, Base UI, lucide icons, `@pierre/diffs` for diffs, `@dagrejs/dagre` for the flow diagram, react-hook-form for forms.

- **Server data** goes through TanStack Query. One module (`apps/web/src/rpc/`) owns the Effect RPC client and turns calls into promises; it is the only place in the web app that runs Effects. Review status and activity arrive on a streaming RPC and are written into the query cache. After a reconnect the client refetches review snapshots before trusting the stream again.
- **Open PRs** are compact horizontal tabs in the 52px title bar, after the prkit mark and the fixed Inbox tab. Each tab shows the PR number, its state, and event-driven review progress. Opening a PR adds it and focuses it. Drag or Alt+Left/Right reorders PR tabs. The server persists their order, account bindings, and active PR. `Cmd+1` opens Inbox, `Cmd+2..9` selects PRs by position, `Ctrl+Tab` and `Cmd+Shift+[`/`]` cycle, `Cmd+W` closes a PR, and `Cmd+Shift+T` reopens the last closed one. `Cmd+N` and `Cmd+T` open the PR palette, which searches titles, repositories, numbers, branches and authors; `Cmd+K` also offers Settings. Settings is a view, opened with `Cmd+,` or the app menu, with Back and Escape returning to the previous tab.
- **A PR view** has a header that collapses to one pinned line on scroll, and four inner tabs: Conversation (reviewers, labels, the description as the opening entry, then comments, reviews, review threads, commits and events in one rail, then checks last; the events are force-pushes, merge, close and reopen, draft and ready, labels, review requests, assignments, title and base branch changes, mentions and duplicates), Files (the full diff with a file tree), Guide (generate, watch progress, read the guide), and Fixes (the fix agent's queue newest first: progress with Stop and discard, what it did per comment or per file, the commit's diff, Push, Discard, Ask the agent to change, Copy patch and Retry, and one line saying whether it runs the PR's check scripts). The checks count sits next to the tabs. Each open PR keeps its own inner tab and scroll position for the session.
- **The Guide tab** starts with a setup block at the app's 12px scale, set up like a document rather than a chat: the agent and model picker grouped by provider with each login and the model's own settings, an optional focus (the PR's own guidance, open from the start when it has some), one muted line of its guide settings ("Skipping 7 files · 2 focus areas · Guidance: Global + this PR"), on a stacked PR the layers to write for, and Generate (`Cmd+G`). The failed state and the Generate again popover reuse the same block. While an attempt runs it shows the agent's narration line, the changed files checked off as the agent reads them with its note on each, a progress bar, and the draft as it is written, planned chapters faded; Details lists the raw tool calls. An update shows the draft as an extra entry in the revision switcher until it is accepted.
- **Look and feel** favors structure and restraint (the 52px title bar, Base UI wrappers in `components/ui/`, a primitive owns its look: `variant`/`size`, layout classes only from the parent), with prkit's own brand: the kit in `assets/brand/` is the source of truth, its colors feed the semantic tokens in `apps/web/src/index.css` (values from the kit), and Fira Sans (UI) and JetBrains Mono (code, wordmark) ship bundled so the app works offline.

## Monorepo

```
apps/server          Effect server: RPC, MCP, GitHub, reviews, agents, git, SQLite
apps/web             React UI
apps/desktop         Electron shell
packages/contracts   Effect Schemas and the RPC group shared by server and web
```

Tooling: pnpm workspaces with a version catalog, Vite+ (`vp`) for dev, build, lint and format, TypeScript 7 with `@effect/tsgo`, and strict compiler options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

## Testing

prkit has almost no unit tests on purpose. Behavior is proven end to end:

- `tests/*.e2e.ts` run with [tester-army/e2e](https://e2e.tester.army/docs) against the real server serving the real UI. Most read the real GitHub accounts on this machine and the fixture repository named in the gitignored `.e2e/local.json`. Journeys that call `startFakeGitHub` read a local fake GitHub (`scripts/fake-github.ts`) with one account instead, so they can count requests, force rate limits and slow answers, push and merge on demand, and open PRs the fixture doesn't have: a fork's, one with a fixed history of events.
- Nothing private goes into the repository. The owner's own values live in gitignored files read at run time (`scripts/localConfig.ts`): `.e2e/local.json` names the fixture repository and `.private-names` the names to refuse, and a linked worktree reads the main checkout's copies. `pnpm check:private`, part of `pnpm lint` and of the pre-commit and commit-msg hooks (`pnpm exec vp hooks enable`), fails on any login of a gh account on this machine, any `.private-names` entry or the home path, and prints only file, line and category.
- The `verify-prkit` skill (`.agents/skills/verify-prkit/`) tells an agent how to launch an isolated instance, drive it, and keep evidence.
- A Playwright `_electron` smoke test proves the built desktop shell starts, shows the UI, and talks to its server.

A unit test is fine when it pins a real behavior that is hard to reach from the UI (guide validation errors are the likely one), and only if it would fail when the behavior breaks.
