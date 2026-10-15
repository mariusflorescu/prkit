// @effect-diagnostics-next-line nodeBuiltinImport:off -- starts node under a profile, to see it run
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- whether this machine has Homebrew's node
import * as NodeFs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { runnerProfile, runtimeOf, SANDBOX_EXEC } from "./seatbelt.ts";

const HOMEBREW_NODE = "/opt/homebrew/opt/node/bin/node";

const path = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path;
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** Whether `executable` starts and runs a line of JavaScript under a runner's profile. */
const runsUnderProfile = (executable: string) => {
  const real = NodeFs.realpathSync(executable);
  const profile = runnerProfile(path, {
    code: runtimeOf(path, real).filter((target) => NodeFs.existsSync(target)),
    reads: [],
    writes: [],
    guarded: [],
    sealedHome: null,
    mcpPort: null,
  });
  return NodeChildProcess.spawnSync(
    SANDBOX_EXEC,
    ["-p", profile, real, "-e", "console.log(6 * 7)"],
    {
      encoding: "utf8",
    },
  );
};

describe("the runner's runtime in its sandbox", () => {
  it("opens node's binary alone, never the folder it is installed in", () => {
    expect(runtimeOf(path, "/usr/local/bin/node")).toContain("/usr/local/bin/node");
    expect(runtimeOf(path, "/usr/local/bin/node")).not.toContain("/usr/local");
    expect(runtimeOf(path, "/Users/octocat/bin/node")).not.toContain("/Users/octocat");
    expect(runtimeOf(path, "/Applications/prkit.app/Contents/MacOS/prkit")).toContain(
      "/Applications/prkit.app/Contents",
    );
  });

  it("starts the node running these tests", () => {
    expect(runsUnderProfile(process.execPath).stdout).toBe("42\n");
  });

  it.skipIf(!NodeFs.existsSync(HOMEBREW_NODE))(
    "starts Homebrew's node, whose libraries live in Homebrew's own folders",
    () => {
      const run = runsUnderProfile(HOMEBREW_NODE);
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe("42\n");
    },
  );
});
