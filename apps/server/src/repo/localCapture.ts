// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat: effect/FileSystem's stat follows links, and the before/after check needs nanosecond mtimes.
import * as NodeFs from "node:fs";

import { type DiffSnapshot, LocalHead, LocalReviewKey, type ReviewId } from "@prkit/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Hex } from "effect/encoding";

import { checkoutFor, type GitTarget, RepoError, type UserRepository } from "./gitRun.ts";
import type { Prepared, Since } from "./RepoCache.ts";

/** One bare repository per local review, holding only what prkit copied or hashed for it. */
export const localCopyPath = (path: Path.Path, home: string, key: LocalReviewKey) =>
  path.join(home, "local", `${key.slice("local:".length)}.git`);

const Commit = Schema.Struct({ sha: Schema.String, subject: Schema.String });

/** A file the snapshot shows as committed (or leaves out when new), and why. */
export const LeftOut = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["too-large", "filtered", "nested-repository"]),
  bytes: Schema.NullOr(Schema.Int),
});
export type LeftOut = typeof LeftOut.Type;

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
  leftOut: Schema.Array(LeftOut),
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

/** Past either, a run is refused before anything is hashed. */
export const MAX_FILES = 200_000;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
/** A file over this keeps its committed content, or stays out when new. */
export const MAX_FILE_BYTES = 50 * 1024 ** 2;
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

const lines = (text: string) => text.split("\n").filter((line) => line !== "");
const fields = (text: string) => text.split("\0").filter((field) => field !== "");

const parseCommits = (text: string) =>
  lines(text).map((line) => {
    const [sha = "", subject = ""] = line.split("\x1f");
    return { sha, subject };
  });

/** `ls-tree -r -z` entries by path: `<mode> <type> <sha>\t<path>`. */
const parseTree = (text: string) =>
  new Map(
    fields(text).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode = "", type = "", sha = ""] = entry.slice(0, tab).split(" ");
      return [entry.slice(tab + 1), { mode, type, sha }] as const;
    }),
  );

/** The paths `check-attr -z` reports a filter driver for: `<path>\0filter\0<value>\0` triples. */
const filteredPaths = (text: string) => {
  const parts = text.split("\0");
  const named = new Set<string>();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const value = parts[index + 2] ?? "unspecified";
    if (value !== "unspecified" && value !== "unset") named.add(parts[index] ?? "");
  }
  return named;
};

