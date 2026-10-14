// @effect-diagnostics-next-line nodeBuiltinImport:off -- effect has no SHA-256 to fingerprint a folder.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- effect/FileSystem lists a folder without telling links from files.
import * as NodeFs from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

/**
 * A SHA-256 of git's rebase state in `<gitDir>/rebase-merge`: the todo, and the rest git
 * reads when the rebase goes on (`done`, `onto`, `head-name`, `author-script`, ...), every
 * file by name and bytes. A link or folder counts by its name and kind, never followed. A
 * missing folder has a hash of its own. Null when prkit can't read the folder or a file in
 * it, which callers treat as a changed plan.
 *
 * prkit starts every rebase with GIT_SEQUENCE_EDITOR=true and --no-autosquash and changes
 * none of these files itself, so between a stop and `rebase --continue` only something
 * outside prkit can change the hash: an `exec` line in the todo would run a command outside
 * the agent's sandbox (docs/internals/fix-agent.md "Before prkit's own git").
 */
export const rebaseStateHash = (gitDir: string) =>
  Effect.promise(async () => {
    const dir = `${gitDir}/rebase-merge`;
    const hash = NodeCrypto.createHash("sha256");
    const entries = await NodeFs.readdir(dir, { withFileTypes: true }).catch((error) =>
      isMissing(error) ? "missing" : null,
    );
    if (entries === "missing") return hash.update("missing").digest("hex");
    if (entries === null) return null;
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      hash.update(`${entry.name}\0`);
      if (!entry.isFile()) {
        hash.update(entry.isDirectory() ? "folder\0" : "other\0");
        continue;
      }
      const bytes = await NodeFs.readFile(`${dir}/${entry.name}`).catch(() => null);
      if (bytes === null) return null;
      hash.update(`file ${bytes.length}\0`).update(bytes);
    }
    return hash.digest("hex");
  });
