# Outside agents

Settings > Outside agents lets the owner's own MCP client (Claude Code, Codex, Cursor, anything that starts a server over stdio) use prkit from a terminal session: see the inbox, open a PR in the app, start and read a guide, add draft comments and send them to the fix agent, follow its progress, and have a guide written of a repository's local changes before a pull request exists. It is off by default. Anything that reaches GitHub stays a click in the app: pushing, merging, posting a review, replying to or resolving a thread.

## Setup

Settings shows one command per client, with `<home>` the prkit home (`~/.prkit` for the app):

```sh
claude mcp add --scope user prkit -- <home>/bin/prkit-mcp
codex mcp add prkit -- <home>/bin/prkit-mcp
```

No secret goes in a client's config. `bin/prkit-mcp` is a launcher prkit writes on every launch (mode 0700): it runs prkit's own server binary (`ELECTRON_RUN_AS_NODE=1` in the app) with `mcp-bridge`, which `bin.ts` picks before loading anything else. The bridge never opens the database or touches `prkit.lock`, so it runs beside the app.

Before writing launchers, prkit checks `bin` and every ancestor using the shared trusted-folder check. Unsafe folders skip both launcher writes while the app keeps running and publishes discovery. Settings reports the component and reason instead of offering bridge setup commands, and the CLI install action refuses with the same problem. Fix the folder and restart prkit to create the launchers.

## Levels and parity inventory

Read tools are available at **Read only** and **Read and start work**. Local state changes and agent starts are available only at **Read and start work** (Work below). Every tool has typed parameters and a typed success schema in `apps/server/src/outside/`, used by the MCP toolkit and available to the CLI.

The inventory covers every WebSocket RPC and the app's local presentation actions. Exclusion A means a GitHub write; B means changing settings, identity or trust; C means a destructive local action; D means putting the guide agent's words into a review, which only a person confirming them in the app may do. Reads of settings are allowed, except environment and sensitive values, which never leave the server. Excluded actions have no tool declaration, so admitting one later requires an explicit declaration at the work level and its handler check.

