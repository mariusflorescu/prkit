import * as NodeChildProcess from "node:child_process";

import { FIXTURE_REPO } from "./fixturePr.ts";

/** A file the fixture PR adds, so every line number below is known. */
export const LIMITS_PATH = "src/limits.js";
export const LIMITS = `// Limits for short links. Each one is checked before a link is stored.
export const MAX_URL_LENGTH = 2048;
export const MAX_CODE_LENGTH = 16;
export const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:"];

export function checkUrl(url) {
  if (url.length > MAX_URL_LENGTH) return "too-long";
  const lower = url.trim().toLowerCase();
  for (const scheme of BLOCKED_SCHEMES) {
    if (lower.startsWith(scheme)) return "blocked-scheme";
  }
  return null;
}

export function checkCode(code) {
  if (code.length === 0) return "empty";
  if (code.length > MAX_CODE_LENGTH) return "too-long";
  return /^[a-z0-9-]+$/.test(code) ? null : "bad-characters";
}
`;
/**
 * The push that outdates drafts: a line after line 4 shifts everything below it by
 * one, and old line 7 changes. Lines 1 to 4 stay where they were.
 */
export const LIMITS_PUSHED = LIMITS.replace(
  'export const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:"];\n',
  'export const BLOCKED_SCHEMES = ["javascript:", "data:", "vbscript:"];\nexport const MIN_CODE_LENGTH = 1;\n',
).replace("if (url.length > MAX_URL_LENGTH)", "if (url.length >= MAX_URL_LENGTH)");
const CODES = `const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// Random code of the given length. Ambiguous characters (i, l, o, 0, 1) are left out.
export function randomCode(length = 6, random = Math.random) {
  let code = "";
  for (let i = 0; i < length; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return code;
}
`;

