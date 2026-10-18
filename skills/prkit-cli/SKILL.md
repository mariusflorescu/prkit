---
name: prkit-cli
description: Use prkit, the desktop app on this Mac for reviewing GitHub pull requests, whenever the user mentions prkit, a guide or guided review, their review queue, PRs assigned to them, or asks you to prepare, summarize or follow up on pull request reviews on this machine. Use it even if they don't mention the CLI. Read their inbox and diffs, choose an installed agent and model to write a guide, follow its progress, and hand local draft comments to prkit's fix agent. Start with prkit status; keep GitHub writes in the app for the user to approve.
---

# prkit CLI

prkit is a local app that keeps the user's pull request inbox across their GitHub accounts, writes **guides** (an agent's walkthrough of a PR's diff, chapter by chapter), and runs a **fix agent** that turns review comments into commits. Those commits wait in the app until the user clicks Push. The command talks to the running app, so everything you start shows up in the app too, labelled "Started from prkit CLI".

The installed CLI is the source of truth for flags: run `prkit --help` or `prkit <command> --help` whenever you're unsure. Read [the command reference](references/commands.md) when you need a less common read, local tab or draft action, or versioned guide settings.

## Start with `prkit status`

Run `prkit status --json` before anything else. It tells you whether prkit is open, the Outside agents access level, the accounts and their GitHub budget, and current guide and fix work. Use `prkit accounts --json` for account details and `prkit agents --json` for model options.

Exit codes tell you what to do next:

| Code | Meaning                                                            | What to do                                                                                                                                      |
| ---- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done                                                               | Carry on.                                                                                                                                       |
| 1    | The action failed                                                  | Read the message: it says why (not found, needs an account, not ready, a GitHub error).                                                         |
| 2    | Usage error                                                        | Check `prkit <command> --help`.                                                                                                                 |
| 3    | prkit isn't open, Outside agents is off, or the CLI can't reach it | Tell the user what the message says, e.g. to open prkit and turn on Settings > Outside agents. Don't try to launch or configure prkit yourself. |
| 4    | Needs "Read and start work"                                        | prkit is set to Read only. Tell the user; don't look for a way around it.                                                                       |
| 130  | Interrupted by SIGINT or SIGTERM                                   | The CLI closed its session. Guide and fix work continue in prkit.                                                                               |

If your sandbox blocks loopback network, the command can't reach the app and exits with 3, saying so. Ask the user to allow network for it or allow this command outside the sandbox.

## Output and paging

Use `--json` whenever you'll read the result yourself: it is the structured answer from prkit's MCP tool, unchanged. Use plain output when you're showing something to the user as is; it explains how to continue a page.

Paged reads take `--limit` (1 to 100) and `--cursor`. Keep the same command, target and filters, pass `nextCursor` verbatim, and continue until it is null. File patches can span pages: join text fragments for the same path in `offset` order until `complete` is true. File contents and fix patches are text items joined by `offset`. A true `githubTruncated` or `threadsTruncated` means GitHub omitted data; say so, even after the last local page.

A large answer can instead be `_tag: "response-fragment"`. Keep the logical page's `--cursor` unchanged, follow `nextResponseCursor` with `--response-cursor`, join each `text` by `offset`, then parse the complete JSON. Only then follow its normal `nextCursor`. Don't treat one fragment as the full answer.

## Naming a pull request

Pass a URL (`https://github.com/owner/repo/pull/123`) or `owner/repo#123`. For a GitHub Enterprise host, add `--host` when using the short form. If prkit can read the PR through more than one account, it fails and lists them; pass `--account` with the one the user means. Never silently switch accounts to make a call succeed.

Repository commands take `owner/repo`; inbox filters use `--repo owner/repo`. Accounts come from status or accounts, as `host/login`, not a token.

## What it won't do, and why

Anything that writes to GitHub stays a click in the app: pushing, merging, posting or resolving comments and reviews, reviewers, labels, closing a PR. So do account and agent setup, Global or Repository settings changes, and discarding or reverting fix work. This is on purpose: an agent reading PR content can be steered by it, so nothing it says can reach GitHub without the user seeing it first. A repository where the user enabled both automatic conflict resolution and automatic push is an existing exception: prkit's watcher can resolve and push conflicts on watched PRs.

Reading settings is allowed. At Read and start work you can also open, close, focus or reorder local tabs, save the app's inbox filters, edit or move local draft comments, mark files reviewed, and save PR-scope guide settings. These stay on the machine. Closing a tab doesn't close the PR on GitHub.

When the user asks for an excluded action, tell them it's waiting for them in prkit (and open the PR there with `prkit pr open <pr>` if that helps). Only do it another way, such as with `gh`, if the user explicitly asks you to.

## Workflows

### What's waiting on me

```sh
prkit inbox --json
prkit inbox --reason review-requested --json
prkit inbox --reason authored --json
prkit inbox --reason involved --repo owner/repo --json
```