| App action | RPC / app surface | Tool or exclusion | Level |
| --- | --- | --- | --- |
| Status and accounts | app.info, accounts.list, github.budget | `prkit_status`, `list_accounts` | Read |
| Account discovery and config directories | accounts.refresh, accounts.addConfigDir, accounts.removeConfigDir | Excluded B: refresh identity, add/remove gh config directories | Excluded |
| Inbox, refresh and filters | inbox.list | `list_inbox`: reason, accountId, repository, state, draft, checks, search, stacks, sort; cursor, limit, refresh | Read |
| Repository list and open repository PRs | repositories.list, repositories.pullRequests | `list_repositories`, `list_repository_pull_requests` | Read |
| PR detail and refresh | pullRequests.detail, pullRequests.refresh | `read_pull_request`; refresh on paged PR reads | Read |
| Changed files and diff | pullRequests.files | `read_pull_request_files` | Read |
| Expand file contents | pullRequests.fileContents | `read_file_contents` | Read |
| Files marked reviewed, and their progress | reviewedFiles.get, reviewedFiles.set | `read_reviewed_files` (current files, or one guide revision with its chapters), `mark_files_reviewed` (sets or clears the mark on files of the current diff; local, never reaches GitHub) | Read / Work |
| Code around each change in the diff viewer | diffs.texts | Presentation: the viewer reads the new side of the changed files to show the function or class around each change. Outside tools read file text with `read_file_contents` | Presentation |
| Manual check steps ticked | manualCheckTicks.get, manualCheckTicks.set | `manualCheckTicked` in `read_guide` and `read_guide_revision`, `tick_manual_check_steps` (ticks or unticks steps of one revision's plan by number; local, never reaches GitHub) | Read / Work |
| Conversation comments/reviews, checks, timeline | pullRequests.timeline | `read_conversation`, `read_checks`, `read_timeline` | Read |
| Stack strip and layers | pullRequests.stack | `read_stack` | Read |
| Available reviewers, teams and labels | pullRequests.candidates | `read_pull_request_action_candidates` | Read |
| GitHub PR actions | pullRequests.execute | Excluded A: merge/squash/rebase, enable/disable auto-merge, close/reopen, draft/ready, edit title/body, reviewers/teams/labels, assignees/milestones, update/delete branch, approve workflows, revert PR | Excluded |
| Workspace and open tabs | workspace.get | `list_open_pull_requests` (tabs, not repository PRs) | Read |
| Open/reopen a PR tab | workspace.open | `open_pull_request` | Work |
| Close/focus/reorder tabs | workspace.close, workspace.activate, workspace.reorder | `close_pull_request_tab`, `focus_pull_request_tab`, `reorder_pull_request_tabs` | Work |
| Save Inbox presentation filters and sort | workspace.saveInboxFilters | `save_inbox_filters` | Work |
| Generate, regenerate and retry a guide | reviews.generate, reviews.retry | `generate_guide` with instance, model, options, guidance, focus and version checks; retries use the same generation service | Work |
| Generate stack guides | reviews.generateStack | `generate_guide` with stack this-pr / whole-stack / chosen-layers, layers and regenerate | Work |
| Stop guide and watcher | reviews.stop | `stop_guide` | Work |
| Current guide/progress and review feed | reviews.get, reviews.feed | `read_guide`, `read_guide_progress`, `list_reviews` | Read |
| Guide revision switcher and saved diff | guides.get, reviews.diff, guides.draft | `list_guide_revisions`, `read_guide_revision`, `read_review_diff`; `read_guide_progress` includes the draft | Read |
| Typical guide duration | reviews.typicalDuration | `read_guide_duration` | Read |
| Guide defaults and auto mode | guideSettings.get | `read_settings` | Read |
| Change default agent or auto mode | guideSettings.update | Excluded B | Excluded |
| Resolved guide settings and preview | guideConfig.pullRequest | `read_guide_settings`: scope versions, active guidance/focus/ignore rules/look-closely paths, skipped files | Read |
| Read scope settings and repository lookup | guideConfig.scope, guideConfig.repositories, guideConfig.findRepository | `read_guide_scope`, `list_guide_repositories`, `find_guide_repository` | Read |
| Save guide settings | guideConfig.save | `save_pull_request_guide_settings`, and guidance/focus in `generate_guide`, only for this PR. Global and Repository changes excluded B | Work |
| Agent picker, status and model options | agents.catalog | `list_agents`; safe fields only, no environment values | Read |
| Agent identity, configuration and installation | agents.signIn, agents.signOut, agents.create, agents.update, agents.remove, agents.reset, agents.installCursor | Excluded B: sign-in/out, instances, environment, sensitive values and SDK installation | Excluded |
| Read/add local drafts | reviewComments.list, reviewComments.add | `list_review_comments`, `add_review_comment` | Read / Work |
| Edit/move local drafts | reviewComments.edit, reviewComments.move | `edit_review_comment`, `move_review_comment` | Work |
| Draft from a guide note | reviewComments.addFromNote | Excluded D: an outside agent writes its own drafts with `add_review_comment` | Excluded |
| Delete drafts | reviewComments.delete | Excluded C | Excluded |
| Submit GitHub review | reviewComments.submit | Excluded A | Excluded |
| Read GitHub threads | reviewThreads.list | `read_threads`, `list_review_comments` | Read |
| Reply/resolve/unresolve GitHub threads | reviewThreads.reply, reviewThreads.resolve | Excluded A; posting or editing GitHub comments is also excluded | Excluded |
| Fix snapshot, feed and turn details | fixers.get, fixers.feed | `read_fix`, `list_fixes`, `read_fix_turn` | Read |
| Send drafts/threads to fix agent | fixers.send | `send_to_fix_agent`: draftIds, threadIds, instructions, instance, model, options; replies after Push stay disabled | Work |
| Resolve conflicts locally | fixers.resolveConflicts | `resolve_conflicts`: merge/rebase strategy and agent selection | Work |
| Change/retry/stop queued or running fix work | fixers.revise, fixers.retry, fixers.stop | `ask_fix_agent_to_change`, `retry_fix`, `stop_fix`; stopping never ends the session or discards a ready commit; retry refuses reverts | Work |
| Read fix diff and Copy patch | fixers.diff, fixers.patch | `read_fix_diff`, `read_fix_patch` | Read |
| Read push/script eligibility | fixers.pushAccess, fixers.scriptAccess | `read_fix_access` | Read |
| Push fix, merge resolution or rebase | fixers.push | Excluded A, including force-push | Excluded |
| Discard fix commit, end fix session, revert | fixers.discard, fixers.revert | Excluded C; ending a session via fixers.stop is also excluded | Excluded |
| Repository fix settings | fixerSettings.list | `read_settings` | Read |
| Push/resolve automatically or trust repository scripts | fixerSettings.update | Excluded B | Excluded |
| Appearance | appearance.get, appearance.update | `read_settings`; changes excluded B | Read / Excluded |
| Outside agents state/access/reset | outsideAgents.get, outsideAgents.update, outsideAgents.reset | `read_settings`; enabling/disabling, access changes and Reset access excluded B | Read / Excluded |
| CLI setup and skill installer | cliInstall.get, cliInstall.install, cliInstall.uninstall, cliInstall.skill | Setup status is presentation; installing/removing the launcher and opening the skill installer are excluded B: machine setup | Presentation / Excluded |
| Local guides: list, read, file contents | localReviews.list, localReviews.get, localReviews.fileContents, guides.get | `list_local_guides`, `read_local_guide` | Read |
| Start and stop a local guide | localReviews.generate, localReviews.stop | `generate_local_guide` from a folder (the app's Run again takes the review's key), `stop_local_guide` | Work |
| Open/close a local guide's tab | workspace.openLocal, workspace.closeLocal | `generate_local_guide` opens the tab without focus; closing it is app only | Work / App |
| Retry a local guide's failed run | localReviews.retry | App only: `generate_local_guide` again takes a fresh snapshot instead | App |
| Remove a local guide | localReviews.remove | Excluded C | Excluded |
| Live updates and waiting | github.events, workspace.changes, reviewedFiles.changes, manualCheckTicks.changes, reviews.watch, fixers.watch, localReviews.watch, localReviews.feed | Finite snapshot reads above plus `wait_for` and `wait_for_local_guide`; no outside background subscriptions or polling loop | Read |
| Desktop updater: channel/automatic checks, check/download/install/restart | Electron update bridge | Changes excluded B (installation and trust). Native updater status has no server service and is outside this unit’s server-only build scope; release notes and What’s new are presentation. | Excluded / Presentation |
| Navigation, inner tabs, scrolling, collapses, keyboard shortcuts, text selection, copy/open links | Presentation only | Read the corresponding data or use the workspace tool; these have no separate domain operation | Presentation |

### Tool parameters

All PR tools accept `url`, or `owner`, `repo`, `number` and optional `host`, plus `accountId` when needed. Paged reads accept `cursor` and `limit` (1-100, default 20). Use `nextCursor` until null. Every list cursor hashes the full ordered result contents and read identity. File-diff identity includes head, base and merge-base SHAs. An invalid cursor answers invalid; a changed result answers conflict: "The list changed, start again without cursor." `refresh: true` spends budget on the first page only. Source truncation (`githubTruncated`, `githubTotal`, or per-account repository totals) is separate from the tool's pagination.

Diffs, file contents and patch text are split into fragments of at most 8,000 characters. The endpoint caps each complete successful MCP tool response at 48,000 encoded bytes, including the text and structured-content copies, JSON escaping and envelope headroom. This applies to metadata too, including the full attempt and draft from `read_guide_progress`. `offset` is a character offset; concatenate fragments in order. A file's `complete` marks its last patch fragment. A truncated page explicitly says to read `nextCursor`. Binary and oversized upstream patches keep their tagged representation rather than pretending to contain text.

When a complete result is too large, the success value is a typed `_tag: "response-fragment"` with `encoding: "json"`, `offset`, `text`, `totalCharacters` and `nextResponseCursor`. Concatenate `text` by offset and decode the original tool success schema. Repeat the original parameters on the same tool with `responseCursor: nextResponseCursor` until null. These calls read an immutable response snapshot and never repeat the tool action or GitHub read. Snapshots are bound to the tool and client, retained for five minutes under a 32 MB total limit; an expired/evicted cursor answers conflict and requires a new read. A result larger than 32 MB fails explicitly and asks for a narrower read. List pagination and response fragmentation are separate: reconstruct each list page before following its `nextCursor`.

| Tool | Level | Parameters beyond the PR target |
| --- | --- | --- |
| `list_accounts` | Read | `ListInput` schema (no PR target) |
| `list_repositories` | Read | `RefreshListInput` schema (no PR target) |
| `list_repository_pull_requests` | Read | `RepositoryInput` schema (no PR target) |
| `list_agents` | Read | `AgentsInput` schema (no PR target) |
| `read_pull_request_files` | Read | `PagedTargetInput` schema |
| `read_reviewed_files` | Read | `ReviewedFilesInput` schema: `revision` reads a guide revision's saved diff and chapters |
| `read_file_contents` | Read | `FileInput` schema |
| `read_timeline` | Read | `PagedTargetInput` schema |
| `read_threads` | Read | `PagedTargetInput` schema |
| `read_checks` | Read | `PagedTargetInput` schema |
| `read_conversation` | Read | `PagedTargetInput` schema |
| `read_stack` | Read | `PagedTargetInput` schema |
| `read_pull_request_action_candidates` | Read | `TargetInput` schema |
| `list_reviews` | Read | `ListInput` schema (no PR target) |
| `list_guide_revisions` | Read | `PagedTargetInput` schema |
| `read_guide_revision` | Read | `RevisionInput` schema |
| `read_guide_progress` | Read | `PagedTargetInput` schema |
| `read_review_diff` | Read | `ReviewDiffInput` schema |
| `read_guide_duration` | Read | `DurationInput` schema (no PR target) |
| `read_guide_settings` | Read | `TargetInput` schema |
| `read_guide_scope` | Read | `ScopeInput` schema (no PR target) |
| `list_guide_repositories` | Read | `SettingsInput` schema (no PR target) |
| `find_guide_repository` | Read | `RepositoryInput` schema (no PR target) |
| `list_fixes` | Read | `ListInput` schema (no PR target) |
| `read_fix_turn` | Read | `FixTurnInput` schema |
| `read_fix_diff` | Read | `FixDiffInput` schema |
| `read_fix_patch` | Read | `FixTurnInput` schema |
| `read_fix_access` | Read | `TargetInput` schema |
| `read_settings` | Read | `SettingsInput` schema (no PR target) |
| `close_pull_request_tab` | Work | `TargetInput` schema |
| `focus_pull_request_tab` | Work | `TargetInput` schema |
| `reorder_pull_request_tabs` | Work | `ReorderInput` schema |
| `save_inbox_filters` | Work | `SaveInboxFiltersInput` schema |
| `save_pull_request_guide_settings` | Work | `SaveGuideSettingsInput` schema |
| `edit_review_comment` | Work | `EditCommentInput` schema |
| `move_review_comment` | Work | `MoveCommentInput` schema |
| `mark_files_reviewed` | Work | `MarkFilesReviewedInput` schema: `headSha` (the one `read_reviewed_files` returned), `paths` and `reviewed` (true when omitted) |
| `list_local_guides` | Read | `LocalListInput` schema (no PR target) |
| `read_local_guide` | Read | `ReadLocalGuideInput` schema: a local target and `revision` (no PR target) |
| `wait_for_local_guide` | Read | `LocalWaitInput` schema: a local target and `timeoutSeconds` (no PR target) |
| `generate_local_guide` | Work | `GenerateLocalGuideInput` schema: `path`, `branch`, `base`, `description`, `regenerate`, `instance`, `model`, `options` (no PR target) |
| `stop_local_guide` | Work | `LocalTargetInput` schema (no PR target) |
| `tick_manual_check_steps` | Work | `TickManualCheckInput` schema: `revision`, `steps` (1-based numbers in that revision's `manualCheck`) and `ticked` (true when omitted) |

`list_inbox` orders each section by `sort`: `updated` (the default, most recent activity first), `waiting` (review requests by how long they have waited on the owner, longest first, then drafts and requests with no known wait; the owner's own and involved PRs by when they were opened) or `size` (smallest size first, then fewest changed lines, then fewest files); `sort` is `updated` when omitted. The app orders its window with the same function, so a client sees the order the owner sees, and the sort is part of a cursor's identity. A read applies only to the PRs prkit holds, up to 100 per search. Each PR also carries `createdAt`, `size` and `wait`. `size` is `{bucket, additions, deletions, lines, files, readingMinutes}`: XS to XL from the larger of the changed lines (`additions + deletions`: 10, 100, 400, 1,000) and the files (2, 5, 15, 30), and a reading time of `ceil(lines / 20 + files / 2)` minutes, at least 1. `wait` is null unless the PR is a review request; otherwise `{_tag: "waiting", since, cause, via, atLeast}` (`cause` is `requested`, `requested-again` or `ready`, `via` says whether the owner or teams were asked, and `atLeast` means the wait may be longer than `since` says), `{_tag: "draft"}`, or `{_tag: "unknown", reason}` with `not-read`, `no-history` or `unreadable`. `save_inbox_filters` replaces the saved search, account, repository and sort together, so it needs all four. A window that is already open keeps its own until the next load.

`generate_guide` adds `instance`, `model`, `options: [{id, value}]`, `guidance: {expectedVersion, text, mode}`, `focus: {expectedVersion, areas: [{id, label, question}], overrides}`, `stack` (`this-pr`, `whole-stack`, `chosen-layers`), `layers` and `regenerate`. New focus-area ids are null. The catalog's `selectionProblem` validates the choice; partial selections, unknown or repeated option ids are refused before work starts. Guidance and focus use the same per-section compare-and-set versions as the app. Stack generation uses `reviews.generateStack`, preserving its bottom-to-top order and skip reasons.

`read_reviewed_files` gives each changed file's state (`reviewed`, `changed` since it was reviewed, `unreviewed`, or `unknown` for a file prkit can't tell apart and doesn't count), the progress over all of them, and with `revision` the saved diff of that guide revision and its chapters. `changedFiles` and `githubTruncated` mean what they mean in `read_pull_request_files`, so a PR past GitHub's 3,000-file cap says so; a revision reads its saved diff whole. A revision whose guide was written through another account is refused. `mark_files_reviewed` names files of the current diff by path, with the `headSha` that read returned, sets them reviewed or, with `reviewed: false`, not reviewed, and answers with their new states. Repeating a call changes nothing. A path that isn't a changed file fails the whole call, and so does a `headSha` the pull request has moved past (`conflict`), so an agent never marks a version it didn't read. The marks are the owner's, kept in prkit like the checkboxes in the app; they are never sent to GitHub or to an agent, and open windows show a change at once.

A guide's `manualCheck` is the agent's suggestion of how to see the change working by hand: `{_tag: "steps", setup, steps: [{action, expect, watchFor, chapter}]}`, `{_tag: "nothing", reason}` when there is nothing to check by hand, or null on a guide written before plans. `read_guide` and `read_guide_revision` add `manualCheckTicked`, the numbers of the steps the owner ticked. `tick_manual_check_steps` names a revision and its steps by number and sets them ticked or, with `ticked: false`, not ticked. A tick belongs to what the step asks and expects, so it carries into later revisions whose step reads the same. Repeating a call changes nothing, a step number the revision doesn't have fails the whole call, and a revision whose guide was written through another account is refused.

`list_open_pull_requests` continues to mean open **app tabs**. `list_repository_pull_requests` lists a repository's open PRs. `read_guide_revision` returns the guide and frozen settings; use the revision's `attemptId` from `list_guide_revisions` with `read_review_diff` for its exact saved diff. `read_fix_turn` returns the full per-comment/per-file report and script decision. Neither read starts an agent.

The CLI uses one command map in `apps/server/src/cli/commands.ts`. Its parity check compares the map with all 60 tools exactly, and its flags come from the same parameter schemas. The public skill and CLI documentation are checked against that map too.

Each tool is declared once with its level (`apps/server/src/mcp/outside/tools.ts`): `reads` or `startsWork` wraps the handler, and the server refuses to start when a handler's level differs from its tool's. A tool above the client's level is hidden from `tools/list` and unknown to `tools/call`, checked again on every call, so lowering the level takes effect at once. Other failures come back as tool errors with a code (`invalid`, `not-found`, `account-needed`, `not-allowed`, `not-ready`, `conflict`, `github`, `failed`) and a plain message.

Never offered: pushing, merging or any other pull request action, submitting a review, replying to or resolving threads, deleting or discarding anything, reverting, and changes to agents, accounts or settings except `save_inbox_filters` (presentation state) and `save_pull_request_guide_settings` (PR scope only, including the PR guidance/focus saved by `generate_guide`). These are the owner's, in the app. So `stop_fix` stops only queued and running work: the session stays, and so does every commit waiting for Push, including one the agent is changing. `retry_fix` refuses a revert.

One case reaches GitHub without a click, and it is the owner's own opt-in. In a repository with both "Resolve conflicts automatically" and "Push fixes automatically" on, the watcher resolves a conflicting PR it watches (an open tab, a watched guide or an active fix session) and pushes the result (`FixerWatcher`, `conflictTurn`). So `open_pull_request`, `generate_guide`, `send_to_fix_agent` or `resolve_conflicts` on such a PR can lead to that push, exactly as doing the same in the app does. Opening tabs or using `generate_guide` for several stack layers makes each of those PRs one the watcher may resolve and push, just as doing the same in the app does. The turn is the watcher's, not the client's, and there is no extra guard: the two settings are what the owner chose for that repository.

`add_review_comment`, `send_to_fix_agent` and `ask_fix_agent_to_change` take a `clientRequestId`. A request is the tool, the client, the pull request and that id (`outside_requests`, kept a day): a retry gets the first answer, looked up before anything else, instead of doing it twice; the same id with other input answers `conflict`. Each key has its own lock, so one slow call holds back only its own retries.

## Local changes

The five local tools never name a pull request or an account, and reach only prkit's reviews and agents. A local target is a `key` (`local:` and 16 hex), or an absolute `path` inside a git work tree: the repository and the branch it has checked out name the review, so one branch is one review whichever worktree or subfolder asks. `branch` names another local branch instead, for a guide of that branch's last commit. `generate_local_guide` snapshots the folder when it is called, so every problem with the repository (not one, nothing changed, no base, no shared history, files changing while prkit reads them) is answered at once, with the sentence the app would show, and nothing starts. With nothing new since the last revision it answers `unchanged` and starts no agent. Files over 50 MB, files a git filter such as Git LFS stores, and repositories nested inside are left out of the snapshot and listed in the run's `leftOut`. Removing a local review, and retrying a failed run on its old snapshot, stay in the app.

## Accounts

A PR is named by URL or by host, owner, repo and number, each held to GitHub's naming rules (no `..`, no slashes). prkit reads it through the account that has it open, has its guide or fix session, or has it in its cached inbox; when none does, through the only ready account on its host, as pasting a URL in the app does. With several, or none on a host with several, the tool asks for `accountId` and names the options. Nothing falls back to another account.

## What a client starts

Calls from outside count as clicks, like the app's own: reads use the cache, and `refresh: true` on `list_inbox` or `read_pull_request` spends budget for a fresh read. The client's name is whatever it reports in `initialize` (the bridge passes it as `x-prkit-client`, with a random id per bridge for the connected-clients list): a label, not an identity. It is stored on the guide attempt or fix turn it starts (`started_by`), and the activity says "Started from Claude Code". A fix turn a client started never pushes by itself, even in a repository set to push automatically: it waits for Push in the app. A retry or a redo after the branch moved keeps the client's name, even when the owner clicks Retry, since it runs the client's request again. A change a client asks for (`ask_fix_agent_to_change`) makes the turn the client's too, even an owner's turn, and the activity says "Claude Code asked: …" (`startedByFor`, `pushesItself` in `fixers/turnRules.ts`). `open_pull_request` opens the tab and, unless `focus: false`, every window switches to it and the desktop app comes forward (`workspace.changes`). With `focus: false` the tab joins the end of the strip and the active PR stays, on the server too, so a relaunch shows the same PR.

## Discovery and tokens

prkit writes `<home>/outside-agents.json` once its server listens: a fresh temporary file (`wx`, mode 0600) renamed over it. A change stages that file, saves the settings, then renames the file in last, putting the old settings back if the rename fails, and swaps the token in memory only after all three; so a failed step leaves the file and the token as they were, puts the settings back (best effort, after a failed rename), removes the temporary file, and reaches the UI as an error. A home prkit creates is 0700. prkit removes the file when the server stops. While on it holds `{port, token, pid, version, access}`; while off, only `{pid, version}`, so the bridge can tell "off" from "not open". A file whose pid is dead reads as not open.

The token is 32 random bytes, compared in constant time, new on every launch, every switch on, every level change and every Reset access. The server keeps only its SHA-256. This is the one exception to "tokens never touch disk": the file is how a client launched by another program finds prkit, it is readable only by the owner, and it holds no GitHub token. Reset access makes a new token and clears the client list. Anything using a copied token stops working; the bridges on this machine read the new file on their next call and carry on, so it doesn't disconnect the owner's own clients.

The endpoint is `/mcp/outside` on the server's own listener, with its own toolkit, sessions and auth (a second `McpServer` through `Layer.fresh`, since effect's server layer is memoized). It refuses any request with an `Origin` header, a `Host` other than `127.0.0.1:<port>`, the switch off, or a token that isn't the current one. Agent turns' `/mcp` is unchanged: their tokens don't open this endpoint, and this token doesn't open theirs.

## The bridge

The bridge reads the file only when it is a regular file of the current user's with no group or other permissions; anything else counts as prkit not being open. It relays stdio to the endpoint: it forwards the session id and protocol version, reads SSE answers, and keeps the client's `initialize`. On a refused connection, a 401, a 403 or an unknown session, it reads the discovery file again and replays `initialize`, so prkit restarting, a new token, or Reset access cost the client nothing. While prkit isn't reachable it answers itself: `initialize` with `tools.listChanged`, `tools/list` with only `prkit_status`, and every call with "prkit isn't open. Open it, then try again." or the way to turn the switch on. It checks the file every two seconds and sends `notifications/tools/list_changed` when prkit opens, closes, turns on or off, or changes level. Claude Code then lists the tools again within the same session.

## Timeouts

Guides and fixes take minutes. `wait_for` returns when the guide or fix settles, or after `timeoutSeconds` (50 by default, at most 600), under Codex's 60-second default tool timeout. For longer waits, raise the client's: `tool_timeout_sec` under `[mcp_servers.prkit]` in Codex's `config.toml`, or `MCP_TOOL_TIMEOUT` (milliseconds) for Claude Code.
