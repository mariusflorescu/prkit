import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Config a planted file could otherwise make prkit's own git run as a program, pinned off
 * on the command line where `-c` beats every config file: the file-system monitor and hook
 * directory, the ssh and credential helpers, the pager and external diff. `protocol.allow`
 * is narrowed to https, the only transport prkit uses, so an `ext::` or other helper URL
 * can't launch a command. Filter drivers (`filter.*.process/clean/smudge`) have no single
 * off switch; they are kept out by pointing git at prkit's own config, which defines none
 * (GIT_COMMON_DIR in `gitDirEnv`). Every git command prkit runs carries these.
 */
export const GIT_SAFETY_FLAGS: ReadonlyArray<string> = [
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
];

/**
 * A linked worktree as prkit lays it out, with every path computed from the cache and the
 * worktree prkit owns, never discovered from the checkout. `git worktree add` names the
 * per-worktree git dir after the worktree's last path segment, and prkit's ids are unique,
 * so the name is the basename.
 */
export interface Checkout {
  /** The bare cache; GIT_COMMON_DIR, where objects, refs and config live. */
  readonly repo: string;
  /** GIT_WORK_TREE, and the command's working directory. */
  readonly worktree: string;
  /** `<repo>/worktrees/<name>`; GIT_DIR, where this worktree's HEAD and index live. */
  readonly gitDir: string;
}

export const checkoutFor = (path: Path.Path, repo: string, worktree: string): Checkout => ({
  repo,
  worktree,
  gitDir: path.join(repo, "worktrees", path.basename(worktree)),
});

/**
 * The user's own repository, which prkit only reads, with every dir it found pinned. The
 * index is a prkit temp file, so nothing prkit runs reads or writes the user's.
 */
export interface UserRepository {
  readonly _tag: "user";
  readonly gitDir: string;
  readonly commonDir: string;
  readonly workTree: string;
  readonly indexFile: string;
  /**
   * Copying objects only: new objects and git's temp files go here, and the user's objects
   * are read as alternates. Without it git writes its temp files into the user's objects.
   */
  readonly objectDirectory?: string;
}

/** Where a git command runs, and the dirs prkit pins so git never discovers them from the checkout. */
export type GitTarget =
  /** Creating the cache: no dir is pinned, because none exists yet. */
  | { readonly _tag: "plain" }
  | { readonly _tag: "bare"; readonly repo: string }
  | { readonly _tag: "worktree"; readonly checkout: Checkout }
  | UserRepository;

/**
 * Config that makes a read write to the user's repository: a split or untracked-cache index
 * written next to theirs, and automatic gc or maintenance after a command.
 */
const USER_READ_FLAGS: ReadonlyArray<string> = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** The full argument list: the safety flags come before the subcommand, where `-c` must sit. */
export const gitArgs = (args: ReadonlyArray<string>, target: GitTarget): ReadonlyArray<string> => [
  ...GIT_SAFETY_FLAGS,
  ...(target._tag === "user" ? USER_READ_FLAGS : []),
  ...args,
];

/**
 * The GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE a command runs under, and in the user's
 * repository its index. Setting all three makes git ignore the worktree's `.git` file and its
 * `commondir`, so a rewrite of either can't point git at a planted config.
 */
export const gitDirEnv = (target: GitTarget): Record<string, string> => {
  switch (target._tag) {
    case "plain":
      return {};
    case "bare":
      return { GIT_DIR: target.repo };
    case "worktree":
      return {
        GIT_DIR: target.checkout.gitDir,
        GIT_COMMON_DIR: target.checkout.repo,
        GIT_WORK_TREE: target.checkout.worktree,
      };
    case "user":
      return {
        GIT_DIR: target.gitDir,
        GIT_COMMON_DIR: target.commonDir,
        GIT_WORK_TREE: target.workTree,
        GIT_INDEX_FILE: target.indexFile,
        // Replace refs would make the user's objects read as others; optional locks would
        // let a read refresh the index.
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        ...(target.objectDirectory === undefined
          ? {}
          : {
              GIT_OBJECT_DIRECTORY: target.objectDirectory,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: `${target.commonDir}/objects`,
            }),
      };
  }
};

export const cwdOf = (target: GitTarget): string | undefined => {
  switch (target._tag) {
    case "plain":
      return undefined;
    case "bare":
      return target.repo;
    case "worktree":
      return target.checkout.worktree;
    case "user":
      return target.workTree;
  }
};

export class RepoError extends Schema.TaggedError<RepoError>()("RepoError", {
  reason: Schema.Literals(["account", "repository"]),
  message: Schema.String,
}) {}

/** prkit refused a git step because the checkout's git metadata was changed under it. */
export class GitTampered extends Schema.TaggedError<GitTampered>()("GitTampered", {
  worktree: Schema.String,
  message: Schema.String,
}) {}

/**
 * Fails when the on-disk git metadata of `checkout` no longer matches what prkit wrote:
 * the worktree's `.git` file must name prkit's git dir, that git dir's `commondir` must
 * resolve to the cache, its `gitdir` back-reference must name the worktree's `.git`, and no
 * per-worktree `config.worktree` may exist. An agent that changed any of these was setting
 * up a later git command to read a config it controls (docs/internals/architecture.md
 * "Repository access"); prkit refuses the step and reports it as needing the owner.
 */
export const checkIntegrity = (fs: FileSystem.FileSystem, path: Path.Path, checkout: Checkout) =>
  Effect.gen(function* () {
    const refuse = (what: string) =>
      new GitTampered({
        worktree: checkout.worktree,
        message: `prkit stopped and needs you: this checkout's git metadata was changed under it (${what}), which could point git at a planted config and run code outside the sandbox. Nothing ran and nothing was committed. Delete this checkout and retry; if it keeps happening, the pull request's own code is doing it.`,
      });
    const real = (target: string) =>
      fs.realPath(target).pipe(
        Effect.map((resolved): string | null => resolved),
        Effect.orElseSucceed(() => null),
      );
    const readTrim = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text): string | null => text.trim()),
        Effect.orElseSucceed(() => null),
      );
    const same = (left: string | null, rightPath: string) =>
      Effect.gen(function* () {
        if (left === null) return false;
        const [a, b] = yield* Effect.all([real(left), real(rightPath)]);
        return a !== null && a === b;
      });

    const gitFile = yield* readTrim(path.join(checkout.worktree, ".git"));
    const pointsAt = gitFile === null ? null : (/^gitdir: (.+)$/.exec(gitFile)?.[1] ?? null);
    if (!(yield* same(pointsAt, checkout.gitDir))) return yield* refuse("its .git file");

    const commondir = yield* readTrim(path.join(checkout.gitDir, "commondir"));
    const commonTarget = commondir === null ? null : path.resolve(checkout.gitDir, commondir);
    if (!(yield* same(commonTarget, checkout.repo))) return yield* refuse("its commondir");

    const back = yield* readTrim(path.join(checkout.gitDir, "gitdir"));
    if (!(yield* same(back, path.join(checkout.worktree, ".git"))))
      return yield* refuse("its gitdir back-reference");

    const hasWorktreeConfig = yield* fs
      .exists(path.join(checkout.gitDir, "config.worktree"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasWorktreeConfig) return yield* refuse("a per-worktree config was added");
  });
