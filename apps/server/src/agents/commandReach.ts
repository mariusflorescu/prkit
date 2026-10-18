import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { isShim } from "../executables.ts";
import type { TurnSetup } from "./AgentProvider.ts";

/**
 * The system's own directories, where commands, their libraries and the developer
 * tools live (Xcode's for `/usr/bin/git`), and Homebrew's programs (rg) without its
 * `etc` and `var`, where installed services keep config and data. The owner's home,
 * `/tmp`, the temp folder, other disks and the rest of `/Library` (keychains,
 * preferences, logs) stay out. Each entry may be a file.
 */
const SYSTEM_DIRS = [
  "/System",
  "/Library/Developer",
  "/Library/Apple",
  // Where Xcode records its accepted license; without it `/usr/bin/git` refuses to run.
  "/Library/Preferences/com.apple.dt.Xcode.plist",
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/private/etc",
  ...["bin", "sbin", "opt", "Cellar", "lib", "libexec", "share"].map(
    (folder) => `/opt/homebrew/${folder}`,
  ),
];

/** What runs a fix's check scripts: the package managers, and node under them. */
const SCRIPT_TOOLS = ["node", "npm", "pnpm", "yarn", "bun"];

/**
 * Where a turn's commands keep their temporary files (`TMPDIR`). Claude Code hands its
 * sandboxed commands `<CLAUDE_CODE_TMPDIR>/claude-<uid>` only while that fits in 44
 * bytes, and drops sandbox rules under /tmp, so the folder is short and outside /tmp.
 */
export const turnTmpDir = (path: Path.Path, turnId: string) =>
  path.join("/Users/Shared", `prkit-${turnId.replaceAll("-", "").slice(0, 6)}`);

export const isUnder = (path: Path.Path, child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

/** A tool's install folder, unless it holds the home folder or is the home or a folder directly in it. */
export const ownFolder = (path: Path.Path, home: string, prefix: string) =>
  isUnder(path, prefix, home)
    ? path.relative(home, prefix).split(path.sep).length >= 2
    : !isUnder(path, home, prefix);

/**
 * The folders a script tool at each real path needs: the folder it is in, and for
 * `<prefix>/bin/<tool>` the prefix, where node keeps npm and npm its own files.
 */
export const toolFolders = (path: Path.Path, home: string, tools: ReadonlyArray<string>) =>
  tools.flatMap((target) => {
    const folder = path.dirname(target);
    const prefix = path.dirname(folder);
    return path.basename(folder) === "bin" && ownFolder(path, home, prefix)
      ? [folder, prefix]
      : [folder];
  });

/** The real path of each target that exists. */
export const realPaths = (fs: FileSystem.FileSystem, targets: ReadonlyArray<string>) =>
  Effect.forEach(targets, (target) =>
    fs.realPath(target).pipe(
      Effect.map((resolved): ReadonlyArray<string> => [resolved]),
      Effect.catchTag("PlatformError", () => Effect.succeed([])),
    ),
  ).pipe(Effect.map((found) => found.flat()));

/**
 * PATH's folders, without a version manager's shims: they pick a tool from the
 * manager's own config, which stays closed, so commands use real installs instead,
 * as prkit does (`findOnPath`).
 */
const pathDirs = (path: Path.Path) =>
  (process.env.PATH ?? "").split(":").filter((dir) => path.isAbsolute(dir) && !isShim(dir));

/**
 * What one turn's commands may read besides its checkout and temp folder, every
 * folder as it really is on disk: the system's own, the turn's directories, prkit's
 * git config, and when the PR's scripts may run, every install of the script tools on
 * PATH, since the agent's login shell reorders it. The repository's git data is returned
 * on its own (`git`): it is readable, but the sandboxes deny writes to it and to the
 * checkout's `.git` entry, so an agent command can't change the metadata prkit's own git
 * reads (docs/internals/architecture.md "Repository access"). Its paths come from the
 * `Checkout` prkit computed, never from the checkout's own `.git`.
 */
export const commandReads = (fs: FileSystem.FileSystem, path: Path.Path, input: TurnSetup) =>
  Effect.gen(function* () {
    const scripts = input.access._tag === "write" && input.access.scripts._tag === "allowed";
    const tools = scripts
      ? toolFolders(
          path,
          process.env.HOME ?? "/",
          yield* realPaths(
            fs,
            SCRIPT_TOOLS.flatMap((name) => pathDirs(path).map((dir) => path.join(dir, name))),
          ),
        )
      : [];
    const gitConfig = input.env.GIT_CONFIG_GLOBAL;
    const [checkout = input.checkout.worktree] = yield* realPaths(fs, [input.checkout.worktree]);
    return {
      system: yield* realPaths(fs, SYSTEM_DIRS),
      turn: yield* realPaths(fs, [
        ...input.readableDirs,
        ...(gitConfig === undefined ? [] : [gitConfig]),
      ]),
      tools,
      git: {
        /** The cache and this worktree's git dir: readable, never writable. */
        data: yield* realPaths(fs, [input.checkout.gitDir, input.checkout.repo]),
        /** The checkout's `.git` entry (a linked worktree's small file), never writable. */
        entry: path.join(checkout, ".git"),
      },
    };
  });

/**
 * PATH with only the real folders inside `open`: on macOS a command lookup that meets
 * a closed folder, or a link in one, fails with EPERM instead of moving on.
 */
export const openPath = (fs: FileSystem.FileSystem, path: Path.Path, open: ReadonlyArray<string>) =>
  realPaths(fs, pathDirs(path)).pipe(
    Effect.map((dirs) =>
      [...new Set(dirs)].filter((dir) => open.some((root) => isUnder(path, dir, root))).join(":"),
    ),
  );
