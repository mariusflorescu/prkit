/**
 * Fails when the built site names anything a GitHub account on this machine can see besides
 * prkit's own repositories: an organization, an account, or a repository with a pull request in
 * the inbox, plus every name in the gitignored `.private-names`. The names come from gh and that
 * file at run time, so none of them is ever written into the repo, and the output shows counts
 * and redacted context, never the names. The repositories the site may name are the one
 * GITHUB_URL points at and the fixture repository in `.e2e/local.json`.
 *
 *   pnpm build:www && pnpm --filter @prkit/www check:clients [--also name,name]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import { privateNames, readLocalConfig } from "../../../scripts/localConfig.ts";
import { type Json, isObject, text } from "./clientSafeSocket.ts";

const OWN_REPOS = new Set(
  [
    new URL(process.env.GITHUB_URL ?? "https://github.com").pathname.slice(1),
    readLocalConfig()?.fixtureRepo ?? "",
  ]
    .map((repo) => repo.replace(/\/$/, "").toLowerCase())
    .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo)),
);
const OWN_LOGINS = new Set([...OWN_REPOS].map((repo) => repo.split("/")[0]));
const TEXT_FILES = new Set([".html", ".css", ".js", ".svg", ".json", ".txt", ".xml"]);
const dist = new URL("../dist/", import.meta.url).pathname;

const QUERY = `query {
  viewer { login organizations(first: 100) { nodes { login } } }
  requested: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 100) { ...repos }
  authored: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) { ...repos }
  involved: search(query: "is:pr is:open archived:false involves:@me", type: ISSUE, first: 100) { ...repos }
}
fragment repos on SearchResultItemConnection { nodes { ... on PullRequest { repository { nameWithOwner } } } }`;

const ghBinary = (): string => {
  try {
    return execFileSync("mise", ["which", "gh"], { encoding: "utf8" }).trim();
  } catch {
    return "gh";
  }
};

const configDirs = (): Array<string> => {
  const root = join(homedir(), ".config");
  return readdirSync(root)
    .filter((name) => name === "gh" || name.startsWith("gh-"))
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "hosts.yml")));
};

const nodes = (value: Json | undefined): Array<Json> =>
  isObject(value) && Array.isArray(value.nodes) ? value.nodes : [];

/** Every name one gh config dir's active account can see, minus prkit's own. */
const namesFor = (gh: string, dir: string): Array<string> => {
  const env = {
    HOME: homedir(),
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    GH_CONFIG_DIR: dir,
  };
  const output = execFileSync(gh, ["api", "graphql", "-f", `query=${QUERY}`], {
    env,
    encoding: "utf8",
  });
  const response: Json = JSON.parse(output);
  const data = isObject(response) && isObject(response.data) ? response.data : {};
  const viewer = isObject(data.viewer) ? data.viewer : {};
  const repos = ["requested", "authored", "involved"].flatMap((key) =>
    nodes(data[key]).map((node) =>
      isObject(node) && isObject(node.repository) ? text(node.repository.nameWithOwner) : "",
    ),
  );
  return [
    text(viewer.login),
    ...nodes(viewer.organizations).map((org) => (isObject(org) ? text(org.login) : "")),
    ...repos.filter((repo) => !OWN_REPOS.has(repo.toLowerCase())),
    ...repos.map((repo) => repo.split("/")[0] ?? ""),
  ].filter((name) => name.length > 0 && !OWN_LOGINS.has(name.toLowerCase()));
};

const filesUnder = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );

if (!existsSync(join(dist, "index.html"))) throw new Error("No build. Run pnpm build:www first.");

const alsoIndex = process.argv.indexOf("--also");
const also = alsoIndex > 0 ? (process.argv[alsoIndex + 1] ?? "").split(",") : [];
const gh = ghBinary();
const dirs = configDirs();
const unreadable: Array<string> = [];
const seen = dirs.flatMap((dir) => {
  try {
    return namesFor(gh, dir);
  } catch {
    unreadable.push(dir);
    return [];
  }
});
const listed = privateNames().map(({ name }) => name);
const names = new Set(
  [...seen, ...listed, ...also]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0),
);
const files = filesUnder(dist).filter((file) => TEXT_FILES.has(extname(file)));

const hits = files.flatMap((file) => {
  const content = readFileSync(file, "utf8").toLowerCase();
  return [...names].flatMap((name) => {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const at = content.search(new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`));
    if (at < 0) return [];
    return [
      `${file.slice(dist.length)}: …${content.slice(Math.max(0, at - 60), at)}<client name>…`,
    ];
  });
});

console.log(
  `Checked ${files.length} files in dist/ against ${names.size} names from ${dirs.length - unreadable.length} gh accounts, ${listed.length} .private-names entries${also.length > 0 ? ` and ${also.length} given names` : ""}.`,
);
if (unreadable.length > 0)
  console.warn(`gh could not read ${unreadable.length} config dirs; their names are not checked.`);
if (hits.length > 0) {
  console.error(`${hits.length} matches:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("No client names in the built site.");
