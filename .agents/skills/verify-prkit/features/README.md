# prkit verification map

This directory is the maintained source for verifying what a prkit user sees. Read this index, then use the matching feature file as the recipe.

One line per feature, kept in this order. Add or edit only your own line (no table: aligned columns made every new row rewrite the others and conflict in every parallel PR).

- [Shell](./shell.md). Route: `/`. Journeys: `shell.e2e.ts`, `auth.e2e.ts`, `verification.e2e.ts`. Covers: Title bar mark and wash, inset frame and tab material, Inbox tab, shortcuts, token, server info, build doctor.
- [Settings](./settings.md). Route: `/settings/<section>`. Journeys: `settings.e2e.ts`, `shell.e2e.ts`, `smoke:desktop`. Covers: The closeable Settings tab, section nav, Cmd+, memory, reload, Escape after popups, Agents, Guides, shortcuts list.
- [Settings > Accounts](./settings-accounts.md). Route: `/settings/accounts`. Journeys: `accounts-inbox.e2e.ts`. Covers: Discovery, directory validation, add and remove.
- [Settings > Appearance](./settings-appearance.md). Route: `/settings/appearance`. Journeys: `settings.e2e.ts`, `smoke:desktop`. Covers: System, Light, Dark; first paint; desktop theme by script.
- [Inbox](./inbox.md). Route: `/`. Journeys: `accounts-inbox.e2e.ts`, `inbox-filters.e2e.ts`. Covers: Groups, account filters, loading skeleton, account error and recovery; repository filter, compact header, row action and empty groups (`inbox-filters`, mostly on the fake GitHub).
- [Open PRs](./open-prs.md). Route: Open PR tabs. Journeys: `open-prs.e2e.ts`. Covers: Switching, close, reorder, memory, relaunch, account binding, palette branch search.
- [PR view](./pr-view.md). Route: `/pr/<host>/<owner>/<repo>/<number>`. Journeys: `pr-view.e2e.ts`, `open-prs.e2e.ts`, `timeline-events.e2e.ts`. Covers: Conversation, comments, timeline events, Files, tab row controls, checks popup, header scroll, bot review threads.
- [PR actions](./pr-actions.md). Route: PR header and Conversation. Journeys: `pr-actions.e2e.ts`, `pr-header.e2e.ts`. Covers: Header actions per state (each once, the menu only what applies, the compact header the same), lifecycle, metadata, merge methods, updates, revert, stale heads, watcher; auto-merge, approvals and fork workflow approval on the fake GitHub.
- [Guide viewer](./guide-viewer.md). Route: PR Guide or `/dev/guide/<fixture>`. Journeys: `guide-viewer.e2e.ts`. Covers: Production exclusion by default, DEV fixtures opt-in.
- [Guide generation](./guide-generation.md). Route: PR Guide, inbox row, palette, Cmd+G. Journeys: `guide-generation.e2e.ts`, `guide-setup.e2e.ts`, `guide-timing.e2e.ts`, `blob-prefetch.e2e.ts`, `smoke:desktop`. Covers: Guide setup at the app's scale, its focus, model and effort, Cmd+G, and Settings > Agents default; a stand-in agent's states and ready toast; Claude `agent`, Codex `codex`; Claude streamed draft and timings `timing`; preparing a PR on a base that never moves `agent`; `revise_guide` after a rejected guide by hand.
- [Guide settings](./guide-config.md). Route: Settings > Guides, PR Guide setup and status bar. Journeys: `guide-config.e2e.ts`. Covers: Scopes and overrides, ignore preview, rename rule, guard, focus areas, guidance replace; `agent` tag for frozen settings and fresh sessions.
- [Review watcher](./review-watcher.md). Route: PR Guide. Journeys: `review-watcher.e2e.ts`. Covers: Automatic updates, revision choice, Stop and done; `agent` tag opt-in.
- [GitHub budget](./github-budget.md). Route: Inbox, open PR tabs, Settings > Accounts. Journeys: `github-budget.e2e.ts`, `scripts/verify-github-limits.ts`. Covers: Updated line, ten-minute cache, relaunch from cache, change detection, idle tabs and tab switching, rate-limit pause and banner, budget readout.
- [Server responsiveness](./server-responsiveness.md). Route: Inbox and PR views. Journeys: `server-responsiveness.e2e.ts`, `scripts/soak-app.ts`. Covers: Concurrent reads, memory limits, health latency.
- [Branding](./branding.md). Route: `/`, Settings, desktop. Journeys: `branding.e2e.ts`. Covers: Splash, favicon, local fonts, About prkit; title bar mark and wash, Dock and About panel by hand.
- [Stacks](./stacks.md). Route: Inbox, PR strip, PR Guide setup, palette. Journeys: `stacks.e2e.ts`, `guide-setup.e2e.ts`. Covers: Stack marks and order, strip, scope control, palette entry, a squash-merged bottom layer; `agent` tag for the layers left after it; rebases by hand.
- [Review comments](./review-comments.md). Route: PR Files, Guide, Conversation. Journeys: `review-comments.e2e.ts`, `guide-generation.e2e.ts`. Covers: Drafts, ranges, submit, reply and resolve, outdated drafts; keyboard line comments, a refused review's error, a push while writing (on the fake GitHub).
- [Fix agent](./fix-agent.md). Route: PR Fixes tab, Review > Send to agent, header Resolve conflicts, Settings > Guides. Journeys: `fix-agent.e2e.ts`, `git-preconditions.e2e.ts`, `symlinks.e2e.ts`, `claude-containment.e2e.ts`, `codex-containment.e2e.ts`, `fix-timing.e2e.ts`. Covers: Send form, repository opt-ins, conflict popover, the Fixes tab hidden until something was sent, the daily cap on automatic resolutions; with a stand-in agent, a repository in the checkout, a changed rebase plan, a cache config key and a leftover job stopped before prkit's git; `agent` tag for fix, push, guide r2, discard, Copy patch, lockfile, branch moved, resolved outside, a hostile test kept inside the checkout; `codex` tag for fix, resumed thread, resolution, a prompt-injected PR kept inside the checkout; both tags for symlinks left unread; `timing` tag for a timed fix; restart by hand.
- [Pickers](./pickers.md). Route: Inbox filters, Settings > Guides, Guide setup, PR actions. Journeys: `accounts-inbox.e2e.ts`, `inbox-filters.e2e.ts`, `guide-config.e2e.ts`, `guide-generation.e2e.ts`, `pr-actions.e2e.ts`, `guide-viewer.e2e.ts`, `compact-pickers.e2e.ts`. Covers: One compact family of selects, searchable pickers and menus; row size; check alignment by hand.
- [Desktop app](./desktop-app.md). Route: the packaged `.app`. Journeys: `pnpm dist:desktop:artifact`, `smoke:desktop --app`. Covers: Stable and nightly artifacts, update feed, signing preflight, packaged run from a Dock-like PATH, one app per home.
- [Website](./www.md). Route: `apps/www` build. Journeys: `www.e2e.ts`. Covers: Page, self-hosted assets, intro once per session, the figure harness (mount near view, offscreen stop, reduced motion); dark and shots by hand.

