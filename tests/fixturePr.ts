import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, type TestFixtures } from "e2e";

import { readLocalConfig } from "../scripts/localConfig.ts";
import { runForUrl } from "../scripts/verify-run.ts";

const local = readLocalConfig();

/** Why a journey that drives the fixture repository skips, or false when it runs. */
export const NEEDS_FIXTURE =
  local === undefined &&
  'Needs your fixture repository: write {"fixtureRepo": "<owner>/<name>"} to .e2e/local.json.';
/**
 * The fixture repository the journeys drive, owned by one of your accounts and read through
 * it. It comes from the gitignored `.e2e/local.json`; the placeholder only fills in for
 * journeys that skip.
 */
export const FIXTURE_REPO = local?.fixtureRepo ?? "octocat/prkit-fixtures";
export const FIXTURE_LOGIN = FIXTURE_REPO.split("/")[0] ?? "";
export const FIXTURE_NAME = FIXTURE_REPO.split("/")[1] ?? "";
export const FIXTURE_ACCOUNT = `github.com/${FIXTURE_LOGIN}`;
/** A PR's path in the app, read through the fixture's account. */
export const prPath = (repository: string, number: number, tab: string) =>
  `/pr/github.com/${repository}/${number}?account=${encodeURIComponent(FIXTURE_ACCOUNT)}&tab=${tab}`;
export const FIXTURE_FILES = [
  "src/validate.js",
  "src/store.js",
  "src/shorten.js",
  "src/server.js",
  "test/validate.test.js",
];
export const AGENT_RUNS = process.env.PRKIT_E2E_AGENT === "1";
export const AGENT_SKIP =
  "Spends your Claude subscription. Run with PRKIT_E2E_AGENT=1 --tag agent.";

export const openFixtureGuide = async ({ app, screen }: Pick<TestFixtures, "app" | "screen">) => {
  await app.open(runForUrl(app.baseUrl).openUrl);
  await screen.getByRole("link", "Inbox").tap();
  await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
  await screen
    .getByRole("region", "Yours")
    .getByRole("link", /#1 Validate links and count clicks/)
    .tap({ timeout: 45_000 });
  await expect(screen.getByRole("heading", "Validate links and count clicks")).toBeVisible({
    timeout: 45_000,
  });
  await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
};

export const readRows = (home: string, query: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"), { readOnly: true });
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
};

/** The process the PR's latest attempt recorded for its agent, or null before it started one. */
export const agentPid = (home: string, key: string) => {
  const [attempt] = readRows(
    home,
    `SELECT a.agent_pid FROM review_attempts a JOIN reviews r ON r.id = a.review_id
     WHERE r.pr_key = '${key}' ORDER BY a.rowid DESC LIMIT 1`,
  );
  return typeof attempt?.agent_pid === "number" ? attempt.agent_pid : null;
};

/** The live processes in an agent's process group; prkit starts every agent as its group's leader. */
export const processGroup = (leader: number) =>
  NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === leader)
    .map(([pid]) => pid);

/** When a process started, as `ps` prints it, or "" once it is gone. */
export const processStart = (pid: number) =>
  NodeChildProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();

/**
 * Kills what is left of an agent's process group, like prkit's startup: only while its
 * leader is gone or is still the process that started at `startedAt`, so a pid the
 * system handed to someone else is never signalled.
 */
export const stopAgentGroup = (leader: number, startedAt: string) => {
  const now = processStart(leader);
  if ((now !== "" && now !== startedAt) || processGroup(leader).length === 0) return;
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // The group ended between the check and the signal.
  }
};

/** Changes the fixture PR on GitHub through the user's own gh, the way a teammate would. */
export const fixturePr = (action: "close" | "reopen") =>
  NodeChildProcess.execFileSync("gh", ["pr", action, "1", "-R", FIXTURE_REPO], { stdio: "pipe" });
