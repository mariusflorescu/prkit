/**
 * The owner's own values, kept in gitignored files so none of them is ever committed:
 * `.private-names`, the names check:private refuses, and `.e2e/local.json`, the fixture
 * repository the journeys and website shots use. A linked worktree has no copy of its own,
 * so it reads the main checkout's.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const mainCheckout = () => {
  try {
    const common = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return [NodePath.dirname(common)];
  } catch {
    return [];
  }
};

const localFile = (relative: string) =>
  [repoRoot, ...mainCheckout()]
    .map((root) => NodePath.join(root, relative))
    .find((path) => NodeFS.existsSync(path));

/** Each name in `.private-names` with its line number; `#` starts a comment. */
export const privateNames = () => {
  const path = localFile(".private-names");
  if (path === undefined) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      const name = line.replace(/#.*/, "").trim();
      return name.length > 0 ? [{ name, line: index + 1 }] : [];
    });
};

const LocalConfig = Schema.fromJsonString(
  Schema.Struct({ fixtureRepo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)) }),
);

/** `.e2e/local.json`, as `{ "fixtureRepo": "<owner>/<name>" }`; undefined when there is none. */
export const readLocalConfig = () => {
  const path = localFile(".e2e/local.json");
  return path === undefined
    ? undefined
    : Schema.decodeSync(LocalConfig)(NodeFS.readFileSync(path, "utf8"));
};
