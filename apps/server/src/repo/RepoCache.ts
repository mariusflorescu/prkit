import {
  type AccountId,
  childEnv,
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
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Base64 } from "effect/encoding";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { makeKeyedGate } from "../github/keyedGate.ts";
import * as ServerConfig from "../config.ts";
import { foreignConfigKeys } from "./cacheConfig.ts";
import { isTreePath, parseBatch, parseTree, readableOids, textAt } from "./blobTexts.ts";
import { buildDiffSnapshot } from "./diffSnapshot.ts";
import { denied, fetchFailure } from "./fetchFailure.ts";
import {
  type Checkout,
  checkIntegrity,
  checkoutFor,
  cwdOf,
  type GitTarget,
  GitTampered,
  gitArgs,
  gitDirEnv,
  RepoError,
} from "./gitRun.ts";
import { linksRefusal, newLinks } from "./links.ts";
import { localCopyPath, makeLocalCapture } from "./localCapture.ts";
import { type NestedEntry, nestedGitEntries } from "./nestedRepos.ts";
import { rebaseStateHash } from "./rebaseState.ts";

export { type Checkout, GitTampered, RepoError } from "./gitRun.ts";

/** prkit committed nothing: the agent made or changed a symlink or submodule (docs/internals/fix-agent.md). */
export class LinkRefused extends Schema.TaggedError<LinkRefused>()("LinkRefused", {
  paths: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

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

const repoName = (ref: PullRequestRef) => `${ref.owner}/${ref.repo}`;
/** The only remote a cache has; the user's own config never rewrites it. */
const originUrl = (ref: PullRequestRef) => `https://${ref.host}/${ref.owner}/${ref.repo}.git`;
const diskFailure = (ref: PullRequestRef) =>
  new RepoError({
    reason: "repository",
    message: `Couldn't write prkit's copy of ${repoName(ref)}. Check the disk has space, then retry.`,
  });

/** Why a rebase stops when prkit can't read git's state for the rest of it (`rebaseStateHash`). */
const REBASE_UNREADABLE =
  "prkit stopped and needs you: it couldn't read git's plan for the rest of the rebase, so it can't tell whether something changed it. prkit dropped the rebase, and nothing was committed or pushed. Retry to start the rebase again.";

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

  /**
   * Every git command, prkit's and the agent's, runs with this. GIT_NO_LAZY_FETCH
   * makes a missing object an error instead of a fetch with no or the wrong identity.
   */
  const isolatedGitEnv = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
  const withRepository = makeKeyedGate<string>(1);
  const serialized =
    (repo: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withRepository(repo, effect);

  const bare = (repo: string): GitTarget => ({ _tag: "bare", repo });
  const wt = (checkout: Checkout): GitTarget => ({ _tag: "worktree", checkout });
  const plain: GitTarget = { _tag: "plain" };

  /**
   * Every git command runs with the safety flags prepended and GIT_DIR / GIT_COMMON_DIR /
   * GIT_WORK_TREE from the target, so a worktree's own `.git`, `commondir` or config can't
   * steer it (docs/internals/architecture.md "Repository access"). Integrity is a separate,
   * explicit check (`verifyCheckout`), so the command builder stays free of its error.
   */
  const runWith = <S>(
    args: ReadonlyArray<string>,
    options: {
      readonly target: GitTarget;
      readonly env?: Readonly<Record<string, string>>;
      readonly input?: string;
    },
    readStdout: (
      stdout: Stream.Stream<Uint8Array, PlatformError>,
    ) => Effect.Effect<S, PlatformError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = cwdOf(options.target);
        const child = yield* spawner.spawn(
          ChildProcess.make("git", gitArgs(args, options.target), {
            ...(cwd === undefined ? {} : { cwd }),
            env: childEnv(process.env, {
              ...isolatedGitEnv,
              ...gitDirEnv(options.target),
              ...options.env,
            }),
            extendEnv: false,
            stdin:
              options.input === undefined
                ? "ignore"
                : Stream.make(new TextEncoder().encode(options.input)),
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            readStdout(child.stdout),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code };
      }),
    ).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new RepoError({
            reason: "repository",
            message: "Couldn't run git. Install git and make sure it is on your PATH.",
          }),
        ),
      ),
    );
  const run = (args: ReadonlyArray<string>, options: Parameters<typeof runWith>[1]) =>
    runWith(args, options, (stdout) => stdout.pipe(Stream.decodeText(), Stream.mkString));
  /** For output that holds file bytes, which a string would mangle. */
  const runBytes = (args: ReadonlyArray<string>, options: Parameters<typeof runWith>[1]) =>
    runWith(args, options, Stream.mkUint8Array);
  const git = (
    args: ReadonlyArray<string>,
    options: Parameters<typeof run>[1] & { readonly failure?: string },
  ) =>
    run(args, options).pipe(
      Effect.flatMap((result) => {
        if (result.code === 0) return Effect.succeed(result.stdout);
        return Effect.logWarning("git failed").pipe(
          Effect.annotateLogs({ args: args.slice(0, 2).join(" "), stderr: result.stderr.trim() }),
          Effect.andThen(
            Effect.fail(
              new RepoError({
                reason: "repository",
                message: options.failure ?? "A git command failed while preparing the code.",
              }),
            ),
          ),
        );
      }),
    );

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

  /**
   * Refuses a fetch or push when the cache's config holds anything but prkit's own keys and
   * values (`cacheConfig.ts`): a planted `include.path`, `url.*.insteadOf` or filter could make
   * git run a program or send the account's token to another server. git reads the file
   * itself, without following includes, so a quirk of its syntax can't hide a key.
   */
  const refuseForeignConfig = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const listed = yield* git(
        ["config", "--file", path.join(repoPath(ref), "config"), "--no-includes", "--list", "-z"],
        {
          target: plain,
          failure: `Couldn't read the settings of prkit's copy of ${repoName(ref)}.`,
        },
      );
      const foreign = foreignConfigKeys(listed, originUrl(ref));
      if (foreign.length > 0)
        return yield* new RepoError({
          reason: "repository",
          message: `prkit stopped and needs you: prkit's copy of ${repoName(ref)} has git settings prkit didn't write (${foreign.slice(0, 5).join(", ")}), which could make git run a program or send your token to another server. Nothing was fetched or pushed. Delete ${repoPath(ref)} and retry, and prkit makes a fresh copy.`,
        });
    });

  /**
   * Network commands only, and only once the cache's config is prkit's own. The token travels
   * in the child's environment, never in argv, a config file or a URL. A refusal re-reads the
   * account's token once.
   */
  const authenticated = (
    accountId: AccountId,
    args: ReadonlyArray<string>,
    options: {
      readonly ref: PullRequestRef;
      readonly input?: string;
      readonly env?: Readonly<Record<string, string>>;
    },
  ) =>
    Effect.gen(function* () {
      yield* refuseForeignConfig(options.ref);
      const attempt = (reread: boolean) =>
        Effect.gen(function* () {
          const binding = yield* accounts.token(accountId, reread);
          const header = `Authorization: Basic ${Base64.encode(`x-access-token:${Redacted.value(binding.token)}`)}`;
          return {
            login: binding.account.login,
            result: yield* run(args, {
              target: bare(repoPath(options.ref)),
              env: {
                ...options.env,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.extraHeader",
                GIT_CONFIG_VALUE_0: header,
              },
              ...(options.input === undefined ? {} : { input: options.input }),
            }),
          };
        });
      const first = yield* attempt(false);
      return first.result.code !== 0 && denied(first.result.stderr) ? yield* attempt(true) : first;
    });

  const FETCH = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none"];

  /**
   * Refs are negotiated: the cache holds every commit and tree its refs reach. Objects
   * are fetched by id with no haves, as git's own lazy fetch does: the cache lacks most
   * blobs its commits reach, and a server told otherwise leaves out blobs asked for or
   * sends them as deltas against blobs the cache never had.
   */
  const fetch = (
    ref: PullRequestRef,
    accountId: AccountId,
    what: string,
    request:
      | { readonly refspecs: ReadonlyArray<string> }
      | { readonly objects: ReadonlyArray<string> },
  ) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("git fetch").pipe(
        Effect.annotateLogs({ accountId, repo: repoName(ref), what }),
      );
      const { login, result } = yield* "refspecs" in request
        ? authenticated(accountId, [...FETCH, "origin", ...request.refspecs], { ref })
        : authenticated(
            accountId,
            ["-c", "fetch.negotiationAlgorithm=noop", ...FETCH, "--stdin", "origin"],
            { ref, input: `${request.objects.join("\n")}\n` },
          );
      if (result.code === 0) return;
      const stderr = result.stderr.trim();
      yield* Effect.logWarning("git fetch failed").pipe(
        Effect.annotateLogs({ accountId, repo: repoName(ref), what, stderr }),
      );
      return yield* new RepoError(
        fetchFailure(stderr, {
          login,
          repo: repoName(ref),
          refspec: "refspecs" in request ? (request.refspecs.at(-1) ?? "") : "",
        }),
      );
    }).pipe(
      Effect.interruptible,
      Effect.timeout("2 minutes"),
      Effect.catchTag("TimeoutError", () =>
        Effect.logWarning("GitHub fetch reached its deadline").pipe(
          Effect.annotateLogs({ accountId, repo: repoName(ref), what, timeoutMs: 120_000 }),
          Effect.andThen(
            Effect.fail(
              new RepoError({
                reason: "repository",
                message: `GitHub took too long to fetch ${repoName(ref)}. Check your connection, then retry.`,
              }),
            ),
          ),
        ),
      ),
      Effect.catchTag("AccountUnavailableError", (error) =>
        Effect.fail(new RepoError({ reason: "account", message: error.message })),
      ),
    );

  const ensureCache = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const repo = repoPath(ref);
      yield* fs.makeDirectory(repo, { recursive: true });
      // Re-running init and config on an existing cache changes nothing.
      yield* git(["init", "--quiet", "--bare", repo], { target: plain });
      for (const [key, value] of [
        ["remote.origin.url", originUrl(ref)],
        ["remote.origin.promisor", "true"],
        ["remote.origin.partialclonefilter", "blob:none"],
      ] as const)
        yield* git(["config", key, value], { target: bare(repo) });
      return repo;
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

  /**
   * Fetches every object `rev-list --objects <args>` names that the blobless cache
   * lacks, in one request, so what runs next never needs the network.
   */
  const prefetch = (
    ref: PullRequestRef,
    accountId: AccountId,
    repo: string,
    [args, what]: readonly [ReadonlyArray<string>, string],
  ) =>
    Effect.gen(function* () {
      const listed = yield* git(["rev-list", "--objects", "--missing=print", ...args], {
        target: bare(repo),
      });
      const missing = listed
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1));
      if (missing.length > 0)
        yield* fetch(ref, accountId, `${missing.length} blobs of the ${what}`, {
          objects: missing,
        });
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
  const identityEnv = (identity: CommitIdentity) => ({
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  const lines = (text: string) => text.split("\n").filter((line) => line !== "");

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
   * Ensures the fixer's checkout exists at `sha` with the git dir prkit expects, rebuilding
   * it if the metadata drifted (the same recovery as `ensureWorktree`), and returns its
   * layout. Used when a follow-up turn amends a ready result, so a drifted checkout is
   * rebuilt rather than treated as gone.
   */
  const ensureFixCheckout = (ref: PullRequestRef, fixerId: FixerId, sha: string) =>
    serialized(repoPath(ref))(ensureWorktree(repoPath(ref), fixerPath(fixerId), sha)).pipe(
      Effect.map((worktree) => checkoutFor(path, repoPath(ref), worktree)),
      Effect.catchTag("PlatformError", () => Effect.fail(diskFailure(ref))),
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

  /**
   * Pushes `sha` to the PR's branch, only if the branch is still at `expected`:
   * a normal push for new commits, a force-push with lease for a rebase. The branch
   * moving first is an answer, not an error; prkit never pushes over it.
   */
  const pushFix = (input: {
    readonly ref: PullRequestRef;
    readonly accountId: AccountId;
    /** `owner/repo` the head branch lives in. */
    readonly headRepo: string;
    readonly headRef: string;
    readonly sha: string;
    readonly expected: string;
    readonly lease: boolean;
  }) =>
    serialized(repoPath(input.ref))(
      Effect.gen(function* () {
        yield* ensureCache(input.ref);
        const url = `https://${input.ref.host}/${input.headRepo}.git`;
        const branch = `refs/heads/${input.headRef}`;
        const listed = yield* authenticated(input.accountId, ["ls-remote", url, branch], {
          ref: input.ref,
        });
        if (listed.result.code !== 0) {
          yield* Effect.logWarning("git ls-remote failed").pipe(
            Effect.annotateLogs({ repo: input.headRepo, stderr: listed.result.stderr.trim() }),
          );
          return yield* new RepoError({
            reason: denied(listed.result.stderr) ? "account" : "repository",
            message: `Couldn't read ${input.headRepo} on GitHub as ${listed.login}. Check your connection, then push again.`,
          });
        }
        const remote = listed.result.stdout.split("\t")[0]?.trim() || null;
        // An earlier push that prkit lost track of (a crash mid-push) already landed.
        if (remote === input.sha) return { _tag: "pushed" } as const;
        if (remote !== input.expected) return { _tag: "moved", remote } as const;
        yield* Effect.logInfo("git push").pipe(
          Effect.annotateLogs({
            accountId: input.accountId,
            repo: input.headRepo,
            branch: input.headRef,
            lease: input.lease,
          }),
        );
        const pushed = yield* authenticated(
          input.accountId,
          [
            "push",
            "--quiet",
            "--no-verify",
            ...(input.lease ? [`--force-with-lease=${branch}:${input.expected}`] : []),
            url,
            `${input.sha}:${branch}`,
          ],
          // A fork may lack base commits a merge brings; let git fetch their blobs.
          { ref: input.ref, env: { GIT_NO_LAZY_FETCH: "0" } },
        );
        if (pushed.result.code === 0) return { _tag: "pushed" } as const;
        const stderr = pushed.result.stderr.trim();
        yield* Effect.logWarning("git push failed").pipe(
          Effect.annotateLogs({ repo: input.headRepo, stderr }),
        );
        if (
          /non-fast-forward|stale info|fetch first|rejected/i.test(stderr) &&
          !/protected/i.test(stderr)
        )
          return { _tag: "moved", remote: null } as const;
        return yield* new RepoError({
          reason: denied(stderr) || /permission|403/i.test(stderr) ? "account" : "repository",
          message: /protected branch|GH006/i.test(stderr)
            ? `${input.headRepo} protects ${input.headRef}, so GitHub refused the push. Copy the patch instead.`
            : /permission|403/i.test(stderr)
              ? `GitHub refused ${pushed.login}'s push to ${input.headRepo}. Copy the patch instead.`
              : `GitHub refused the push to ${input.headRepo}: ${stderr.split("\n").at(-1) ?? "unknown error"}`,
        });
      }),
    ).pipe(
      Effect.timeout("2 minutes"),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new RepoError({
              reason: "repository",
              message:
                "GitHub took too long to take the push. Check your connection, then push again.",
            }),
          ),
        AccountUnavailableError: (error) =>
          Effect.fail(new RepoError({ reason: "account", message: error.message })),
        PlatformError: () => Effect.fail(diskFailure(input.ref)),
      }),
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
    ensureFixCheckout,
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
