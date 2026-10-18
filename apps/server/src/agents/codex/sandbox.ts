import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { TurnSetup } from "../AgentProvider.ts";
import { commandReads, openPath, ownFolder, realPaths } from "../commandReach.ts";

/** The name prkit's sandbox has in the turn's Codex config. */
export const PROFILE = "prkit";

/**
 * How one Codex turn is held to its checkout (docs/internals/architecture.md "Agents"),
 * measured on Codex 0.162. Codex reads only what the profile lists, except `/tmp` and
 * the temp folder, which it opens unless they are listed as `none`. A guide reads the
 * checkout and prkit's directories for the turn; a fix also writes the checkout (Codex
 * keeps its `.git` read-only) and its own temp folder, and when its scripts may run,
 * reads the tools that run them, wherever they are installed (`commandReads`). A turn
 * whose commands prkit approves also lists `/` as `none`. Every folder the profile
 * lists stays open, the more specific entry winning, and a command the agent asked to
 * run outside the profile (`require_escalated`) keeps exactly the profile's reads:
 * Codex widens an approved one to the whole disk only where `/` is readable.
 */
export const codexSandbox = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: TurnSetup,
  executable: string,
) =>
  Effect.gen(function* () {
    const writes = input.access._tag === "write";
    const reads = yield* commandReads(fs, path, input);
    const filesystem: Record<string, "read" | "write" | "none"> = { ":minimal": "read" };
    const grant = (targets: ReadonlyArray<string>, access: "read" | "write") => {
      for (const target of targets) filesystem[target] = access;
    };
    grant(reads.system, "read");
    // Codex's own install: its file helper (images, edits) runs from the executable, and
    // every command's PATH starts with its `codex-path` folder.
    const release = path.dirname(path.dirname(executable));
    grant(
      yield* realPaths(fs, [
        ownFolder(path, process.env.HOME ?? "/", release) ? release : path.dirname(executable),
      ]),
      "read",
    );
    grant(reads.turn, "read");
    grant(reads.tools, "read");
    // The repository's git data is readable but never writable, so an agent command can't
    // plant metadata that prkit's own git reads (docs/internals/architecture.md "Agents").
    grant(reads.git.data, "read");
    grant(yield* realPaths(fs, [input.cwd]), writes ? "write" : "read");
    if (input.access._tag === "write") grant(yield* realPaths(fs, [input.access.tmpDir]), "write");
    // The checkout's `.git` entry stays read-only even while the checkout is writable.
    grant([reads.git.entry], "read");
    const approved = input.access._tag === "read-only" || input.access.scripts._tag === "blocked";
    if (approved) filesystem["/"] = "none";
    filesystem[":slash_tmp"] = "none";
    // `:tmpdir` is the commands' TMPDIR: for a fix, its own temp folder, granted above.
    if (!writes) filesystem[":tmpdir"] = "none";

    const open = Object.entries(filesystem).flatMap(([target, access]) =>
      target.startsWith(":") || access === "none" ? [] : [target],
    );
    return {
      profile: { filesystem, network: { enabled: false } },
      path: yield* openPath(fs, path, open),
    };
  });
