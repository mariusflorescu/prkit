# prkit

prkit is a local desktop app for reviewing GitHub pull requests. It lists the PRs that need you across every GitHub account on the machine, keeps many of them open at once, and with one click asks the user's own coding agent (Claude Code, Codex or Cursor, on their own subscription) to write a guided review of a PR. The agent keeps watching the PR and updates the guide when new commits land, until the PR is merged or closed.

It is built as an Effect server that owns all real work, a thin React client, and an Electron shell that hosts both. How the pieces fit, and why, is in [docs/internals/architecture.md](docs/internals/architecture.md). Read it before changing anything on the server.

## What we never compromise on

1. **Local only.** prkit never talks to a service of its own. GitHub tokens, agent sessions and clones stay on the user's machine, and agents run on the user's own Claude, Codex or Cursor login, never an API key of prkit's or from the environment. The one key is Cursor's: each Cursor instance uses its own Cursor key, the one its sign-in mints and saves in the instance's folder, or a `CURSOR_API_KEY` the user enters, kept only as a sensitive value.
2. **The right account, every time.** Each PR is read through the GitHub account that found it, and nothing falls back to "whichever token works". Showing one client's private code under another client's account is the worst bug this app can have.
3. **Fast, calm UI.** Switching between open PRs is instant. No continuously repainting animations, no lying spinners, no layout jumps when data arrives. Every view has a loading skeleton, an empty state and an error state with a way out.
4. **Guides worth reading.** The guide is the product. Plain words, one idea per chapter, core change first.
5. **Nothing private in the repository.** prkit is open source. No GitHub login, no client, company, organization or repository name from the owner's work, and no home path goes into a tracked file, a commit message or a PR. The owner's real values live in gitignored files read at run time: `.e2e/local.json` names the fixture repository, and `.private-names` lists the names to refuse. Tests use placeholders (`octocat`, `acme/widgets`) and find accounts in the running app. `pnpm check:private`, part of `pnpm lint`, fails on any login of a gh account on this machine, any `.private-names` entry, or the home path, and prints only file, line and category. `pnpm exec vp hooks enable` runs it on every commit and its message.

## Glossary

- **account** - one GitHub login reached through a gh config directory (`github.com/octocat`).
- **inbox** - PRs that request your review, belong to you, or involve you, across all accounts.
- **open PRs** - the PRs the user has open, shown as compact tabs in the horizontal title bar strip, after the fixed Inbox tab.
- **provider** - Claude Code, Codex or Cursor, installed locally and signed in with the user's subscription. Cursor's SDK is installed into prkit's home on request, and each Cursor instance uses its own Cursor key: the one its sign-in mints and saves in the instance's folder, or a `CURSOR_API_KEY` the user enters.
- **review** - one guide session per PR, in `preparing`, `writing`, `watching`, `failed`, or `done`.
- **attempt** - one revision attempt with its own process, fetched head, diff snapshot, and outcome.
- **revision** - an accepted guide and the exact diff it explains. It stays readable after the PR moves.
- **guide** - the visualize-pr `guide.json` overview, flow diagram, chapters, and line notes.
- **stack** - a GitHub stack of PRs, each building on the one below it, made with `gh stack`. Hosts without stacks (Enterprise Server) read as unstacked.
- **layer** - one PR of a stack, numbered from the bottom (`Stack 2/3`). Its guide covers only its own diff.
- **watcher** - periodic checks for new heads, new base branches, and merged or closed PRs.
- **done** - the PR was merged or closed, or the user stopped the review.
- **fixer session** - one writable agent session per PR, with its own checkout, that fixes review comments and resolves merge conflicts. Its work arrives as turns, queued per PR.
- **fix** - one turn's batch of review comments (prkit's drafts or GitHub threads) and the commit prkit makes from what the agent changed. Nothing reaches GitHub until Push, unless the repository pushes automatically.
- **resolution** - a turn that merges the base into the head (or rebases onto it) and resolves the conflicts: the agent the text files, the owner the files that need a person.

## Three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or kill a PID you found by matching a name or path. Other dev servers and the user's own prkit run on this machine. Kill only a PID you captured when you started the process.
2. **Touching real state.** `~/.prkit` is the user's real data. In a checkout, dev state lives in the gitignored `.prkit/` and that is the only state you write. Never point a dev server at `~/.prkit`.
3. **Leaking or crossing tokens.** Never log a GitHub token, write one to a file, git config or remote URL, or pass it to a process that does not need it. Child processes get an allowlisted environment (`packages/contracts/src/childEnv.ts`): `GH_TOKEN`/`GITHUB_TOKEN` would silently switch accounts, and `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` would switch the agent off the user's subscription.

## Running it

- `pnpm install` installs. Vite+ (`vp`) runs through pnpm scripts or `pnpm exec vp`.
- `pnpm dev` starts the server and Vite in `.prkit/` and prints the token-bearing URL. `pnpm dev:desktop` opens Electron against Vite.
- `pnpm build` builds server, web, and Electron. The server embeds a build timestamp and writes `apps/server/dist/build.json`.
- `pnpm verify:app start --name <name> --detach` serves the build in `.e2e/homes/<name>`. Open its printed URL. `doctor --name <name>` checks processes, health, home, build identity, and UI. Rebuild and restart when the build differs.
- `pnpm verify:app stop --name <name>` stops the recorded processes and removes that home. Add `--keep-home` for restart checks. Evidence and logs stay.
- `pnpm smoke:desktop` checks the built Electron window, server connection, and server shutdown. It saves `.e2e/evidence/desktop-smoke.png`.

## Verifying

- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, and `pnpm build`.
- Use [.agents/skills/verify-prkit/SKILL.md](.agents/skills/verify-prkit/SKILL.md) to drive the real app in an isolated home. UI changes need screenshots. Motion or timing needs a short recording.
- `pnpm e2e run` runs the default journeys. Most read the real GitHub accounts and the fixture repository named in the gitignored `.e2e/local.json`. Journeys that call `startFakeGitHub` (`tests/fakeGitHub.ts`), all of `github-budget` and `timeline-events` and some in nine other files, read `scripts/fake-github.ts` instead: one fake account whose requests they count, and whose pushes, merges, limits and latency they force. Each run gets a fresh instance. Agent journeys skip by default.
- Agent journeys carry a tag: `agent` runs Claude (`PRKIT_E2E_AGENT=1 pnpm e2e run <file> --tag agent`), `codex` runs Codex (`PRKIT_E2E_CODEX=1 ... --tag codex`), and `timing` measures either, with that agent's flag. `.agents/skills/verify-prkit/features/README.md` names the journeys behind each tag. All three spend the user's subscription. Run them separately, and coordinate fixture access before journeys that change it.
- The DEV Guide viewer journey requires `PRKIT_GUIDE_URL` pointing at an isolated Vite preview. Production excludes fixture routes. Tests use `screen` locators because e2e has no model configured.
- Prefer end-to-end behavior checks. Add a unit test only for a real behavior hard to reach through the UI, such as guide validation. Never test calls, constants, or props alone.

## Where code lives

- `apps/server` - Effect services, account-bound GitHub reads, RPC, agent MCP, reviews, providers, repository cache, and SQLite migrations.
- `apps/web` - React UI for Inbox, Settings, open PRs, Conversation, Files, Guide, and Fixes. Only `src/rpc/` runs Effects.
- `apps/desktop` - Electron startup, server child, window, and preload bridge.
- `packages/contracts` - shared Schemas, branded identities, guide and review models, child environment, and RPC group.
- `scripts` - dev runner, verification supervisor, run-file helpers, the gitignored local config reader, the private-name check, the fake GitHub, and the soak and GitHub-limit checks.
- `tests` - default and opt-in e2e journeys. `.agents/skills/verify-prkit/features/` maps user paths to proof.
- `docs/internals` - decisions and constraints that cross components.

## Server conventions (Effect v4)

- Effect services: a feature is a `Context.Service` with `make` and `layer`; dependencies are acquired with `yield*` inside `make`; module order is imports, errors and schemas, the service, `make`, `layer`.
- Transports stay thin. An RPC handler, HTTP route or MCP tool decodes input, calls one service method, and maps errors. A capability the UI can trigger lives on a service so the watcher and agents can reach it too.
- Errors are `Schema.TaggedError` with structured fields. Catch known tags with `Effect.catchTags`; never swallow interruption or defects with a broad catch.
- Real import paths in effect 4.0.2: `effect/http`, `effect/rpc`, `effect/sql/*`, `effect/ai`, `effect/cli`, `effect/socket/Socket`. There is no `effect/unstable/*`. `Context.Service` keys use the language service's format (`@prkit/server/<path>/<Name>`) or typecheck fails.
- Node built-ins need `// @effect-diagnostics-next-line nodeBuiltinImport:off -- <reason>`; prefer `effect/FileSystem`, `effect/Path` and `effect/process` when they cover the case.
- Every GitHub read goes through a `makeReadCache` cache, and work nobody clicked for (revalidation, watcher ticks, auto guides) runs under `inBackground`, so the 10% reserve and rate-limit pauses apply. See docs/internals/architecture.md "GitHub reads".
- State that must survive a restart goes in SQLite through a migration. Every lifecycle step must be safe to run twice and safe after a crash at any point.

## Client conventions

- Server data goes through TanStack Query, with calls from `src/rpc/`. Show the error from the server, in words a user understands, with a retry.
- Local presentation state uses zustand. Anything that must survive a relaunch is stored by the server, because the window's origin changes with the server port.
- `src/components/ui` primitives own their look: pick a `variant` or `size`, never restyle them with `className` (`shadcn/no-restyle` fails lint). Layout classes belong on the parent. A look that belongs to one feature stays in that feature's component.
- One component per file, files well under 1000 lines. Forms use react-hook-form.
- Colors, radii and sizes come from the tokens in `src/index.css`, with values from the brand kit in `assets/brand/`. Do not invent new colors.

## TypeScript

- No `any`, no `as` casts (except `as const`), no `!`, no `unknown` outside the few library boundaries listed in `vite.config.ts`. Lint enforces all four. If the compiler can't prove something, parse it with a Schema at the boundary instead.
- Inferred types over annotations. Brand ids (`AccountId`, `PullRequestKey`, `ReviewId`).

## Commits and pull requests

- Conventional commit titles in plain words: `feat(inbox): group PRs by why they need you`.
- PR body: the problem in a sentence or two, then what changed and how you proved it. UI changes include screenshots. No tool or model attribution lines.
- One unit of work per PR.
- The PR title becomes the squash commit subject, which picks the next version and the release-notes line. Releases, nightlies and signing: [docs/operations/release.md](docs/operations/release.md).
- The website (`apps/www`) is hosted on Vercel, and its download button turns on by itself with the first stable release: [docs/operations/website.md](docs/operations/website.md).

## Documentation

Most changes need no doc change; agents can read the code. `docs/internals/` holds decisions and constraints that cross components, and the traps that are hard to see from the source. When a documented decision changes, rewrite the affected text instead of appending a new account. Do not commit plans, research notes or scratch files.

## Third-party code

Before copying code from another project, check that its license allows it, and credit the source in `THIRD_PARTY_NOTICES.md`.

## Taste

Prefer the smallest model that makes the correct behavior unsurprising. Fight scope creep and machinery that only looks impressive. If a rule here fights the task in front of you, say so and ask before breaking it.
