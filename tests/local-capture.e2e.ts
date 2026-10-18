import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  GenerateLocalGuideResult,
  LocalGuideResult,
  LocalWaitResult,
} from "../apps/server/src/outside/schemas.ts";
import { DiffSnapshot } from "../packages/contracts/src/diffSnapshot.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, scratchRoot, switchOn } from "./localGuideSession.ts";
import { fixtureGit } from "./localRepoFixture.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const decodeRead = Schema.decodeSync(Schema.fromJsonString(LocalGuideResult));
const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));
const decodeSnapshots = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ snapshot: Schema.fromJsonString(DiffSnapshot) })),
);

/** `files` committed on `main`, with `origin/main` there and `feature/work` checked out. */
const repository = (root: string, name: string, files: Readonly<Record<string, string>>) => {
  const repo = NodePath.join(root, name);
  NodeFS.mkdirSync(repo, { recursive: true });
  const git = fixtureGit(root, repo);
  const write = (path: string, content: string) => {
    const file = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  };
  git(["init", "--initial-branch=main"]);
  for (const [path, content] of Object.entries(files)) write(path, content);
  git(["add", "-A"]);
  git(["commit", "-m", "Base"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["checkout", "-b", "feature/work"]);
  return { repo, git, write };
};

const STATUS = new Map([
  ["A", "added"],
  ["M", "modified"],
  ["D", "removed"],
]);

/**
 * The change git shows the user: `git diff` of the working tree against the merge base, which
 * takes a file git already hashed from the index, and untracked files as added. With optional
 * locks off, git refreshes nothing.
 */
const gitView = (git: ReturnType<typeof fixtureGit>) => {
  const read = (args: ReadonlyArray<string>) =>
    git(args, { GIT_OPTIONAL_LOCKS: "0" })
      .split("\0")
      .filter((field) => field !== "");
  const tracked = read([
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    git(["merge-base", "origin/main", "HEAD"]),
  ]);
  return [
    ...tracked.flatMap((field, index) =>
      index % 2 === 0 ? [] : [`${STATUS.get(tracked[index - 1] ?? "")} ${field}`],
    ),
    ...read(["ls-files", "--others", "--exclude-standard", "-z"]).map((path) => `added ${path}`),
  ].toSorted();
};

/** Every entry under `top` by size, mtime and mode, and with `contents` every file's bytes. */
const treeHash = (top: string, contents: boolean, skip: string | null = null) => {
  const hash = NodeCrypto.createHash("sha256");
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).toSorted(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      const path = NodePath.join(directory, entry.name);
      if (path === skip) continue;
      const stat = NodeFS.lstatSync(path, { bigint: true });
      hash.update(`${NodePath.relative(top, path)} ${stat.size} ${stat.mtimeNs} ${stat.mode}\n`);
      if (entry.isDirectory()) walk(path);
      else if (contents && entry.isFile()) hash.update(NodeFS.readFileSync(path));
    }
  };
  walk(top);
  return hash.digest("hex");
};

/** The user's index byte for byte, everything else in `.git`, and the working tree with its contents. */
const repositoryState = (repo: string) => {
  const gitDir = NodePath.join(repo, ".git");
  return {
    index: NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(gitDir, "index")))
      .digest("hex"),
    gitDir: treeHash(gitDir, false),
    workTree: treeHash(repo, true, gitDir),
  };
};

