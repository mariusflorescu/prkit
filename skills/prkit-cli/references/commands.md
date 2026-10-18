# Command reference

Read this when you need a less common read, a local tab or draft action, or the JSON shapes for guide settings. `prkit --help` and `prkit <command> --help` are the source of truth for the installed version's flags.

Every command accepts `--json`. `<pr>` means an HTTPS PR URL or `owner/repo#number`; add `--host` for an Enterprise short form and `--account host/login` when needed. Repository targets use `owner/repo` and accept the same host and account selection.

Paged reads accept `--limit 1..100` and `--cursor`. Repeat the same request with its `nextCursor` until null. All tool commands also accept `--response-cursor` for an outer `response-fragment`; keep the logical page cursor and other arguments, join fragment text by offset, parse the complete JSON, then continue its `nextCursor`. These two cursors aren't interchangeable. Human output prints the continuation instructions.

## Discovery and inbox

| Command                                                          | What it returns or changes                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prkit status --json`                                            | Version, access, accounts and budgets, available agents, work counts. Start here.                                                              |
| `prkit accounts --json`                                          | Paged account readiness and per-resource GitHub budgets.                                                                                       |
| `prkit agents --json`                                            | Paged instances, readiness, models, blocked reasons and option descriptors. `--agent` narrows the instance; `--refresh` refreshes the catalog. |
| `prkit inbox --json`                                             | Paged inbox, grouped by account and reason.                                                                                                    |
| `prkit repos list --json`                                        | Paged visible repositories and per-account freshness.                                                                                          |
| `prkit repos prs owner/repo --account github.com/octocat --json` | Paged open repository PRs, separate from app tabs.                                                                                             |
| `prkit settings --json`                                          | Guide defaults, appearance, outside access and paged repository fix settings, without secrets.                                                 |

Inbox flags are `--reason review-requested|authored|involved`, `--repo owner/repo`, `--account host/login`, `--state open|closed|merged`, `--draft` or `--no-draft`, `--checks passing|failing|pending|none`, `--search text`, and `--stacks all|stacked|unstacked`. `--repo` also accepts quoted JSON `{"host":"git.example.test","owner":"owner","name":"repo"}` for an Enterprise repository. The list command doesn't save filters.

`prkit inbox filters save --search security --account github.com/octocat --repo owner/repo` saves the app's search, account and repository for its next launch. All three are required. `--account null --repo null` clears those selections. A repository shorthand needs a non-null account; full repository JSON also needs an `accountIds` array, for example `{"host":"git.example.test","owner":"owner","name":"repo","accountIds":["git.example.test/octocat"]}`. This saved filter is different from the additional reason, state, draft, checks and stacks selectors on an inbox read.

## PR reads

| Command                                                | What it returns                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `prkit pr read <pr> --json`                            | Title, description, branches, checks summary, reviewers, labels, files and stack summary.                                 |
| `prkit pr files <pr> --json`                           | Current changed files and patch fragments. Join each path's patches by `offset` until `complete`.                         |
| `prkit pr file <pr> --path src/a.ts --side new --json` | Old or new file contents as text pages; join by `offset`.                                                                 |
| `prkit pr timeline <pr> --json`                        | Paged timeline events.                                                                                                    |
| `prkit pr threads <pr> --json`                         | Paged GitHub threads, anchors and permissions. No reply or resolution.                                                    |
| `prkit pr checks <pr> --json`                          | Paged check names, states, links and GitHub's short summaries.                                                            |
| `prkit pr conversation <pr> --json`                    | Paged issue comments, reviews and review comments.                                                                        |
| `prkit pr stack <pr> --json`                           | Paged stack layers from bottom to top; a non-stacked PR has a null stack.                                                 |
| `prkit pr candidates <pr> --json`                      | Paged reviewer, team and label choices. Reading them doesn't apply them.                                                  |
| `prkit pr diff <pr> --attempt-id <attempt-id> --json`  | The immutable diff a guide attempt read, with file-fragment paging. Get the id from guide revisions.                      |
| `prkit pr reviewed <pr> --json`                        | Which changed files the user marked reviewed, with progress. `--revision <n>` reads a guide revision's diff and chapters. |

Each file in `prkit pr reviewed` is `reviewed`, `changed` (reviewed before, then it changed), `unreviewed` or `unknown` (prkit can't tell it apart, so it can't be marked and isn't counted). `progress` counts all files, and a chapter's `state` is null when none of its files can be marked. These marks are the user's own checkboxes in prkit; they never reach GitHub.

`githubTruncated` reports upstream omissions even if the local pages are finished. Binary or too-large patches aren't text. Use file contents where available and tell the user about any gap instead of claiming a complete review.

## Guides

| Command                                                                 | What it returns or changes                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `prkit guide list --json`                                               | Paged guide sessions, including stopped and failed ones.                                   |
| `prkit guide read <pr> --json`                                          | State and latest accepted guide.                                                           |
| `prkit guide generate <pr> --stack this`                                | Starts a guide using the PR agent or app default.                                          |
| `prkit guide stop <pr>`                                                 | Stops guide work and watching; accepted guides remain readable.                            |
| `prkit guide revisions <pr> --json`                                     | Paged accepted revisions and their attempt ids, oldest first.                              |
| `prkit guide revision <pr> --revision 1 --json`                         | One accepted guide and its frozen configuration.                                           |
| `prkit guide progress <pr> --json`                                      | Current narration, files read, draft and paged activity, without polling GitHub.           |
| `prkit guide duration --agent <instance> --lines 500 --json`            | Typical duration, or null without enough samples.                                          |
| `prkit guide settings <pr> --json`                                      | Three scopes and versions, resolved settings, skipped files.                               |
| `prkit guide scope --scope '{"_tag":"global"}' --json`                  | One scope's versioned sections. Also accepts repository or pull-request tagged scope JSON. |
| `prkit guide repositories --json`                                       | Paged repositories with guide configuration.                                               |
| `prkit guide repository owner/repo --account github.com/octocat --json` | Stable repository id for a repository scope.                                               |

A guide's `content.flow` is its before/after: `null`, `{ "_tag": "graph", nodes, edges }` or `{ "_tag": "behavior", rows }`, where each row has `status`, `text`, `depth`, `at` and `chapter`, and `at` is a new-side `{ path, line }` in that revision's own diff, so read it with the attempt's diff (`prkit pr diff <pr> --attempt-id <attempt-id> --json`), not today's.

Generation accepts `--agent <instance> --model <slug>` and repeated `--option key=value`. Use only catalog-supported selections from `prkit agents --json`. For a stack, read its layers first: `--stack this`, `--stack all` or `--stack 1,3`; `--regenerate` includes layers with guides. Use `--stack` once; numbered selection cannot be combined with `--layers`. Native values `this-pr`, `whole-stack` and `chosen-layers` are also accepted; the last takes repeated `--layers <number>`:

```sh
prkit guide generate <pr> --stack chosen-layers --layers 1 --layers 3
```

Read `prkit guide settings <pr> --json` before editing settings. `scopes.pullRequest` contains `ignore`, `focus` and `guidance`, each with its own `version`. The `expectedVersion` must be the current version of the section being edited; the numbers below illustrate the shape, not a version to assume. Preserve existing ids and overrides unless changing them is the user's intent. New focus or ignore items have `id: null`.

```sh
prkit guide generate <pr> --guidance '{"expectedVersion":3,"text":"Check migration safety","mode":"append"}'
prkit guide generate <pr> --focus '{"expectedVersion":2,"areas":[{"id":null,"label":"Migrations","question":"Can they run twice safely?"}],"overrides":[]}'
prkit guide settings save <pr> --expected-version 3 --edit '{"_tag":"guidance","text":"Check migration safety","mode":"append"}'
```

The first two save the PR's section as part of generation. The standalone save accepts one tagged `--edit`: guidance with `text` and `mode` (`append` or `replace`); focus with `areas` and `overrides`; or ignore with `rules` and `overrides`. An ignore rule is `{"id":null,"pattern":"vendor/**"}`; an override is `{"itemId":"<existing-item-id>","value":"off"}` or `"on"`. A conflict means read again and reconcile, not force an overwrite.

Scope reads accept `{"_tag":"repository","repositoryId":"<id>"}` or `{"_tag":"pull-request","key":"github.com/owner/repo#123"}` as well as global. Only PR-scope writes exist in the CLI. Changing global defaults, repository settings or agent setup remains an app action.

## Comments and fixes

| Command                                                                                                    | What it returns or changes                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prkit comments list <pr> --json`                                                                          | Paged drafts and GitHub threads, including ids for fixes.                                                                                            |
| `prkit comments add <pr> --path src/a.ts --line 42 --body 'Handle the empty list' --request-id comment-42` | Adds a local draft; optional `--start-line` and `--side` set to `old` or `new`.                                                                      |
| `prkit comments edit <pr> --id <draft-id> --body 'Handle the empty list'`                                  | Edits local draft text.                                                                                                                              |
| `prkit comments move <pr> --id <draft-id> --placement '<placement-json>'`                                  | Moves a local draft to a diff anchor.                                                                                                                |
| `prkit fix list --json`                                                                                    | Paged fix sessions and states.                                                                                                                       |
| `prkit fix read <pr> --json`                                                                               | Paged turns and latest diff summary, which can be cut.                                                                                               |
| `prkit fix turn <pr> --turn-id <turn-id> --json`                                                           | Complete turn report, settings and paged activity.                                                                                                   |
| `prkit fix diff <pr> --turn-id <turn-id> --json`                                                           | Paged file fragments for a turn; resolution turns support `--side` set to `ours` or `theirs`.                                                        |
| `prkit fix patch <pr> --turn-id <turn-id> --json`                                                          | Complete patch as text pages joined by offset.                                                                                                       |
| `prkit fix access <pr> --json`                                                                             | Push eligibility and permission to run check scripts; a read doesn't grant either.                                                                   |
| `prkit fix send <pr> --request-id fix-42`                                                                  | Starts fixes for all waiting drafts. Repeat `--draft-ids` or `--thread-ids` to select comments; optional `--instructions`, agent, model and options. |
| `prkit fix change <pr> --instructions 'Keep the existing name' --request-id change-42`                     | Asks for another change to the latest turn waiting for Push, or the `--turn-id` selected turn.                                                       |
| `prkit fix stop <pr>`                                                                                      | Stops queued/running work while preserving commits waiting for Push.                                                                                 |
| `prkit fix retry <pr>`                                                                                     | Retries the latest failed fix or resolution, or a selected `--turn-id`.                                                                              |
| `prkit fix resolve <pr> --strategy merge`                                                                  | Resolves conflicts; `rebase` is available only for the owner's PRs. Accepts agent, model and options.                                                |
| `prkit wait <pr> --for fix --timeout 600 --json`                                                           | Waits for guide or fix work to stop. `--for guide` waits for the guide; a timeout never stops work.                                                  |

