import {
  type AccountId,
  type DiffSnapshot,
  type DiffTexts,
  type FixerId,
  type LocalReviewKey,
  type PullRequestRef,
  type ReviewId,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import * as ServerConfig from "../config.ts";
import { diskFailure, makeCacheRemote, repoName } from "./cacheRemote.ts";
import { isTreePath, parseBatch, parseTree, readableOids, textAt } from "./blobTexts.ts";
import { buildDiffSnapshot } from "./diffSnapshot.ts";
import { makeFixCheckout } from "./fixCheckout.ts";
import {
  type Checkout,
  checkIntegrity,
  checkoutFor,
  type GitTarget,
  makeGitRunner,
  RepoError,
} from "./gitRun.ts";
import { localCopyPath, makeLocalCapture } from "./localCapture.ts";
import { nestedGitEntries } from "./nestedRepos.ts";

export { type Checkout, GitTampered, RepoError } from "./gitRun.ts";
export { LinkRefused } from "./fixCheckout.ts";

/** How the fetched head relates to the previous revision's head. */
export type Since =
  /** There is no previous revision. */
  | { readonly _tag: "none" }
  | { readonly _tag: "same" }
  | {
      readonly _tag: "descends";
      /** Oldest first. */
      readonly commits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
      /** The diff from the previous head to the new one, per file, so ignore rules can filter it. */
      readonly snapshot: DiffSnapshot;
    }
  /** A force-push or rebase: the new head doesn't descend from the previous one. */
  | { readonly _tag: "rewritten" };

export interface Prepared {
  readonly worktree: string;
  /** The worktree's git-dir layout, for prkit's own later git steps in it. */
  readonly checkout: Checkout;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly snapshot: DiffSnapshot;
  readonly since: Since;
}

export interface PreparedFix {
  readonly worktree: string;
  readonly checkout: Checkout;
  readonly headSha: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
}

/** Where a review's objects live: its pull request's repository cache, or a local review's own copy. */
export type CacheRef =
  | { readonly _tag: "pull-request"; readonly ref: PullRequestRef }
  | { readonly _tag: "local"; readonly key: LocalReviewKey };

/** Who prkit's own commits are by: the PR's account. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export class RepoCache extends Context.Service<RepoCache, Effect.Success<typeof make>>()(
  "@prkit/server/repo/RepoCache",
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const accounts = yield* GitHubAccounts;
  const crypto = yield* Crypto.Crypto;
  const reposDir = path.join(config.home, "repos");
  const worktreesDir = path.join(config.home, "worktrees");
  const fixesDir = path.join(config.home, "fixes");
  const gitconfig = path.join(config.home, "gitconfig");
  yield* fs.makeDirectory(reposDir, { recursive: true });
  yield* fs.makeDirectory(worktreesDir, { recursive: true });
  yield* fs.makeDirectory(fixesDir, { recursive: true });
  // prkit's own global config: the user's insteadOf rules, credential helpers and pagers never
  // apply, and a pull request's symlink is checked out as a small file holding its target, so
  // nothing an agent reads or writes in a checkout can lead outside it.
  yield* fs.writeFileString(gitconfig, "[core]\n\tsymlinks = false\n");

  const { isolatedGitEnv, serialized, run, runBytes, git } = makeGitRunner({ spawner, gitconfig });

  const bare = (repo: string): GitTarget => ({ _tag: "bare", repo });
  const wt = (checkout: Checkout): GitTarget => ({ _tag: "worktree", checkout });

  const repoPath = (ref: PullRequestRef) =>
    path.join(reposDir, ref.host, ref.owner, `${ref.repo}.git`);
  const cachePath = (cache: CacheRef) =>
    cache._tag === "pull-request"
      ? repoPath(cache.ref)
      : localCopyPath(path, config.home, cache.key);
  const worktreePath = (reviewId: ReviewId) => path.join(worktreesDir, reviewId);

  /** A worktree as prkit lays it out, with its git dir and common dir computed, never read from it. */
  const checkout = (ref: PullRequestRef, worktree: string): Checkout =>
    checkoutFor(path, repoPath(ref), worktree);
  /** Refuses the next git step when an agent changed the checkout's git metadata under prkit. */
  const verifyCheckout = (co: Checkout) => checkIntegrity(fs, path, co);

  const { ensureCache, fetch, prefetch, pushFix } = makeCacheRemote({
    fs,
    path,
    accounts,
    run,
    git,
    serialized,
    repoPath,
  });

  /** The links a checkout holds as real ones, which only a checkout from before core.symlinks=false has. */
  const realLinks = (co: Checkout) =>
    Effect.gen(function* () {
      const links = (yield* git(["ls-files", "-s", "-z"], { target: wt(co) }))
        .split("\0")
        .filter((entry) => entry.startsWith("120000 "))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));
      const real = yield* Effect.forEach(links, (file) =>
        fs.readLink(path.join(co.worktree, file)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      );
      return links.filter((_, index) => real[index]);
    });

  /**
   * Drops a rebase in progress by removing git's state for it, so git never reads what an
   * agent could have changed there (prkit's checkouts are always detached, so nothing else
   * needs restoring). The checkout's own reset follows.
   */
  const dropRebase = (co: Checkout) =>
    Effect.forEach(
      ["rebase-merge", "rebase-apply"],
      (name) => fs.remove(path.join(co.gitDir, name), { recursive: true, force: true }),
      { discard: true },
    );

  const ensureWorktree = (repo: string, worktree: string, headSha: string) =>
    Effect.gen(function* () {
      const co = checkoutFor(path, repo, worktree);
      const reset = Effect.gen(function* () {
        // A conflict resolution an earlier turn left mid-merge or mid-rebase is dropped first.
        yield* run(["merge", "--abort"], { target: wt(co) });
        yield* dropRebase(co);
        yield* git(["checkout", "--quiet", "--detach", "--force", headSha], { target: wt(co) });
        yield* git(["clean", "--quiet", "-ffdx"], { target: wt(co) });
      });
      const existing = yield* fs.exists(path.join(worktree, ".git"));
      if (existing) {
        // A checkout an agent left with changed git metadata, still holding real links, or
        // with a repository inside it, is made again from scratch instead of trusted or reset
        // in place: `clean` leaves a repository at a submodule's path.
        const intact = yield* checkIntegrity(fs, path, co).pipe(
          Effect.as(true),
          Effect.catchTag("GitTampered", () => Effect.succeed(false)),
        );
        if (intact) {
          const healthy = yield* reset.pipe(
            Effect.andThen(Effect.all([realLinks(co), nestedGitEntries(worktree)])),
            Effect.map(([links, nested]) => links.length === 0 && nested.length === 0),
            Effect.catchTag("RepoError", () => Effect.succeed(false)),
          );
          if (healthy) return worktree;
        }
      }
      yield* fs.remove(worktree, { recursive: true, force: true });
      yield* git(["worktree", "prune"], { target: bare(repo) });
      yield* git(["worktree", "add", "--quiet", "--detach", "--force", worktree, headSha], {
        target: bare(repo),
        failure: "Couldn't check out the pull request's code.",
      });
      return worktree;
    });

  const DIFF = ["diff", "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv"];

  const snapshotOf = (
    target: GitTarget,
    mergeBaseSha: string,
    headSha: string,
    paths: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      // Flags first: after `--`, git reads every word as a path.
      const range = [mergeBaseSha, headSha, ...(paths.length > 0 ? ["--", ...paths] : [])];
      const failure = "Couldn't read the pull request's diff.";
      const [raw, numstat, patch] = yield* Effect.all(
        [
          // Full blob ids: a stored version has to match what GitHub's files API calls `sha`.
          git([...DIFF, "-z", "--raw", "--no-abbrev", ...range], { target, failure }),
          git([...DIFF, "-z", "--numstat", ...range], { target, failure }),
          git([...DIFF, "--patch", ...range], { target, failure }),
        ],
        { concurrency: 3 },
      );
      const built = buildDiffSnapshot({ raw, numstat, patch });
      if (built._tag === "error") {
        yield* Effect.logWarning("Couldn't parse the diff").pipe(
          Effect.annotateLogs({ problem: built.message }),
        );
        return yield* new RepoError({ reason: "repository", message: failure });
      }
      return built.snapshot;
    });

  /** Ancestry only; the commits and patch are read once the previous head's blobs are local. */
  const relation = (repo: string, previousHead: string | null, headSha: string) =>
    Effect.gen(function* () {
      if (previousHead === null) return { _tag: "none" } as const;
      if (previousHead === headSha) return { _tag: "same" } as const;
      // A cache rebuilt since the revision no longer has its head; write the guide fresh.
      const known = yield* run(["cat-file", "-e", `${previousHead}^{commit}`], {
        target: bare(repo),
      });
      if (known.code !== 0) return { _tag: "rewritten" } as const;
      const ancestor = yield* run(["merge-base", "--is-ancestor", previousHead, headSha], {
        target: bare(repo),
      });
      if (ancestor.code === 0) return { _tag: "descends", from: previousHead } as const;
      if (ancestor.code === 1) return { _tag: "rewritten" } as const;
      return yield* new RepoError({
        reason: "repository",
        message: "Couldn't compare the pull request with the last guide's commit.",
      });
    });

  const commitsSince = (repo: string, from: string, headSha: string) =>
    Effect.gen(function* () {
      const failure = "Couldn't read the commits since the last guide.";
      const log = yield* git(["log", "--reverse", "--format=%H%x1f%s", `${from}..${headSha}`], {
        target: bare(repo),
        failure,
      });
      const snapshot = yield* snapshotOf(bare(repo), from, headSha);
      const commits = log
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [sha = "", subject = ""] = line.split("\x1f");
          return { sha, subject };
        });
      return { _tag: "descends", commits, snapshot } satisfies Since;
    });

  /**
   * Fetches the PR head and base branch into the review account's cache, prefetches
   * every blob of the head and merge-base trees (and of the previous revision's head
   * when the new head descends from it), and resets the review's worktree to the head.
   * The head is whatever GitHub serves now; if it moved past what the attempt read,
   * the watcher's next tick picks that up.
   */
  const prepare = (input: {
    readonly reviewId: ReviewId;
    readonly ref: PullRequestRef;
    readonly accountId: AccountId;
    readonly baseRef: string;
    /** The last accepted revision's head, for `since`. */
    readonly previousHead: string | null;
  }) => {
    const { ref, accountId } = input;
    const headRef = `refs/prkit/pulls/${ref.number}/head`;
    const baseRef = `refs/prkit/pulls/${ref.number}/base`;
    return serialized(repoPath(ref))(
      Effect.gen(function* () {
        const repo = yield* ensureCache(ref);
        yield* fetch(ref, accountId, `pull ${ref.number} head and ${input.baseRef}`, {
          refspecs: [
            `+refs/pull/${ref.number}/head:${headRef}`,
            `+refs/heads/${input.baseRef}:${baseRef}`,
          ],
        });
        const headSha = (yield* git(["rev-parse", headRef], { target: bare(repo) })).trim();
        const baseSha = (yield* git(["rev-parse", baseRef], { target: bare(repo) })).trim();
        const mergeBaseSha = (yield* git(["merge-base", headSha, baseSha], {
          target: bare(repo),
          failure: "The pull request's branch shares no history with its base branch.",
        })).trim();
        const related = yield* relation(repo, input.previousHead, headSha);
        const trees =
          related._tag === "descends"
            ? [headSha, mergeBaseSha, related.from]
            : [headSha, mergeBaseSha];
        yield* prefetch(ref, accountId, repo, [
          ["--no-walk", ...trees],
          `${trees.length} trees the agent reads`,
        ]);
        const worktree = yield* ensureWorktree(repo, worktreePath(input.reviewId), headSha);
        const snapshot = yield* snapshotOf(bare(repo), mergeBaseSha, headSha);
        const since: Since =
          related._tag === "descends" ? yield* commitsSince(repo, related.from, headSha) : related;
        return {
          worktree,
          checkout: checkoutFor(path, repo, worktree),
          headSha,
          baseSha,
          mergeBaseSha,
          snapshot,
          since,
        } satisfies Prepared;
      }),
    ).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new RepoError({
            reason: "repository",
            message: `Couldn't write prkit's copy of ${repoName(ref)}. Check the disk has space, then retry.`,
          }),
        ),
      ),
    );
  };

  /** Keeps an accepted revision's head reachable so git never collects it. */
  const keepRevision = (cache: CacheRef, reviewId: ReviewId, revision: number, headSha: string) =>
    serialized(cachePath(cache))(
      git(["update-ref", `refs/prkit/${reviewId}/r${revision}`, headSha], {
        target: bare(cachePath(cache)),
      }),
    ).pipe(Effect.asVoid);

  /**
   * Removes a worktree's folder and prunes its now-stale entry from the cache. The cache
   * is prkit's own (`cachePath(cache)`), never read from the worktree's `.git`; a caller that
   * has no record of the review (`cache` null) just drops the folder, and the next
   * `ensureWorktree` on that cache prunes the stale entry.
   */
  const removeWorktree = (reviewId: ReviewId, cache: CacheRef | null) =>
    Effect.gen(function* () {
      const worktree = worktreePath(reviewId);
      if (!(yield* fs.exists(worktree))) return false;
      const repo = cache === null ? null : cachePath(cache);
      const remove = Effect.gen(function* () {
        yield* fs.remove(worktree, { recursive: true, force: true });
        if (repo !== null && (yield* fs.exists(repo)))
          yield* git(["worktree", "prune"], { target: bare(repo) }).pipe(
            Effect.catchTag("RepoError", () => Effect.void),
          );
      });
      yield* repo === null ? remove : serialized(repo)(remove);
      yield* Effect.logInfo("Removed worktree").pipe(Effect.annotateLogs({ reviewId }));
      return true;
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new RepoError({
            reason: "repository",
            message: "Couldn't remove the review's checkout.",
          }),
        ),
      ),
    );

  const listWorktrees = () =>
    fs.readDirectory(worktreesDir).pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));

  // Each fixer owns one writable checkout under `fixes/`, apart from the review worktrees,
  // so neither cleanup removes the other's (docs/internals/fix-agent.md "The checkout").
  const fixerPath = (fixerId: FixerId) => path.join(fixesDir, fixerId);

  /**
   * Fetches the PR's head and base, prefetches every blob the turn reads or
   * writes offline (the head tree; for a merge also the base and merge-base trees;
   * for a rebase also every PR commit), and resets the fixer's checkout to the head.
   */
  const prepareFix = (input: {
    readonly fixerId: FixerId;
    readonly ref: PullRequestRef;
    readonly accountId: AccountId;
    readonly baseRef: string;
    readonly needs: "head" | "merge" | "rebase";
    /** More commits whose trees the turn reads, such as a merge it reverts. */
    readonly also?: ReadonlyArray<string>;
  }) => {
    const { ref, accountId } = input;
    const headRef = `refs/prkit/pulls/${ref.number}/head`;
    const baseRef = `refs/prkit/pulls/${ref.number}/base`;
    return serialized(repoPath(ref))(
      Effect.gen(function* () {
        const repo = yield* ensureCache(ref);
        yield* fetch(ref, accountId, `pull ${ref.number} head and ${input.baseRef} for a fix`, {
          refspecs: [
            `+refs/pull/${ref.number}/head:${headRef}`,
            `+refs/heads/${input.baseRef}:${baseRef}`,
          ],
        });
        const headSha = (yield* git(["rev-parse", headRef], { target: bare(repo) })).trim();
        const baseSha = (yield* git(["rev-parse", baseRef], { target: bare(repo) })).trim();
        const mergeBaseSha = (yield* git(["merge-base", headSha, baseSha], {
          target: bare(repo),
          failure: "The pull request's branch shares no history with its base branch.",
        })).trim();
        const trees = [
          ...(input.needs === "head" ? [headSha] : [headSha, baseSha, mergeBaseSha]),
          ...(input.also ?? []),
        ];
        yield* prefetch(ref, accountId, repo, [["--no-walk", ...trees], "trees the fix reads"]);
        if (input.needs === "rebase")
          yield* prefetch(ref, accountId, repo, [
            [headSha, `^${mergeBaseSha}`],
            "commits the rebase replays",
          ]);
        const worktree = yield* ensureWorktree(repo, fixerPath(input.fixerId), headSha);
        return {
          worktree,
          checkout: checkoutFor(path, repo, worktree),
          headSha,
          baseSha,
          mergeBaseSha,
        } satisfies PreparedFix;
      }),
    ).pipe(Effect.catchTag("PlatformError", () => Effect.fail(diskFailure(ref))));
  };

  const {
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
  } = makeFixCheckout({ fs, path, run, git, dropRebase });

  /** The diff between two commits, optionally limited to some paths, for the Fixes panel. */
  const diffBetween = (co: Checkout, from: string, to: string, paths: ReadonlyArray<string> = []) =>
    snapshotOf(wt(co), from, to, paths);

  /**
   * A patch the owner can apply by hand: `git am` for commits (`from..sha`), or
   * `git apply` for what a merge changes on the head.
   */
  const patchOf = (
    co: Checkout,
    input: { readonly sha: string; readonly from: string; readonly merge: boolean },
  ) =>
    input.merge
      ? git([...DIFF, "--binary", input.from, input.sha], { target: wt(co) })
      : git(["format-patch", "--stdout", "--binary", `${input.from}..${input.sha}`], {
          target: wt(co),
        });

  /**
   * Points the checkout back at `sha` and drops everything else, a merge in progress
   * included. The next turn's `ensureWorktree` rebuilds the checkout if an agent left
   * its git metadata changed; here the explicit git dir keeps the reset itself safe.
   */
  const resetFix = (ref: PullRequestRef, fixerId: FixerId, sha: string) =>
    Effect.gen(function* () {
      const co = checkout(ref, fixerPath(fixerId));
      if (!(yield* fs.exists(path.join(co.worktree, ".git")))) return;
      yield* run(["merge", "--abort"], { target: wt(co) });
      yield* dropRebase(co);
      yield* git(["checkout", "--quiet", "--detach", "--force", sha], { target: wt(co) });
      yield* git(["clean", "--quiet", "-ffdx"], { target: wt(co) });
    });

  /**
   * Ensures a detached checkout of `sha` at `dir` with the git dir prkit expects, rebuilding
   * it if the metadata drifted (the same recovery as `ensureWorktree`), and returns its
   * layout. Offline: it needs only commits and blobs the cache already holds. git names the
   * checkout's git dir after `dir`'s last part, so no two checkouts of one repository may
   * share it.
   */
  const ensureCheckout = (cache: CacheRef, dir: string, sha: string) =>
    serialized(cachePath(cache))(ensureWorktree(cachePath(cache), dir, sha)).pipe(
      Effect.map((worktree) => checkoutFor(path, cachePath(cache), worktree)),
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          cache._tag === "pull-request"
            ? diskFailure(cache.ref)
            : new RepoError({
                reason: "repository",
                message:
                  "Couldn't write prkit's copy of your local changes. Check the disk has space, then retry.",
              }),
        ),
      ),
    );

  /** Keeps a ready commit reachable until it is pushed or discarded. */
  const holdCommit = (ref: PullRequestRef, name: string, sha: string | null) =>
    serialized(repoPath(ref))(
      sha === null
        ? run(["update-ref", "-d", `refs/prkit/fixes/${name}`], {
            target: bare(repoPath(ref)),
          }).pipe(Effect.asVoid)
        : git(["update-ref", `refs/prkit/fixes/${name}`, sha], {
            target: bare(repoPath(ref)),
          }).pipe(Effect.asVoid),
    );

  /** Like `removeWorktree`, for a fixer's checkout; the cache comes from `ref`, not the checkout. */
  const removeFixer = (fixerId: FixerId, ref: PullRequestRef | null) =>
    Effect.gen(function* () {
      const worktree = fixerPath(fixerId);
      if (!(yield* fs.exists(worktree))) return false;
      const repo = ref === null ? null : repoPath(ref);
      const remove = Effect.gen(function* () {
        yield* fs.remove(worktree, { recursive: true, force: true });
        if (repo !== null && (yield* fs.exists(repo)))
          yield* git(["worktree", "prune"], { target: bare(repo) }).pipe(
            Effect.catchTag("RepoError", () => Effect.void),
          );
      });
      yield* repo === null ? remove : serialized(repo)(remove);
      yield* Effect.logInfo("Removed fixer worktree").pipe(Effect.annotateLogs({ fixerId }));
      return true;
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new RepoError({ reason: "repository", message: "Couldn't remove the fixer's checkout." }),
        ),
      ),
    );

  const listFixers = () =>
    fs.readDirectory(fixesDir).pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));

  /** The bytes of each blob, null for one the cache lacks, from one `git cat-file --batch` run. */
  const readBlobs = (target: GitTarget, oids: ReadonlyArray<string>, failure: string) =>
    Effect.gen(function* () {
      if (oids.length === 0) return new Map<string, Uint8Array | null>();
      const batch = yield* runBytes(["cat-file", "--batch"], {
        target,
        input: `${oids.join("\n")}\n`,
      });
      const blobs = batch.code === 0 ? parseBatch(batch.stdout, oids) : null;
      if (blobs === null) {
        yield* Effect.logWarning("git cat-file failed").pipe(
          Effect.annotateLogs({ stderr: batch.stderr.trim() }),
        );
        return yield* new RepoError({ reason: "repository", message: failure });
      }
      return blobs;
    });

  /**
   * The new side of each path at a commit, from prkit's copy alone: GIT_NO_LAZY_FETCH stays on,
   * so a blob the cache lacks reads as missing. `git ls-tree` names each blob and its size, so a
   * file over the cap is never read; the rest come back from one `git cat-file --batch` run. It
   * takes no repository gate: reading objects is safe beside a fetch.
   */
  const textsAt = (target: GitTarget, sha: string, paths: ReadonlyArray<string>, failure: string) =>
    Effect.gen(function* () {
      const asked = paths.filter(isTreePath);
      const listing =
        asked.length === 0
          ? ""
          : // Literal, so a path that looks like pathspec magic (`:(icase)`) is just a name.
            yield* git(["ls-tree", "-z", "-l", sha, "--", ...asked], {
              target,
              env: { GIT_LITERAL_PATHSPECS: "1" },
              failure,
            });
      const tree = parseTree(listing);
      const oids = [...readableOids(tree.values())];
      const blobs = yield* readBlobs(target, oids, failure);
      return {
        files: paths.map((path) => ({ path, text: textAt(tree.get(path), blobs) })),
      } satisfies DiffTexts;
    });
  const readTexts = (ref: PullRequestRef, sha: string, paths: ReadonlyArray<string>) =>
    textsAt(
      bare(repoPath(ref)),
      sha,
      paths,
      `prkit couldn't read this commit from its copy of ${repoName(ref)}.`,
    );

  /** Guides of local changes: snapshots of the user's own repository, in copies prkit owns. */
  const local = makeLocalCapture({
    fs,
    path,
    crypto,
    home: config.home,
    run,
    git,
    serialized,
    ensureWorktree,
    snapshotOf: (repo, from, to) => snapshotOf(bare(repo), from, to),
    readTexts: (repo, sha, paths, failure) => textsAt(bare(repo), sha, paths, failure),
    relation,
    commitsSince,
    worktreePath,
  });

  return {
    isolatedGitEnv,
    checkout,
    verifyCheckout,
    prepare,
    keepRevision,
    removeWorktree,
    listWorktrees,
    worktreePath,
    fixerPath,
    prepareFix,
    ensureCheckout,
    mergeBase,
    rebaseOnto,
    rebaseContinue,
    conflictedFiles,
    takeBase,
    diffCheck,
    commitAll,
    revertMerge,
    logBetween,
    checkoutFrom,
    headOf,
    isAncestor,
    diffBetween,
    patchOf,
    resetFix,
    holdCommit,
    pushFix,
    removeFixer,
    listFixers,
    readTexts,
    local,
  };
});

export const layer = Layer.effect(RepoCache, make);
