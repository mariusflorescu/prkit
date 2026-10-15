import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { repoRoot } from "../scripts/verify-run.ts";

/** Real local git objects behind a transport stand-in; no production transport changes. */
export const outsideGit = (name: string, { fetches = true } = {}) => {
  const root = NodePath.join(repoRoot, ".e2e", "fake", `${name}-git`);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  const source = NodePath.join(root, "source");
  const realGit = NodeChildProcess.execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync(realGit, args, {
      cwd: source,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  NodeFS.mkdirSync(NodePath.join(source, "src"), { recursive: true });
  git("init", "-q", "-b", "main");
  NodeFS.writeFileSync(
    NodePath.join(source, "src", "limits.ts"),
    'export const limits = {\n  url: 1024,\n  title: 120,\n};\n\nexport const schemes = ["http", "https"];\n',
  );
  git("add", ".");
  git("commit", "-qm", "Base fixture");
  for (const number of [1, 2, 9]) {
    git("checkout", "-qb", `feature-${number}`, number === 2 ? "feature-1" : "main");
    NodeFS.writeFileSync(
      NodePath.join(source, "src", "change-0.ts"),
      `${Array.from({ length: 1600 }, (_, index) => `// Fixture detail ${index}`).join("\n")}\nexport const change0 = "Start fixture ${number}";\n`,
    );
    if (number === 9)
      NodeFS.writeFileSync(
        NodePath.join(source, "src", "limits.ts"),
        'export const limits = {\n  url: 2048,\n  slug: 64,\n  title: 120,\n};\n\nexport const schemes = ["http", "https"];\n',
      );
    git("add", ".");
    git("commit", "-qm", `Fixture ${number}`);
    git("update-ref", `refs/pull/${number}/head`, "HEAD");
  }
  const pushLog = NodePath.join(root, "pushes.jsonl");
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin);
  // Redirect fetches to this fixture only. Keep the app's pinned git config and real git
  // for every operation. A push is refused even if the app unexpectedly tries one.
  NodeFS.writeFileSync(
    NodePath.join(bin, "git"),
    `#!${process.execPath}
import * as cp from "node:child_process";
import * as fs from "node:fs";
const args = process.argv.slice(2).filter((arg) => arg !== "--filter=blob:none");
if (args.includes("push")) { fs.appendFileSync(${JSON.stringify(pushLog)}, JSON.stringify(args) + "\\n"); process.stderr.write("Fixture refuses pushes\\n"); process.exit(1); }
if (args.includes("fetch") || args.includes("ls-remote")) {
  if (!${String(fetches)}) { process.stderr.write("Fixture refuses fetches\\n"); process.exit(1); }
  const at = args.findIndex((arg) => arg === "origin" || arg === "https://github.com/budget/fixtures.git");
  if (at < 0) { process.stderr.write("Fixture refuses another remote\\n"); process.exit(1); }
  args[at] = ${JSON.stringify(source)};
  args.unshift("-c", "protocol.file.allow=always");
}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );

  /** Apply only while the supervisor is spawned; its children retain this PATH. */
  const start = <A>(launch: () => A) => {
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    try {
      return launch();
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  };
  return {
    start,
    pushes: () =>
      NodeFS.existsSync(pushLog)
        ? NodeFS.readFileSync(pushLog, "utf8")
            .trim()
            .split("\n")
            .map((line) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(line),
            )
        : [],
  };
};