For a move, `placement` is an object containing `anchor`, `snippet` and `commitSha`. The anchor contains `path`, `start` and `end`; each endpoint has `side` (`old` or `new`) and a positive `line`. Use the exact diff rows for `snippet` and the diff's head SHA. Read the PR files and current draft placement before moving a comment.

Only comments add, fix send and fix change take `--request-id`. Reuse it after an uncertain response to avoid starting the same action twice. Other work commands aren't automatically replayed; read their current state before retrying. Fix commits started here wait for Push in the app.

## Reviewed files

| Command                                                                             | What it changes                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `prkit pr reviewed set <pr> --head-sha <headSha> --paths src/a.ts --paths src/b.ts` | Marks those changed files of the current diff reviewed. Every path must be one of them. |
| `prkit pr reviewed set <pr> --head-sha <headSha> --paths src/a.ts --no-reviewed`    | Marks them not reviewed. Repeating either command changes nothing.                      |

Read `prkit pr reviewed <pr> --json` first for the paths and its `headSha`. If the PR moved since that read, nothing is marked and the command fails with `conflict`. Read it again. Mark files only when the user asks: it records their judgment, in prkit, and an open window shows it at once.

## Local tabs

| Command                                                                                | What it returns or changes                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `prkit tabs list --json`                                                               | Open PR tabs in order and the active key.                                              |
| `prkit pr open <pr>`                                                                   | Opens a tab and brings the app forward; `--no-focus` opens quietly.                    |
| `prkit tabs close <pr>`                                                                | Closes the local tab, preserving guides, fixes and commits.                            |
| `prkit tabs focus <pr>`                                                                | Focuses an already open tab.                                                           |
| `prkit tabs reorder --keys github.com/owner/repo#123 --keys github.com/owner/repo#124` | Saves the complete tab order; stale or incomplete lists fail. Read the tab list first. |

All reads work at Read only. Local changes, guide/fix work and PR settings saves require Read and start work, enforced by the server. There are no GitHub write commands. `prkit --version` and `prkit --completions zsh` also work offline.
