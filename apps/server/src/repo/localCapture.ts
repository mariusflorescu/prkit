import {
  type DiffSnapshot,
  type DiffTexts,
  LocalHead,
  LocalLeftOut,
  LocalReviewKey,
  type ReviewId,
} from "@prkit/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Hex } from "effect/encoding";

import {
  checkoutFor,
  gitErrorLine,
  type GitTarget,
  RepoError,
  type UserRepository,
} from "./gitRun.ts";
import { lines, makeWorkingTree } from "./localWorkingTree.ts";
import type { Prepared, Since } from "./RepoCache.ts";

/** One bare repository per local review, holding only what prkit copied or hashed for it. */
export const localCopyPath = (path: Path.Path, home: string, key: LocalReviewKey) =>
  path.join(home, "local", `${key.slice("local:".length)}.git`);

const Commit = Schema.Struct({ sha: Schema.String, subject: Schema.String });

/**
 * What one run took. Two commits in prkit's copy carry it: B, the merge-base tree with no
 * parent, and H, the reviewed tree. Both have a fixed author, date and message, so the same
 * trees and parent always give the same ids, and B depends on its tree alone.
 */
export const LocalCapture = Schema.Struct({
  /** H: what the guide agent checks out. */
  headSha: Schema.String,
  /** B: an ancestor of H, so `git diff B...HEAD` works in the checkout. */
  mergeBaseSha: Schema.String,
  headTree: Schema.String,
  baseTree: Schema.String,
  /** The base as resolved: what was asked for, or the first default that exists. */
  baseRef: Schema.String,
  /** The user's merge-base commit. */
  baseSha: Schema.String,
  /** The user's head commit when prkit read it. */
  userHead: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: LocalHead,
  /** merge-base..head in the user's repository, oldest first, the newest MAX_LISTED_COMMITS. */
  commits: Schema.Array(Commit),
  commitCount: Schema.Int,
  /** The user's commits since the previous capture's head; null without one or after a rewrite. */
  newCommits: Schema.NullOr(Schema.Array(Commit)),
  /** The working tree differs from the head commit; always false for the branch head. */
  uncommitted: Schema.Boolean,
  leftOut: Schema.Array(LocalLeftOut),
  description: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
export type LocalCapture = typeof LocalCapture.Type;

export class LocalCaptureError extends Schema.TaggedError<LocalCaptureError>()(
  "LocalCaptureError",
  {
    reason: Schema.Literals([
      "not-a-repository",
      "bare-repository",
      "not-owned",
      "prkit-checkout",
      "sparse-checkout",
      "no-commits",
      "branch-not-found",
      "base-not-found",
      "no-shared-history",
      "nothing-changed",
      "missing-objects",
      "too-large",
      "moved",
      "repository-changed",
    ]),
    message: Schema.String,
  },
) {}

export const MAX_LISTED_COMMITS = 200;

/** The user's repository as identify found it. */
export interface LocalIdentity {
  readonly key: LocalReviewKey;
  /** The work tree's top level, its real path. */
  readonly path: string;
  /** The top level's folder name. */
  readonly name: string;
  readonly gitDir: string;
  readonly commonDir: string;
  /** The branch the review is about; null for a detached HEAD. */
  readonly branch: string | null;
  readonly objectFormat: "sha1" | "sha256";
}

interface GitOptions {
  readonly target: GitTarget;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

/** RepoCache's own git machinery, so prkit keeps one command builder and one gate per repository. */
export interface LocalCaptureDeps {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly home: string;
  readonly run: (
    args: ReadonlyArray<string>,
    options: GitOptions,
  ) => Effect.Effect<
    { readonly stdout: string; readonly stderr: string; readonly code: number },
    RepoError
  >;
  readonly git: (
    args: ReadonlyArray<string>,
    options: GitOptions & { readonly failure?: string },
  ) => Effect.Effect<string, RepoError>;
  readonly serialized: (
    repo: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly ensureWorktree: (
    repo: string,
    worktree: string,
    headSha: string,
  ) => Effect.Effect<string, RepoError | PlatformError>;
  readonly snapshotOf: (
    repo: string,
    from: string,
    to: string,
  ) => Effect.Effect<DiffSnapshot, RepoError>;
  readonly relation: (
    repo: string,
    previousHead: string | null,
    headSha: string,
  ) => Effect.Effect<
    | Exclude<Since, { readonly _tag: "descends" }>
    | { readonly _tag: "descends"; readonly from: string },
    RepoError
  >;
  readonly commitsSince: (
    repo: string,
    from: string,
    headSha: string,
  ) => Effect.Effect<Since, RepoError>;
  readonly worktreePath: (reviewId: ReviewId) => string;
  readonly readTexts: (
    repo: string,
    sha: string,
    paths: ReadonlyArray<string>,
    failure: string,
  ) => Effect.Effect<DiffTexts, RepoError>;
}

/** prkit's commits in a copy: the same trees and parents always give the same ids. */
const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: "prkit",
  GIT_AUTHOR_EMAIL: "prkit@localhost",
  GIT_AUTHOR_DATE: "946684800 +0000",
  GIT_COMMITTER_NAME: "prkit",
  GIT_COMMITTER_EMAIL: "prkit@localhost",
  GIT_COMMITTER_DATE: "946684800 +0000",
};

const parseCommits = (text: string) =>
  lines(text).map((line) => {
    const [sha = "", subject = ""] = line.split("\x1f");
    return { sha, subject };
  });

const onWhat = (branch: string | null) => (branch === null ? "a detached HEAD" : `\`${branch}\``);

export const makeLocalCapture = (deps: LocalCaptureDeps) => {
  const { fs, path, run, git } = deps;
  const localDir = path.join(deps.home, "local");
  const plain: GitTarget = { _tag: "plain" };
  const bare = (repo: string): GitTarget => ({ _tag: "bare", repo });

  const copyOf = (key: LocalReviewKey) => localCopyPath(path, deps.home, key);
  /** Capture, prepare and forget of one key run one at a time, with keepRevision on its copy. */
  const gated = (key: LocalReviewKey) => deps.serialized(copyOf(key));

  const refuse = (reason: LocalCaptureError["reason"], message: string) =>
    Effect.fail(new LocalCaptureError({ reason, message }));
  const diskFailure = new RepoError({
    reason: "repository",
    message:
      "Couldn't write prkit's copy of your changes. Check the disk has space, then run again.",
  });
  /** A copy step that read the user's objects failed; a partial clone lacking one is the likely cause. */
  const missingOr = (stderr: string, failure: string) =>
    /missing|unable to read|could not read|not a valid|bad object|promisor|lazy fetch/i.test(stderr)
      ? refuse(
          "missing-objects",
          "Some of this repository's objects aren't on this Mac. Run `git fetch` there, then run prkit again.",
        )
      : Effect.logWarning("git failed").pipe(
          Effect.annotateLogs({ error: gitErrorLine(stderr) }),
          Effect.andThen(Effect.fail(new RepoError({ reason: "repository", message: failure }))),
        );

  const hex16 = (text: string) =>
    deps.crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
      Effect.map((bytes) => Hex.encode(bytes).slice(0, 16)),
      Effect.orDie,
    );

  /**
   * Finds the repository `where` is in, by discovery from that folder: the only step that reads
   * the user's repository without every dir pinned. Reads only.
   */
  const identify = (where: string, branch?: string) =>
    Effect.gen(function* () {
      const notRepository = refuse(
        "not-a-repository",
        `\`${where}\` isn't inside a git repository.`,
      );
      const notOwned = refuse("not-owned", "prkit only reads repositories you own.");
      if (!path.isAbsolute(where)) return yield* notRepository;
      const at = (args: ReadonlyArray<string>) => run(["-C", where, ...args], { target: plain });

      const kind = yield* at(["rev-parse", "--is-bare-repository", "--is-inside-work-tree"]);
      if (kind.code !== 0)
        return yield* /dubious ownership/i.test(kind.stderr) ? notOwned : notRepository;
      const [isBare, inside] = lines(kind.stdout);
      if (isBare === "true")
        return yield* refuse(
          "bare-repository",
          `\`${where}\` is a bare repository. Run prkit in a working tree.`,
        );
      if (inside !== "true") return yield* notRepository;

      const found = yield* at([
        "rev-parse",
        "--show-toplevel",
        "--absolute-git-dir",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-object-format",
      ]);
      const [top = "", gitDir = "", commonDir = "", format] = lines(found.stdout);
      if (found.code !== 0 || commonDir === "") return yield* notRepository;
      const [realTop, realGitDir, realCommon, realHome] = yield* Effect.all([
        fs.realPath(top),
        fs.realPath(gitDir),
        fs.realPath(commonDir),
        fs.realPath(deps.home),
      ]).pipe(Effect.catchTag("PlatformError", () => notRepository));

      const uid = process.getuid?.() ?? null;
      if (uid !== null) {
        const owners = yield* Effect.forEach([realTop, realCommon], (dir) =>
          fs.stat(dir).pipe(
            Effect.map((info) => info.uid),
            Effect.catchTag("PlatformError", () => notRepository),
          ),
        );
        if (owners.some((owner) => owner._tag === "None" || owner.value !== uid))
          return yield* notOwned;
      }
      const within = (dir: string) => dir === realHome || dir.startsWith(`${realHome}${path.sep}`);
      if (within(realTop) || within(realCommon))
        return yield* refuse("prkit-checkout", `\`${where}\` is one of prkit's own checkouts.`);

      const reviewed = yield* Effect.gen(function* () {
        if (branch !== undefined) {
          const exists = yield* run(
            ["-C", realTop, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            { target: plain },
          );
          if (exists.code !== 0)
            return yield* refuse("branch-not-found", `There's no local branch \`${branch}\`.`);
          return branch;
        }
        return yield* currentBranch(at);
      });
      const hex = yield* hex16(
        `${realCommon}\0${reviewed === null ? `HEAD@${realTop}` : `refs/heads/${reviewed}`}`,
      );
      return {
        key: LocalReviewKey.make(`local:${hex}`),
        path: realTop,
        name: path.basename(realTop),
        gitDir: realGitDir,
        commonDir: realCommon,
        branch: reviewed,
        objectFormat: format === "sha256" ? "sha256" : "sha1",
      } satisfies LocalIdentity;
    });

  type Read = (args: ReadonlyArray<string>) => ReturnType<typeof run>;

  const commitOf = (read: Read, ref: string) =>
    read(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)),
    );

  /** The branch HEAD is on; null when detached. */
  const currentBranch = (read: Read) =>
    read(["symbolic-ref", "--quiet", "HEAD"]).pipe(
      Effect.map((result) => {
        const ref = result.stdout.trim();
        return result.code === 0 && ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : null;
      }),
    );

  /** The given base, else the first of origin/HEAD's target, origin/main, origin/master, main, master. */
  const resolveBase = (read: Read, asked: string | null) =>
    Effect.gen(function* () {
      if (asked !== null) {
        const sha = asked.startsWith("-") ? null : yield* commitOf(read, asked);
        if (sha !== null) return { ref: asked, sha };
        return yield* refuse(
          "base-not-found",
          `prkit couldn't find a base branch: it tried \`${asked}\`. Pass --base.`,
        );
      }
      const originHead = yield* read(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
      const candidates = [
        ...(originHead.code === 0 ? [originHead.stdout.trim()] : []),
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
      ].filter((ref, index, all) => all.indexOf(ref) === index);
      const shortName = (ref: string) => ref.replace(/^refs\/(remotes|heads)\//, "");
      for (const ref of candidates) {
        const sha = yield* commitOf(read, ref);
        if (sha !== null) return { ref: shortName(ref), sha };
      }
      return yield* refuse(
        "base-not-found",
        `prkit couldn't find a base branch: it tried ${candidates.map((ref) => `\`${shortName(ref)}\``).join(", ")}. Pass --base.`,
      );
    });

  /**
   * Copies the objects of `roots`, trees or blobs, the copy lacks, reading the user's objects
   * as alternates.
   */
  const copyObjects = (user: UserRepository, copy: string, roots: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const failure = "Couldn't copy your repository's objects into prkit's copy.";
      const listed = yield* run(["rev-list", "--objects", "--no-object-names", "--stdin"], {
        target: user,
        input: `${roots.join("\n")}\n`,
      });
      if (listed.code !== 0) return yield* missingOr(listed.stderr, failure);
      const checked = yield* git(["cat-file", "--batch-check=%(objectname)"], {
        target: bare(copy),
        input: `${lines(listed.stdout).join("\n")}\n`,
        failure,
      });
      const missing = lines(checked)
        .filter((line) => line.endsWith(" missing"))
        .map((line) => line.slice(0, line.indexOf(" ")));
      if (missing.length === 0) return;
      // Never with the user's objects as GIT_OBJECT_DIRECTORY: pack-objects writes its temp
      // files there.
      const packed = yield* run(
        ["pack-objects", "-q", path.join(copy, "objects", "pack", "pack")],
        {
          target: { ...user, objectDirectory: path.join(copy, "objects") },
          input: `${missing.join("\n")}\n`,
        },
      );
      if (packed.code !== 0) return yield* missingOr(packed.stderr, failure);
    });

  const workingTree = makeWorkingTree(deps, { refuse, copyObjects });

  /**
   * Snapshots the user's changes into the review's copy and makes B and H there. Reads the
   * user's repository only through the `user` target, with prkit's own temp index, and writes
   * nothing to it. H stays reachable under `refs/prkit/captures/<H>` until the copy is forgotten.
   * `sameAsPrevious` when both trees equal the previous capture's: then no commit is made and
   * the previous capture's commits come back.
   */
  const capture = (input: {
    readonly identity: LocalIdentity;
    readonly base: string | null;
    readonly head: LocalHead;
    readonly previous: LocalCapture | null;
    readonly description: string | null;
  }) => {
    const { identity, previous } = input;
    const copy = copyOf(identity.key);
    const scratch = path.join(copy, "prkit-capture");
    return gated(identity.key)(
      Effect.gen(function* () {
        const existed = yield* fs.exists(path.join(copy, "HEAD"));
        const work = Effect.gen(function* () {
          // Not again on a copy that exists: a kill mid-init would leave a config lock behind.
          if (!existed) {
            yield* fs.makeDirectory(copy, { recursive: true });
            yield* git(
              ["init", "--quiet", "--bare", `--object-format=${identity.objectFormat}`, copy],
              { target: plain, failure: "Couldn't make prkit's copy of your changes." },
            );
          }
          yield* fs.remove(scratch, { recursive: true, force: true });
          yield* fs.makeDirectory(scratch, { recursive: true });

          const user: UserRepository = {
            _tag: "user",
            gitDir: identity.gitDir,
            commonDir: identity.commonDir,
            workTree: identity.path,
            indexFile: path.join(scratch, "index"),
          };
          const read = (args: ReadonlyArray<string>) => run(args, { target: user });
          const readOk = (args: ReadonlyArray<string>) =>
            git(args, { target: user, failure: "Couldn't read your repository." });

          const onBranch = yield* currentBranch(read);
          const noCommits = refuse(
            "no-commits",
            "This branch has no commits yet. Commit once, then run prkit again.",
          );
          const headRef =
            input.head === "branch" && identity.branch !== null
              ? `refs/heads/${identity.branch}`
              : "HEAD";
          if (input.head === "working-tree" && onBranch !== identity.branch)
            return yield* refuse(
              "moved",
              `\`${identity.path}\` is on ${onWhat(onBranch)} now, not ${onWhat(identity.branch)}. Switch back, or run prkit there for a new local review.`,
            );
          const userHead = yield* commitOf(read, headRef);
          if (userHead === null)
            return yield* headRef === "HEAD" || identity.branch === onBranch
              ? noCommits
              : refuse("branch-not-found", `There's no local branch \`${identity.branch}\`.`);
          const unmoved = Effect.all([commitOf(read, headRef), currentBranch(read)]).pipe(
            Effect.map(([now, branch]) => now === userHead && branch === onBranch),
          );

          const base = yield* resolveBase(read, input.base);
          const mergeBase = yield* read(["merge-base", base.sha, userHead]);
          if (mergeBase.code === 1)
            return yield* refuse(
              "no-shared-history",
              `${identity.branch === null ? "`HEAD`" : `\`${identity.branch}\``} shares no history with \`${base.ref}\`. Pass --base with the branch it started from.`,
            );
          if (mergeBase.code !== 0)
            return yield* missingOr(mergeBase.stderr, "Couldn't find where your branch started.");
          const baseSha = mergeBase.stdout.trim();
          const [headTree = "", baseTree = ""] = lines(
            yield* readOk(["rev-parse", `${userHead}^{tree}`, `${baseSha}^{tree}`]),
          );

          yield* copyObjects(user, copy, [headTree, baseTree]);
          const taken =
            input.head === "working-tree"
              ? yield* workingTree({ user, copy, scratch, identity, userHead, headTree, unmoved })
              : { tree: headTree, leftOut: [] };

          if (taken.tree === baseTree) {
            const where =
              input.head === "working-tree"
                ? `your working tree on ${onWhat(identity.branch)}`
                : onWhat(identity.branch);
            const filtered = taken.leftOut.filter((file) => file.reason === "filtered");
            const [first] = filtered;
            return yield* refuse(
              "nothing-changed",
              first === undefined
                ? `Nothing differs between \`${base.ref}\` and ${where}.`
                : `Nothing prkit can read differs between \`${base.ref}\` and ${where}. \`${first.path}\`${filtered.length > 1 ? ` and ${filtered.length - 1} more` : ""} changed, but prkit leaves out files git stores through a filter.`,
            );
          }

          const listCommits = (range: string) =>
            readOk([
              "rev-list",
              "--no-commit-header",
              "--format=%H%x1f%s",
              "--reverse",
              `--max-count=${MAX_LISTED_COMMITS}`,
              range,
            ]).pipe(Effect.map(parseCommits));
          const commits = yield* listCommits(`${baseSha}..${userHead}`);
          const commitCount = Number(
            (yield* readOk(["rev-list", "--count", `${baseSha}..${userHead}`])).trim(),
          );
          const newCommits =
            previous === null
              ? null
              : previous.userHead === userHead
                ? []
                : (yield* read(["merge-base", "--is-ancestor", previous.userHead, userHead]))
                      .code === 0
                  ? yield* listCommits(`${previous.userHead}..${userHead}`)
                  : null;

          const has = (sha: string) =>
            run(["cat-file", "-e", `${sha}^{commit}`], { target: bare(copy) }).pipe(
              Effect.map((result) => result.code === 0),
            );
          const previousKept = previous !== null && (yield* has(previous.headSha));
          const sameAsPrevious =
            previousKept && previous.headTree === taken.tree && previous.baseTree === baseTree;
          const commitTree = (tree: string, message: string, parents: ReadonlyArray<string>) =>
            git(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], {
              target: bare(copy),
              env: FIXED_IDENTITY,
              input: `${message}\n`,
              failure: "Couldn't record the snapshot in prkit's copy.",
            }).pipe(Effect.map((sha) => sha.trim()));
          // B depends on its tree alone, so an H built on the previous H still has it as an ancestor.
          const mergeBaseSha = yield* commitTree(baseTree, "The base of these changes", []);
          const headSha = sameAsPrevious
            ? previous.headSha
            : yield* commitTree(
                taken.tree,
                `${input.head === "working-tree" ? "Local" : "Committed"} changes on ${identity.branch ?? "a detached HEAD"}`,
                [previousKept && previous.baseTree === baseTree ? previous.headSha : mergeBaseSha],
              );
          // The same trees always give the same H, so a run killed here would block every
          // later one with its lock. Behind the copy's gate, no other git holds it.
          yield* fs.remove(path.join(copy, "refs", "prkit", "captures", `${headSha}.lock`), {
            force: true,
          });
          yield* git(["update-ref", `refs/prkit/captures/${headSha}`, headSha], {
            target: bare(copy),
            failure: "Couldn't record the snapshot in prkit's copy.",
          });

          return {
            capture: {
              headSha,
              mergeBaseSha,
              headTree: taken.tree,
              baseTree,
              baseRef: base.ref,
              baseSha,
              userHead,
              branch: identity.branch,
              head: input.head,
              commits,
              commitCount,
              newCommits,
              uncommitted: input.head === "working-tree" && taken.tree !== headTree,
              leftOut: taken.leftOut,
              description: input.description,
              capturedAt: DateTime.formatIso(yield* DateTime.now),
            } satisfies LocalCapture,
            sameAsPrevious,
          };
        });
        return yield* work.pipe(
          Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)),
          // A copy this run made is only worth keeping once it holds a capture.
          Effect.onError(() =>
            existed
              ? Effect.void
              : fs.remove(copy, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
        );
      }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(diskFailure))),
    );
  };

  /** The attempt's checkout of H at `worktrees/<reviewId>`, from the copy, and its diff against B. */
  const prepare = (input: {
    readonly reviewId: ReviewId;
    readonly key: LocalReviewKey;
    readonly capture: LocalCapture;
    /** The last accepted revision's head, for `since`. */
    readonly previousHead: string | null;
  }) => {
    const copy = copyOf(input.key);
    const { headSha, mergeBaseSha } = input.capture;
    const gone = new RepoError({
      reason: "repository",
      message: "prkit's copy of this run is gone. Run prkit again.",
    });
    return gated(input.key)(
      Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(copy, "HEAD")))) return yield* gone;
        for (const sha of [headSha, mergeBaseSha]) {
          const present = yield* run(["cat-file", "-e", `${sha}^{commit}`], { target: bare(copy) });
          if (present.code !== 0) return yield* gone;
        }
        const related = yield* deps.relation(copy, input.previousHead, headSha);
        const worktree = yield* deps.ensureWorktree(
          copy,
          deps.worktreePath(input.reviewId),
          headSha,
        );
        const snapshot = yield* deps.snapshotOf(copy, mergeBaseSha, headSha);
        const since: Since =
          related._tag === "descends"
            ? yield* deps.commitsSince(copy, related.from, headSha)
            : related;
        return {
          worktree,
          checkout: checkoutFor(path, copy, worktree),
          headSha,
          baseSha: mergeBaseSha,
          mergeBaseSha,
          snapshot,
          since,
        } satisfies Prepared;
      }),
    ).pipe(Effect.catchTag("PlatformError", () => Effect.fail(diskFailure)));
  };

  /** A file's text at a commit of the review's copy; null when the copy or the file lacks it. */
  const contents = (key: LocalReviewKey, sha: string, file: string) =>
    Effect.gen(function* () {
      const copy = copyOf(key);
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return null;
      if (!(yield* fs.exists(path.join(copy, "HEAD")))) return null;
      const shown = yield* run(["cat-file", "blob", `${sha}:${file}`], { target: bare(copy) });
      return shown.code === 0 ? shown.stdout : null;
    }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)));

  /** The new side of each path at a commit of the review's copy, so never the working tree. */
  const texts = (key: LocalReviewKey, sha: string, paths: ReadonlyArray<string>) =>
    deps.readTexts(
      copyOf(key),
      sha,
      paths,
      "prkit couldn't read this snapshot from its copy of your changes.",
    );

  /** Removes the review's copy. A missing copy is already the goal. */
  const forget = (key: LocalReviewKey) =>
    gated(key)(fs.remove(copyOf(key), { recursive: true, force: true })).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new RepoError({
            reason: "repository",
            message: "Couldn't remove prkit's copy of your changes.",
          }),
        ),
      ),
    );

  /** At startup: removes every copy whose key has no local review. Converges in one run. */
  const sweep = (live: ReadonlySet<LocalReviewKey>) =>
    Effect.gen(function* () {
      const names = yield* fs
        .readDirectory(localDir)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));
      for (const name of names) {
        const hex = /^([0-9a-f]{16})\.git$/.exec(name)?.[1];
        if (hex === undefined) continue;
        const key = LocalReviewKey.make(`local:${hex}`);
        if (!live.has(key)) yield* forget(key);
      }
    });

  return { copyOf, identify, capture, prepare, contents, texts, forget, sweep };
};

export type LocalCaptureService = ReturnType<typeof makeLocalCapture>;
