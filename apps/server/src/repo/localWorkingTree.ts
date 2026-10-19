// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat: effect/FileSystem's stat follows links, and the before/after check needs nanosecond mtimes.
import * as NodeFs from "node:fs";

import type { LocalLeftOut } from "@prkit/contracts";
import * as Effect from "effect/Effect";

import { type GitTarget, RepoError, type UserRepository } from "./gitRun.ts";
import type { LocalCaptureDeps, LocalCaptureError, LocalIdentity } from "./localCapture.ts";

/** Past either, a run is refused before anything is hashed. */
export const MAX_FILES = 200_000;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
/** A file over this keeps its committed content, or stays out when new. */
export const MAX_FILE_BYTES = 50 * 1024 ** 2;

export const lines = (text: string) => text.split("\n").filter((line) => line !== "");
const fields = (text: string) => text.split("\0").filter((field) => field !== "");

/** `ls-tree -r -z` entries by path: `<mode> <type> <sha>\t<path>`. */
const parseTree = (text: string) =>
  new Map(
    fields(text).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode = "", type = "", sha = ""] = entry.slice(0, tab).split(" ");
      return [entry.slice(tab + 1), { mode, type, sha }] as const;
    }),
  );

/**
 * What git would run or convert a file through that prkit can't: a filter command, or an
 * encoding that fails the whole add on one bad byte. A changed file with either stays out.
 */
const UNREAD = ["filter", "working-tree-encoding"];

/** The paths `check-attr -z` reports one of the asked attributes set for, from its triples. */
const attributedPaths = (text: string) => {
  const parts = text.split("\0");
  const named = new Set<string>();
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const value = parts[index + 2] ?? "unspecified";
    if (value !== "unspecified" && value !== "unset") named.add(parts[index] ?? "");
  }
  return named;
};

/** `ls-files -s -v -z` entries, `<tag> <mode> <sha> <stage>\t<path>`. */
const parseIndex = (text: string) =>
  fields(text).map((entry) => {
    const tab = entry.indexOf("\t");
    const [tag = "", mode = "", sha = "", stage = ""] = entry.slice(0, tab).split(" ");
    return { tag, mode, sha, stage, path: entry.slice(tab + 1) };
  });
type IndexEntry = ReturnType<typeof parseIndex>[number];

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

