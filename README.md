<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo/prkit-logo-paper.svg" />
    <img src="assets/brand/logo/prkit-logo-ink.svg" alt="prkit" width="240" />
  </picture>
</h1>

<p align="center">Stay in the loop when agents write the code.</p>

prkit is a local desktop app for reviewing GitHub pull requests across every GitHub account on your machine. It asks your own coding agent to write a guided review of each PR and keeps it current as new commits land.

```sh
vp i                  # install
vp run dev            # server + web; open the URL it prints
vp run dev:desktop    # Electron window, which runs its own server
```

Your own coding agent can use prkit too: turn on Settings > Outside agents, then add it to your client once.

```sh
claude mcp add --scope user prkit -- ~/.prkit/bin/prkit-mcp
codex mcp add prkit -- ~/.prkit/bin/prkit-mcp
```

It can read your inbox, open PRs, start guides and send comments to the fix agent. Pushing, merging and posting to GitHub stay a click in prkit. More in [docs/features/outside-agents.md](docs/features/outside-agents.md).

How it fits together: [docs/internals/architecture.md](docs/internals/architecture.md).

The website lives in [apps/www](apps/www): `vp run dev:www` serves it, `vp run build:www` builds it.

## Command line and coding agents

Install `prkit` from Settings > Outside agents > Command line, or the command palette's **Install command line tool** action. Turn Outside agents on, then run `prkit status`, `prkit inbox`, or `prkit --help`. Use `--json` for scripts. The same Settings block opens the pinned installer for the `prkit-cli` skill in your terminal, where you choose the agents to install it for. See [the CLI guide](docs/features/cli.md) for commands, access levels and sandbox setup.