Journey files live under `tests/`. The default suite leaves subscription journeys skipped. Run them separately with the environment flag and matching tag in their feature file.

## Baseline preconditions

- `pnpm build` ran after the last change.
- The instance comes from the supervisor: `pnpm e2e run`, `open_session`, or `pnpm verify:app start --name <name> --detach`.
- `pnpm verify:app doctor` passes for that instance.
- The page was opened through the run file's `openUrl` once.
- `.e2e/local.json` names the fixture repository, written `<fixture>` (`<owner>/<name>`) in these files. Its owner `<owner>` is one of the machine's gh accounts, `github.com/<owner>`, and the journeys read it through that account. The fixture PR is `<fixture>#1`, "Validate links and count clicks", authored by `<owner>`, five files. Some journeys need a second account and skip without one.

## Driving conventions

- Prefer roles and accessible names (`getByRole("button", "Refresh inbox")`), then `data-testid`, never CSS or position.
- Check a locator with `locate` over MCP before writing it into a test.
- Treat quoted names as literal; matching is exact.
- Wait with `expect` matchers, never with sleeps.
- Journeys in a run share one instance and the app restores the last active tab and the Inbox's filters. A journey that needs the Inbox starts with `openInbox` from `tests/openInbox.ts`, which selects it and clears the filters, never by assuming either.
- The same shared instance means a journey's database reads must be scoped to its own pull request (`WHERE pr_key = ...`, the fixer row for its PR) and its locators to its own tab or region; never count rows or match elements across the whole app.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- A mutation needs a second, read-only view of the stored value: a reload, a restart with `--keep-home`, or `sqlite3 -readonly <home>/prkit.sqlite`.
- Record the feature file and the entry point used with every artifact.
- Report an unreachable entry point with the command you tried and the unmet precondition. Never report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on the user-visible behavior. Describe shipped behavior. Name an unmet prerequisite when a journey cannot run. Then come exactly four H2 sections, in this order.

1. `Sub-features` lists short ids with one line each.
2. `How to get to it (user POV)` lists every entry point.
3. `Driving it with e2e` starts with `Preconditions:`, then labeled bullets that pair each user action with the exact MCP call or locator and the observable result.
4. `Gotchas` lists traps that waste or invalidate a run.