/** Snapshots a capture's working tree with the capture's own git, refusals and object copy. */
export const makeWorkingTree = (
  deps: LocalCaptureDeps,
  {
    refuse,
    copyObjects,
  }: {
    readonly refuse: (
      reason: LocalCaptureError["reason"],
      message: string,
    ) => Effect.Effect<never, LocalCaptureError>;
    readonly copyObjects: (
      user: UserRepository,
      copy: string,
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<void, RepoError | LocalCaptureError>;
  },
) => {
  const { fs, path, run, git } = deps;
  const plain: GitTarget = { _tag: "plain" };
  const bare = (repo: string): GitTarget => ({ _tag: "bare", repo });

  /**
   * A key of the user's own global config, which prkit's isolated global config hides. Only
   * that key is read from their global config files, without following includes; a path
   * falls back to git's own default file there, which prkit's git (run without
   * XDG_CONFIG_HOME) would otherwise miss.
   */
  const globalSetting = (key: string, defaultFile: string | null) =>
    Effect.gen(function* () {
      const home = process.env.HOME ?? "";
      const xdg = process.env.XDG_CONFIG_HOME ?? "";
      const configs = [
        ...(home === "" ? [] : [path.join(home, ".gitconfig")]),
        ...(xdg !== ""
          ? [path.join(xdg, "git", "config")]
          : home === ""
            ? []
            : [path.join(home, ".config", "git", "config")]),
      ];
      for (const file of configs) {
        if (!(yield* fs.exists(file))) continue;
        const found = yield* run(
          [
            "config",
            "--file",
            file,
            "--no-includes",
            ...(defaultFile === null ? [] : ["--type=path"]),
            "--get",
            key,
          ],
          { target: plain },
        );
        if (found.code === 0 && found.stdout.trim() !== "") return found.stdout.trim();
      }
      return defaultFile === null || xdg === "" ? null : path.join(xdg, "git", defaultFile);
    });

  /**
   * Each file as lstat sees it. A file under a symlink or anything else that isn't a real
   * folder is `missing`, as git sees it, so nothing outside the repository is read.
   */
  const lookAll = (root: string, files: ReadonlyArray<string>) => {
    const folders = new Map<string, boolean>();
    const inFolder = (file: string): boolean => {
      const parent = path.dirname(file);
      if (parent === ".") return true;
      const known = folders.get(parent);
      if (known !== undefined) return known;
      const real =
        inFolder(parent) &&
        NodeFs.lstatSync(path.join(root, parent), { throwIfNoEntry: false })?.isDirectory() ===
          true;
      folders.set(parent, real);
      return real;
    };
    const missing: OnDisk = { kind: "missing" };
    return Effect.forEach(
      Array.from({ length: Math.ceil(files.length / 2000) }, (_, index) =>
        files.slice(index * 2000, (index + 1) * 2000),
      ),
      (chunk) =>
        Effect.try({
          try: () => chunk.map((file) => (inFolder(file) ? look(path.join(root, file)) : missing)),
          catch: () =>
            new RepoError({
              reason: "repository",
              message: "prkit couldn't read some of your files.",
            }),
        }),
    ).pipe(Effect.map((chunks) => chunks.flat()));
  };

  /**
   * The user's index, read from a copy in prkit's copy: git touches a split index's shared
   * file whenever it reads the index, so the user's own is never read in place.
   */
  const userIndexEntries = (identity: LocalIdentity, copy: string, scratch: string) =>
    Effect.gen(function* () {
      const index = path.join(identity.gitDir, "index");
      if (!(yield* fs.exists(index))) return new Array<IndexEntry>();
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
          git(["ls-files", "-s", "-v", "-z"], {
            target: bare(copy),
            env: { GIT_INDEX_FILE: path.join(scratch, "user-index") },
            failure: "Couldn't read your repository's index.",
          }),
        ),
        Effect.map(parseIndex),
        Effect.ensuring(
          Effect.forEach(shared, (name) => fs.remove(path.join(copy, name), { force: true }), {
            discard: true,
          }).pipe(Effect.ignore),
        ),
      );
    });

  /**
   * `files` as `git add` reads them, against the user's own index rebuilt in the copy: their
   * entries, stages included, without stat data, so git reads every file again. git takes an
   * attributes file missing from the work tree from that index, and converts a file's line
   * endings by the entry it already has. `unread` are the files with an attribute prkit can't
   * follow; `added` the ids git gives the rest. Objects go only to the copy, whose config names
   * no filter command to run.
   */
  const asAdded = (input: {
    readonly user: UserRepository;
    readonly copy: string;
    readonly scratch: string;
    readonly identity: LocalIdentity;
    readonly entries: ReadonlyArray<IndexEntry>;
    readonly tracked: ReturnType<typeof parseTree>;
    readonly files: ReadonlyArray<string>;
    readonly settings: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      if (input.files.length === 0)
        return { unread: new Set<string>(), added: new Map<string, string>() };
      const { copy, identity } = input;
      const failure = "prkit couldn't read some of your files.";
      // The repository's own attributes file, mirrored where git looks for it in the copy.
      const info = path.join(identity.commonDir, "info", "attributes");
      const mirror = path.join(copy, "info", "attributes");
      if (yield* fs.exists(info)) {
        yield* fs.makeDirectory(path.dirname(mirror), { recursive: true });
        yield* fs.copyFile(info, mirror);
      } else yield* fs.remove(mirror, { force: true });
      const staged = input.entries.filter(
        (entry) =>
          (entry.mode === "100644" || entry.mode === "100755") &&
          entry.sha !== input.tracked.get(entry.path)?.sha,
      );
      if (staged.length > 0)
        yield* copyObjects(
          input.user,
          copy,
          staged.map((entry) => entry.sha),
        );
      const env = {
        GIT_INDEX_FILE: path.join(input.scratch, "add-index"),
        GIT_LITERAL_PATHSPECS: "1",
      };
      const target: GitTarget = {
        _tag: "worktree",
        checkout: { repo: copy, worktree: identity.path, gitDir: copy },
      };
      if (input.entries.length > 0)
        yield* git(["update-index", "-z", "--index-info"], {
          target: bare(copy),
          env,
          input: input.entries
            .map((entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.path}\0`)
            .join(""),
          failure,
        });
      const unread = attributedPaths(
        yield* git([...input.settings, "check-attr", "-z", "--stdin", ...UNREAD], {
          target,
          env,
          input: input.files.map((file) => `${file}\0`).join(""),
          failure,
        }),
      );
      const readable = input.files.filter((file) => !unread.has(file));
      if (readable.length === 0) return { unread, added: new Map<string, string>() };
      yield* git(
        [
          ...input.settings,
          "-c",
          "core.safecrlf=false",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "add",
          "-f",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { target, env, input: readable.map((file) => `${file}\0`).join(""), failure },
      );
      const index = new Map(
        parseIndex(
          yield* git(["ls-files", "-s", "-v", "-z"], { target: bare(copy), env, failure }),
        ).map((entry) => [entry.path, entry.sha]),
      );
      return {
        unread,
        added: new Map(
          readable.flatMap((file) => {
            const sha = index.get(file);
            return sha === undefined ? [] : [[file, sha] as const];
          }),
        ),
      };
    });

  /**
   * The working tree's tree in the copy: HEAD's tree with every file as it is on disk, untracked
   * files that aren't ignored, staged ones, and deletions. Every file is hashed with no filters
   * into the copy alone (a write that found the object in the user's objects would touch their
   * file); the changed ones again as `git add` would store them.
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

      const entries = yield* userIndexEntries(identity, copy, scratch);
      if (entries.some((entry) => entry.tag === "S" || entry.tag === "s"))
        return yield* refuse(
          "sparse-checkout",
          "prkit can't read sparse checkouts yet: files it can't see would look deleted.",
        );

      const failure = "Couldn't list your repository's files.";
      yield* read(["read-tree", input.userHead], failure);
      // `-c` would beat a repository's own setting, so the global one applies only without it.
      const ownExcludes = yield* run(["config", "--get", "core.excludesFile"], { target: user });
      const excludes =
        ownExcludes.code === 0 ? null : yield* globalSetting("core.excludesFile", "ignore");
      const others = fields(
        yield* read(
          [
            ...(excludes === null ? [] : ["-c", `core.excludesFile=${excludes}`]),
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
          ],
          failure,
        ),
      );
      const tracked = parseTree(
        yield* read(["ls-tree", "-r", "-z", "--full-tree", input.headTree], failure),
      );
      const fileMode = yield* run(["config", "--type=bool", "--get", "core.fileMode"], {
        target: user,
      });
      // What git reads when it adds a file: the repository's own setting, else the user's global one.
      const ownAttributes = yield* run(["config", "--type=path", "--get", "core.attributesFile"], {
        target: user,
      });
      const attributesFile =
        ownAttributes.code === 0
          ? ownAttributes.stdout.trim()
          : yield* globalSetting("core.attributesFile", "attributes");
      const ownAutocrlf = yield* run(["config", "--get", "core.autocrlf"], { target: user });
      const autocrlf =
        ownAutocrlf.code === 0
          ? ownAutocrlf.stdout.trim()
          : yield* globalSetting("core.autocrlf", null);

      const leftOut: Array<LocalLeftOut> = others
        .filter((file) => file.endsWith("/"))
        .map((file) => ({ path: file.slice(0, -1), reason: "nested-repository", bytes: null }));
      const listed = new Set(others);
      // Files staged though ignored (`git add -f`) are in neither list.
      const staged = [...new Set(entries.map((entry) => entry.path))].filter(
        (file) => !tracked.has(file) && !listed.has(file),
      );
      // The entry git reads for a path: stage 0, or in a conflict ours, then the base, then theirs.
      const rank = ["3", "1", "2", "0"];
      const indexed = new Map(
        entries
          .toSorted((left, right) => rank.indexOf(left.stage) - rank.indexOf(right.stage))
          .map((entry) => [entry.path, entry]),
      );
      const files = [
        ...[...tracked].filter(([, entry]) => entry.type !== "commit").map(([file]) => file),
        ...staged,
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
              : indexed.get(file)?.mode === "100755"
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
          `Your working tree has ${toHash.length.toLocaleString("en-US")} files and ${gib(bytes)} to read. prkit reads at most ${MAX_FILES.toLocaleString("en-US")} files and ${gib(MAX_TOTAL_BYTES)} per run.`,
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

      for (const [index, entry] of toHash.entries()) {
        const sha = hashed[index] ?? "";
        const old = tracked.get(entry.path);
        // `git add --renormalize` stages a change to a file whose bytes on disk are HEAD's.
        const inIndex = indexed.get(entry.path)?.sha ?? old?.sha;
        if (old === undefined || old.sha !== sha || old.mode !== entry.mode || inIndex !== old.sha)
          changes.push({ ...entry, sha });
      }

      const contents = changes.filter(
        (change) => change.mode === "100644" || change.mode === "100755",
      );
      // The rest as `git add` stores them: line endings, `ident` and the like by git's own rules.
      const { unread, added } = yield* asAdded({
        user,
        copy,
        scratch,
        identity,
        entries,
        tracked,
        files: contents.map((change) => change.path),
        settings: [
          ...(attributesFile === null ? [] : ["-c", `core.attributesFile=${attributesFile}`]),
          ...(autocrlf === null ? [] : ["-c", `core.autocrlf=${autocrlf}`]),
        ],
      });

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

      for (const change of contents)
        if (unread.has(change.path))
          leftOut.push({ path: change.path, reason: "filtered", bytes: change.bytes });
      const kept = changes.flatMap((change) => {
        if (unread.has(change.path)) return [];
        const sha = added.get(change.path);
        if (sha === undefined) return [change];
        const old = tracked.get(change.path);
        return old?.sha === sha && old.mode === change.mode ? [] : [{ ...change, sha }];
      });

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

  const byPath = (left: LocalLeftOut, right: LocalLeftOut) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

  return workingTree;
};