test(
  "a guide of local changes snapshots the change git shows, staged line endings included, and leaves the index and working tree as they were",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "local-capture";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const filterMark = NodePath.join(root, "filter-ran");
    const log: Array<string> = [];
    try {
      const run = startFakeInstance(name, fake, [
        "--claude",
        claude.file,
        "--watch-interval",
        "600000",
      ]);
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      await switchOn({ app, screen, browser }, run.openUrl);

      /** Guides `repo`'s working tree from the CLI; the repository must read the same after. */
      const guide = (repo: string) => {
        const before = repositoryState(repo);
        const started = cli(repo, ["local", "guide", "--json"]);
        expect(started.code).toBe(0);
        const key = decodeGenerate(started.stdout).status.key;
        const waited = decodeWait(
          cli(repo, ["local", "wait", "--timeout", "120", "--json"]).stdout,
        );
        expect(waited.status.state).toBe("ready");
        const leftOut = decodeRead(cli(repo, ["local", "read", "--json"]).stdout).status.run
          ?.leftOut;
        expect(repositoryState(repo)).toEqual(before);
        const files =
          decodeSnapshots(
            readRows(
              run.home,
              `SELECT a.snapshot FROM review_attempts a JOIN reviews r ON r.id = a.review_id
               WHERE r.pr_key = '${key}' ORDER BY a.rowid DESC LIMIT 1`,
            ),
          ).at(-1)?.snapshot.files ?? [];
        const patchOf = (path: string) => {
          const patch = files.find((file) => file.path === path)?.patch;
          return patch?._tag === "text" ? patch.patch : "";
        };
        return {
          files: files.map((file) => `${file.status} ${file.path}`).toSorted(),
          patchOf,
          leftOut: leftOut?.map((file) => `${file.reason} ${file.path}`),
        };
      };

      // A plain branch: a commit, then unstaged, staged, staged-then-edited, staged-then-undone,
      // deleted, untracked, ignored and executable changes.
      const widgets = repository(root, "widgets", {
        ".gitignore": "dist/\n",
        "README.md": "Widgets\n",
        "notes.md": "Notes\n",
        "run.sh": "echo widgets\n",
        "src/flags.ts": "export const flags = [];\n",
        "src/limits.ts": "export const limit = 1;\n",
        "src/retired.ts": "export const retired = true;\n",
      });
      widgets.write("src/limits.ts", "export const limit = 2;\n");
      widgets.git(["commit", "-am", "Raise the limit"]);
      widgets.write("README.md", "Widgets, with limits\n");
      widgets.write("src/staged.ts", "export const staged = true;\n");
      widgets.write("src/flags.ts", "export const flags = ['limits'];\n");
      widgets.write("notes.md", "Notes, staged\n");
      widgets.git(["add", "src/staged.ts", "src/flags.ts", "notes.md"]);
      widgets.write("src/flags.ts", "export const flags = ['limits', 'retired'];\n");
      widgets.write("notes.md", "Notes\n");
      NodeFS.rmSync(NodePath.join(widgets.repo, "src/retired.ts"));
      widgets.write("docs/limits.md", "# Limits\n");
      widgets.write("dist/out.js", "built\n");
      NodeFS.chmodSync(NodePath.join(widgets.repo, "run.sh"), 0o755);
      const plain = guide(widgets.repo);
      expect(plain.files).toEqual(gitView(widgets.git));
      expect(plain.files).toEqual([
        "added docs/limits.md",
        "added src/staged.ts",
        "modified README.md",
        "modified run.sh",
        "modified src/flags.ts",
        "modified src/limits.ts",
        "removed src/retired.ts",
      ]);
      expect(plain.patchOf("src/flags.ts")).toContain(
        "+export const flags = ['limits', 'retired'];",
      );
      expect(plain.leftOut).toEqual([]);

      // Line endings committed as CRLF, then `.gitattributes` and `git add --renormalize`: the
      // files on disk still hold HEAD's bytes, and the index holds them with LF.
      const endings = repository(root, "endings", {
        "README.md": "Endings\n",
        "build.sh": "echo one\r\necho two\r\n",
        "notes.txt": "one\r\ntwo\r\n",
      });
      endings.write(".gitattributes", "*.txt text=auto\n*.sh text eol=lf\n");
      endings.git(["add", ".gitattributes"]);
      endings.git(["add", "--renormalize", "."]);
      const renormalized = guide(endings.repo);
      expect(gitView(endings.git)).toEqual([
        "added .gitattributes",
        "modified build.sh",
        "modified notes.txt",
      ]);
      expect(renormalized.files).toEqual(gitView(endings.git));
      expect(renormalized.patchOf("notes.txt")).toContain("-one\r\n-two\r\n+one\n+two\n");
      expect(renormalized.patchOf("build.sh")).toContain("-echo one\r\n-echo two\r\n+echo one\n");

      // The same through `core.autocrlf`, with no attributes at all.
      const autocrlf = repository(root, "autocrlf", {
        "README.md": "Line endings\n",
        "notes.txt": "one\r\ntwo\r\n",
      });
      autocrlf.git(["config", "core.autocrlf", "true"]);
      autocrlf.git(["add", "--renormalize", "."]);
      const converted = guide(autocrlf.repo);
      expect(gitView(autocrlf.git)).toEqual(["modified notes.txt"]);
      expect(converted.files).toEqual(gitView(autocrlf.git));
      expect(converted.patchOf("notes.txt")).toContain("-one\r\n-two\r\n+one\n+two\n");

      // With `core.fileMode` off, git takes the executable bit from the index, not the disk.
      const modes = repository(root, "modes", { "README.md": "Modes\n", "run.sh": "echo run\n" });
      modes.git(["config", "core.fileMode", "false"]);
      modes.git(["update-index", "--chmod=+x", "run.sh"]);
      const executable = guide(modes.repo);
      expect(gitView(modes.git)).toEqual(["modified run.sh"]);
      expect(executable.files).toEqual(gitView(modes.git));
      expect(executable.patchOf("run.sh")).toContain("new mode 100755");

      // A clean filter, then `git add --renormalize`: prkit runs no filter, so the file is left
      // out and named, never read as unchanged.
      const filtered = repository(root, "filtered", {
        ".gitattributes": "*.dat filter=upper\n",
        "data.dat": "hello\n",
        "notes.md": "Notes\n",
      });
      filtered.git(["config", "filter.upper.clean", `touch '${filterMark}'; tr a-z A-Z`]);
      filtered.git(["config", "filter.upper.smudge", "cat"]);
      filtered.git(["add", "--renormalize", "."]);
      expect(gitView(filtered.git)).toEqual(["modified data.dat"]);
      NodeFS.rmSync(filterMark, { force: true });
      const untouched = repositoryState(filtered.repo);
      const refused = cli(filtered.repo, ["local", "guide"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("`data.dat`");
      expect(refused.stderr).toContain("filter");
      expect(repositoryState(filtered.repo)).toEqual(untouched);
      filtered.write("notes.md", "Notes, longer\n");
      const withFilter = guide(filtered.repo);
      expect(NodeFS.existsSync(filterMark)).toBe(false);
      expect(withFilter.files).toEqual(["modified notes.md"]);
      expect(withFilter.leftOut).toEqual(["filtered data.dat"]);
      expect(gitView(filtered.git)).toEqual(["modified data.dat", "modified notes.md"]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
      const evidence = NodePath.join(import.meta.dirname, "../.e2e/evidence", name);
      NodeFS.mkdirSync(evidence, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(evidence, "cli-transcript.txt"), log.join("\n\n"));
    }
  },
);