/** `--stdin-paths` reads one path a line, and C-unquotes a line that starts with a double quote. */
const stdinPath = (file: string) => {
  const escape = (char: string) =>
    char === '"' || char === "\\"
      ? `\\${char}`
      : char < " "
        ? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`
        : char;
  const chars = [...file];
  return chars.some((char) => escape(char) !== char) ? `"${chars.map(escape).join("")}"` : file;
};

/** A file as lstat sees it; `stamp` changes with its size, mtime, mode or inode. */
type OnDisk =
  | { readonly kind: "missing" }
  | { readonly kind: "other"; readonly stamp: string }
  | { readonly kind: "link"; readonly stamp: string }
  | {
      readonly kind: "file";
      readonly stamp: string;
      readonly size: number;
      readonly executable: boolean;
    };

const look = (file: string): OnDisk => {
  const stat = NodeFs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined) return { kind: "missing" };
  const stamp = `${stat.size}:${stat.mtimeNs}:${stat.mode}:${stat.ino}`;
  if (stat.isSymbolicLink()) return { kind: "link", stamp };
  if (!stat.isFile()) return { kind: "other", stamp };
  return { kind: "file", stamp, size: Number(stat.size), executable: (stat.mode & 0o100n) !== 0n };
};

const sameOnDisk = (left: OnDisk, right: OnDisk) =>
  left.kind === right.kind &&
  (left.kind === "missing" || right.kind === "missing" || left.stamp === right.stamp);

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
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
          Effect.annotateLogs({ stderr: stderr.trim() }),
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

  /** Copies the objects of `trees` the copy lacks, reading the user's objects as alternates. */
  const copyObjects = (user: UserRepository, copy: string, trees: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const failure = "Couldn't copy your repository's objects into prkit's copy.";
      const listed = yield* run(["rev-list", "--objects", "--no-object-names", ...trees], {
        target: user,
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

  const lookAll = (root: string, files: ReadonlyArray<string>) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(files.length / 2000) }, (_, index) =>
        files.slice(index * 2000, (index + 1) * 2000),
      ),
      (chunk) =>
        Effect.try({
          try: () => chunk.map((file) => look(path.join(root, file))),
          catch: () =>
            new RepoError({
              reason: "repository",
              message: "prkit couldn't read some of your files.",
            }),
        }),
    ).pipe(Effect.map((chunks) => chunks.flat()));

  /**
   * `ls-files -v` of the user's index, read from a copy in prkit's copy: git touches a split
   * index's shared file whenever it reads the index, so the user's own is never read in place.
   */
  const userIndexEntries = (identity: LocalIdentity, copy: string, scratch: string) =>
    Effect.gen(function* () {
      const index = path.join(identity.gitDir, "index");
      if (!(yield* fs.exists(index))) return [];
      const shared = (yield* fs.readDirectory(identity.gitDir)).filter((name) =>
        name.startsWith("sharedindex."),
      );
      yield* fs.copyFile(index, path.join(scratch, "user-index"));
      return yield* Effect.forEach(
        shared,
        (name) => fs.copyFile(path.join(identity.gitDir, name), path.join(copy, name)),
        { discard: true },
      ).pipe(
        Effect.andThen(
          git(["ls-files", "-v", "-z"], {
            target: bare(copy),
            env: { GIT_INDEX_FILE: path.join(scratch, "user-index") },
            failure: "Couldn't read your repository's index.",
          }),
        ),
        Effect.map(fields),
        Effect.ensuring(
          Effect.forEach(shared, (name) => fs.remove(path.join(copy, name), { force: true }), {
            discard: true,
          }).pipe(Effect.ignore),
        ),
      );
    });

  /**
   * The working tree's tree in the copy: HEAD's tree with every file as it is on disk, untracked
   * files that aren't ignored, and deletions, hashed with no filters into the copy alone (a
   * write that found the object in the user's objects would touch their file).
   */
  const workingTree = (input: {
    readonly user: UserRepository;
    readonly copy: string;
    readonly scratch: string;
    readonly identity: LocalIdentity;
    readonly userHead: string;
    readonly headTree: string;
    readonly unmoved: Effect.Effect<boolean, RepoError>;
  }) =>
    Effect.gen(function* () {
      const { user, copy, scratch, identity } = input;
      const read = (args: ReadonlyArray<string>, failure: string) =>
        git(args, { target: user, failure });

      if ((yield* userIndexEntries(identity, copy, scratch)).some((entry) => /^[Ss] /.test(entry)))
        return yield* refuse(
          "sparse-checkout",
          "prkit can't read sparse checkouts yet: files it can't see would look deleted.",
        );

      const failure = "Couldn't list your repository's files.";
      yield* read(["read-tree", input.userHead], failure);
      const others = fields(
        yield* read(["ls-files", "-z", "--others", "--exclude-standard"], failure),
      );
      const tracked = parseTree(
        yield* read(["ls-tree", "-r", "-z", "--full-tree", input.headTree], failure),
      );
      const fileMode = yield* run(["config", "--type=bool", "--get", "core.fileMode"], {
        target: user,
      });

      const leftOut: Array<LeftOut> = others
        .filter((file) => file.endsWith("/"))
        .map((file) => ({ path: file.slice(0, -1), reason: "nested-repository", bytes: null }));
      const files = [
        ...[...tracked].filter(([, entry]) => entry.type !== "commit").map(([file]) => file),
        ...others.filter((file) => !file.endsWith("/")),
      ];
      const before = yield* lookAll(identity.path, files);

      const zero = "0".repeat(identity.objectFormat === "sha256" ? 64 : 40);
      const changes: Array<{
        readonly path: string;
        readonly mode: string;
        readonly sha: string;
        readonly bytes: number | null;
      }> = [];
      const toHash: Array<{
        readonly path: string;
        readonly mode: string;
        readonly source: string;
        readonly bytes: number | null;
      }> = [];
      const links: Array<{ readonly path: string; readonly source: string }> = [];
      let bytes = 0;
      for (const [index, file] of files.entries()) {
        const disk = before[index] ?? { kind: "missing" };
        const old = tracked.get(file);
        if (disk.kind === "missing" || disk.kind === "other") {
          if (old !== undefined) changes.push({ path: file, mode: "0", sha: zero, bytes: null });
        } else if (disk.kind === "link") {
          const source = path.join(scratch, "links", `${links.length}`);
          links.push({ path: file, source });
          toHash.push({ path: file, mode: "120000", source, bytes: null });
        } else if (disk.size > MAX_FILE_BYTES) {
          leftOut.push({ path: file, reason: "too-large", bytes: disk.size });
        } else {
          bytes += disk.size;
          const mode =
            fileMode.stdout.trim() !== "false"
              ? disk.executable
                ? "100755"
                : "100644"
              : old?.mode === "100755"
                ? "100755"
                : "100644";
          toHash.push({
            path: file,
            mode,
            source: path.join(identity.path, file),
            bytes: disk.size,
          });
        }
      }
      if (toHash.length > MAX_FILES || bytes > MAX_TOTAL_BYTES)
        return yield* refuse(
          "too-large",
          `This change has ${toHash.length.toLocaleString("en-US")} files and ${gib(bytes)} to read. prkit reads at most ${MAX_FILES.toLocaleString("en-US")} files and ${gib(MAX_TOTAL_BYTES)} per run.`,
        );

      yield* fs.makeDirectory(path.join(scratch, "links"), { recursive: true });
      yield* Effect.forEach(
        links,
        (link) =>
          fs
            .readLink(path.join(identity.path, link.path))
            .pipe(Effect.flatMap((target) => fs.writeFileString(link.source, target))),
        { discard: true },
      );
      const hashed =
        toHash.length === 0
          ? []
          : lines(
              yield* git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
                target: bare(copy),
                input: `${toHash.map((entry) => stdinPath(entry.source)).join("\n")}\n`,
                failure: "prkit couldn't read some of your files.",
              }),
            );

      const after = yield* lookAll(identity.path, files);
      const settled = before.every((disk, index) => {
        const now = after[index];
        return now !== undefined && sameOnDisk(disk, now);
      });
      if (!settled || !(yield* input.unmoved))
        return yield* refuse(
          "repository-changed",
          "Your files changed while prkit read them. Run again when they settle.",
        );

      for (const [index, entry] of toHash.entries()) {
        const sha = hashed[index] ?? "";
        const old = tracked.get(entry.path);
        if (old === undefined || old.sha !== sha || old.mode !== entry.mode)
          changes.push({ ...entry, sha });
      }

      const contents = changes.filter(
        (change) => change.mode === "100644" || change.mode === "100755",
      );
      const filtered =
        contents.length === 0
          ? new Set<string>()
          : filteredPaths(
              yield* git(["check-attr", "-z", "--stdin", "filter"], {
                target: user,
                input: contents.map((change) => `${change.path}\0`).join(""),
                failure,
              }),
            );
      for (const change of contents)
        if (filtered.has(change.path))
          leftOut.push({ path: change.path, reason: "filtered", bytes: change.bytes });
      const kept = changes.filter((change) => !filtered.has(change.path));

      if (kept.length === 0) return { tree: input.headTree, leftOut: leftOut.toSorted(byPath) };
      const index = { GIT_INDEX_FILE: path.join(scratch, "copy-index") };
      const building = "Couldn't build the snapshot in prkit's copy.";
      yield* git(["read-tree", input.headTree], {
        target: bare(copy),
        env: index,
        failure: building,
      });
      yield* git(["update-index", "-z", "--index-info"], {
        target: bare(copy),
        env: index,
        input: kept.map((change) => `${change.mode} ${change.sha}\t${change.path}\0`).join(""),
        failure: building,
      });
      const tree = (yield* git(["write-tree"], {
        target: bare(copy),
        env: index,
        failure: building,
      })).trim();
      return { tree, leftOut: leftOut.toSorted(byPath) };
    });

  const byPath = (left: LeftOut, right: LeftOut) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

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
          yield* fs.makeDirectory(copy, { recursive: true });
          yield* git(
            ["init", "--quiet", "--bare", `--object-format=${identity.objectFormat}`, copy],
            { target: plain, failure: "Couldn't make prkit's copy of your changes." },
          );
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

          if (taken.tree === baseTree)
            return yield* refuse(
              "nothing-changed",
              `Nothing differs between \`${base.ref}\` and ${
                input.head === "working-tree"
                  ? `your working tree on ${onWhat(identity.branch)}`
                  : onWhat(identity.branch)
              }.`,
            );

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

  return { copyOf, identify, capture, prepare, contents, forget, sweep };
};

export type LocalCaptureService = ReturnType<typeof makeLocalCapture>;
