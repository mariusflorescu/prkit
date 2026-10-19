// @effect-diagnostics nodeBuiltinImport:off -- builds real git repositories and reads their files outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ReviewId } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import * as ServerConfig from "../config.ts";
import type { LocalCapture, LocalCaptureError, LocalCaptureService } from "./localCapture.ts";
import * as RepoCache from "./RepoCache.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFs.rmSync(root, { recursive: true, force: true });
});

/** A user's repository, built with the user's own git and nothing of this machine's config. */
const userRepository = () => {
  const root = NodeFs.realpathSync(
    NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "prkit-local-")),
  );
  roots.push(root);
  const repo = NodePath.join(root, "widgets");
  const filterMark = NodePath.join(root, "filter-ran");
  NodeFs.mkdirSync(repo);
  const env = {
    HOME: root,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const file = (name: string) => NodePath.join(repo, name);
  const write = (name: string, content: string | Uint8Array) => {
    NodeFs.mkdirSync(NodePath.dirname(file(name)), { recursive: true });
    NodeFs.writeFileSync(file(name), content);
  };
  const fingerprint = () => {
    const hash = NodeCrypto.createHash("sha256");
    const walk = (directory: string) => {
      for (const entry of NodeFs.readdirSync(directory, { withFileTypes: true }).toSorted(
        (left, right) => (left.name < right.name ? -1 : 1),
      )) {
        const full = NodePath.join(directory, entry.name);
        const stat = NodeFs.lstatSync(full);
        hash.update(`${NodePath.relative(repo, full)} ${stat.size} ${stat.mtimeMs} ${stat.mode}\n`);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(repo);
    return hash.digest("hex");
  };
  git("init", "--quiet", "--initial-branch=main");
  return {
    root,
    repo,
    git,
    file,
    write,
    /** Every file of the repository, `.git` included, with its size, mtime and mode. */
    fingerprint,
    filterMark,
    filterRan: () => NodeFs.existsSync(filterMark),
  };
};

/**
 * `main`, an `origin/main` the feature branch started from, one commit on the branch, then
 * uncommitted, deleted, staged, untracked, ignored, symlink, executable and binary changes,
 * with the index split.
 */
const featureBranch = () => {
  const user = userRepository();
  user.write(".gitignore", "node_modules/\n");
  user.write("src/limits.ts", "export const limit = 1;\n");
  user.write("src/retired.ts", "export const retired = true;\n");
  user.write("assets/logo.bin", new Uint8Array([0, 1, 2, 3, 0, 255]));
  user.write("run.sh", "echo widgets\n");
  user.write("notes.md", "Notes\n");
  NodeFs.symlinkSync("src/limits.ts", user.file("limits-link"));
  user.git("add", "-A");
  user.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
  // A submodule that was never checked out: its folder exists and is empty.
  NodeFs.mkdirSync(user.file("vendor/lib"), { recursive: true });
  user.git("commit", "--quiet", "-m", "Base");
  user.git("update-ref", "refs/remotes/origin/main", "HEAD");
  user.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  user.git("checkout", "--quiet", "-b", "feature/limits");
  user.write("src/limits.ts", "export const limit = 2;\n");
  user.git("commit", "--quiet", "-am", "Raise the limit");

  user.write("src/limits.ts", "export const limit = 2;\nexport const enabled = true;\n");
  NodeFs.rmSync(user.file("src/retired.ts"));
  user.write("src/staged.ts", "export const staged = true;\n");
  user.git("add", "src/staged.ts");
  user.write("src/flags.ts", "export const flags = ['limits'];\n");
  user.write("node_modules/ignored.js", "ignored\n");
  NodeFs.chmodSync(user.file("run.sh"), 0o755);
  NodeFs.rmSync(user.file("limits-link"));
  NodeFs.symlinkSync("src/flags.ts", user.file("limits-link"));
  user.write("assets/logo.bin", new Uint8Array([0, 9, 9, 0]));
  // A split index: git touches its shared file whenever it reads the index.
  user.git("update-index", "--split-index");
  return user;
};

/** The capture service of a real RepoCache in a fresh prkit home; GitHub accounts are never read. */
const withCapture = <A, E>(
  body: (local: LocalCaptureService, home: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "prkit-local-home-" });
        const repo = yield* RepoCache.make.pipe(
          Effect.provideService(
            ServerConfig.ServerConfig,
            ServerConfig.ServerConfig.of({
              host: ServerConfig.SERVER_HOST,
              port: 0,
              home,
              dbPath: ":memory:",
              webDist: Option.none(),
              devWebOrigin: Option.none(),
              authToken: Redacted.make("test"),
              watchIntervalMs: 60_000,
              devReviewRequested: [],
              e2e: false,
              version: "0.0.0",
              startedAt: "2026-10-18T00:00:00.000Z",
            }),
          ),
          Effect.provide(Layer.mock(GitHubAccounts, { apiBase: () => "https://api.github.com" })),
        );
        return yield* body(repo.local, home);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

/** The reason a capture step was refused with. */
const refusal = <A, R>(effect: Effect.Effect<A, RepoCache.RepoError | LocalCaptureError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error._tag === "LocalCaptureError" ? error.reason : error.message)),
  );

