import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { type Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import type { FixFixture } from "./fixFixture.ts";
import { FIXTURE_REPO, prPath, readRows } from "./fixturePr.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";

export const CODEX_RUNS = process.env.PRKIT_E2E_CODEX === "1";
export const CODEX_SKIP =
  "Spends your ChatGPT subscription. Run with PRKIT_E2E_CODEX=1 --tag codex.";
/** An agent turn on the fixture takes about a minute; this leaves room for a slow one. */
export const AGENT_WAIT = 480_000;

export type Fixtures = Pick<TestFixtures, "app" | "screen"> & { readonly browser: Browser };

const prUrl = (app: TestFixtures["app"], fixture: FixFixture, tab: string) =>
  `${runForUrl(app.baseUrl).url}${prPath(FIXTURE_REPO, fixture.number, tab)}`;

/** Opens the PR on a tab, signed in, the way a link from the inbox would. */
export const openPull = async ({ app, screen }: Fixtures, fixture: FixFixture, tab: string) => {
  await app.open(runForUrl(app.baseUrl).openUrl);
  await app.open(prUrl(app, fixture, tab));
  await expect(screen.getByRole("navigation", "Pull request tabs")).toBeVisible({
    timeout: 60_000,
  });
};

/** Writes a draft on one line from the Files tab's gutter. */
export const draftOn = async (
  { screen, browser }: Fixtures,
  number: number,
  body: string,
  path = LIMITS_PATH,
) => {
  const line = (at: number) =>
    browser.locator(`[data-path="${path}"] [data-column-number="${at}"]`);
  const gutterButton = browser.locator(`[data-path="${path}"] [data-utility-button]`);
  // The diff re-renders once highlighted, which can drop an early hover.
  await expect
    .poll(
      async () => {
        await line(number === 1 ? 2 : 1).hover();
        await line(number).hover();
        return gutterButton.count();
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await gutterButton.tap();
  await screen.getByRole("textbox", `Comment on line ${number}`).fill(body);
  await screen.getByRole("textbox", `Comment on line ${number}`).press("Meta+Enter");
  await expect(
    screen.getByRole("article", `Pending comment on ${path} line ${number}`),
  ).toBeVisible();
};

/** Review > Send to agent, with the drafts the form picks by default. */
export const openSendToAgent = async ({ screen }: Fixtures, pending: number) => {
  await screen.getByRole("button", `Review, ${pending} pending`).first().tap();
  await screen
    .getByRole("group", "Where your comments go")
    .getByRole("button", "Send to agent")
    .tap();
  const dialog = screen.getByRole("dialog", "Send to agent");
  await expect(dialog.getByRole("button", /^Agent and model: /)).toBeVisible({ timeout: 30_000 });
  return dialog;
};

export const pickModel = async (
  { screen }: Fixtures,
  scope: ReturnType<TestFixtures["screen"]["getByRole"]>,
  search: string,
  option: RegExp,
) => {
  await scope.getByRole("button", /^Agent and model: /).tap();
  await screen.getByRole("combobox", "Search models").fill(search);
  await screen.getByRole("option", option).first().tap();
};

export const fixesTab = ({ screen }: Fixtures) =>
  screen.getByRole("navigation", "Pull request tabs").getByRole("link", /^Fixes/);

/** The git dir a fixer's checkout names in its `.git` file. */
export const gitDirOf = (checkout: string) =>
  /^gitdir: (.+)$/m.exec(NodeFs.readFileSync(NodePath.join(checkout, ".git"), "utf8"))?.[1] ?? "";

/** The fixer's checkout still points at prkit's own git dir, with an untouched commondir. */
export const gitMetadataIntact = (home: string, checkout: string) => {
  try {
    const gitDir = gitDirOf(checkout);
    const commondir = NodeFs.readFileSync(NodePath.join(gitDir, "commondir"), "utf8").trim();
    return gitDir.startsWith(NodePath.join(home, "repos")) && commondir === "../..";
  } catch {
    return false;
  }
};

/** Where a fix turn stops until someone acts on it. */
export const TURN_ENDED: ReadonlySet<string> = new Set(["ready", "failed", "unchanged"]);

export const latestTurn = (home: string) =>
  readRows(
    home,
    "SELECT json_extract(status, '$._tag') AS state, json_extract(status, '$.message') AS message, head_sha AS head, commit_sha AS sha FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
  )[0];

/** The fix session of fixture PR `number`; earlier journeys of the same run leave theirs. */
export const fixerOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT id, provider, session_id AS session FROM fixers WHERE pr_key = 'github.com/${FIXTURE_REPO}#${number}'`,
  )[0];

/**
 * Every file the provider kept of a session: everything the agent sent and was sent
 * back. Claude files each conversation under the checkout it ran in, so this reads all
 * of that checkout's, a resumed or nudged one included. Codex runs in prkit's own Codex
 * home and names each file after the thread, under the day it started, and this reads
 * every one of them.
 */
export const transcriptOf = (home: string, provider: string, cwd: string, sessionId: string) => {
  const claudeProject = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOs.homedir(), ".claude"),
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
  );
  const files =
    provider === "claude"
      ? NodeFs.existsSync(claudeProject)
        ? NodeFs.readdirSync(claudeProject)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => NodePath.join(claudeProject, file))
        : []
      : NodeFs.globSync(`${NodePath.join(home, "codex", "sessions")}/**/*${sessionId}.jsonl`);
  return files.map((file) => NodeFs.readFileSync(file, "utf8"));
};

/** Whether a `node --test` run in these transcripts passed every test, as JSON keeps its output. */
export const testsPassed = (transcripts: ReadonlyArray<string>) =>
  transcripts.some((text) => /ℹ pass [1-9]\d*\\nℹ fail 0\\n/.test(text));
