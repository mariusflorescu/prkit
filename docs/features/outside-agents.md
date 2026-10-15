# Outside agents

Settings > Outside agents lets the owner's own MCP client (Claude Code, Codex, Cursor, anything that starts a server over stdio) use prkit from a terminal session: see the inbox, open a PR in the app, start and read a guide, add draft comments and send them to the fix agent, and follow its progress. It is off by default. Anything that reaches GitHub stays a click in the app: pushing, merging, posting a review, replying to or resolving a thread.

## Setup

Settings shows one command per client, with `<home>` the prkit home (`~/.prkit` for the app):

```sh
claude mcp add --scope user prkit -- <home>/bin/prkit-mcp
codex mcp add prkit -- <home>/bin/prkit-mcp
```

No secret goes in a client's config. `bin/prkit-mcp` is a launcher prkit writes on every launch (mode 0700): it runs prkit's own server binary (`ELECTRON_RUN_AS_NODE=1` in the app) with `mcp-bridge`, which `bin.ts` picks before loading anything else. The bridge never opens the database or touches `prkit.lock`, so it runs beside the app.

## Levels

- **Read only**: `prkit_status`, `list_inbox`, `list_open_pull_requests`, `read_pull_request`, `read_guide`, `list_review_comments`, `read_fix`, `wait_for`.
- **Read and start work** adds `open_pull_request`, `generate_guide`, `stop_guide`, `add_review_comment`, `send_to_fix_agent`, `ask_fix_agent_to_change`, `stop_fix`, `retry_fix`, `resolve_conflicts`.

Each tool is declared once with its level (`apps/server/src/mcp/outside/access.ts`): `reads` or `startsWork` wraps the handler, and the server refuses to start when a handler's level differs from its tool's. A tool above the client's level is hidden from `tools/list` and unknown to `tools/call`, checked again on every call, so lowering the level takes effect at once. Other failures come back as tool errors with a code (`invalid`, `not-found`, `account-needed`, `not-allowed`, `not-ready`, `conflict`, `github`, `failed`) and a plain message.

Never offered: pushing, merging or any other pull request action, submitting a review, replying to or resolving threads, deleting or discarding anything, reverting, and any change to agents, accounts or settings. These are the owner's, in the app. So `stop_fix` stops only queued and running work: the session stays, and so does every commit waiting for Push, including one the agent is changing. `retry_fix` refuses a revert.

`add_review_comment`, `send_to_fix_agent` and `ask_fix_agent_to_change` take a `clientRequestId`. A request is the tool, the client, the pull request and that id (`outside_requests`, kept a day): a retry gets the first answer, looked up before anything else, instead of doing it twice; the same id with other input answers `conflict`. Each key has its own lock, so one slow call holds back only its own retries.

## Accounts

A PR is named by URL or by host, owner, repo and number, each held to GitHub's naming rules (no `..`, no slashes). prkit reads it through the account that has it open, has its guide or fix session, or has it in its cached inbox; when none does, through the only ready account on its host, as pasting a URL in the app does. With several, or none on a host with several, the tool asks for `accountId` and names the options. Nothing falls back to another account.

## What a client starts

Calls from outside count as clicks, like the app's own: reads use the cache, and `refresh: true` on `list_inbox` or `read_pull_request` spends budget for a fresh read. The client's name is whatever it reports in `initialize` (the bridge passes it as `x-prkit-client`, with a random id per bridge for the connected-clients list): a label, not an identity. It is stored on the guide attempt or fix turn it starts (`started_by`), and the activity says "Started from Claude Code". A fix turn a client started never pushes by itself, even in a repository set to push automatically: it waits for Push in the app. A retry or a redo after the branch moved keeps the client's name, even when the owner clicks Retry, since it runs the client's request again. A change a client asks for (`ask_fix_agent_to_change`) makes the turn the client's too, even an owner's turn, and the activity says "Claude Code asked: …" (`startedByFor`, `pushesItself` in `fixers/turnRules.ts`). `open_pull_request` opens the tab and, unless `focus: false`, every window switches to it and the desktop app comes forward (`workspace.changes`).

## Discovery and tokens

prkit writes `<home>/outside-agents.json` once its server listens: a fresh temporary file (`wx`, mode 0600) renamed over it, inside the same transaction as the settings, so a failed write changes neither the settings nor the token and reaches the UI as an error. A home prkit creates is 0700. prkit removes the file when the server stops. While on it holds `{port, token, pid, version, access}`; while off, only `{pid, version}`, so the bridge can tell "off" from "not open". A file whose pid is dead reads as not open.

The token is 32 random bytes, compared in constant time, new on every launch, every switch on, every level change and every Reset access. The server keeps only its SHA-256. This is the one exception to "tokens never touch disk": the file is how a client launched by another program finds prkit, it is readable only by the owner, and it holds no GitHub token. Reset access makes a new token and clears the client list. Anything using a copied token stops working; the bridges on this machine read the new file on their next call and carry on, so it doesn't disconnect the owner's own clients.

The endpoint is `/mcp/outside` on the server's own listener, with its own toolkit, sessions and auth (a second `McpServer` through `Layer.fresh`, since effect's server layer is memoized). It refuses any request with an `Origin` header, a `Host` other than `127.0.0.1:<port>`, the switch off, or a token that isn't the current one. Agent turns' `/mcp` is unchanged: their tokens don't open this endpoint, and this token doesn't open theirs.

## The bridge

The bridge reads the file only when it is a regular file of the current user's with no group or other permissions; anything else counts as prkit not being open. It relays stdio to the endpoint: it forwards the session id and protocol version, reads SSE answers, and keeps the client's `initialize`. On a refused connection, a 401, a 403 or an unknown session, it reads the discovery file again and replays `initialize`, so prkit restarting, a new token, or Reset access cost the client nothing. While prkit isn't reachable it answers itself: `initialize` with `tools.listChanged`, `tools/list` with only `prkit_status`, and every call with "prkit isn't open. Open it, then try again." or the way to turn the switch on. It checks the file every two seconds and sends `notifications/tools/list_changed` when prkit opens, closes, turns on or off, or changes level. Claude Code then lists the tools again within the same session.

## Timeouts

Guides and fixes take minutes. `wait_for` returns when the guide or fix settles, or after `timeoutSeconds` (50 by default, at most 600), under Codex's 60-second default tool timeout. For longer waits, raise the client's: `tool_timeout_sec` under `[mcp_servers.prkit]` in Codex's `config.toml`, or `MCP_TOOL_TIMEOUT` (milliseconds) for Claude Code.
