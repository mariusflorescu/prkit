---
name: prkit-cli
description: Drive prkit, the desktop app on this Mac for reviewing GitHub pull requests, from the terminal with the `prkit` command. See which PRs wait on the user's review or are theirs, open a PR in the app, generate a guided review (choosing the agent and model), follow it until it's ready, read the guide, and hand draft review comments to prkit's fix agent. Use this skill whenever the user mentions prkit, a guide or guided review of a PR, their review queue or the PRs assigned to them, or wants you to prepare, summarize or follow up on pull request reviews on this machine, even if they don't mention the CLI.
---

# prkit CLI

prkit is a local app that keeps the user's pull request inbox across their GitHub accounts, writes **guides** (an agent's walkthrough of a PR's diff, chapter by chapter), and runs a **fix agent** that turns review comments into commits. Those commits wait in the app until the user clicks Push. The `prkit` command talks to the running app, so everything you start shows up in the app too, labelled "Started from prkit CLI".

The installed CLI is the source of truth for flags: run `prkit --help` or `prkit <command> --help` whenever you're unsure. This guide covers how to use it well.

## Start with `prkit status`

Run `prkit status --json` before anything else. It tells you whether prkit is open, whether Outside agents is on, the access level, and the agents (instances and models) you can pick for a guide.

Exit codes tell you what to do next:

| Code | Meaning                                                            | What to do                                                                                                                                      |
| ---- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done                                                               | Carry on.                                                                                                                                       |
| 1    | The action failed                                                  | Read the message: it says why (not found, needs an account, not ready, a GitHub error).                                                         |
| 2    | Usage error                                                        | Check `prkit <command> --help`.                                                                                                                 |
| 3    | prkit isn't open, Outside agents is off, or the CLI can't reach it | Tell the user what the message says, e.g. to open prkit and turn on Settings > Outside agents. Don't try to launch or configure prkit yourself. |
| 4    | Needs "Read and start work"                                        | prkit is set to Read only. Tell the user; don't look for a way around it.                                                                       |

If you run inside a sandbox that blocks network (Codex's default sandbox does), `prkit` can't reach the app and exits with 3, saying so. Ask the user to allow this command outside the sandbox, or to allow network for it.

## Output

Use `--json` whenever you'll read the result yourself: it's the same structured answer prkit's MCP tools give. Use the plain output when you're showing something to the user as is.

## Naming a pull request

Pass a URL (`https://github.com/owner/repo/pull/123`) or `owner/repo#123`. For a GitHub Enterprise host, add `--host` when using the short form. If prkit can read the PR through more than one of the user's accounts, it fails and lists them; pass `--account` with the one the user means.

## What it won't do, and why

Anything that writes to GitHub stays a click in the app: pushing, merging, posting or resolving comments and reviews, reviewers, labels, closing. So do settings, accounts, agent setup, and discarding or reverting the fix agent's work. This is on purpose: an agent reading PR content can be steered by it, so nothing it says can reach GitHub without the user seeing it first. A repository where the user enabled both automatic conflict resolution and automatic push is an existing exception: prkit's watcher can resolve and push conflicts on watched PRs.

When the user asks for one of these, tell them it's waiting for them in prkit (and open the PR there with `prkit pr open` if that helps). Only do it another way, such as with `gh`, if the user explicitly asks you to.

## Workflows

### What's waiting on me

```sh
prkit inbox --json                              # everything, with why each PR is there
prkit inbox --reason review-requested --json    # assigned to the user for review
prkit inbox --reason authored --json            # the user's own PRs
```

Summarize by repository and age, and say which ones already have a guide.

### Write a guide and report back

1. Pick the agent. Use the one the user names, or leave it out to get prkit's default. Valid instances and models come from `prkit status --json`. Use model options the selected model supports.
2. Start it:
   ```sh
   prkit guide generate <pr> [--agent <instance>] [--model <model>] [--option effort=high]
   ```
3. Wait for it. Guides take a few minutes:
   ```sh
   prkit wait <pr> --for guide --timeout 600
   ```
   `wait` returns when the guide is ready or failed, or when the timeout passes. If it times out, call it again. Don't loop on `sleep` and reads: `wait` is cheaper and prkit already watches GitHub.
4. Read it with `prkit guide read <pr> --json` and give the user the summary, the main risks, and what deserves a closer look. Mention they can read the full guide in the app.

For several PRs, start every guide first, then wait on each. prkit runs two agents at a time and queues the rest.

### Hand review comments to the fix agent

```sh
prkit comments add <pr> --path src/a.ts --line 42 --body "Handle the empty list"   # a draft, not posted
prkit fix send <pr>                     # sends every draft, or pick some
prkit wait <pr> --for fix --timeout 600
prkit fix read <pr> --json
```

Tell the user what the fix agent changed and that the commit is waiting for Push in prkit. To adjust it, use `prkit fix change <pr> --instructions "what to change"`. For merge conflicts, use `prkit fix resolve <pr>`. Each of these also waits for Push.

### Show the user something

`prkit pr open <pr>` opens the PR in prkit and brings the app forward. Use it when the user should look at something themselves.

## Retries

`comments add`, `fix send` and `fix change` take `--request-id <id>`. If a call timed out and you don't know whether it went through, retry with the same id: prkit returns the first answer instead of doing it twice.

## GitHub budget

Reads come from prkit's cache, which prkit keeps fresh itself. Add `--refresh` only when the user wants the very latest. It spends their GitHub API budget, which they share with every other tool.
