import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { AgentAccess, TurnInput } from "../AgentProvider.ts";
import { makeTestCheckout, removeTestCheckout } from "../testCheckout.ts";
import { codexSandbox } from "./sandbox.ts";

// Codex 0.162.1 runs an escalated command it was allowed to run with the whole disk open
// but the profile's `none` folders, unless `/` itself is `none`. A turn whose commands
// prkit approves closes `/`, and the folders the profile lists stay open.
describe("codexSandbox", () => {
  let checkout: Effect.Success<ReturnType<typeof makeTestCheckout>>;
  beforeAll(async () => {
    checkout = await Effect.runPromise(makeTestCheckout());
  });
  afterAll(() => Effect.runPromise(removeTestCheckout(checkout.root)));

  const profileFor = (access: AgentAccess) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const input: TurnInput = {
          turn: { id: "turn-1", ended: () => Effect.void },
          cwd: checkout.checkout,
          checkout: checkout.co,
          readableDirs: [checkout.diffs],
          instructions: "",
          prompt: "",
          resumeSessionId: null,
          model: null,
          options: [],
          mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "test" },
          env: {},
          access,
          tools: [],
        };
        const { profile } = yield* codexSandbox(
          fs,
          yield* Path.Path,
          input,
          "/nowhere/codex/bin/codex",
        );
        const real = yield* fs.realPath(checkout.checkout);
        return { root: profile.filesystem["/"], checkout: profile.filesystem[real], profile };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  it.each([
    ["a guide", { _tag: "read-only", tmpDir: "/nowhere" }, { root: "none", checkout: "read" }],
    [
      "a fix whose scripts can't run",
      { _tag: "write", scripts: { _tag: "blocked", reason: "a fork" }, tmpDir: "/nowhere" },
      { root: "none", checkout: "write" },
    ],
    [
      "a fix whose scripts run, which Codex never asks about",
      { _tag: "write", scripts: { _tag: "allowed", names: ["test"] }, tmpDir: "/nowhere" },
      { root: undefined, checkout: "write" },
    ],
  ] as const)("lists / and the checkout for %s", async (_, access, expected) => {
    const { root, checkout: entry } = await profileFor(access);
    expect({ root, checkout: entry }).toEqual(expected);
  });

  it("never opens /Library or /opt whole, nor Homebrew's etc and var", async () => {
    const { profile } = await profileFor({ _tag: "read-only", tmpDir: "/nowhere" });
    expect(profile.filesystem["/System"]).toBe("read");
    expect(
      Object.keys(profile.filesystem).filter((target) =>
        /^\/(Library|opt|opt\/homebrew|opt\/homebrew\/(etc|var)(\/.*)?)$/.test(target),
      ),
    ).toEqual([]);
  });

  /** The repository's git data and the checkout's `.git` entry, as the profile grades them. */
  const gitGrades = (access: AgentAccess) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { profile } = yield* Effect.promise(() => profileFor(access));
        const [repo, gitDir, root] = yield* Effect.all([
          fs.realPath(checkout.co.repo),
          fs.realPath(checkout.co.gitDir),
          fs.realPath(checkout.checkout),
        ]);
        return {
          cache: profile.filesystem[repo],
          worktreeGitDir: profile.filesystem[gitDir],
          dotGit: profile.filesystem[path.join(root, ".git")],
        };
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  it.each([
    ["a guide", { _tag: "read-only", tmpDir: "/nowhere" }],
    [
      "a fix whose scripts can't run",
      { _tag: "write", scripts: { _tag: "blocked", reason: "a fork" }, tmpDir: "/nowhere" },
    ],
    [
      "a fix whose scripts run",
      { _tag: "write", scripts: { _tag: "allowed", names: ["test"] }, tmpDir: "/nowhere" },
    ],
  ] as const)(
    "reads but never writes the git data or the checkout's .git for %s",
    async (_, access) => {
      expect(await gitGrades(access)).toEqual({
        cache: "read",
        worktreeGitDir: "read",
        dotGit: "read",
      });
    },
  );
});
