# Stacks

A PR in a GitHub stack (each PR builds on the one below it, made with `gh stack`) shows `Stack 2/3` in the inbox, and the layers of one stack sit together in their group, bottom to top. Under the PR header a strip lists the layers bottom to top with their state and guide; a layer opens as a tab. The guide setup of a stacked PR writes guides for This PR, the Whole stack, or chosen layers with one agent: each layer gets its own guide of its own diff, its tab shows the progress, and one toast and one macOS notification say `Stack guides ready · 3 PRs`. In a guide, `#123` for a layer opens that layer's Guide tab. A host without stacks reads every PR as unstacked.

## Sub-features

- `stack-inbox` marks stacked rows `Stack <position>/<size>` (`[data-stack-mark]`) and orders a stack's rows bottom to top where its newest layer would be.
- `stack-strip` is `navigation "Stack"` under the PR header: one button per layer, `Layer 2 of 3: #191 <title>, Open, No guide`, the current one with `aria-current="page"`, `[data-layer-guide]` none, writing or ready. Loading holds its height (`aria-label "Loading stack"`); a failed read shows `role="alert"` with Retry.
- `stack-scope` is `radiogroup "Write guides for"`: This PR, `Whole stack (<n> PRs)` (open layers), Choose layers (`group "Layers to write guides for"`, closed and merged layers disabled). The button reads `Generate <n> guides`, counting only layers without a guide unless the Regenerate box is ticked. A focus added there goes to every chosen layer. Cmd+G stays This PR, so a stack scope's button has no shortcut.
- `stack-palette` is the palette's `Generate guides for the whole stack` on a stacked PR, with the default agent and no regeneration.
- `stack-batch` starts one review per chosen layer bottom to top under the two agent slots, opens each as a tab on its Guide, skips a layer that has a guide (unless Regenerate), is running, or isn't open, and sends one `stack-ready` notice when the last one ends.
- `stack-prompt` gives each layer's agent its position, the layers and the stack rules: only its own files, other layers as `#123`, a lower layer's code `unchanged` with `Added in #123` in the flow. Validation stays per PR.
- `stack-links` opens a layer's Guide tab from `#123` in its guide text (`a[data-stack-link]`); other references open GitHub.
- `stack-rebase` updates every layer's guide after `gh stack rebase` (layers above the changed one are `rewritten`), and writes a fresh `retargeted` guide when the layer below merges and the PR targets the trunk.

## How to get to it (user POV)

- Inbox: search the stack's titles; stacked rows carry `Stack n/m`.
- Open any layer: the strip sits between the header and the Conversation, Files, Guide tabs.
- Guide tab of a stacked PR: the scope control is the setup's `Write for` row, above Generate.
- `Cmd+K` on a stacked PR, type `generate guides`: `button /^Generate guides for the whole stack/`.

## Driving it with e2e

Preconditions:

- Signed in through `openUrl`; `gh stack` is installed (`gh stack --version`) and `~/.config/gh` is `<owner>`.
- The journey makes its own three-layer stack on `<fixture>` with `tests/stackFixture.ts` (a trunk branch, the contents API, then `gh stack link --base <trunk>` from an empty repo with an origin remote). A fixture that fails half made cleans up what it made. At the end `cleanupStackFixture` unstacks, closes and deletes it, reads every layer back, and returns what it left; the journeys check it with `expect.soft(...).toEqual([])`, so a leak fails the run without hiding the journey's own error.

