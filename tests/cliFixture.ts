import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { FakeGitHub } from "./fakeGitHub.ts";

type Files = Readonly<Record<string, string>>;

const DEFAULT_FILES: { readonly base: Files; readonly head: Files } = {
  base: { "src/limits.ts": "export const limit = 1;\n" },
  head: { "src/limits.ts": "export const limit = 2;\nexport const enabled = true;\n" },
};

/**
 * Real local git objects behind the API fake. No git request can leave the journey's HOME.
 * `files` are the base of PR 9 and the head's changes on top of it.
 */
export const cliFixture = async (fake: FakeGitHub, files = DEFAULT_FILES) => {
  const repo = NodePath.join(fake.home, "source");
  const bin = NodePath.join(fake.home, "git-bin");
  NodeFS.mkdirSync(repo, { recursive: true });
  NodeFS.mkdirSync(bin, { recursive: true });
  const realGit = NodeChildProcess.execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  const git = (args: string[]) =>
    NodeChildProcess.execFileSync(realGit, ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: fake.home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  const write = (changes: Files) => {
    for (const [path, content] of Object.entries(changes)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(repo, path), content);
    }
    git(["add", ...Object.keys(changes)]);
  };
  const advance = async (message: string) => {
    git(["commit", "-m", message]);
    const head = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/pull/9/head", head]);
    git(["update-ref", "refs/heads/feature-9", head]);
    await fetch(`${fake.url}/__fake/git-head?pr=9&sha=${head}`, { method: "POST" });
    return head;
  };
  git(["init", "--initial-branch=main"]);
  write(files.base);
  git(["commit", "-m", "Base"]);
  git(["checkout", "-b", "change"]);
  write(files.head);
  const head = await advance("Change limit");
  const script = NodePath.join(bin, "git.mjs");
  NodeFS.writeFileSync(
    script,
    `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('push') || args.includes('clone')) throw new Error('This fixture never pushes or clones.');
if (args.includes('fetch')) {
  const remote = args.indexOf('origin');
  if (remote < 0) throw new Error('Unexpected fetch remote.');
  args[remote] = ${JSON.stringify(repo)};
  const filter = args.indexOf('--filter=blob:none');
  if (filter >= 0) args.splice(filter, 1);
  args.unshift('-c', 'protocol.file.allow=always');
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "git"),
    `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o700 },
  );
  return {
    path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    head,
    /** A new commit on the PR's branch with these files changed; answers its sha. */
    commit: async (changes: Files, message: string) => {
      write(changes);
      return advance(message);
    },
  };
};
