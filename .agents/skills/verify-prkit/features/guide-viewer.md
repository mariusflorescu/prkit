# Guide viewer

The guide viewer renders a normalized review with how carefully to read it, a summary, a before/after card (a merged graph or a behavior diff), chapters and notes pinned to diff lines. Accepted revisions render in the PR Guide tab. `/dev/guide/<fixture>` supplies static public examples in Vite development only.

## Sub-features

- `guide-render` shows the overview, the before/after, chapter kinds, file notes and line annotations.
- `guide-navigation` opens chapters from the roadmap, focus items, flow nodes, behavior-diff chapter numbers and j/k, and opens a line from a behavior-diff row's file:line.
- `guide-risk` shows the pull request's risk level, its reasons and prkit's signals at the top of the Overview, and each chapter's level on the roadmap and the chapter header. Every reason opens its chapter, line or file.
- `guide-diff` switches unified/split and wrapping, and expands unchanged lines through a callback.
- `guide-states` contains a chapter failure and shows unavailable contents without losing the guide.
- `guide-production` excludes fixture routes and fixture JSON from production.

## How to get to it (user POV)

- Open the URL printed by `pnpm dev`, then `/dev/guide/vercel-ai-22182`.
- Choose another public PR with the `Guide fixture` picker.
- Open a PR, choose Guide, and Generate through a ready provider to render an accepted revision.

## Driving it with e2e

Preconditions:

- `pnpm build` and `pnpm verify:app doctor` pass for an isolated server.
- The fixture journey needs a Vite development preview proxied to an isolated server. Choose unused ports. These examples use server port 43111 and web port 43112.
- Start the server with `pnpm verify:app start --name guide --port 43111 --dev-web-origin http://127.0.0.1:43112 --detach`.
- In another shell, run `PRKIT_SERVER_PORT=43111 PRKIT_WEB_PORT=43112 pnpm --filter @prkit/web exec vp dev`.
- Retain the supervisor's token. Pass `http://127.0.0.1:43112/?token=<token>` as `PRKIT_GUIDE_URL` to `pnpm e2e run tests/guide-viewer.e2e.ts`. After capturing proof, stop Vite and run `pnpm verify:app stop --name guide`.
- The production-only journey runs with `pnpm e2e run tests/guide-viewer.e2e.ts` and reports the DEV journey skipped when no preview URL is provided.

- **Fixtures.** `choose(screen, screen.getByRole("combobox", "Guide fixture"), label)` opens a fixture by its label (`Vercel AI #22182`); `screen.getByRole("heading", "Overview")` is visible. Four are graphs, `gh-stack #91, behavior diff` is the same PR as rows, and `Vercel AI #22182, stored before behavior diffs` is a revision stored before the `_tag`, decoded without normalizing as the Guide tab reads it. Three graphs rate risk: `T3 Code #16353` low, `T3 Code #16782` medium (look-closely paths, and an ignore rule that adds prkit's skipped chapter), `gh-stack #91` high. `fixtures.ts` applies each fixture's ignore and look-closely paths the way an attempt does, and checks a guide with signals only when it has `risk`.
- **Graph.** `screen.getByRole("region", "Before and after")` shows one merged picture: no `Before` or `After` buttons, the `Legend` list is visible, and on gh-stack #91 a `[data-flow-node][data-status="added"]` and a `[data-status="removed"]` node are visible together. Removed nodes and edges are dashed.
- **Behavior diff.** Rows read like a diff (`+`, `-`, context) with a file:line chip and a chapter number. Collapse the chapter first (`[data-chapter-id="init-flow"] [data-chapter-toggle]`), then tap `screen.getByRole("button", "Open cmd/init.go line 154")`: the chapter opens, `screen.getByRole("region", "cmd/init.go")` has `data-open="true"` and focus, and in the diff's shadow root the new-side gutter cell for 154 has `data-selected-line`. Its top is the same 100 ms and 1.5 s after the tap, and the page root never scrolls. Tapping another row's chip moves the highlight. Under 700px the chip drops under the row text.
- **Stored revision.** The stored fixture renders its graph with no window errors.
- **Risk.** `screen.getByRole("region", "Risk")` shows the level word (`Risk: High`, the color only repeats it), one list item per reason, and the signal chips or `None of prkit's checks fired.` A reason's `Open chapter N: <title>` button focuses `[data-chapter-id]` of its chapter, and its `Open <path> line <n>` chip selects that line. A chip with files (`Look closely: 5 files`) opens `screen.getByRole("dialog", "Look closely")`; each `Open <path>` there closes it and focuses the file card, opening a collapsed chapter. `[data-roadmap-row] [data-risk-tag]` and `[data-chapter-meta] [data-risk-tag]` list every chapter's word, `Not reviewed` on the skipped chapter. Under 700px the roadmap keeps the risk tag and hides the kind. Guides without `risk` (the stored fixture, `Vercel AI #22182`, the behavior diff) show no region and no tag.
- **Line notes.** Tap a `[data-roadmap-row]`, scroll a `[data-guide-note][data-pinned]` into view, then capture the chapter. Pierre's shadow DOM places it in `[data-line-annotation]`.
- **Preferences.** Tap the icon buttons `Split`, `Unified` and `Wrap`; check their `aria-pressed` values.
- **Keyboard.** From a chapter, `browser.keyboard.press("j")` opens the next, `k` the previous. Escape leaves the scroll unchanged. Text inputs and controls outside the guide keep their keys.
- **Contents.** Click `[data-unmodified-lines]`, or focus `[data-expand-button]` and press Enter. Fixtures explain that full contents are unavailable; changed lines and notes remain visible. `tests/pr-view.e2e.ts` proves live Files contents load only after expansion.
- **Production.** The built app shows `Not Found` at `/dev/guide/vercel-ai-22182` and has no `Guide fixture` picker.
- **Proof.** Keep the `risk-*` screenshots: each level's overview in light and dark, the look-closely popover, the roadmap with `Not reviewed`, the high chapter header, 640 wide, and the stored fixture with none. Keep each graph overview in light and dark with one pinned-note chapter, the behavior diff in light and dark and at 760 and 640 wide, both jumps, and a recording of the jump (`pnpm e2e run tests/guide-viewer.e2e.ts --video=on`). Scroll all 17 Vercel AI files and save a recording, long-task measurements and direct window errors under `.e2e/evidence/guide-viewer/`.

## Gotchas

- The fixture route is absent from the built app on purpose. Do not enable it in production to make a test pass.
- Patch snapshots contain no full file contents or trailing-line counts. The shared card accepts a content callback and an optional known trailing count.
- Pierre 1.5.2 can emit one transient ResizeObserver warning while it sets gutter width for an annotated unwrapped diff. Record it separately from render failures; do not suppress it in the app.
- Listen to window `error` events as well as browser page exceptions. Vite can intercept ResizeObserver warnings before a page-exception listener sees them.
- Local evidence scripts are not committed. Use `tests/guide-viewer.e2e.ts` for a rerunnable fixture pass. Owned browser scripts must pass `--use-mock-keychain`.
