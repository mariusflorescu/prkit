# Chapter before and after

When a chapter changes how logic that already existed works, its pseudocode can be a pair: how it worked before this change and how it works now. prkit compares the two sides line by line and marks the changed lines like a diff, side by side when the chapter's column has room and stacked when it doesn't. The agent writes a pair only where the logic changed shape; tests, docs and generated chapters, and chapters whose files are all new, keep one block or none, and prkit refuses a pair there. Revisions stored before pairs show their single block exactly as before. Local reviews and the outside agents' guide reads carry the same pairs.

## Sub-features

- `pair-render` - the pair inside the chapter narration, its sides, marks, alignment and widths (see [Guide viewer](./guide-viewer.md), `guide-chapter-pair`).
- `pair-checks` - `submit_guide` and `revise_guide` refuse a pair with an empty or identical side, more than 10 lines a side, in a tests, docs or generated chapter, or in a chapter whose files are all new (`packages/contracts/test/guidePseudocode.test.ts`).
- `pair-agent` - real Claude writes pairs on the fixture PR where its logic changed shape, and none on a rename plus a new helper (`agent` tag).
- `pair-local` - a guide of local changes shows its pairs on the local review page, and `prkit local read --json` returns them (`agent` tag).

## How to get to it (user POV)

- Open a pull request's Guide tab after a guide was written, and read a chapter whose logic changed: the pair sits under the chapter text, above its callouts.
- Open a local review (`prkit local guide`, then its tab in the strip) the same way.
- `/dev/guide/github-gh-stack-91-pairs` and `/dev/guide/github-gh-stack-91-stored` in Vite development.

## Driving it with e2e

Preconditions: `pnpm build`. The agent journeys spend the Claude subscription: run each once per real change. `tests/chapter-before-after.e2e.ts` reads only the fake GitHub, so it needs no fixture lock; `tests/guide-generation.e2e.ts` reads the fixture repository, so it runs through the fixture lock.

- **DEV fixtures.** Sides, marks, fillers, the 1440, 1000, 760 and 640 widths, both themes and the stored revision are driven without an agent in [Guide viewer](./guide-viewer.md) (`tests/guide-viewer.e2e.ts`, the chapter before/after test).
- **No change of shape.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/chapter-before-after.e2e.ts --tag agent` writes a guide of PR 9 on the fake GitHub, where `addLink` is renamed `createLink` everywhere and a `slugFor` helper nothing calls yet arrives with its test. It logs each chapter's kind and pseudocode form, expects no pair in the stored revision and no `[data-pseudocode-pair]` on the Guide tab, and saves `chapter-before-after-none` in light and dark. The stored guide is kept in `.e2e/evidence/chapter-before-after/none.json`.
- **The fixture PR.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/guide-generation.e2e.ts --tag agent --grep "Generate narrates"` logs `chapter before/after: <chapter> (<kind>, <rows> rows)` for every pair and checks that each chapter's `[data-pseudocode-side="before"]` has as many removed lines, and `[data-pseudocode-side="after"]` as many added lines, as `pseudocodeRows` gives for the stored pair, with `guide-chapter-before-after` in light and dark for the first.
- **Local.** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/local-guides.e2e.ts --tag agent` reads the guide with `prkit local read --json`, logs its pairs, opens `/local/<key>` and finds one `[data-pseudocode-pair]` per pair, with `local-guide-chapter-before-after` in light and dark when there is one.

## Gotchas

- Whether Claude writes a pair is its call: only the no-shape journey asserts the count. The fixture PR and local journeys check what was written, so read their logs to see what Claude chose.
- The fixture PR's screenshots show the real repository name in the PR header: crop the top before filing them.
- A pair is plain text. Raw `<` and `>` render as text, never as markup.
