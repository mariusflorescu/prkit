/**
 * Release versions and release notes from conventional commits, worked out by git-cliff with
 * the root cliff.toml. Runs in the git repository of the current directory.
 *
 *   node scripts/release-version.ts next
 *     The next stable version (`0.2.0`) from the commits since the last `vX.Y.Z` tag.
 *     Nightly tags never count. Prints nothing when no commit is a feat, fix, perf or
 *     breaking change, because then there is nothing to release.
 *   node scripts/release-version.ts nightly --date 20261014 --run 7
 *     `<next>-nightly.20261014.7`, or nothing when `next` prints nothing.
 *   node scripts/release-version.ts notes --version 0.2.0 [--from <ref>] [--to <ref>]
 *     Markdown for the release body, from the commits in from..to. `--to` defaults to HEAD,
 *     and without `--from` the notes start at the first commit.
 *   node scripts/release-version.ts manifest-notes --version 0.2.0 [--from <ref>] [--to <ref>]
 *     The update manifest's `releaseNotes` as JSON: `[{"version","note"}]`, newest first. The
 *     first entry is what `notes` prints; then come the releases before it on its track (stable
 *     or nightly), from the tags merged into `--to`, at most 10 in all.
 *
 * Every subcommand exits 0 when it worked, also when it printed nothing, and 1 with the reason
 * on stderr otherwise. PR links point at `--repository owner/name`, else GITHUB_REPOSITORY,
 * else the GitHub repository of the origin remote.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { childEnv } from "@prkit/contracts";
import * as Schema from "effect/Schema";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const config = NodePath.join(repoRoot, "cliff.toml");
const gitCliff = NodePath.join(repoRoot, "node_modules", ".bin", "git-cliff");

const stableVersion = /^\d+\.\d+\.\d+$/;
const stableTag = /^v\d+\.\d+\.\d+$/;
const nightlyTag = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
/** The app shows six versions and says when it left older ones out, so ten is plenty. */
const MANIFEST_RELEASES = 10;
const repositoryName = /^[\w.-]+\/[\w.-]+$/;

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    date: { type: "string" },
    run: { type: "string" },
    version: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    repository: { type: "string" },
  },
});

const Context = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      version: Schema.NullOr(Schema.String),
      commits: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
);

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const run = (command: string, args: ReadonlyArray<string>) => {
  // The allowlisted environment keeps GITHUB_TOKEN and GIT_CLIFF_* away from git-cliff, so it
  // can neither reach GitHub nor read a configuration other than cliff.toml.
  const result = NodeChildProcess.spawnSync(command, args, {
    env: childEnv(process.env),
    encoding: "utf8",
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const cliff = (args: ReadonlyArray<string>) => {
  const result = run(gitCliff, ["--config", config, "--offline", ...args]);
  if (result.ok) return result.stdout;
  const reason = result.stderr
    // oxlint-disable-next-line no-control-regex -- git-cliff colors its log lines.
    .replaceAll(/\u001B\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => line.startsWith("ERROR"))
    .join("\n");
  return fail(`git-cliff failed${reason.length > 0 ? `:\n${reason}` : "."}`);
};

const commitOf = (ref: string) => {
  const result = run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : fail(`${ref} is not a commit in this repository.`);
};

const nextVersion = () => {
  const releases = Schema.decodeSync(Context)(cliff(["--unreleased", "--bump", "--context"]));
  const unreleased = releases[0];
  if (unreleased === undefined || unreleased.commits.length === 0) {
    console.error(
      "Nothing to release: no feat, fix, perf or breaking commit since the last release.",
    );
    return undefined;
  }
  const version = (unreleased.version ?? "").replace(/^v/, "");
  return stableVersion.test(version)
    ? version
    : fail(`git-cliff picked "${version}", which is not a version like 1.2.3.`);
};

const originRepository = () => {
  const url = run("git", ["remote", "get-url", "origin"]).stdout.trim();
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
};

const notes = (version: string, from: string | undefined, to: string) => {
  const repository = values.repository ?? process.env.GITHUB_REPOSITORY ?? originRepository() ?? "";
  if (!repositoryName.test(repository))
    fail("Pass --repository owner/name: the PR links need the GitHub repository.");
  const head = commitOf(to);
  const range = from === undefined ? [head] : [`${commitOf(from)}..${head}`];
  const body = cliff([
    "--github-repo",
    repository,
    "--tag",
    `v${version}`,
    // One flat list for the whole range, even when it spans other release tags.
    "--ignore-tags",
    ".*",
    "--strip",
    "all",
    ...range,
  ]).trim();
  return body.length > 0 ? body : "No user-facing changes in this release.";
};

const earlierReleases = (version: string, to: string) => {
  const track = nightlyTag.test(`v${version}`) ? nightlyTag : stableTag;
  const tags = run("git", ["tag", "--list", "--merged", commitOf(to), "--sort=v:refname", "v*"]);
  if (!tags.ok) fail(`git couldn't list the tags merged into ${to}:\n${tags.stderr.trim()}`);
  return tags.stdout.split("\n").filter((tag) => track.test(tag) && tag !== `v${version}`);
};

/**
 * `version`'s notes, then each earlier release of its track with the notes it was published
 * with, from the release before it. The oldest nightly tag left is skipped: its notes start at a
 * nightly the release workflow may have deleted. The first stable's start at the first commit.
 */
const manifestNotes = (version: string, from: string | undefined, to: string) => {
  const tags = earlierReleases(version, to);
  const nightly = nightlyTag.test(`v${version}`);
  const earlier = tags
    .map((tag, index) => ({ tag, previous: tags[index - 1] }))
    .filter((release) => !nightly || release.previous !== undefined)
    .toReversed()
    .slice(0, MANIFEST_RELEASES - 1)
    .map(({ tag, previous }) => ({
      version: tag.slice(1),
      note: notes(tag.slice(1), previous, tag),
    }));
  return [{ version, note: notes(version, from, to) }, ...earlier];
};

const subcommand = positionals[0];
if (subcommand === "next") {
  const version = nextVersion();
  if (version !== undefined) console.log(version);
} else if (subcommand === "nightly") {
  const date = values.date ?? "";
  const runNumber = values.run ?? "";
  if (!/^\d{8}$/.test(date)) fail("--date must be the UTC date as YYYYMMDD.");
  if (!/^[1-9]\d*$/.test(runNumber)) fail("--run must be a positive whole number.");
  const version = nextVersion();
  if (version !== undefined) console.log(`${version}-nightly.${date}.${runNumber}`);
} else if (subcommand === "notes" || subcommand === "manifest-notes") {
  const version = values.version ?? "";
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version))
    fail("--version must be a version like 1.2.3 or 1.2.3-nightly.20261014.7.");
  const to = values.to ?? "HEAD";
  console.log(
    subcommand === "notes"
      ? notes(version, values.from, to)
      : JSON.stringify(manifestNotes(version, values.from, to)),
  );
} else {
  fail(
    "Usage: release-version next | nightly --date YYYYMMDD --run N | notes --version V | manifest-notes --version V",
  );
}
