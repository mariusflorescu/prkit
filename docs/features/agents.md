# Agents and their instances

An agent instance is one setup of Claude Code or Codex: its own label, optional accent, binary, config folder and environment. Each kind has a default instance whose id is the kind (`claude`, `codex`). It exists without a row, can be renamed, turned off or reset, and is never removed. Everything else the user adds in Settings > Agents and lives in `agent_instances`. Reviews, fix sessions, attempts and turns store the instance they ran on (`instance_id`) next to the kind (`provider`).

## Ids

An id is 1-64 characters, starts with a letter, and uses letters, digits, `-` and `_`. The Add dialog makes it from the label (`claude_work`), adds `_2`, `_3` while one is taken, and never hands out a default's id. An id never changes, so a label can.

## Where each instance runs from

`Agents` builds one provider per instance and builds it again when anything it was built from changes: binary, config folder, login mode, environment, label, on or off. Binaries are looked up on every check, so installing one shows up on Check again.

- **Claude Code** runs with `CLAUDE_CONFIG_DIR` set to the instance's folder, with `~` expanded and nothing else changed. Claude Code names a moved folder's keychain login after a hash of `CLAUDE_CONFIG_DIR` exactly as given (`Claude Code-credentials-<8 hex>`), so `~/.claude-work` and `/Users/<you>/.claude-work/` are two logins. HOME is never changed: Claude finds its keychain through it. Its sessions are files under `<folder>/projects/`, which is where prkit looks before resuming one.
- **Codex** runs in a home of prkit's own. The default keeps `$PRKIT_HOME/codex`, since Codex names a keychain login after its home's path and moving it would lose prkit's login and every session. Others get `$PRKIT_HOME/codex-instances/<id>`, sharing the login of the Codex home the instance names, or, for an instance added with "Sign in with ChatGPT", holding a ChatGPT login of its own. Removing such an instance signs that login out (pinned to the keychain, so a shared login file is never touched) and then deletes its home; if the sign-out fails, nothing is deleted.

A default instance without a folder of its own keeps the one the server was started with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), as before instances existed.

## Conversations

A conversation group is the kind plus where its sessions live: Claude's resolved config folder, Codex's prkit home. Moving a guide or a fix session to an instance in the same group keeps the conversation; another group starts a new one. So two Claude instances on one folder share conversations, and every Codex instance has its own.

## Turned off or removed

An instance that is off stays in Settings, shows Off, and leaves every picker. A guide or fix that used it, or one that was removed, runs on its kind's default instance while that is on, else on the default agent, without asking. The client picks the same way (`sessionSelection`), so the setup shows what will run.

## Environment

Each instance can carry environment variables. Names that would move an agent off the user's subscription (`ANTHROPIC_*`, `OPENAI_*`, cloud provider switches), cross GitHub accounts (`GH_*`, `GITHUB_*`), break containment (`HOME`, `PATH`, `TMPDIR`, `NODE_OPTIONS`, `DYLD_*` and the like), or that prkit sets itself (`PRKIT_*`, `GIT_*`, the config folder variables) are refused with the reason (`environmentNameProblem`). A sensitive value is kept in `$PRKIT_HOME/agent-secrets.json` (mode 0600), never in the database, a log or the app: the app gets it back empty and marked redacted, and sending it back that way keeps it. There are no launch arguments.
