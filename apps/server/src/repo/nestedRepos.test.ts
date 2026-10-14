// @effect-diagnostics-next-line nodeBuiltinImport:off -- the walk's own folder listing, removing a folder right before it.
import * as NodeFs from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { describe, expect, it } from "vite-plus/test";

import { isDotGit, type ListFolder, nestedGitEntries } from "./nestedRepos.ts";

const LOCKED = "locked";

/**
 * A checkout with its own `.git` file and a source file, plus what `plant` adds, and what the
 * walk finds in it.
 */
const walk = (
  plant: (
    checkout: string,
  ) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path>,
  list?: ListFolder,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const p = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "prkit-nested-" });
      const checkout = p.join(root, "f1");
      yield* fs.makeDirectory(p.join(checkout, "src"), { recursive: true });
      yield* fs.writeFileString(p.join(checkout, ".git"), "gitdir: /r/x.git/worktrees/f1\n");
      yield* fs.writeFileString(p.join(checkout, "src", "a.js"), "export const a = 1;\n");
      yield* plant(checkout);
      const found = yield* nestedGitEntries(checkout, 5, list);
      // The folder one case locks, opened again so the cleanup can remove it.
      yield* fs.chmod(p.join(checkout, LOCKED), 0o755).pipe(Effect.ignore);
      yield* fs.remove(root, { recursive: true });
      return found;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

const make = (checkout: string, ...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    yield* fs.makeDirectory(p.join(checkout, ...segments), { recursive: true });
  });

describe("nestedGitEntries", () => {
  it("finds nothing in a checkout with only its own .git", async () => {
    expect(await walk(() => Effect.void)).toEqual([]);
  });

  it("finds an empty repository at any depth, as a folder, file or link", async () => {
    expect(
      await walk((checkout) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Path.Path;
          yield* make(checkout, "nested", ".git", "objects");
          yield* fs.writeFileString(p.join(checkout, "nested", ".git", "HEAD"), "ref: x\n");
          yield* make(checkout, "vendor", "lib");
          yield* fs.writeFileString(p.join(checkout, "vendor", "lib", ".git"), "gitdir: /x\n");
          yield* make(checkout, "deep", "a", "b");
          yield* fs.symlink("/nowhere", p.join(checkout, "deep", "a", "b", ".git"));
        }),
      ),
    ).toEqual([
      { path: "deep/a/b/.git", kind: "git" },
      { path: "nested/.git", kind: "git" },
      { path: "vendor/lib/.git", kind: "git" },
    ]);
  });

  it("finds .git in another case", async () => {
    expect(await walk((checkout) => make(checkout, "src", ".GIT"))).toEqual([
      { path: "src/.GIT", kind: "git" },
    ]);
  });

  it("never follows a link to a folder holding a repository", async () => {
    expect(
      await walk((checkout) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Path.Path;
          const outside = p.join(p.dirname(checkout), "outside");
          yield* make(outside, ".git");
          yield* fs.symlink(outside, p.join(checkout, "linked"));
        }),
      ),
    ).toEqual([]);
  });

  it("refuses a folder it can't list, which could hide a repository", async () => {
    expect(
      await walk((checkout) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Path.Path;
          yield* make(checkout, LOCKED, "inner");
          yield* fs.chmod(p.join(checkout, LOCKED), 0o111);
        }),
      ),
    ).toEqual([{ path: LOCKED, kind: "unreadable" }]);
  });

  it("refuses a folder that goes away while it walks, since something still changes the checkout", async () => {
    const vanishing: ListFolder = async (folder) => {
      if (folder.endsWith("/src")) await NodeFs.rm(folder, { recursive: true });
      return NodeFs.readdir(folder, { withFileTypes: true });
    };
    expect(await walk(() => Effect.void, vanishing)).toEqual([{ path: "src", kind: "changed" }]);
  });
});

describe("isDotGit", () => {
  it.each([
    [".git", true],
    [".GIT", true],
    [".Git", true],
    // HFS+ leaves zero-width joiners and byte order marks out of names, and so does git.
    [".g‌it", true],
    ["﻿.git", true],
    [".gitignore", false],
    ["git", false],
    [".git~", false],
  ])("%j is .git: %s", (name, expected) => {
    expect(isDotGit(name)).toBe(expected);
  });
});
