// @effect-diagnostics-next-line nodeBuiltinImport:off -- starts node under a profile, to see it run
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- whether this machine has Homebrew's node
import * as NodeFs from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { runnerProfile, runtimeOf, runtimeReads, SANDBOX_EXEC } from "./seatbelt.ts";

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
    reads: runtimeReads(real).filter((target) => NodeFs.existsSync(target)),
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
    expect(runtimeOf(path, "/usr/local/bin/node")).toEqual(["/usr/local/bin/node"]);
    expect(runtimeOf(path, "/Users/octocat/bin/node")).toEqual(["/Users/octocat/bin/node"]);
    expect(runtimeReads("/usr/local/bin/node")).toEqual([]);
    expect(runtimeOf(path, "/Applications/prkit.app/Contents/MacOS/prkit")).toEqual([
      "/Applications/prkit.app/Contents",
    ]);
  });

  it("opens Homebrew's folders only for Homebrew's own node", () => {
    const node = "/opt/homebrew/Cellar/node/24.0.0/bin/node";
    expect(runtimeOf(path, node)).toEqual([
      node,
      "/opt/homebrew/opt",
      "/opt/homebrew/Cellar",
      "/opt/homebrew/lib",
    ]);
    expect(runtimeReads(node)).toEqual([
      "/opt/homebrew/etc/openssl@3",
      "/opt/homebrew/etc/ca-certificates",
    ]);
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
