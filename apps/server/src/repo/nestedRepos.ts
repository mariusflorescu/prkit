// @effect-diagnostics-next-line nodeBuiltinImport:off -- effect/FileSystem lists a folder without telling links from folders.
import * as NodeFs from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Code points HFS+ leaves out of a name, which git also leaves out when it compares one with `.git`. */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** Whether git on a Mac volume opens this folder entry as `.git`: any case, HFS+ spellings too. */
export const isDotGit = (name: string) => name.replace(HFS_IGNORED, "").toLowerCase() === ".git";

/** What the walk found below a checkout that stops prkit's git. */
export interface NestedEntry {
  /** Relative to the checkout, with `/` between folders. */
  readonly path: string;
  /**
   * A `.git` file, folder or link; a folder the walk couldn't list, which could hide one; or
   * a folder that went away or stopped being one while the walk ran, so something is still
   * changing the checkout.
   */
  readonly kind: "git" | "unreadable" | "changed";
}

const isListFailure = Schema.is(Schema.Struct({ code: Schema.String }));
const FOLDERS_AT_ONCE = 16;

/** A folder's entries, as `readdir` gives them. */
export type ListFolder = (
  folder: string,
) => Promise<ReadonlyArray<{ readonly name: string; isDirectory(): boolean }>>;

const listFolder: ListFolder = (folder) => NodeFs.readdir(folder, { withFileTypes: true });

/**
 * Every entry below `root` that git would open as a repository: one named `.git` in any case
 * (a file, folder or link) other than the root's own, and every folder it couldn't list, since
 * git can still reach `<folder>/.git` by name. A plain walk of the checkout: it never follows a
 * link and never runs git, so nothing in the checkout runs either. A folder that goes away
 * while it runs counts too. Stops at `limit` entries.
 */
export const nestedGitEntries = (root: string, limit = 5, list: ListFolder = listFolder) =>
  Effect.promise(async () => {
    const found: Array<NestedEntry> = [];
    let level: ReadonlyArray<string> = [""];
    while (level.length > 0 && found.length < limit) {
      const next: Array<string> = [];
      for (let start = 0; start < level.length && found.length < limit; start += FOLDERS_AT_ONCE)
        await Promise.all(
          level.slice(start, start + FOLDERS_AT_ONCE).map(async (dir) => {
            const entries = await list(dir === "" ? root : `${root}/${dir}`).catch((error) => {
              // The turn's processes are gone by now, so nothing should still change the tree.
              const changed =
                isListFailure(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
              found.push({ path: dir, kind: changed ? "changed" : "unreadable" });
              return [];
            });
            for (const entry of entries) {
              const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
              // The root's own `.git` is the file prkit's `worktree add` wrote, spelled exactly so.
              if (isDotGit(entry.name)) {
                if (path !== ".git") found.push({ path, kind: "git" });
              } else if (entry.isDirectory()) next.push(path);
            }
          }),
        );
      level = next;
    }
    return found.slice(0, limit).toSorted((a, b) => a.path.localeCompare(b.path));
  });