const REVIEW = ReviewId.make("review-1");
const inCheckout = (worktree: string, file: string) =>
  NodeFs.readFileSync(NodePath.join(worktree, file), "utf8");

// Each case runs a few hundred real git processes, slow when the whole suite runs at once.
describe("local capture", { timeout: 30_000 }, () => {
  it("snapshots the working tree into prkit's copy and never writes the user's repository", async () => {
    const user = featureBranch();
    const before = user.fingerprint();

    const { taken, prepared, contents, checkout } = await withCapture((local) =>
      Effect.gen(function* () {
        const identity = yield* local.identify(user.repo);
        const { capture } = yield* local.capture({
          identity,
          base: null,
          head: "working-tree",
          previous: null,
          description: "Raise the limit",
        });
        const prepared = yield* local.prepare({
          reviewId: REVIEW,
          key: identity.key,
          capture,
          previousHead: null,
        });
        const contents = {
          head: yield* local.contents(identity.key, capture.headSha, "src/limits.ts"),
          base: yield* local.contents(identity.key, capture.mergeBaseSha, "src/limits.ts"),
          missing: yield* local.contents(identity.key, capture.headSha, "src/nothing.ts"),
        };
        const checkout = {
          limits: inCheckout(prepared.worktree, "src/limits.ts"),
          link: inCheckout(prepared.worktree, "limits-link"),
          executable:
            (NodeFs.statSync(NodePath.join(prepared.worktree, "run.sh")).mode & 0o100) !== 0,
          ignored: NodeFs.existsSync(NodePath.join(prepared.worktree, "node_modules")),
        };
        return { taken: capture, prepared, contents, checkout };
      }),
    );

    expect(user.fingerprint()).toBe(before);
    expect(taken).toMatchObject({
      baseRef: "origin/main",
      branch: "feature/limits",
      head: "working-tree",
      commits: [{ subject: "Raise the limit" }],
      commitCount: 1,
      newCommits: null,
      uncommitted: true,
      leftOut: [],
      description: "Raise the limit",
    });
    const files = new Map(prepared.snapshot.files.map((file) => [file.path, file]));
    expect([...files.keys()].toSorted()).toEqual([
      "assets/logo.bin",
      "limits-link",
      "run.sh",
      "src/flags.ts",
      "src/limits.ts",
      "src/retired.ts",
      "src/staged.ts",
    ]);
    expect(files.get("assets/logo.bin")).toMatchObject({
      status: "modified",
      patch: { _tag: "binary" },
    });
    expect(files.get("src/flags.ts")).toMatchObject({ status: "added" });
    expect(files.get("src/staged.ts")).toMatchObject({ status: "added" });
    expect(files.get("src/retired.ts")).toMatchObject({ status: "removed" });
    const patchOf = (path: string) => {
      const patch = files.get(path)?.patch;
      return patch?._tag === "text" ? patch.patch : "";
    };
    expect(patchOf("src/limits.ts")).toContain("-export const limit = 1;");
    expect(patchOf("src/limits.ts")).toContain("+export const limit = 2;");
    expect(patchOf("src/limits.ts")).toContain("+export const enabled = true;");
    expect(patchOf("limits-link")).toContain("+src/flags.ts");
    expect(patchOf("run.sh")).toContain("new mode 100755");

    expect(checkout).toEqual({
      limits: NodeFs.readFileSync(user.file("src/limits.ts"), "utf8"),
      link: "src/flags.ts",
      executable: true,
      ignored: false,
    });
    expect(prepared.since).toEqual({ _tag: "none" });
    expect(contents).toEqual({
      head: "export const limit = 2;\nexport const enabled = true;\n",
      base: "export const limit = 1;\n",
      missing: null,
    });
  });

  it("keeps filtered, huge and nested-repository files out, and runs no filter the repository names", async () => {
    const user = userRepository();
    user.write("data.dat", "committed\n");
    user.write("big.bin", "small\n");
    user.write("notes.md", "Notes\n");
    user.git("add", "-A");
    user.git("commit", "--quiet", "-m", "Base");
    user.git("checkout", "--quiet", "-b", "feature/assets");
    user.write(".gitattributes", "*.dat filter=mark\n");
    user.git("config", "filter.mark.clean", `touch '${user.filterMark}'; cat`);
    user.write("data.dat", "changed on disk\n");
    const huge = new Uint8Array(51 * 1024 * 1024).fill(7);
    user.write("big.bin", huge);
    user.write("huge.log", huge);
    user.write("notes.md", "Notes, longer\n");
    user.write("tools/linter/README.md", "A repository of its own\n");
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: user.file("tools/linter") });
    const before = user.fingerprint();

    const { taken, prepared, data } = await withCapture((local) =>
      Effect.gen(function* () {
        const identity = yield* local.identify(user.repo);
        const { capture } = yield* local.capture({
          identity,
          base: "main",
          head: "working-tree",
          previous: null,
          description: null,
        });
        const prepared = yield* local.prepare({
          reviewId: REVIEW,
          key: identity.key,
          capture,
          previousHead: null,
        });
        return { taken: capture, prepared, data: inCheckout(prepared.worktree, "data.dat") };
      }),
    );

    expect(user.filterRan()).toBe(false);
    expect(user.fingerprint()).toBe(before);
    expect(prepared.snapshot.files.map((file) => file.path).toSorted()).toEqual([
      ".gitattributes",
      "notes.md",
    ]);
    expect(taken.leftOut).toEqual([
      { path: "big.bin", reason: "too-large", bytes: huge.length },
      { path: "data.dat", reason: "filtered", bytes: "changed on disk\n".length },
      { path: "huge.log", reason: "too-large", bytes: huge.length },
      { path: "tools/linter", reason: "nested-repository", bytes: null },
    ]);
    expect(data).toBe("committed\n");

    // The planted filter is live: the user's own git runs it.
    user.git("add", "data.dat");
    expect(user.filterRan()).toBe(true);
  });

  it("snapshots what git sees: no file through a symlinked folder, staged ignored files, line endings git converts", async () => {
    const user = userRepository();
    user.write(
      ".gitattributes",
      "*.bat text eol=crlf\n*.cfg text=auto\n*.enc working-tree-encoding=UTF-16\n",
    );
    user.write("gradlew.bat", "@echo off\nrem first\n");
    user.write("tool.bat", "@echo off\n");
    user.write("config/settings.txt", "inside\n");
    user.write("notes.md", "Notes\n");
    user.git("add", "-A");
    user.git("commit", "--quiet", "-m", "Base");
    user.git("checkout", "--quiet", "-b", "feature/scripts");
    // Checked out again, the batch files hold CRLF on disk as git writes them.
    NodeFs.rmSync(user.file("gradlew.bat"));
    NodeFs.rmSync(user.file("tool.bat"));
    user.git("checkout", "--", "gradlew.bat", "tool.bat");
    user.write("tool.bat", "@echo off\r\nrem changed\r\n");
    user.write("legacy.enc", "converted\n");
    // git reads a control byte as binary under `text=auto`, and keeps its CRLF.
    user.write("blob.cfg", new Uint8Array([1, 97, 13, 10]));
    const outside = NodePath.join(user.root, "outside");
    NodeFs.mkdirSync(outside);
    NodeFs.writeFileSync(NodePath.join(outside, "settings.txt"), "outside the repository\n");
    NodeFs.rmSync(user.file("config"), { recursive: true });
    NodeFs.symlinkSync(outside, user.file("config"));
    user.write(".gitignore", "config\nbuild/\n");
    user.write("build/out.txt", "forced\n");
    user.git("add", "-f", "build/out.txt");
    const before = user.fingerprint();

    const { taken, files, tool, blob } = await withCapture((local) =>
      Effect.gen(function* () {
        const identity = yield* local.identify(user.repo);
        const { capture } = yield* local.capture({
          identity,
          base: "main",
          head: "working-tree",
          previous: null,
          description: null,
        });
        const prepared = yield* local.prepare({
          reviewId: REVIEW,
          key: identity.key,
          capture,
          previousHead: null,
        });
        return {
          taken: capture,
          files: prepared.snapshot.files.map((file) => [file.path, file.status]).toSorted(),
          tool: yield* local.contents(identity.key, capture.headSha, "tool.bat"),
          blob: yield* local.contents(identity.key, capture.headSha, "blob.cfg"),
        };
      }),
    );

    expect(user.fingerprint()).toBe(before);
    expect(files).toEqual([
      [".gitignore", "added"],
      ["blob.cfg", "added"],
      ["build/out.txt", "added"],
      ["config/settings.txt", "removed"],
      ["tool.bat", "modified"],
    ]);
    expect(tool).toBe("@echo off\nrem changed\n");
    expect(blob).toBe("\u0001a\r\n");
    expect(taken.leftOut).toEqual([
      { path: "legacy.enc", reason: "filtered", bytes: "converted\n".length },
    ]);
  });

  it("ignores what the user's global ignore file names, unless the repository sets its own", async () => {
    const user = userRepository();
    user.write("notes.md", "Notes\n");
    user.git("add", "-A");
    user.git("commit", "--quiet", "-m", "Base");
    user.git("checkout", "--quiet", "-b", "feature/notes");
    user.write("notes.md", "Notes, longer\n");
    user.write(".DS_Store", "finder\n");
    user.write("draft.tmp", "draft\n");
    NodeFs.writeFileSync(NodePath.join(user.root, "global-ignore"), ".DS_Store\n");
    NodeFs.writeFileSync(
      NodePath.join(user.root, ".gitconfig"),
      "[core]\n\texcludesFile = ~/global-ignore\n",
    );
    const snapshotFiles = (reviewId: ReviewId) =>
      withCapture((local) =>
        Effect.gen(function* () {
          const identity = yield* local.identify(user.repo);
          const { capture } = yield* local.capture({
            identity,
            base: "main",
            head: "working-tree",
            previous: null,
            description: null,
          });
          const prepared = yield* local.prepare({
            reviewId,
            key: identity.key,
            capture,
            previousHead: null,
          });
          return prepared.snapshot.files.map((file) => file.path).toSorted();
        }),
      );

    const home = process.env.HOME;
    process.env.HOME = user.root;
    try {
      expect(await snapshotFiles(REVIEW)).toEqual(["draft.tmp", "notes.md"]);
      NodeFs.writeFileSync(NodePath.join(user.root, "repository-ignore"), "draft.tmp\n");
      user.git("config", "core.excludesFile", NodePath.join(user.root, "repository-ignore"));
      expect(await snapshotFiles(ReviewId.make("review-2"))).toEqual([".DS_Store", "notes.md"]);
    } finally {
      process.env.HOME = home;
    }
  });

  it("refuses what it can't snapshot faithfully", async () => {
    const empty = userRepository();
    const lone = userRepository();
    lone.write("a.txt", "a\n");
    lone.git("add", "-A");
    lone.git("commit", "--quiet", "-m", "A");
    lone.git("branch", "-m", "dev");
    const orphan = userRepository();
    orphan.write("a.txt", "a\n");
    orphan.git("add", "-A");
    orphan.git("commit", "--quiet", "-m", "A");
    orphan.git("checkout", "--quiet", "--orphan", "unrelated");
    orphan.write("a.txt", "b\n");
    orphan.git("commit", "--quiet", "-am", "B");
    const clean = userRepository();
    clean.write("a.txt", "a\n");
    clean.git("add", "-A");
    clean.git("commit", "--quiet", "-m", "A");
    const sparse = featureBranch();
    sparse.git("update-index", "--skip-worktree", "notes.md");
    const bareRepo = NodePath.join(clean.root, "bare.git");
    clean.git("init", "--quiet", "--bare", bareRepo);

    const reasons = await withCapture((local, home) =>
      Effect.gen(function* () {
        const insideHome = NodePath.join(home, "worktrees", "x");
        NodeFs.mkdirSync(insideHome, { recursive: true });
        NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: insideHome });
        const run = (repo: string, base: string | null) =>
          local.identify(repo).pipe(
            Effect.flatMap((identity) =>
              local.capture({
                identity,
                base,
                head: "working-tree",
                previous: null,
                description: null,
              }),
            ),
          );
        return {
          relative: yield* refusal(local.identify("widgets")),
          notRepository: yield* refusal(local.identify(empty.root)),
          bare: yield* refusal(local.identify(bareRepo)),
          prkitCheckout: yield* refusal(local.identify(insideHome)),
          noBranch: yield* refusal(local.identify(clean.repo, "nope")),
          noCommits: yield* refusal(run(empty.repo, null)),
          noBase: yield* refusal(run(lone.repo, null)),
          askedBase: yield* refusal(run(clean.repo, "nope")),
          noSharedHistory: yield* refusal(run(orphan.repo, "main")),
          nothingChanged: yield* refusal(run(clean.repo, null)),
          sparse: yield* refusal(run(sparse.repo, null)),
        };
      }),
    );

    expect(reasons).toEqual({
      relative: "not-a-repository",
      notRepository: "not-a-repository",
      bare: "bare-repository",
      prkitCheckout: "prkit-checkout",
      noBranch: "branch-not-found",
      noCommits: "no-commits",
      noBase: "base-not-found",
      askedBase: "base-not-found",
      noSharedHistory: "no-shared-history",
      nothingChanged: "nothing-changed",
      sparse: "sparse-checkout",
    });
  });

  it("names one review per branch, repeats a run as the same capture, and builds on the last one", async () => {
    const user = featureBranch();

    const seen = await withCapture((local) =>
      Effect.gen(function* () {
        const identity = yield* local.identify(user.repo);
        const fromFolder = yield* local.identify(user.file("src"));
        const onMain = yield* local.identify(user.repo, "main");
        const run = (previous: LocalCapture | null, base: string | null = null) =>
          local.capture({ identity, base, head: "working-tree", previous, description: null });
        const first = yield* run(null);
        const again = yield* run(first.capture);

        user.git("commit", "--quiet", "-am", "Enable limits");
        user.write("notes.md", "Notes, longer\n");
        const second = yield* run(first.capture);
        const updated = yield* local.prepare({
          reviewId: REVIEW,
          key: identity.key,
          capture: second.capture,
          previousHead: first.capture.headSha,
        });
        const rebased = yield* run(second.capture, second.capture.commits[0]?.sha ?? null);
        const rewritten = yield* local.prepare({
          reviewId: REVIEW,
          key: identity.key,
          capture: rebased.capture,
          previousHead: second.capture.headSha,
        });
        const committed = yield* local.capture({
          identity,
          base: null,
          head: "branch",
          previous: null,
          description: null,
        });
        const branchOnly = yield* local.prepare({
          reviewId: ReviewId.make("review-2"),
          key: identity.key,
          capture: committed.capture,
          previousHead: null,
        });

        yield* local.forget(identity.key);
        yield* local.forget(identity.key);
        const afterForget = yield* local.contents(identity.key, first.capture.headSha, "notes.md");
        return {
          keys: { identity: identity.key, fromFolder: fromFolder.key, onMain: onMain.key },
          first,
          again,
          second,
          updated,
          rewritten,
          committed,
          branchOnly,
          afterForget,
        };
      }),
    );

    expect(seen.keys.fromFolder).toBe(seen.keys.identity);
    expect(seen.keys.onMain).not.toBe(seen.keys.identity);

    expect(seen.first.sameAsPrevious).toBe(false);
    expect(seen.again.sameAsPrevious).toBe(true);
    expect(seen.again.capture.headSha).toBe(seen.first.capture.headSha);
    expect(seen.again.capture.mergeBaseSha).toBe(seen.first.capture.mergeBaseSha);

    expect(seen.second.sameAsPrevious).toBe(false);
    expect(seen.second.capture.newCommits?.map((commit) => commit.subject)).toEqual([
      "Enable limits",
    ]);
    expect(seen.second.capture.commits.map((commit) => commit.subject)).toEqual([
      "Raise the limit",
      "Enable limits",
    ]);
    expect(seen.updated.since._tag).toBe("descends");
    expect(
      seen.updated.since._tag === "descends"
        ? seen.updated.since.snapshot.files.map((file) => file.path)
        : [],
    ).toEqual(["notes.md"]);
    expect(seen.updated.snapshot.files.map((file) => file.path)).toContain("src/limits.ts");
    expect(seen.rewritten.since).toEqual({ _tag: "rewritten" });

    expect(seen.committed.capture).toMatchObject({ head: "branch", uncommitted: false });
    // The branch's last commit holds every tracked change, but not the untracked file or the
    // edit made after it.
    expect(seen.branchOnly.snapshot.files.map((file) => file.path).toSorted()).toEqual([
      "assets/logo.bin",
      "limits-link",
      "run.sh",
      "src/limits.ts",
      "src/retired.ts",
      "src/staged.ts",
    ]);
    expect(seen.afterForget).toBeNull();
  });
});
