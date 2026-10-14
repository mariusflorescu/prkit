/**
 * Fails when a file in the repository names something private: a login of any gh account on
 * this machine, an entry of the gitignored `.private-names` denylist (one name per line, `#`
 * starts a comment), or the current user's home path. The names are read at run time and
 * never printed; each match shows its file, line and category.
 *
 *   node scripts/check-private.ts          tracked and untracked files that are not ignored
 *   node scripts/check-private.ts <file>   only these files, such as a commit message
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { privateNames } from "./localConfig.ts";
import { repoRoot } from "./verify-run.ts";

type Needle = { readonly text: string; readonly category: string };

const ghBinary = () => {
  try {
    return NodeChildProcess.execFileSync("mise", ["which", "gh"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "gh";
  }
};

const configDirs = () => {
  const root = NodePath.join(NodeOs.homedir(), ".config");
  if (!NodeFS.existsSync(root)) return [];
  return NodeFS.readdirSync(root)
    .filter((name) => name === "gh" || name.startsWith("gh-"))
    .map((name) => NodePath.join(root, name))
    .filter((dir) => NodeFS.existsSync(NodePath.join(dir, "hosts.yml")));
};

/** Every login in every gh config dir, read by gh itself so no token is touched here. */
const accountLogins = () => {
  const gh = ghBinary();
  const dirs = configDirs();
  const logins = dirs.flatMap((dir, index) => {
    const listed = NodeChildProcess.spawnSync(
      gh,
      ["auth", "status", "--json", "hosts", "--jq", ".hosts[][].login"],
      {
        // A clean environment: GH_TOKEN or a tool's GH_CONFIG_DIR would name another account.
        env: { HOME: NodeOs.homedir(), PATH: process.env.PATH ?? "", GH_CONFIG_DIR: dir },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const found = (listed.stdout ?? "").split("\n").filter((login) => login.length > 0);
    if (found.length === 0)
      console.warn(`gh could not list the accounts of gh config dir ${index + 1}.`);
    return found;
  });
  return { dirs: dirs.length, logins: [...new Set(logins)] };
};

const listFiles = () =>
  NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (path) =>
        path.length > 0 &&
        NodeFS.statSync(NodePath.join(repoRoot, path), { throwIfNoEntry: false })?.isFile() ===
          true,
    );

const accounts = accountLogins();
const denied = privateNames().map(({ name, line }) => ({
  text: name.toLowerCase(),
  category: `denylist entry ${line}`,
}));
const needles: ReadonlyArray<Needle> = [
  ...accounts.logins.map((login) => ({ text: login.toLowerCase(), category: "account login" })),
  ...denied,
  { text: NodeOs.homedir().toLowerCase(), category: "home path" },
];

const redact = (text: string) =>
  needles.reduce(
    (redacted, needle) =>
      redacted.replaceAll(
        new RegExp(needle.text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        `<${needle.category}>`,
      ),
    text,
  );

const matches = (text: string, where: (needle: Needle) => string) =>
  needles.filter((needle) => text.toLowerCase().includes(needle.text)).map(where);

const scan = (path: string, shown: string) => {
  const content = NodeFS.readFileSync(path);
  if (content.includes(0)) return [];
  return content
    .toString("utf8")
    .split("\n")
    .flatMap((line, index) =>
      matches(line, (needle) => `${shown}:${index + 1}: ${needle.category}`),
    );
};

const given = process.argv.slice(2);
const files = given.length > 0 ? given : listFiles();
const hits =
  given.length > 0
    ? given.flatMap((file, index) => scan(file, `file ${index + 1}`))
    : files.flatMap((file) => {
        const shown = redact(file);
        return [
          ...matches(file, (needle) => `${shown}: file name (${needle.category})`),
          ...scan(NodePath.join(repoRoot, file), shown),
        ];
      });

console.log(
  `Checked ${files.length} files for ${accounts.logins.length} account logins from ${accounts.dirs} gh config dirs, ${denied.length} denylist entries and the home path.`,
);
if (hits.length > 0) {
  console.error(
    `${hits.length} private names:\n${hits.join("\n")}\nDescribe them generically, or read them at run time from a gitignored file.`,
  );
  process.exit(1);
}