export const gh = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("gh", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

/** How long GitHub may take to serve a new pull request's head ref before a journey gives up. */
const PULL_REF_WAIT_MS = 30_000;

/**
 * Returns once GitHub serves `refs/pull/<number>/head`, which prkit fetches as soon as the
 * pull request opens. GitHub answers the pull request's creation a moment before that ref
 * exists, so a journey that opens it at once can fail to fetch it.
 */
export const waitForPullRef = (number: number) => {
  const ref = `refs/pull/${number}/head`;
  const started = Date.now();
  for (let reads = 1; ; reads++) {
    try {
      gh(["api", `repos/${FIXTURE_REPO}/git/ref/pull/${number}/head`, "--jq", ".object.sha"]);
      console.log(
        `Fixture #${number}: GitHub serves ${ref} after ${Date.now() - started} ms (${reads} reads).`,
      );
      return number;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
    }
    if (Date.now() - started >= PULL_REF_WAIT_MS)
      throw new Error(
        `Fixture #${number}: GitHub still doesn't serve ${ref} ${PULL_REF_WAIT_MS / 1000} seconds after the pull request opened, so prkit can't fetch it. Run the journey again.`,
      );
    console.log(`Fixture #${number}: waiting for GitHub to serve ${ref} (read ${reads}).`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
};

export const putFile = (branch: string, path: string, content: string, message: string) => {
  let sha: string | null = null;
  try {
    sha = gh([
      "api",
      `repos/${FIXTURE_REPO}/contents/${path}?ref=${branch}`,
      "--jq",
      ".sha",
    ]).trim();
  } catch {
    sha = null;
  }
  gh([
    "api",
    "-X",
    "PUT",
    `repos/${FIXTURE_REPO}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `content=${Buffer.from(content).toString("base64")}`,
    "-f",
    `branch=${branch}`,
    ...(sha ? ["-f", `sha=${sha}`] : []),
  ]);
};

/**
 * Opens a PR of its own on the fixture repo, so a run never shares reviews with another.
 * `journey` names it in the branch, title and description.
 */
export const createReviewFixture = (stamp: string, journey = "review comments") => {
  const branch = `e2e/${journey.replaceAll(" ", "-")}-${stamp}`;
  const main = gh([
    "api",
    `repos/${FIXTURE_REPO}/git/ref/heads/main`,
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
    `sha=${main}`,
  ]);
  putFile(branch, LIMITS_PATH, LIMITS, "feat: check link limits");
  putFile(branch, "src/codes.js", CODES, "feat: random codes of any length");
  const number = Number(
    gh([
      "api",
      "-X",
      "POST",
      `repos/${FIXTURE_REPO}/pulls`,
      "-f",
      `title=${journey.charAt(0).toUpperCase()}${journey.slice(1)} fixture ${stamp}`,
      "-f",
      `head=${branch}`,
      "-f",
      "base=main",
      "-f",
      `body=Opened by the ${journey} journey. It closes itself when the run ends.`,
      "--jq",
      ".number",
    ]).trim(),
  );
  waitForPullRef(number);
  return { branch, number };
};

export const pushOutdatingChange = (branch: string) =>
  putFile(branch, LIMITS_PATH, LIMITS_PUSHED, "fix: reject links at the limit");

/**
 * Rewrites the branch's last commit with a new message and force-pushes it, like
 * `git commit --amend` and `git push --force`: the new head doesn't descend from the old one.
 */
export const amendHead = (branch: string) => {
  const head = gh([
    "api",
    `repos/${FIXTURE_REPO}/git/ref/heads/${branch}`,
    "--jq",
    ".object.sha",
  ]).trim();
  const commit = (field: string) =>
    gh(["api", `repos/${FIXTURE_REPO}/git/commits/${head}`, "--jq", field]).trim();
  const amended = gh([
    "api",
    "-X",
    "POST",
    `repos/${FIXTURE_REPO}/git/commits`,
    "-f",
    `message=${commit(".message")} (amended)`,
    "-f",
    `tree=${commit(".tree.sha")}`,
    "-f",
    `parents[]=${commit(".parents[0].sha")}`,
    "--jq",
    ".sha",
  ]).trim();
  gh([
    "api",
    "-X",
    "PATCH",
    `repos/${FIXTURE_REPO}/git/refs/heads/${branch}`,
    "-f",
    `sha=${amended}`,
    "-F",
    "force=true",
  ]);
  return amended;
};

export const headSha = (number: number) =>
  gh(["api", `repos/${FIXTURE_REPO}/pulls/${number}`, "--jq", ".head.sha"]).trim();

/** The PR's line comments as `path:start-end:side body`, newest review last. */
export const postedComments = (number: number) =>
  gh([
    "api",
    `repos/${FIXTURE_REPO}/pulls/${number}/comments`,
    "--jq",
    '.[] | "\\(.path):\\(.start_line // .line)-\\(.line):\\(.side) \\(.body)"',
  ])
    .trim()
    .split("\n");

export const reviewStates = (number: number) =>
  gh([
    "api",
    `repos/${FIXTURE_REPO}/pulls/${number}/reviews`,
    "--jq",
    '.[] | "\\(.state) \\(.body)"',
  ])
    .trim()
    .split("\n");

export const threadStates = (number: number) =>
  gh([
    "api",
    "graphql",
    "-f",
    `query=query { repository(owner: "${FIXTURE_REPO.split("/")[0]}", name: "${FIXTURE_REPO.split("/")[1]}") { pullRequest(number: ${number}) { reviewThreads(first: 50) { nodes { path line isResolved comments(first: 20) { totalCount } } } } } }`,
    "--jq",
    '.data.repository.pullRequest.reviewThreads.nodes[] | "\\(.path):\\(.line) resolved=\\(.isResolved) comments=\\(.comments.totalCount)"',
  ])
    .trim()
    .split("\n");

export const closeReviewFixture = (fixture: { branch: string; number: number }) => {
  gh(["pr", "close", String(fixture.number), "-R", FIXTURE_REPO, "--delete-branch"]);
};
