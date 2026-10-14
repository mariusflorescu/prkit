import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { checkoutFor } from "../repo/gitRun.ts";
import { checkoutPaths } from "./checkoutPaths.ts";

/**
 * A checkout under the system temp directory (itself behind /var -> /private/var on
 * macOS) whose links lead out, as a pull request's could: `notes.md` to a file
 * outside, `linked` to a directory outside, `dangling` to nothing, and `inner` to its
 * own `src`. `diffs/` stands for an attempt's extra readable directory. `opts/` holds a
 * file named like an option, which a pattern there would pass to the command. It is a
 * linked worktree of a bare cache under `repos/`, so a sandbox built from its `Checkout`
 * (`co`) has real git data to open.
 */
export const makeTestCheckout = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "prkit-paths-" });
    const checkout = path.join(root, "checkout");
    const outside = path.join(root, "outside");
    const diffs = path.join(root, "diffs");
    const repo = path.join(root, "repos", "widgets.git");
    const co = checkoutFor(path, repo, checkout);
    for (const dir of [
      path.join(checkout, "src"),
      path.join(checkout, "opts"),
      path.join(outside, "dir"),
      diffs,
      co.gitDir,
    ])
      yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(checkout, "src", "a.js"), "export {};\n");
    yield* fs.writeFileString(path.join(checkout, "src", "b.js"), "export {};\n");
    yield* fs.writeFileString(path.join(checkout, "opts", "--pre=sh"), "");
    yield* fs.writeFileString(path.join(checkout, "opts", "a.txt"), "touch ran\n");
    yield* fs.writeFileString(path.join(checkout, ".git"), `gitdir: ${co.gitDir}\n`);
    yield* fs.writeFileString(path.join(co.gitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(co.gitDir, "gitdir"), `${path.join(checkout, ".git")}\n`);
    yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret\n");
    yield* fs.writeFileString(path.join(outside, "dir", "inside.txt"), "secret\n");
    yield* fs.writeFileString(path.join(diffs, "numbered.diff"), "+1\n");
    yield* fs.symlink(path.join(outside, "secret.txt"), path.join(checkout, "notes.md"));
    yield* fs.symlink(path.join(outside, "dir"), path.join(checkout, "linked"));
    yield* fs.symlink(path.join(outside, "missing.txt"), path.join(checkout, "dangling"));
    yield* fs.symlink(path.join(checkout, "src"), path.join(checkout, "inner"));
    const paths = yield* checkoutPaths(fs, path, { checkout, readable: [diffs] });
    return { root, checkout, outside, diffs, repo, co, paths };
  }).pipe(Effect.provide(NodeServices.layer));

export const removeTestCheckout = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(root, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer));
