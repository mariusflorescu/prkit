import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { describe, expect, it } from "vite-plus/test";

import { rebaseStateHash } from "./rebaseState.ts";

const TODO = "pick 7d1c2a0 two\npick 9e4b3f1 three\n";

/**
 * The hash of a worktree's git dir stopped mid-rebase as git leaves it, and the hash once
 * `change` has run on its `rebase-merge` folder.
 */
const hashes = (
  change: (state: string) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const p = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectory({ prefix: "prkit-rebase-" });
      const state = p.join(gitDir, "rebase-merge");
      yield* fs.makeDirectory(state);
      yield* fs.writeFileString(p.join(state, "git-rebase-todo"), TODO);
      yield* fs.writeFileString(p.join(state, "done"), "pick 3a9f0c2 one\n");
      yield* fs.writeFileString(p.join(state, "onto"), `${"b".repeat(40)}\n`);
      yield* fs.writeFileString(p.join(state, "head-name"), "detached HEAD\n");
      const before = yield* rebaseStateHash(gitDir);
      yield* change(state);
      const after = yield* rebaseStateHash(gitDir);
      // A case that locks the folder opens it again, so the cleanup can remove it.
      yield* fs.chmod(state, 0o755).pipe(Effect.ignore);
      yield* fs.remove(gitDir, { recursive: true });
      return { before, after };
    }).pipe(Effect.provide(NodeServices.layer)),
  );

const write = (state: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    yield* fs.writeFileString(p.join(state, name), text);
  });

describe("rebaseStateHash", () => {
  it("stays the same while nothing changes the rebase", async () => {
    const { before, after } = await hashes(() => Effect.void);
    expect(after).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [
      "the todo reordered",
      (state: string) => write(state, "git-rebase-todo", "pick 9e4b3f1 three\npick 7d1c2a0 two\n"),
    ],
    [
      "an exec line in the todo",
      (state: string) => write(state, "git-rebase-todo", `exec touch /tmp/x\n${TODO}`),
    ],
    ["another file git reads", (state: string) => write(state, "head-name", "refs/heads/main\n")],
    ["a file added", (state: string) => write(state, "strategy", "ours\n")],
    [
      "the todo swapped for a link to the same text",
      (state: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Path.Path;
          // Outside the folder, so only the todo's own entry differs.
          const elsewhere = p.join(p.dirname(state), "todo-elsewhere");
          yield* fs.writeFileString(elsewhere, TODO);
          yield* fs.remove(p.join(state, "git-rebase-todo"));
          yield* fs.symlink(elsewhere, p.join(state, "git-rebase-todo"));
        }),
    ],
    [
      "the rebase gone",
      (state: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(state, { recursive: true });
        }),
    ],
  ])("changes with %s", async (_, change) => {
    const { before, after } = await hashes(change);
    expect(after).not.toBe(before);
  });

  it.each([
    ["a file in it", "git-rebase-todo"],
    ["the folder itself", ""],
  ])("is null when prkit can't read %s", async (_, name) => {
    const { after } = await hashes((state) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;
        yield* fs.chmod(p.join(state, name), 0o000);
      }),
    );
    expect(after).toBeNull();
  });
});
