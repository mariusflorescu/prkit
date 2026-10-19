import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { type Checkout, type GitRunner, type GitTarget, GitTampered, RepoError } from "./gitRun.ts";
import { linksRefusal, newLinks } from "./links.ts";
import { type NestedEntry, nestedGitEntries } from "./nestedRepos.ts";
import { rebaseStateHash } from "./rebaseState.ts";
import type { CommitIdentity } from "./RepoCache.ts";

/** prkit committed nothing: the agent made or changed a symlink or submodule (docs/internals/fix-agent.md). */
export class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", {
  paths: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** Why a rebase stops when prkit can't read git's state for the rest of it (`rebaseStateHash`). */
const REBASE_UNREADABLE =
  "prkit stopped and needs you: it couldn't read git's plan for the rest of the rebase, so it can't tell whether something changed it. prkit dropped the rebase, and nothing was committed or pushed. Retry to start the rebase again.";

/** prkit's own git in a fixer's checkout after a turn: merges, rebases, conflict sides, commits. */
export const makeFixCheckout = ({
  fs,
  path,
  run,
  git,
  dropRebase,
}: Pick<GitRunner, "run" | "git"> & {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly dropRebase: (co: Checkout) => Effect.Effect<void, PlatformError>;
}) => {
  const wt = (checkout: Checkout): GitTarget => ({ _tag: "worktree", checkout });

  /**
   * Refuses the next git step when the checkout holds a repository of its own. `git add` and
   * `git diff` run `git status` inside one at a submodule's path, which reads that repository's
   * config outside every sandbox; an empty one elsewhere makes `git add` read it and fail
   * (docs/internals/fix-agent.md "Before prkit's own git").
   */
  const refuseNestedRepos = (co: Checkout) =>
    Effect.gen(function* () {
      const nested = yield* nestedGitEntries(co.worktree);
      if (nested.length === 0) return;
      const listed = (kind: NestedEntry["kind"]) =>
        nested
          .filter((entry) => entry.kind === kind)
          .map((entry) => entry.path || ".")
          .join(", ");
      const what = [
        ...(listed("git") === "" ? [] : [`a git repository inside it (${listed("git")})`]),
        ...(listed("unreadable") === ""
          ? []
          : [`a folder prkit can't look inside (${listed("unreadable")}), which could hide one`]),
        ...(listed("changed") === ""
          ? []
          : [
              `a folder that changed while prkit looked through it (${listed("changed")}), so something may still be working there`,
            ]),
      ].join(" and ");
      return yield* new GitTampered({
        worktree: co.worktree,
        message: `prkit stopped and needs you: the checkout has ${what}. prkit's own git would read a repository there outside the agent's sandbox, so nothing was committed. Retry to start from a fresh checkout; if it comes back, the pull request's own code makes it.`,
      });
    });

  const identityEnv = (identity: CommitIdentity) => ({
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  const lines = (text: string) => text.split("\n").filter((line) => line !== "");

  /** The files git left conflicted, each with what kind of conflict it is. */
  const conflictedFiles = (co: Checkout) =>
    Effect.gen(function* () {
      const listed = yield* git(["ls-files", "-u", "-z"], { target: wt(co) });
      const stages = new Map<string, Set<string>>();
      for (const entry of listed.split("\0").filter((item) => item !== "")) {
        const tab = entry.indexOf("\t");
        const stage = entry.slice(0, tab).split(" ")[2] ?? "";
        const file = entry.slice(tab + 1);
        stages.set(file, (stages.get(file) ?? new Set()).add(stage));
      }
      return yield* Effect.forEach([...stages], ([file, present]) =>
        Effect.gen(function* () {
          if (!present.has("2") || !present.has("3"))
            return { path: file, kind: "deleted" } as const;
          const bytes = yield* fs
            .readFile(path.join(co.worktree, file))
            .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(new Uint8Array())));
          return {
            path: file,
            kind: bytes.subarray(0, 8000).includes(0) ? "binary" : "text",
          } as const;
        }),
      );
    });

  /** Merges the base into the head in the fixer's checkout, without committing. */
  const mergeBase = (co: Checkout, baseSha: string, identity: CommitIdentity) =>
    Effect.gen(function* () {
      const result = yield* run(["merge", "--no-ff", "--no-commit", "--no-edit", baseSha], {
        target: wt(co),
        env: identityEnv(identity),
      });
      const merging =
        (yield* run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { target: wt(co) })).code === 0;
      if (result.code === 0)
        return merging ? ({ _tag: "clean" } as const) : ({ _tag: "up-to-date" } as const);
      const files = yield* conflictedFiles(co);
      if (files.length > 0) return { _tag: "conflicts", files } as const;
      yield* Effect.logWarning("git merge failed").pipe(
        Effect.annotateLogs({ stderr: result.stderr.trim() }),
      );
      return yield* new RepoError({
        reason: "repository",
        message: "git couldn't merge the base branch into the pull request's branch.",
      });
    });

  /**
   * Rebase results: replayed everything, or stopped on a commit that conflicts.
   * The exit code says which; git can leave `REBASE_HEAD` behind after it finishes.
   */
  const rebaseStep = (co: Checkout, result: { readonly code: number; readonly stderr: string }) =>
    Effect.gen(function* () {
      if (result.code === 0) {
        const head = (yield* git(["rev-parse", "HEAD"], { target: wt(co) })).trim();
        return { _tag: "done", head } as const;
      }
      const files = yield* conflictedFiles(co);
      if (files.length === 0) {
        yield* Effect.logWarning("git rebase failed").pipe(
          Effect.annotateLogs({ stderr: result.stderr.trim() }),
        );
        return yield* new RepoError({
          reason: "repository",
          message: "git couldn't replay the pull request's commits onto the base branch.",
        });
      }
      const [sha = "", subject = ""] = (yield* git(
        ["log", "-1", "--format=%H%x1f%s", "REBASE_HEAD"],
        { target: wt(co) },
      ))
        .trim()
        .split("\x1f");
      // What `rebaseContinue` compares, so the rest of the rebase is exactly what git planned.
      const plan = yield* rebaseStateHash(co.gitDir);
      if (plan === null) {
        yield* dropRebase(co);
        return yield* new GitTampered({ worktree: co.worktree, message: REBASE_UNREADABLE });
      }
      return { _tag: "stopped", commit: { sha, subject }, files, plan } as const;
    });

  /**
   * Replays the PR's commits onto the base; may stop on a conflicting commit. The todo is
   * git's own: no sequence editor runs and no `fixup!` commit moves.
   */
  const rebaseOnto = (
    co: Checkout,
    input: {
      readonly baseSha: string;
      readonly mergeBaseSha: string;
      readonly identity: CommitIdentity;
    },
  ) =>
    run(["rebase", "--no-autosquash", "--onto", input.baseSha, input.mergeBaseSha], {
      target: wt(co),
      env: { ...identityEnv(input.identity), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    }).pipe(Effect.flatMap((result) => rebaseStep(co, result)));

  /**
   * Fails when the staged tree holds a symlink or gitlink that none of `sources` holds the
   * same way: a link the agent made or changed could point anywhere on the owner's machine
   * once the branch is checked out, and a submodule makes git read another repository.
   * `--ignore-submodules=none` beats a pull request's `.gitmodules`, whose `ignore = all`
   * would hide a changed gitlink; with `--cached` git looks inside no submodule.
   */
  const refuseNewLinks = (co: Checkout, sources: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const links = newLinks(
        yield* Effect.forEach(sources, (source) =>
          git(
            ["diff", "--cached", "--raw", "--no-renames", "-z", "--ignore-submodules=none", source],
            { target: wt(co) },
          ),
        ),
      );
      if (links.length > 0)
        return yield* new LinkRefused({
          paths: links.map((link) => link.path),
          message: linksRefusal(links),
        });
    });

  /**
   * Stages the resolved files and lets the rebase go on to the next commit, unless git's
   * rebase state no longer has the hash `plan` recorded at the stop or the checkout holds a
   * repository of its own. Either way the rebase is dropped without git reading its state
   * (`dropRebase`; the turn's reset puts the checkout back at the head).
   */
  const rebaseContinue = (co: Checkout, identity: CommitIdentity, plan: string) =>
    Effect.gen(function* () {
      const now = yield* rebaseStateHash(co.gitDir);
      if (now !== plan) {
        yield* dropRebase(co);
        return yield* new GitTampered({
          worktree: co.worktree,
          message:
            now === null
              ? REBASE_UNREADABLE
              : "prkit stopped and needs you: git's plan for the rest of the rebase changed under it, which could make git run a command outside the agent's sandbox. prkit dropped the rebase, and nothing was committed or pushed. Retry to start the rebase again; if it keeps happening, the pull request's own code is doing it.",
        });
      }
      yield* refuseNestedRepos(co).pipe(
        Effect.catchTag("GitTampered", (error) =>
          dropRebase(co).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
      yield* git(["add", "-A"], { target: wt(co) });
      yield* refuseNewLinks(co, ["HEAD", "REBASE_HEAD"]);
      const result = yield* run(["rebase", "--continue"], {
        target: wt(co),
        env: { ...identityEnv(identity), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
      });
      return yield* rebaseStep(co, result);
    });

  /**
   * Resolves conflicted files to the base branch's side: its content, or its
   * deletion. The base is "theirs" in a merge and "ours" in a rebase.
   */
  const takeBase = (co: Checkout, files: ReadonlyArray<string>, strategy: "merge" | "rebase") =>
    refuseNestedRepos(co).pipe(
      Effect.andThen(
        Effect.forEach(
          files,
          (file) =>
            Effect.gen(function* () {
              const side = strategy === "merge" ? "--theirs" : "--ours";
              const taken = yield* run(["checkout", side, "--", file], { target: wt(co) });
              if (taken.code !== 0)
                yield* git(["rm", "--quiet", "--ignore-unmatch", "--", file], { target: wt(co) });
            }),
          { discard: true },
        ),
      ),
    );

  /**
   * Conflict markers git's check reports in the checkout's changes, one line each, unless
   * the checkout holds a repository of its own. `--ignore-submodules=all` keeps git from
   * running `git status` inside a submodule's checkout to see whether it changed.
   */
  const diffCheck = (co: Checkout) =>
    refuseNestedRepos(co).pipe(
      Effect.andThen(run(["diff", "--check", "--ignore-submodules=all"], { target: wt(co) })),
      Effect.map((result) => lines(result.stdout).filter((line) => !line.startsWith("+"))),
    );

  /**
   * Commits everything in the checkout on top of `parents` and points the checkout
   * at it. Null when the tree is the first parent's, so nothing changed. Uses
   * commit-tree so no hook, editor or signing config can run. Refuses a checkout that
   * holds a repository of its own, and a symlink that `linksFrom` (the parents by
   * default) doesn't already hold.
   */
  const commitAll = (input: {
    readonly checkout: Checkout;
    readonly parents: ReadonlyArray<string>;
    readonly message: string;
    readonly identity: CommitIdentity;
    readonly linksFrom?: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const co = input.checkout;
      yield* refuseNestedRepos(co);
      yield* git(["add", "-A"], { target: wt(co) });
      yield* refuseNewLinks(co, input.linksFrom ?? input.parents);
      const tree = (yield* git(["write-tree"], { target: wt(co) })).trim();
      const [first = ""] = input.parents;
      const parentTree = (yield* git(["rev-parse", `${first}^{tree}`], { target: wt(co) })).trim();
      if (tree === parentTree && input.parents.length === 1) return null;
      const sha = (yield* git(
        ["commit-tree", tree, ...input.parents.flatMap((parent) => ["-p", parent])],
        { target: wt(co), input: `${input.message.trim()}\n`, env: identityEnv(input.identity) },
      )).trim();
      yield* run(["merge", "--quit"], { target: wt(co) });
      yield* git(["update-ref", "--no-deref", "HEAD", sha], { target: wt(co) });
      return sha;
    });

  /** Oldest first: the commits in `to` that `from` lacks. */
  const logBetween = (co: Checkout, from: string, to: string) =>
    git(["log", "--reverse", "--format=%H%x1f%s", `${from}..${to}`], { target: wt(co) }).pipe(
      Effect.map((text) =>
        lines(text).map((line) => {
          const [sha = "", subject = ""] = line.split("\x1f");
          return { sha, subject };
        }),
      ),
    );

  /** Puts files back as they are in `sha`, or deletes them when `sha` lacks them. */
  const checkoutFrom = (co: Checkout, sha: string, files: ReadonlyArray<string>) =>
    refuseNestedRepos(co).pipe(
      Effect.andThen(
        Effect.forEach(
          files,
          (file) =>
            Effect.gen(function* () {
              const taken = yield* run(["checkout", sha, "--", file], { target: wt(co) });
              if (taken.code !== 0)
                yield* git(["rm", "--quiet", "--ignore-unmatch", "--", file], { target: wt(co) });
            }),
          { discard: true },
        ),
      ),
    );

  const headOf = (co: Checkout) =>
    git(["rev-parse", "HEAD"], { target: wt(co) }).pipe(Effect.map((text) => text.trim()));

  const isAncestor = (co: Checkout, ancestor: string, of: string) =>
    run(["merge-base", "--is-ancestor", ancestor, of], { target: wt(co) }).pipe(
      Effect.map((result) => result.code === 0),
    );

  /** Undoes a merge commit's changes to the head with a new commit (`git revert -m 1`). */
  const revertMerge = (co: Checkout, sha: string, identity: CommitIdentity) =>
    git(["revert", "--no-commit", "-m", "1", sha], {
      target: wt(co),
      env: identityEnv(identity),
      failure: "git couldn't revert the merge on the current head. Revert it by hand.",
    });

  return {
    conflictedFiles,
    mergeBase,
    rebaseOnto,
    rebaseContinue,
    takeBase,
    diffCheck,
    commitAll,
    logBetween,
    checkoutFrom,
    headOf,
    isAncestor,
    revertMerge,
  };
};
