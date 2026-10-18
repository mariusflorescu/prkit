import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { describe, expect, it } from "vite-plus/test";

import { type Checkout, checkIntegrity, checkoutFor, cwdOf, gitArgs, gitDirEnv } from "./gitRun.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

describe("checkoutFor", () => {
  it("names the git dir after the worktree's last segment, under the cache", () => {
    expect(
      checkoutFor(
        path,
        "/home/me/.prkit/repos/github.com/octocat/x.git",
        "/home/me/.prkit/fixes/f1",
      ),
    ).toEqual({
      repo: "/home/me/.prkit/repos/github.com/octocat/x.git",
      worktree: "/home/me/.prkit/fixes/f1",
      gitDir: "/home/me/.prkit/repos/github.com/octocat/x.git/worktrees/f1",
    });
  });
});

describe("gitArgs and gitDirEnv", () => {
  const co: Checkout = { repo: "/r/x.git", worktree: "/w/f1", gitDir: "/r/x.git/worktrees/f1" };

  it("pins every hostile config off before the subcommand", () => {
    expect(gitArgs(["reset", "--hard", "HEAD"], { _tag: "plain" })).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.sshCommand=",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "reset",
      "--hard",
      "HEAD",
    ]);
  });

  it.each([
    ["plain", { _tag: "plain" } as const, {}, undefined],
    ["bare", { _tag: "bare", repo: "/r/x.git" } as const, { GIT_DIR: "/r/x.git" }, "/r/x.git"],
    [
      "worktree",
      { _tag: "worktree", checkout: co } as const,
      { GIT_DIR: "/r/x.git/worktrees/f1", GIT_COMMON_DIR: "/r/x.git", GIT_WORK_TREE: "/w/f1" },
      "/w/f1",
    ],
  ])("sets the git dir and cwd for a %s target", (_, target, env, cwd) => {
    expect(gitDirEnv(target)).toEqual(env);
    expect(cwdOf(target)).toBe(cwd);
  });
});

/**
 * Lays out a linked worktree's on-disk metadata as `git worktree add` writes it, applies
 * one tampering change (or none), and returns `checkIntegrity`'s verdict.
 */
const verdict = (
  tamper: (dirs: {
    repo: string;
    worktree: string;
    gitDir: string;
  }) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const p = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "prkit-gitint-" });
      const repo = p.join(root, "repos", "x.git");
      const worktree = p.join(root, "fixes", "f1");
      const gitDir = p.join(repo, "worktrees", "f1");
      yield* fs.makeDirectory(gitDir, { recursive: true });
      yield* fs.makeDirectory(worktree, { recursive: true });
      yield* fs.writeFileString(p.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
      yield* fs.writeFileString(p.join(gitDir, "commondir"), "../..\n");
      yield* fs.writeFileString(p.join(gitDir, "gitdir"), `${p.join(worktree, ".git")}\n`);
      yield* tamper({ repo, worktree, gitDir });
      const result = yield* checkIntegrity(fs, p, checkoutFor(p, repo, worktree)).pipe(
        Effect.as("ok" as const),
        Effect.catchTag("GitTampered", (error) => Effect.succeed(error.message)),
      );
      yield* fs.remove(root, { recursive: true });
      return result;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describe("checkIntegrity", () => {
  it("passes an untouched checkout", async () => {
    expect(await verdict(() => Effect.void)).toBe("ok");
  });

  it("refuses a .git file pointed at a planted git dir", async () => {
    const message = await verdict(({ worktree, repo }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const planted = path.join(repo, "evil");
        yield* fs.makeDirectory(planted, { recursive: true });
        yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${planted}\n`);
      }),
    );
    expect(message).toContain("its .git file");
  });

  it("refuses a commondir pointed at a planted common dir", async () => {
    const message = await verdict(({ repo, gitDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(path.join(repo, "evil"), { recursive: true });
        yield* fs.writeFileString(path.join(gitDir, "commondir"), "../../evil\n");
      }),
    );
    expect(message).toContain("its commondir");
  });

  it("refuses a gitdir back-reference pointed elsewhere", async () => {
    const message = await verdict(({ gitDir, repo }) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(path.join(gitDir, "gitdir"), `${path.join(repo, "nope")}\n`),
      ),
    );
    expect(message).toContain("gitdir back-reference");
  });

  it("refuses a per-worktree config", async () => {
    const message = await verdict(({ gitDir }) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString(path.join(gitDir, "config.worktree"), "[core]\n\tfsmonitor = x\n"),
      ),
    );
    expect(message).toContain("per-worktree config");
  });

  it("refuses when the checkout's .git is gone", async () => {
    const message = await verdict(({ worktree }) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(path.join(worktree, ".git"))),
    );
    expect(message).toContain("its .git file");
  });
});
