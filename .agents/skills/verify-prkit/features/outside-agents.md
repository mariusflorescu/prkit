# Outside agents

Settings > Outside agents turns on an MCP endpoint for the owner's own client (Claude Code, Codex, Cursor), reached through the launcher `<home>/bin/prkit-mcp` over stdio. Off by default; Read only lists reads; Read and start work adds opening PRs, guides, draft comments and fix turns. Nothing a client does reaches GitHub, and its fix turns wait for Push. How it works: [docs/features/outside-agents.md](../../../../docs/features/outside-agents.md).

## Sub-features

- `switch` is `switch "Let my coding agents use prkit"`; the toast says "Outside agents can read" or "Outside agents are off".
- `levels` are `radio "Read only"` and `radio "Read and start work"`, each saving on change.
- `setup` shows the `claude mcp add` and `codex mcp add` commands with Copy buttons, only while on.
- `clients` is `list "Connected clients"`, by the name each gave in `initialize`, or "None yet. A client shows here after its first call."
- `reset` is `button "Reset access"`: a new token and an empty list. A copied token stops working; bridges on this machine carry on.
- `discovery` is `<home>/outside-agents.json`, mode 0600: `{_tag: "on", port, token, pid, version, access}` or `{_tag: "off", pid, version}`.
- `bridge` relays stdio, recovers after a restart or a new token, and answers alone with `prkit_status` while prkit is closed or off.
- `live-workspace` shows a PR a client opened, in every window, and brings the desktop window forward.
- `started-from` is "Started from <client>" on the fix turn card and the guide progress, and `started_by` on `fixer_turns` and `review_attempts`.

## How to get to it (user POV)

- Cmd+, then Outside agents in the section list, or `<url>/settings/outside-agents`.
- From a terminal: the setup command, then the client's own session.

## Driving it with e2e

Preconditions:

- `pnpm build` ran after the last change. Never run `claude mcp add` or `codex mcp add` against your real config: use a temporary `--mcp-config` file and `--strict-mcp-config`.

- **Access journey.** `tests/outside-agents.e2e.ts` (tag `outside-agents`) runs on fake GitHub with the stand-in Claude: off by default with the bridge answering `OUTSIDE_OFF`; on through the UI, `notifications/tools/list_changed`, reads only; a starts-work call is "not found"; `Origin` and a non-loopback `Host` get 403 and a wrong token 401 (`node:http`, since `fetch` drops `Host`); Read and start work lists 52 tools; `open_pull_request` switches the window to `heading "Keyboard fixture 9"`; `add_review_comment` twice with one `clientRequestId` makes one draft; `send_to_fix_agent` with no ids sends every draft, and the Fixes tab says "Started from e2e client", which the owner's Retry keeps; Reset access, a restart with `--keep-home` and the switch off, each with the bridge recovering; and `fake.writes()` empty. With the fake's second account, a PR in no inbox, or in both, asks for `accountId` and names both accounts, and a named one reads through it. All four journeys use fake GitHub only. The guide/fix and revision journeys use local git objects and the stand-in agent, including the owner-ready-fix automatic-push setting case. Transcripts go to `.e2e/evidence/u69/`.
- **Parity journey.** `tests/outside-agents-parity.e2e.ts` enables access through the same switch and radios, then uses the launcher as a real client. It reads every new surface, filters Inbox by account/reason/repository and the other predicates, follows cursors, rejects a wrong cursor, validates model options, saves versioned PR guidance/focus, and exercises this PR, chosen layers and whole-stack generation. `tests/outsideGit.ts` redirects only this instance's git transport to real local fixture commits and refuses pushes, so stand-in guides and a fix finish without real GitHub or subscription use. It reads accepted revisions, saved diff fragments, full fix turns, the diff and Copy patch, edits/moves a draft, focuses/reorders/closes tabs, and asserts zero fake GitHub writes. The journey also invalidates a changed-list cursor, reconstructs an oversized conversation response from bounded fragments, and closes the shown A tab after B was opened quietly. Every bridge call checks the full encoded response cap; final assertions check REST/GraphQL and git-push attempts after the last tool call. Screenshots include the focused tab, shown-tab removal and final settings; the transcript is `.e2e/evidence/u70/parity.md`.
- **Client by hand.** `tests/outsideBridge.ts` spawns the launcher like a client and gives `initialize`, `tools`, `call` and the notifications it saw.
- **Real Claude Code.** Write `{"mcpServers":{"prkit":{"command":"<home>/bin/prkit-mcp"}}}` to a temporary file and run `claude -p "<ask>" --mcp-config <file> --strict-mcp-config --allowedTools "mcp__prkit__*" --output-format stream-json --verbose` against a verify instance. Start it with prkit closed and open the instance mid-run to see its tools refresh.
- **Agent turns untouched.** `apps/server/src/mcp/outside/OutsideMcp.test.ts` lists both endpoints on one server: `/mcp` lists exactly `PRKIT_TOOLS`, and neither token opens the other endpoint.

## Gotchas

- The bridge reads the discovery file every two seconds; poll `tools/list` rather than reading it once after a change.
- A tool above the client's level is a JSON-RPC "not found" error, not a tool result with `isError`.
- The access journey uses fake GitHub without git, so its work fails at checkout. The parity journey adds the local git transport stand-in and can finish guides and fixes offline.
- Claude Code calls itself `claude-code`; prkit shows it as "Claude Code".
