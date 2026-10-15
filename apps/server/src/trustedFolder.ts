// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.stat follows links; every folder component needs lstat before traversal.
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const missing = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal("ENOENT") }));

/** Checks the complete path before any creation, then the owned, writable final folder. */
export const trustedFolderProblem = (
  directory: string,
  options: { readonly allowMissing?: boolean } = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const uid = process.getuid?.();
      if (uid === undefined)
        return `prkit can't use ${directory}: it couldn't verify the current user's ownership.`;
      const absolute = NodePath.resolve(directory);
      let current = NodePath.parse(absolute).root;
      const remaining = absolute.slice(current.length).split(NodePath.sep).filter(Boolean);
      let links = 0;
      while (true) {
        const info = await NodeFs.lstat(current).catch((error) => {
          if (options.allowMissing === true && Option.isSome(missing(error))) return null;
          throw new Error(`prkit can't inspect ${current}. Check its permissions and retry.`);
        });
        if (info === null) return null;
        if (info.isSymbolicLink()) {
          if (info.uid !== 0) return `prkit can't use ${current}: its symlink isn't owned by root.`;
          if (++links > 40) return `prkit can't use ${current}: it crosses too many symlinks.`;
          const target = await NodeFs.readlink(current);
          const root = NodePath.parse(target).root;
          remaining.unshift(...target.slice(root.length).split(NodePath.sep));
          current = root === "" ? NodePath.dirname(current) : root;
          continue;
        }
        if (!info.isDirectory()) return `prkit can't use ${current}: it isn't a real folder.`;
        if (info.uid !== 0 && info.uid !== uid)
          return `prkit can't use ${current}: it is owned by neither root nor the current user.`;
        if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
          return `prkit can't use ${current}: it is writable by group or others.`;
        const next = remaining.shift();
        if (next === undefined) {
          if (info.uid !== uid)
            return `prkit can't use ${current}: it isn't owned by the current user.`;
          try {
            await NodeFs.access(current, NodeFs.constants.W_OK);
          } catch {
            return `prkit can't use ${current}: it isn't writable by the current user.`;
          }
          return null;
        }
        // Resolve link targets one component at a time, including any links before "..".
        if (next === "..") current = NodePath.dirname(current);
        else if (next !== "" && next !== ".") current = NodePath.join(current, next);
      }
    },
    catch: (error) =>
      error instanceof Error
        ? error.message
        : `prkit couldn't inspect ${directory}. Check its permissions and retry.`,
  }).pipe(Effect.orElseSucceed((problem) => problem));
