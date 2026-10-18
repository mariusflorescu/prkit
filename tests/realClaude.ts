import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { repoRoot } from "../scripts/verify-run.ts";

const Status = Schema.fromJsonString(
  Schema.Struct({ loggedIn: Schema.Boolean, authMethod: Schema.optionalKey(Schema.String) }),
);

/**
 * The owner's own Claude Code, for an instance on the fake GitHub. `verify-app --gh-home` gives
 * the server the fake's HOME, and Claude Code reports it logged out there. So `file` is a `claude`
 * written at run time under `.e2e/` that runs the one on PATH with the process's own HOME back.
 * Spends the owner's subscription, so only an agent-tagged journey uses it.
 */
export const setUpRealClaude = (name: string) => {
  const real = NodeChildProcess.execFileSync("/usr/bin/which", ["claude"], {
    encoding: "utf8",
  }).trim();
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-real-claude`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(file, `#!/bin/sh\nHOME='${NodeOS.homedir()}' exec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  const status = NodeChildProcess.spawnSync(file, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: process.env,
  });
  const login = Schema.decodeOption(Status)(status.stdout);
  if (Option.isNone(login) || !login.value.loggedIn || login.value.authMethod !== "claude.ai")
    throw new Error(
      "The agent journey needs Claude Code signed in with a claude.ai subscription: run `claude auth login`.",
    );
  return { file };
};
