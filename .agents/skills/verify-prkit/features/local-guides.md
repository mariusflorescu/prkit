# Local guides

A guide of a repository's changes before a pull request exists, asked for from a terminal or an outside agent. prkit snapshots the folder's working tree (the branch's commits since its base, plus staged, unstaged and untracked files) or a branch's last commit into a copy of its own, writes the guide with the review's agent, and never changes the repository, runs anything its config names, or reaches GitHub. The app has no page for local guides yet; they are read through the CLI and the outside tools.

## Sub-features

- `local.generate`: `prkit local guide` and `generate_local_guide`, from the working directory or `--path`, with `--branch`, `--base`, `--description`, `--regenerate` and the agent flags.
- `local.unchanged`: a run with nothing new since the latest revision answers `unchanged` and starts no agent.
- `local.refusals`: repository problems exit 1 with the catalogue's sentence before anything starts.
- `local.read`: `prkit local read`, `wait`, `list` and `stop`, by working directory, `--path`, `--branch` or `--key`.
- `local.restart`: a restart mid-attempt writes the guide from that attempt's own snapshot.
- `local.isolation`: no GitHub request or write, no change to the repository's `.git`, its clean filter never run, and the Inbox and `list_reviews` never show a local review.

## How to get to it (user POV)

- A terminal inside a repository: `prkit local guide --description "..."`, then `prkit local wait` and `prkit local read`.
- Another folder: `prkit local guide --path <folder>`; a branch tip: `--branch <name>`.
- An outside MCP client: `generate_local_guide`, `wait_for_local_guide`, `read_local_guide`, `stop_local_guide`, `list_local_guides`.
- Settings (Cmd+,) > Outside agents must be on; starting and stopping need Read and start work.

## Driving it with e2e

Preconditions: `pnpm build`. The journey uses the fake GitHub and the stand-in Claude only, so it runs without the fixture lock: `pnpm e2e run tests/local-guides.e2e.ts`.

- **Setup:** the journey builds `tests/localRepoFixture.ts` in a temporary folder outside any repository, starts its own instance (`--claude <stand-in> --watch-interval 600000`), opens `screen.getByRole("switch", "Let my coding agents use prkit")` and `screen.getByRole("radio", "Read and start work")`, then resets the fake GitHub's stats.
- **First guide:** `prkit local guide --description ... --json` from the repository answers `started`; `prkit local wait` reaches `ready`, revision 1; `prkit local read --json` has the stand-in's summary, base `origin/main`, head `working-tree`. The attempt's saved snapshot (`review_attempts.snapshot`, read with `node:sqlite` read-only) is exactly `.gitattributes`, `src/limits.ts`, `src/retired.ts`; `src/flags.ts` and `src/limits.ts` are left out as `filtered`. The `.git` fingerprint is unchanged and the filter mark is absent.
- **Unchanged:** a second `prkit local guide` prints `Nothing changed since revision 1. The guide is current.` and the stand-in's `runs.log` gains no turn.
- **Next revision:** a new file, then `prkit local guide` from `src/`, gives the same key revision 2. `--branch feature/limits` gives revision 3 with head `branch`, nothing uncommitted, and only `src/limits.ts` in the snapshot.
- **Refusals:** a folder outside any repository, a repository with nothing changed, one with no base, and an orphan branch with `--base main` each exit 1 with the catalogue's sentence, and `prkit local list` still lists one review.
- **Access:** at `screen.getByRole("radio", "Read only")`, `prkit local guide` exits 4 and `prkit local read --json` exits 0.
- **Stop:** with the stand-in held (`claude.hold()`), `prkit local stop` prints `Stopped the guide of widgets · feature/limits. Its revisions stay readable.` and the review reads `stopped`.
- **Isolation:** the fake GitHub's request log is empty for the whole local block; `prkit guide list --json` and `prkit inbox --json` carry no `local:` key, and the Inbox shows no `widgets`. `fake.writes()` is empty at the end.
- **Restart:** with the stand-in held, a run starts, the instance stops (`stopFakeInstance` with `keepHome: true`), a file is added, and the instance starts again. The run finishes as revision 4; its interrupted attempt and the rerun carry the same capture `headSha`, the revision's head is that commit, and the added file is not in the snapshot.
- **Real Claude:** `PRKIT_E2E_AGENT=1 pnpm e2e run tests/local-guides.e2e.ts --tag agent` writes a guide of a small discount change (one commit, two untracked files) with the user's Claude. It spends the subscription. The guide covers all three files, the repository's status is unchanged, and the fake GitHub saw no write. Transcripts go to `.e2e/evidence/local-guides/`.

## Gotchas

- Build every local repository outside the prkit checkout and outside the instance's home: a folder inside the checkout is read as prkit's own repository, and one inside the home is refused as prkit's checkout.
- The repository's `.gitattributes` names a filter for `*.ts`, so uncommitted `.ts` content is left out by design. Expect `filtered` entries, not a bug.
- `--branch` with the current branch names the same review as the working tree: the head mode is per run, not part of the key.
- Opening the Inbox revalidates GitHub reads. Take the request-log assertion before any Inbox navigation.