- **Inbox.** `pnpm e2e run tests/stacks.e2e.ts`. After Refresh, the search `Stack fixture <stamp>` lists three links in `region "Yours"` matching `/#<n> .*Stack 1\/3/` and so on, in that order.
- **Strip.** Tap layer 2's row: `navigation "Stack"` has three buttons, `/^Layer 2 of 3: #<n> /` has `aria-current="page"`, layer 1 ends in `No guide`. Tap `/^Layer 3 of 3: #<n> /`: the URL is layer 3's and its tab `link /^Open <fixture> #<n>\b/` is in `navigation "Workspace tabs"`.
- **Scope.** On the Guide tab, `radio "Whole stack (3 PRs)"` makes `button "Generate 3 guides"`, and `button "Add a focus"` then opens `textbox "Guidance for every chosen pull request"`. `radio "Choose layers"` ticks layer 2 (`checkbox /^Layer 2: #<n> /`) and reads `Generate 1 guide`; layers 1 and 3 instead read `Generate 2 guides`.
- **Scope on the fake.** `tests/guide-setup.e2e.ts` opens the fake GitHub's `#2 Budget fixture 2`, layer 2 of 2, in the default suite. `button "Generate guide"` has `aria-keyshortcuts`; `Whole stack (2 PRs)` makes `button "Generate 2 guides"` without one. A focus added under Whole stack, then Generate 2 guides, shows `Writing 2 stack guides` and saves the same guidance row on `#1` and `#2`.
- **Palette.** `Meta+KeyK`, fill `searchbox "Find a pull request"` with `generate guides for`: `button /^Generate guides for the whole stack 3 PRs · default agent$/`.
- **Agent runs, by hand or over MCP.** Whole stack with a Codex model: every layer's tab gets `[data-review-status="writing"]`, one toast `Stack guides ready` with `3 PRs`, no per-PR `Guide ready`. Each layer's accepted guide lists only its own files (`[data-guide-view]`); `sqlite3 -readonly <home>/prkit.sqlite "SELECT pr_key, json_extract(status,'$._tag') FROM reviews"` and `SELECT batch_id, outcome FROM review_attempts`. Layer 2's flow has a node with title `Added in #<layer 1>`.
- **Rebase and merge.** Commit on layer 1 in a `gh stack` checkout, `gh stack rebase`, `gh stack push`: each layer gets a new revision (`rewritten` above layer 1). Merge layer 1: layer 2's next revision is `retargeted` (revision switcher `new base branch`).

- **Squash-merged bottom layer.** `pnpm e2e run tests/stacks.e2e.ts --grep "squash-merged"`. The fixture squash-merges layer 1 with `gh stack merge <n> --yes --squash` (`squashMergeBottom`). GitHub keeps it in the stack as layer 1, merged, and rebases layer 2 onto the trunk. After Refresh, `region "Yours"` has exactly two links, `/#<layer 2> .*Stack 2\/3/` and `/#<layer 3> .*Stack 3\/3/`; the strip on layer 2 has `/^Layer 1 of 3: #<n> .*, Merged, No guide$/`; the setup offers `radio "Whole stack (2 PRs)"` and `button "Generate 2 guides"`, and under Choose layers `checkbox /^Layer 1: #<n> /` is disabled.
- **Guides for the layers left.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/stacks.e2e.ts --tag agent`. Whole stack (2 PRs) with Claude Sonnet: one toast `Stack guides ready` with `2 PRs`; `review_revisions` has an accepted guide for layer 2 (base the trunk, files `src/vanity.js`) and layer 3 (base layer 2's branch, files `src/shorten.js`).
- **Host without stacks.** `tests/github-budget.e2e.ts` runs the fake GitHub with `--no-stacks` (it answers `undefinedField` like Enterprise Server) for the open-tab journey: changes still show, and `graphql:no-stacks` counts one or two refusals before prkit stops asking. The cache journey's fake has stacks: `link /#1 Budget fixture 1 Stack 1\/2/`.

## Gotchas

- The inbox caches for ten minutes; tap Refresh after making a stack.
- The fixture's bottom layer targets a trunk branch it makes (`e2e/stack-<stamp>-trunk`), so a merged layer never lands on main. Cleanup deletes the trunk too.
- GitHub never removes a merged PR from its stack: `gh stack unstack` answers `Unstacking not allowed: Pull request #<n> cannot be removed from this stack` and unstacks the other layers. Each squash-merge run leaves a stack of its one merged, closed layer, as any merged PR stays in the repository's history. Cleanup does not report it.
- GitHub's search trails a merge by a few seconds, so `is:open` may still return the merged layer; prkit leaves out any node that isn't open.
- `gh stack link` needs `--base main` outside a real clone, or it can't find the default branch.
- `gh pr merge` refuses stacked PRs; merge with `gh stack merge <n> --yes`.
- A stacked PR's position comes from GitHub; a merged layer may stay in the stack as merged.
