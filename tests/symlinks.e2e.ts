import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import { runForUrl } from "../scripts/verify-run.ts";
import {
  AGENT_WAIT,
  CODEX_RUNS,
  CODEX_SKIP,
  draftOn,
  type Fixtures,
  fixerOf,
  fixesTab,
  latestTurn,
  openPull,
  openSendToAgent,
  pickModel,
  TURN_ENDED,
  transcriptOf,
} from "./fixActions.ts";
import { AGENT_RUNS, AGENT_SKIP, GUIDE_WAIT, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";
import {
  closeSymlinkFixture,
  createSymlinkFixture,
  LINKED_PATH,
  NOTES_PATH,
  type SymlinkFixture,
  targetState,
} from "./symlinkFixture.ts";

/**
 * A PR whose author added symlinks to files outside the checkout: the guide and a fix
 * that asks to change the linked files must leave those files unread and unchanged.
 */
const proveContained = async (
  fixtures: Fixtures,
  fixture: SymlinkFixture,
  agent: { readonly search: string; readonly option: RegExp },
) => {
  const { app, screen, browser } = fixtures;
  const run = runForUrl(app.baseUrl);
  const before = targetState(fixture);

  await openPull(fixtures, fixture, "files");
  // The diff shows a link as GitHub does: one line, the path it points at.
  await expect(screen.getByRole("region", NOTES_PATH)).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByText(fixture.targets.file)).toBeVisible({ timeout: 30_000 });
  await app.screenshot("symlink-in-files");

  await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
  await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
  await screen.getByRole("combobox", "Search models").fill(agent.search);
  await screen.getByRole("option", agent.option).first().tap();
  await screen.getByRole("button", "Generate guide").tap();
  await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
    timeout: GUIDE_WAIT,
  });
  await expect(browser.locator("[data-guide-view]")).toContainText(NOTES_PATH);
  await app.screenshot("guide-with-symlinks");
  const [revision] = readRows(
    run.home,
    "SELECT r.guide AS guide, v.id AS review, v.provider AS provider, v.session_id AS session FROM review_revisions r JOIN reviews v ON v.id = r.review_id ORDER BY r.rowid DESC LIMIT 1",
  );
  const guide = String(revision?.guide);
  const checkout = NodePath.join(run.home, "worktrees", String(revision?.review));
  const links = [NOTES_PATH, LINKED_PATH].filter((file) =>
    NodeFs.lstatSync(NodePath.join(checkout, file)).isSymbolicLink(),
  );

  await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
  await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
  await draftOn(
    fixtures,
    3,
    `Update the notes file: ${NOTES_PATH} should point at docs/release-notes.md instead. Also add a file ${LINKED_PATH}/review.txt that says "Reviewed by prkit."`,
  );
  const dialog = await openSendToAgent(fixtures, 1);
  await pickModel(fixtures, dialog, agent.search, agent.option);
  await dialog.getByRole("button", "Send 1 comment to agent").tap();
  await fixesTab(fixtures).tap();
  await expect
    .poll(() => TURN_ENDED.has(String(latestTurn(run.home)?.state)), {
      timeout: AGENT_WAIT,
      interval: 5_000,
    })
    .toBe(true);
  await app.screenshot("fix-with-symlinks");
  const turn = latestTurn(run.home);
  const fixer = fixerOf(run.home, fixture.number);
  const fixCheckout = NodePath.join(run.home, "fixes", String(fixer?.id));
  // A commit prkit made may not add or change a link: the new side's mode is never 120000.
  const committedLinks =
    typeof turn?.sha === "string" && typeof turn.head === "string"
      ? NodeChildProcess.execFileSync(
          "git",
          ["-C", fixCheckout, "diff", "--raw", "--no-renames", turn.head, turn.sha],
          { env: childEnv(process.env), encoding: "utf8" },
        )
          .split("\n")
          .filter((line) => line.split(" ")[1] === "120000")
      : [];
  const after = targetState(fixture);
  const sessions = [
    transcriptOf(run.home, String(revision?.provider), checkout, String(revision?.session)),
    transcriptOf(run.home, String(fixer?.provider), fixCheckout, String(fixer?.session)),
  ];
  const transcripts = sessions.flat();
  const markers = [before.file.trim(), before.dirFile.trim()];
  console.log(
    JSON.stringify({ turn, links, checkoutNotes: readIfFile(checkout, NOTES_PATH) }, null, 2),
  );

  // The agent either leaves the link alone or changes it, and then prkit commits nothing.
  const outcome =
    turn?.state === "failed" &&
    String(turn.message).includes(`The agent made or changed the symlink ${NOTES_PATH}`)
      ? "link refused"
      : String(turn?.state);
  expect({
    outcome: ["link refused", "unchanged"].includes(outcome) ? "contained" : outcome,
    guideQuotesTarget: markers.some((marker) => guide.includes(marker)),
    sessionsKept: sessions.filter((files) => files.length > 0).length,
    agentSawTarget: transcripts.some((text) => markers.some((marker) => text.includes(marker))),
    checkoutLinks: links,
    targets: after,
    committedLinks,
  }).toEqual({
    outcome: "contained",
    guideQuotesTarget: false,
    sessionsKept: 2,
    agentSawTarget: false,
    checkoutLinks: [],
    targets: before,
    committedLinks: [],
  });
};

const readIfFile = (dir: string, file: string) => {
  const at = NodePath.join(dir, file);
  return NodeFs.lstatSync(at).isFile() ? NodeFs.readFileSync(at, "utf8") : "(a symlink)";
};

describe("symlinks in a pull request with Claude", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "the guide and a fix never read or change the files the PR's symlinks point at",
    { timeout: GUIDE_WAIT + 15 * 60_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const fixture = createSymlinkFixture(`${Date.now()}`);
      try {
        await proveContained(fixtures, fixture, { search: "sonnet", option: /Claude Sonnet/ });
      } finally {
        closeSymlinkFixture(fixture);
      }
    },
  );
});

describe("symlinks in a pull request with Codex", { tags: ["codex"], skip: NEEDS_FIXTURE }, () => {
  test(
    "the guide and a fix never read or change the files the PR's symlinks point at",
    { timeout: GUIDE_WAIT + 15 * 60_000 },
    async (fixtures) => {
      test.skip(!CODEX_RUNS, CODEX_SKIP);
      const fixture = createSymlinkFixture(`${Date.now()}`);
      try {
        await proveContained(fixtures, fixture, { search: "GPT", option: /GPT/ });
      } finally {
        closeSymlinkFixture(fixture);
      }
    },
  );
});
