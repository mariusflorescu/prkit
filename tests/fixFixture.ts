import { FIXTURE_REPO } from "./fixturePr.ts";
import { gh, LIMITS, LIMITS_PATH, putFile, waitForPullRef } from "./reviewFixture.ts";

/** A test the fixture's `npm test` (node --test) runs, so the agent has a check script. */
export const LIMITS_TEST_PATH = "test/limits.test.js";
const LIMITS_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCode, checkUrl } from "../src/limits.js";

test("checkUrl blocks javascript links", () => {
  assert.equal(checkUrl("javascript:alert(1)"), "blocked-scheme");
});

test("checkCode rejects an empty code", () => {
  assert.equal(checkCode(""), "empty");
});
`;

export const CONFIG_PATH = "src/config.js";
const CONFIG = `// How long short links live and how many each user may create.
export const LINK_TTL_DAYS = 30;
export const MAX_LINKS_PER_USER = 100;
`;
/** The pull request's side: links live for a quarter. */
const CONFIG_HEAD = CONFIG.replace(
  "export const LINK_TTL_DAYS = 30;",
  "export const LINK_TTL_DAYS = 90; // A quarter, so campaign links outlive the campaign.",
);
/** The base's side, on the same lines: a shorter life, and more links per user. */
export const CONFIG_BASE = CONFIG.replace(
  "export const LINK_TTL_DAYS = 30;\nexport const MAX_LINKS_PER_USER = 100;",
  "export const LINK_TTL_DAYS = 60;\nexport const MAX_LINKS_PER_USER = 200;",
);
export const LOCKFILE_PATH = "pnpm-lock.yaml";
const LOCKFILE = `lockfileVersion: '9.0'

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-left}
`;
const LOCKFILE_HEAD = LOCKFILE.replace(
  "  left-pad@1.3.0:",
  "  nanoid@5.0.7:\n    resolution: {integrity: sha512-nanoid}\n\n  left-pad@1.3.0:",
);
export const LOCKFILE_BASE = LOCKFILE.replace(
  "  left-pad@1.3.0:",
  "  zod@3.23.8:\n    resolution: {integrity: sha512-zod}\n\n  left-pad@1.3.0:",
);

const branchFrom = (branch: string, from: string) => {
  const sha = gh([
    "api",
    `repos/${FIXTURE_REPO}/git/ref/heads/${from}`,
    "--jq",
    ".object.sha",
  ]).trim();
  gh([
    "api",
    "-X",
    "POST",
    `repos/${FIXTURE_REPO}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${sha}`,
  ]);
};

const openPull = (head: string, base: string, title: string, body: string) =>
  waitForPullRef(
    Number(
      gh([
        "api",
        "-X",
        "POST",
        `repos/${FIXTURE_REPO}/pulls`,
        "-f",
        `title=${title}`,
        "-f",
        `head=${head}`,
        "-f",
        `base=${base}`,
        "-f",
        `body=${body}`,
        "--jq",
        ".number",
      ]).trim(),
    ),
  );

export interface FixFixture {
  readonly number: number;
  readonly head: string;
  /** A base branch the fixture made for itself; null when it merges into main. */
  readonly base: string | null;
}

/**
 * Adds a submodule at `path` on `branch`, pinned to main's head: a commit whose tree has a
 * gitlink there, and a `.gitmodules` naming a URL nothing fetches. prkit's checkout holds an
 * empty folder at the path.
 */
const putSubmodule = (branch: string, path: string) => {
  const ref = `repos/${FIXTURE_REPO}/git/ref/heads/${branch}`;
  const parent = gh(["api", ref, "--jq", ".object.sha"]).trim();
  const baseTree = gh([
    "api",
    `repos/${FIXTURE_REPO}/git/commits/${parent}`,
    "--jq",
    ".tree.sha",
  ]).trim();
  const pinned = gh([
    "api",
    `repos/${FIXTURE_REPO}/git/ref/heads/main`,
    "--jq",
    ".object.sha",
  ]).trim();
  const tree = gh([
    "api",
    "-X",
    "POST",
    `repos/${FIXTURE_REPO}/git/trees`,
    "--jq",
    ".sha",
    "-f",
    `base_tree=${baseTree}`,
    "-f",
    `tree[][path]=${path}`,
    "-f",
    "tree[][mode]=160000",
    "-f",
    "tree[][type]=commit",
    "-f",
    `tree[][sha]=${pinned}`,
  ]).trim();
  const commit = gh([
    "api",
    "-X",
    "POST",
    `repos/${FIXTURE_REPO}/git/commits`,
    "--jq",
    ".sha",
    "-f",
    "message=chore: vendor the link library",
    "-f",
    `tree=${tree}`,
    "-f",
    `parents[]=${parent}`,
  ]).trim();
  gh([
    "api",
    "-X",
    "PATCH",
    `repos/${FIXTURE_REPO}/git/refs/heads/${branch}`,
    "-f",
    `sha=${commit}`,
  ]);
  putFile(
    branch,
    ".gitmodules",
    `[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.invalid/lib.git\n`,
    "chore: name the link library's source",
  );
};

/**
 * A PR of its own with `src/limits.js` and a test, so a fix run can run `npm test`. With
 * `submodule`, the PR also adds a submodule at that path.
 */
export const createFixFixture = (
  stamp: string,
  options: { readonly submodule?: string } = {},
): FixFixture => {
  const head = `e2e/fix-agent-${stamp}`;
  branchFrom(head, "main");
  putFile(head, LIMITS_PATH, LIMITS, "feat: check link limits");
  putFile(head, LIMITS_TEST_PATH, LIMITS_TEST, "test: cover the link limits");
  if (options.submodule !== undefined) putSubmodule(head, options.submodule);
  const number = openPull(
    head,
    "main",
    `Fix agent fixture ${stamp}`,
    "Opened by the fix agent journey. It closes itself when the run ends.",
  );
  return { number, head, base: null };
};

/**
 * A PR that conflicts with its own base branch: both edit the same lines of
 * `src/config.js`, and, with `lockfile`, of `pnpm-lock.yaml` too. With `later`, two more
 * commits that conflict with nothing follow on the PR, so a rebase that stops at the first
 * still has two to go. main is never touched.
 */
export const createConflictFixture = (
  stamp: string,
  options: { readonly lockfile: boolean; readonly later?: boolean },
): FixFixture => {
  const base = `e2e/fix-base-${stamp}`;
  const head = `e2e/fix-head-${stamp}`;
  branchFrom(base, "main");
  putFile(base, CONFIG_PATH, CONFIG, "feat: link limits config");
  if (options.lockfile) putFile(base, LOCKFILE_PATH, LOCKFILE, "chore: lockfile");
  branchFrom(head, base);
  putFile(head, CONFIG_PATH, CONFIG_HEAD, "feat: keep links for a quarter");
  if (options.lockfile) putFile(head, LOCKFILE_PATH, LOCKFILE_HEAD, "chore: add nanoid");
  if (options.later === true)
    for (const name of ["campaigns", "expiry"])
      putFile(head, `notes/${name}.md`, `Notes on ${name}.\n`, `docs: notes on ${name}`);
  putFile(base, CONFIG_PATH, CONFIG_BASE, "feat: shorter links, more of them");
  if (options.lockfile) putFile(base, LOCKFILE_PATH, LOCKFILE_BASE, "chore: add zod");
  const number = openPull(
    head,
    base,
    `Conflict fixture ${stamp}`,
    "Campaign links must live for a quarter (90 days), whatever the base does with the per-user limit. Opened by the fix agent journey; it closes itself when the run ends.",
  );
  return { number, head, base };
};

/** What GitHub says about the PR now; `mergeable` is null while GitHub is still working it out. */
export const pullState = (number: number) => {
  const [head = "", mergeable = "", state = ""] = gh([
    "api",
    `repos/${FIXTURE_REPO}/pulls/${number}`,
    "--jq",
    '"\\(.head.sha) \\(.mergeable) \\(.state)"',
  ])
    .trim()
    .split(" ");
  return { head, mergeable: mergeable === "null" ? null : mergeable === "true", state };
};

export const headCommit = (number: number) =>
  gh([
    "api",
    `repos/${FIXTURE_REPO}/pulls/${number}/commits`,
    "--jq",
    '.[-1] | "\\(.sha) \\(.parents | length) \\(.commit.message | split("\\n")[0])"',
  ]).trim();

export const fileAt = (branch: string, path: string) =>
  Buffer.from(
    gh(["api", `repos/${FIXTURE_REPO}/contents/${path}?ref=${branch}`, "--jq", ".content"]).trim(),
    "base64",
  ).toString("utf8");

/** Someone else pushes to the PR's branch: a new file, so it still conflicts. */
export const pushUnrelated = (fixture: FixFixture, stamp: string) =>
  putFile(
    fixture.head,
    `notes/${stamp}.md`,
    `Notes pushed from the command line at ${stamp}.\n`,
    "docs: notes from the command line",
  );

/** The owner resolves the conflict outside prkit: the branch takes the base's side of every conflicted file. */
export const resolveOutside = (fixture: FixFixture, options: { readonly lockfile: boolean }) => {
  putFile(fixture.head, CONFIG_PATH, CONFIG_BASE, "fix: take the base's limits");
  if (options.lockfile)
    putFile(fixture.head, LOCKFILE_PATH, LOCKFILE_BASE, "chore: take the base's lockfile");
};

export const closeFixFixture = (fixture: FixFixture) => {
  gh(["pr", "close", String(fixture.number), "-R", FIXTURE_REPO, "--delete-branch"]);
  if (fixture.base !== null)
    gh(["api", "-X", "DELETE", `repos/${FIXTURE_REPO}/git/refs/heads/${fixture.base}`]);
};

/** A reviewer's line comment on GitHub, so a batch can carry a thread as well as drafts. */
export const reviewerThread = (fixture: FixFixture, line: number, body: string) => {
  const head = pullState(fixture.number).head;
  gh([
    "api",
    "-X",
    "POST",
    `repos/${FIXTURE_REPO}/pulls/${fixture.number}/comments`,
    "-f",
    `body=${body}`,
    "-f",
    `commit_id=${head}`,
    "-f",
    "path=src/limits.js",
    "-F",
    `line=${line}`,
    "-f",
    "side=RIGHT",
  ]);
};

/** Every line comment's body on the PR, oldest first. */
export const commentBodies = (number: number) =>
  gh(["api", `repos/${FIXTURE_REPO}/pulls/${number}/comments`, "--jq", ".[].body"])
    .trim()
    .split("\n");
