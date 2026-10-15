# Agents and their instances

An agent instance is one setup of Claude Code or Codex: its own label, optional accent, binary, config folder and environment. Each kind has a default instance whose id is the kind (`claude`, `codex`). It exists without a row, can be renamed, turned off or reset, and is never removed. Everything else the user adds in Settings > Agents and lives in `agent_instances`. Reviews, fix sessions, attempts and turns store the instance they ran on (`instance_id`) next to the kind (`provider`).

## Ids

An id is 1-64 characters, starts with a letter, and uses letters, digits, `-` and `_`. Ids are unique whatever their case, so `Claude_Work` is taken once `claude_work` exists, and `Claude` or `CODEX` are a default's. The Add dialog makes it from the label (`claude_work`), adds `_2`, `_3` while one is taken, and never hands out a default's id. An id never changes, so a label can.

## Where each instance runs from

`Agents` builds one provider per instance and builds it again when anything it was built from changes: binary, config folder, login mode, environment, label, on or off. Binaries are looked up on every check, so installing one shows up on Check again. A binary or folder is a full path, starting with `/` or `~/`.

- **Claude Code** runs with `CLAUDE_CONFIG_DIR` set to the instance's folder, with `~` expanded the way a shell does and nothing else changed. Claude Code names a moved folder's keychain login after a hash of `CLAUDE_CONFIG_DIR` exactly as given (`Claude Code-credentials-<8 hex>`). So `~/.claude-work` and its full path are one login, but a trailing slash or a path through a symlink is another. HOME is never changed: Claude finds its keychain through it. Its sessions are files under `<folder>/projects/<the checkout's folder>/`, which is where prkit looks before resuming one.
- **Codex** runs in a home of prkit's own. The default keeps `$PRKIT_HOME/codex`, since Codex names a keychain login after its home's path and moving it would lose prkit's login and every session. Others get `$PRKIT_HOME/codex-instances/<id>`, sharing the login of the Codex home the instance names, or, for an instance added with "Sign in with ChatGPT", holding a ChatGPT login of its own. Removing an instance whose home holds a login of its own signs that login out (pinned to the keychain, so a shared login file is never touched), and deletes the home only once `codex login status` answers "Not logged in". Without a Codex binary, or without that answer (a timeout, a failed start), the removal is refused and nothing is deleted.

A default instance without a folder of its own keeps the one the server was started with (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), as before instances existed.

## Conversations

A conversation group is the kind plus where its sessions live: Claude's resolved config folder, Codex's prkit home. Moving a guide or a fix session to an instance in the same group keeps the conversation; another group starts a new one. So two Claude instances on one folder share conversations, and every Codex instance has its own.

## Turned off or removed

An instance that is off stays in Settings, shows Off, and leaves every picker. A guide or fix that used it, or one that was removed, runs on its kind's default instance while that is on, else on the default agent, without asking. That covers the turns nobody picks an agent for too: a redo after the branch moved, a revert, a retry and a change request. A revert runs no agent, so it never waits for one to be ready: with none, it keeps the session's own. A change request that finds no agent, or fails any other way, leaves the earlier result as it was, still naming the agent it ran on. The client picks the same way (`sessionSelection`), so the setup shows what will run.

Removing an instance turns it off first, so no guide or fix can start on it while prkit checks and signs it out; an instance a guide or fix is running on can't be removed until that run ends, and a refused removal turns it back on. A default instance can't be removed at all; Reset to default asks first, since it drops its environment and sensitive values.

## Environment

Each instance can carry environment variables. Names that would move an agent off the user's subscription (`ANTHROPIC_*`, `OPENAI_*`, cloud provider switches), cross GitHub accounts (`GH_*`, `GITHUB_*`), break containment (`HOME`, `PATH`, `TMPDIR`, `DYLD_*` and the like), or that prkit sets itself (`PRKIT_*`, `GIT_*`, the config folder variables) are refused with the reason (`environmentNameProblem`). Variables that set how the agent itself runs are refused on purpose, as whole namespaces: `CLAUDE_*`, `CODEX_*`, `BUN_*` and `NODE_*`, with one named exception, `NODE_EXTRA_CA_CERTS`, a CA file for a corporate proxy that runs no code. Claude Code and Codex add such settings often, and many load settings, plugins, shells or code from outside prkit's sandbox. Another setup belongs in its own config folder. A name a newer rule refuses is dropped from a stored instance too, never passed on, and isn't checked again when the instance is saved, so turning it on or off still works.

Claude Code passes these to commands it runs; on trusted fixes the repository's check scripts can read them. prkit can't keep them out: a command can read its parent's environment (`ps eww`), so unsetting them in the command would only look safe. Codex starts its commands with an environment of prkit's own (`shell_environment_policy`), without them.

A sensitive value is kept in `$PRKIT_HOME/agent-secrets.json` (mode 0600), never in the database, a log or the app: the app gets it back empty and marked redacted, and sending it back that way keeps it. Unlocking a saved one asks for the value again. Only a missing file counts as empty. One prkit can't read or decode stays as it is: a save that would rewrite it is refused with the file's path and how to recover (move it aside, then enter the values again), and so is a removal or reset. Every agent still starts; one that had sensitive values shows Needs attention ("prkit couldn't read its saved secrets…") instead of running without them, and the rest work as before. There are no launch arguments.
