import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { FakeGitHub } from "./fakeGitHub.ts";

/** Real local git objects behind the API fake. No git request can leave the journey's HOME. */
export const cliFixture = async (fake: FakeGitHub) => {
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
  git(["init", "--initial-branch=main"]);
  NodeFS.mkdirSync(NodePath.join(repo, "src"));
  NodeFS.writeFileSync(NodePath.join(repo, "src/limits.ts"), "export const limit = 1;\n");
  git(["add", "src/limits.ts"]);
  git(["commit", "-m", "Base"]);
  git(["checkout", "-b", "change"]);
  NodeFS.writeFileSync(
    NodePath.join(repo, "src/limits.ts"),
    "export const limit = 2;\nexport const enabled = true;\n",
  );
  git(["add", "src/limits.ts"]);
  git(["commit", "-m", "Change limit"]);
  const head = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/pull/9/head", head]);
  git(["update-ref", "refs/heads/feature-9", head]);
  await fetch(`${fake.url}/__fake/git-head?pr=9&sha=${head}`, { method: "POST" });
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
  return { path: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, head };
};
