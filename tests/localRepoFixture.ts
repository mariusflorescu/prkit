import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The base's long file, line by line; a journey changes one line to have unchanged ones around it. */
export const handbook = (changes: Readonly<Record<number, string>> = {}) =>
  Array.from(
    { length: 30 },
    (_, index) => changes[index + 1] ?? `Line ${index + 1} of the handbook.`,
  )
    .map((line) => `${line}\n`)
    .join("");

/**
 * A user's own repository for local guide journeys: `main` with an `origin/main` it was
 * branched from, a feature branch with one commit, then uncommitted, deleted, untracked
 * and ignored files. Its config names a clean filter that leaves a mark when it runs, so
 * a journey can prove prkit never runs anything the repository's config names. The base's
 * `docs/handbook.md` stays unchanged until a journey edits it.
 */
export const localRepoFixture = (root: string, name = "widgets") => {
  const repo = NodePath.join(root, name);
  const filterMark = NodePath.join(root, `${name}-filter-ran`);
  NodeFS.mkdirSync(repo, { recursive: true });
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  const write = (path: string, content: string | Buffer) => {
    const file = NodePath.join(repo, path);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  };

  git(["init", "--initial-branch=main"]);
  write(".gitignore", "node_modules/\n");
  write("src/limits.ts", "export const limit = 1;\n");
  write("src/retired.ts", "export const retired = true;\n");
  write("assets/logo.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  write("docs/handbook.md", handbook());
  NodeFS.symlinkSync("src/limits.ts", NodePath.join(repo, "limits-link"));
  git(["add", "-A"]);
  git(["commit", "-m", "Base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", base]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["checkout", "-b", "feature/limits"]);
  write("src/limits.ts", "export const limit = 2;\n");
  git(["commit", "-am", "Raise the limit"]);
  write("src/limits.ts", "export const limit = 2;\nexport const enabled = true;\n");
  NodeFS.rmSync(NodePath.join(repo, "src/retired.ts"));
  write("src/flags.ts", "export const flags = ['limits'];\n");
  write("node_modules/ignored.js", "ignored\n");
  write(".gitattributes", "*.ts filter=mark\n");
  git(["config", "filter.mark.clean", `touch '${filterMark}'; cat`]);
  NodeFS.rmSync(filterMark, { force: true });

  return {
    repo,
    base,
    git,
    write,
    /** True once anything ran the clean filter the repository's config names. */
    filterRan: () => NodeFS.existsSync(filterMark),
    /**
     * Every file of the repository's `.git` with its size, mtime and mode, hashed. Equal
     * fingerprints mean nothing wrote to the index, refs, objects, stash or config.
     */
    fingerprint: () => {
      const hash = NodeCrypto.createHash("sha256");
      const walk = (directory: string) => {
        for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).toSorted(
          (left, right) => left.name.localeCompare(right.name),
        )) {
          const path = NodePath.join(directory, entry.name);
          const stat = NodeFS.lstatSync(path);
          hash.update(
            `${NodePath.relative(repo, path)} ${stat.size} ${stat.mtimeMs} ${stat.mode}\n`,
          );
          if (entry.isDirectory()) walk(path);
        }
      };
      walk(NodePath.join(repo, ".git"));
      return hash.digest("hex");
    },
  };
};
