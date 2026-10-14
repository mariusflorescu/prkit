# Guide viewer

The guide viewer renders a normalized review with a summary, Before/After flow, chapters and notes pinned to diff lines. Accepted revisions render in the PR Guide tab. `/dev/guide/<fixture>` supplies static public examples in Vite development only.

## Sub-features

- `guide-render` shows the overview, flow, chapter kinds, file notes and line annotations.
- `guide-navigation` opens chapters from the roadmap, focus items, flow nodes and j/k.
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

- **Fixtures.** `choose(screen, screen.getByRole("combobox", "Guide fixture"), label)` opens each of the four fixtures by its label (`Vercel AI #22182`); `screen.getByRole("heading", "Overview")` is visible.
- **Flow.** Tap `screen.getByRole("button", "Before")` and `screen.getByRole("button", "After")`; the selected button has `aria-pressed="true"` and nodes keep their positions.
- **Line notes.** Tap a `[data-roadmap-row]`, scroll a `[data-guide-note][data-pinned]` into view, then capture the chapter. Pierre's shadow DOM places it in `[data-line-annotation]`.
- **Preferences.** Tap the icon buttons `Split`, `Unified` and `Wrap`; check their `aria-pressed` values.
- **Keyboard.** From a chapter, `browser.keyboard.press("j")` opens the next, `k` the previous. Escape leaves the scroll unchanged. Text inputs and controls outside the guide keep their keys.
- **Contents.** Click `[data-unmodified-lines]`, or focus `[data-expand-button]` and press Enter. Fixtures explain that full contents are unavailable; changed lines and notes remain visible. `tests/pr-view.e2e.ts` proves live Files contents load only after expansion.
- **Production.** The built app shows `Not Found` at `/dev/guide/vercel-ai-22182` and has no `Guide fixture` picker.
- **Proof.** Keep overview Before/After and one pinned-note chapter in light and dark for each fixture. Scroll all 17 Vercel AI files and save a recording, long-task measurements and direct window errors under `.e2e/evidence/guide-viewer/`.

## Gotchas

- The fixture route is absent from the built app on purpose. Do not enable it in production to make a test pass.
- Patch snapshots contain no full file contents or trailing-line counts. The shared card accepts a content callback and an optional known trailing count.
- Pierre 1.5.2 can emit one transient ResizeObserver warning while it sets gutter width for an annotated unwrapped diff. Record it separately from render failures; do not suppress it in the app.
- Listen to window `error` events as well as browser page exceptions. Vite can intercept ResizeObserver warnings before a page-exception listener sees them.
- Local evidence scripts are not committed. Use `tests/guide-viewer.e2e.ts` for a rerunnable fixture pass. Owned browser scripts must pass `--use-mock-keychain`.