Summarize by repository and age, and say which PRs already have a guide. Add `--account`, `--state`, `--draft`, `--checks`, `--search` or `--stacks` when the user asks to narrow it. These reads don't change the app's saved filters.

### Read the PR and its diff

```sh
prkit pr read <pr> --json
prkit pr files <pr> --limit 20 --json
prkit pr files <pr> --limit 20 --cursor '<nextCursor>' --json
prkit pr file <pr> --path src/a.ts --side new --json
prkit pr threads <pr> --json
prkit pr checks <pr> --json
```

`prkit pr files <pr>` gives the current PR's changed files and patches. `prkit pr reviewed <pr> --json` says which of those files the user already marked reviewed in prkit (`changed` means the file changed after they reviewed it, so it needs another look), so you can start with what they haven't seen. Mark files reviewed with `prkit pr reviewed set <pr> --head-sha <headSha> --paths <path>`, passing the `headSha` that read returned, only when the user asks: a mark is their judgment that they read the change. Read old or new file contents when the patch isn't enough. To explain an accepted guide's exact snapshot, get its attempt id from `prkit guide revisions <pr> --json`, then use `prkit pr diff <pr> --attempt-id <attempt-id> --json`. Don't assume today's diff is the one the guide reviewed.

### Write a guide and report back

1. Pick the agent. Read `prkit agents --json`, follow its pages, and choose a ready, enabled instance with an unblocked model. Use its `instance` for `--agent`, its model `slug` for `--model`, and only option ids and values advertised by that model. Repeat `--option key=value`; `true` and `false` are booleans. Leave selection out for the PR's configured agent or prkit's default.
2. For a stack, read `prkit pr stack <pr> --json` before choosing. `--stack this` covers this PR, `--stack all` covers the stack, and `--stack 1,3` selects its numbered layers. Use `--stack` once; numbered selection cannot be combined with `--layers`. The native form is `--stack chosen-layers --layers 1 --layers 3`. `--regenerate` includes layers that already have guides.
3. Start it:
   ```sh
   prkit guide generate <pr> --agent <instance> --model <model> --option effort=high --stack this
   ```
4. Wait for it. Guides take a few minutes:
   ```sh
   prkit wait <pr> --for guide --timeout 600
   ```
   `wait` returns when work stops or the timeout passes. Check the returned state for failure. If `finished` is false, call it again. Don't loop on `sleep` and reads: `wait` is cheaper and prkit already watches GitHub. Use `prkit guide progress <pr> --json` for narration and activity when asked.
5. Read it with `prkit guide read <pr> --json` and give the user the summary, the before/after (`content.flow`, when there is one), the main risks, and what deserves a closer look. Mention they can read the full guide in the app.

For several PRs, start every guide first, then wait on each; prkit queues work behind running agents.

`--focus` and `--guidance` are versioned JSON edits that save this PR's settings when generation starts, not plain strings. Read `prkit guide settings <pr> --json` first. Use the matching `scopes.pullRequest.focus.version` or `scopes.pullRequest.guidance.version` as `expectedVersion`. Preserve current items and overrides that the user hasn't asked to change. See the reference for the JSON shapes and standalone PR settings saves. On a version conflict, read again and reconcile the user's change; don't overwrite the newer settings blindly.

### Hand review comments to the fix agent

```sh
prkit comments add <pr> --path src/a.ts --line 42 --body "Handle the empty list" --request-id comment-42
prkit fix send <pr> --request-id fix-42
prkit wait <pr> --for fix --timeout 600
prkit fix read <pr> --json
```

Comments stay as local drafts. `fix send` sends every waiting draft unless you select repeated `--draft-ids` or `--thread-ids` from `prkit comments list <pr> --json`. Follow the fix read's pages. For the complete change, use `prkit fix diff <pr> --turn-id <turn-id> --json` or `prkit fix patch <pr> --turn-id <turn-id> --json`; the summary's latest diff can be cut.

Tell the user what changed and that the commit is waiting for Push in prkit. To adjust it, use `prkit fix change <pr> --instructions "what to change" --request-id change-42`. For merge conflicts, use `prkit fix resolve <pr>`. Each of these also waits for Push.

### Show the user something

`prkit pr open <pr>` opens the PR in prkit and brings the app forward. Use it when the user should look at something themselves. `prkit tabs list --json` shows the open tabs; local close and focus actions leave guides, fixes and commits in place.

## Retries

`prkit comments add <pr>`, `prkit fix send <pr>` and `prkit fix change <pr>` take `--request-id <id>`. If a call timed out and you don't know whether it went through, retry with the same id: prkit returns the first answer instead of doing it twice. A lost response isn't automatically replayed. Read the current state before retrying other work commands.

## GitHub budget

Reads come from prkit's cache, which prkit keeps fresh itself. Add `--refresh` only when the user wants the very latest and that command offers it. It spends their GitHub API budget, which they share with every other tool. Follow continuation cursors instead of refreshing every page.
