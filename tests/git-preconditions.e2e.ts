import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  draftOn,
  type Fixtures,
  fixerOf,
  fixesTab,
  gitDirOf,
  gitMetadataIntact,
  latestTurn,
  openSendToAgent,
  pickModel,
} from "./fixActions.ts";
import {
  closeFixFixture,
  createConflictFixture,
  createFixFixture,
  type FixFixture,
  pullState,
} from "./fixFixture.ts";
import { FIXTURE_REPO, NEEDS_FIXTURE, prPath, readRows } from "./fixturePr.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";

/** A stand-in agent's turn on the fixture, from the draft to its end. */
const TURN_WAIT = 180_000;

/**
 * Runs `journey` against a prkit of its own whose Claude is the stand-in agent
 * (scripts/fake-claude.ts), on a fixture PR, and closes both whatever happens.
 */
const withStandIn = async (
  fixtures: Fixtures,
  name: string,
  makeFixture: () => FixFixture,
  journey: (input: {
    readonly claude: ReturnType<typeof setUpFakeClaude>;
    readonly run: ReturnType<typeof startInstance>;
    readonly fixture: FixFixture;
    readonly open: (tab: string) => Promise<void>;
  }) => Promise<void>,
) => {
  const claude = setUpFakeClaude(name);
  const fixture = makeFixture();
  const run = startInstance(name, ["--claude", claude.file]);
  const open = async (tab: string) => {
    await fixtures.app.open(run.openUrl);
    await fixtures.app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, tab)}`);
    await expect(fixtures.screen.getByRole("navigation", "Pull request tabs")).toBeVisible({
      timeout: 60_000,
    });
  };
  try {
    await journey({ claude, run, fixture, open });
  } finally {
    stopFakeInstance(name, { keepHome: false });
    closeFixFixture(fixture);
  }
};

/** Sends one draft on `src/limits.js` to the stand-in agent and opens the Fixes tab. */
const sendFix = async (fixtures: Fixtures, open: (tab: string) => Promise<void>) => {
  await open("files");
  await expect(fixtures.screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
  await draftOn(fixtures, 3, "Add a note on how the limits were chosen.");
  const dialog = await openSendToAgent(fixtures, 1);
  await pickModel(fixtures, dialog, "sonnet", /Claude Sonnet/);
  await dialog.getByRole("button", "Send 1 comment to agent").tap();
  await fixesTab(fixtures).tap();
};

const checkoutOf = (home: string, number: number) =>
  NodePath.join(home, "fixes", String(fixerOf(home, number)?.id));

/** What a refused step must leave: no commit, the PR where it was, prkit's git metadata. */
const nothingLanded = (home: string, fixture: FixFixture) => {
  const turn = latestTurn(home);
  return {
    state: turn?.state,
    commit: turn?.sha ?? null,
    head: pullState(fixture.number).head,
    metadata: gitMetadataIntact(home, checkoutOf(home, fixture.number)),
  };
};

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    env: { ...childEnv(process.env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });

/** Push waits for prkit to confirm the account may push to the branch. */
const push = async (turn: ReturnType<Fixtures["screen"]["getByRole"]>) => {
  const button = turn.getByRole("button", "Push");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.tap();
};

/** GitHub works out mergeability after the PR opens; Resolve conflicts waits for it. */
const conflicting = (fixture: FixFixture) =>
  expect
    .poll(() => pullState(fixture.number).mergeable, { timeout: 60_000, interval: 3_000 })
    .toBe(false);

/** Whether the stand-in's lingering `sleep` still runs: same PID, same command. */
const lingering = (pid: number) => {
  try {
    return (
      NodeChildProcess.execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim() === "/bin/sleep 3593"
    );
  } catch {
    return false;
  }
};

describe("prkit's git steps after an agent turn", { skip: NEEDS_FIXTURE }, () => {
  test(
    "a repository the agent left inside the checkout stops the fix before staging, and Retry starts clean",
    { timeout: 900_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      await withStandIn(
        fixtures,
        "git-nested",
        () => createFixFixture(`${Date.now()}`),
        async ({ claude, run, fixture, open }) => {
          const head = pullState(fixture.number).head;
          claude.plant("nested", "vendor/empty");
          await sendFix(fixtures, open);
          const failed = screen.getByRole("article", "Fix 1 comment: Failed");
          await expect(failed).toBeVisible({ timeout: TURN_WAIT });
          await expect(failed).toContainText(
            "prkit stopped and needs you: the checkout has a git repository inside it (vendor/empty/.git)",
          );
          await app.screenshot("nested-repository-refused");
          expect(nothingLanded(run.home, fixture)).toEqual({
            state: "failed",
            commit: null,
            head,
            metadata: true,
          });

          claude.plant("nested", null);
          await failed.getByRole("button", "Retry").tap();
          await expect(screen.getByRole("article", "Fix 1 comment: Ready to review")).toBeVisible({
            timeout: TURN_WAIT,
          });
          expect(
            NodeFs.existsSync(NodePath.join(checkoutOf(run.home, fixture.number), "vendor")),
          ).toBe(false);
        },
      );
    },
  );

  test(
    "a repository the agent made at the PR's submodule stops the fix before staging",
    { timeout: 900_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      await withStandIn(
        fixtures,
        "git-submodule",
        () => createFixFixture(`${Date.now()}`, { submodule: "vendor/lib" }),
        async ({ claude, run, fixture, open }) => {
          const head = pullState(fixture.number).head;
          claude.plant("nested", "vendor/lib");
          await sendFix(fixtures, open);
          const failed = screen.getByRole("article", "Fix 1 comment: Failed");
          await expect(failed).toBeVisible({ timeout: TURN_WAIT });
          await expect(failed).toContainText(
            "prkit stopped and needs you: the checkout has a git repository inside it (vendor/lib/.git)",
          );
          await app.screenshot("submodule-repository-refused");
          expect(nothingLanded(run.home, fixture)).toEqual({
            state: "failed",
            commit: null,
            head,
            metadata: true,
          });
        },
      );
    },
  );

  test(
    "a rebase whose todo changed during the resolution is dropped; a clean merge resolution still commits and pushes",
    { timeout: 1_200_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      await withStandIn(
        fixtures,
        "git-rebase-plan",
        () => createConflictFixture(`${Date.now()}`, { lockfile: false, later: true }),
        async ({ claude, run, fixture, open }) => {
          await conflicting(fixture);
          const head = pullState(fixture.number).head;
          claude.plant("todo", "");
          // The Fixes tab shows once something went to the agent; Resolve conflicts is in the header.
          await open("conversation");
          await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
          await screen.getByRole("radio", /^Rebase onto /).tap();
          await screen.getByRole("button", "Resolve with the agent").tap({ timeout: 30_000 });
          const failed = screen.getByRole("article", /^Rebase onto e2e\/fix-base-.*: Failed$/);
          await expect(failed).toBeVisible({ timeout: TURN_WAIT });
          await expect(failed).toContainText(
            "prkit stopped and needs you: git's plan for the rest of the rebase changed under it",
          );
          await app.screenshot("rebase-plan-refused");
          const checkout = checkoutOf(run.home, fixture.number);
          expect({
            ...nothingLanded(run.home, fixture),
            rebase: NodeFs.existsSync(NodePath.join(gitDirOf(checkout), "rebase-merge")),
          }).toEqual({ state: "failed", commit: null, head, metadata: true, rebase: false });

          claude.plant("todo", null);
          await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
          await screen.getByRole("radio", /^Merge /).tap();
          await screen.getByRole("button", "Resolve with the agent").tap({ timeout: 30_000 });
          const ready = screen.getByRole(
            "article",
            /^Merge e2e\/fix-base-.* into this branch: Ready to review$/,
          );
          await expect(ready).toBeVisible({ timeout: TURN_WAIT });
          await push(ready);
          await expect(
            screen.getByRole("article", /^Merge e2e\/fix-base-.* into this branch: Pushed$/),
          ).toBeVisible({ timeout: 120_000 });
          await expect
            .poll(() => pullState(fixture.number).head, { timeout: 60_000, interval: 3_000 })
            .not.toBe(head);
          await app.screenshot("clean-resolution-pushed");
        },
      );
    },
  );

  test(
    "a key prkit didn't write in the cache's config stops Push and the next fix's fetch; a clean fix still commits and pushes",
    { timeout: 900_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      await withStandIn(
        fixtures,
        "git-cache-config",
        () => createFixFixture(`${Date.now()}`),
        async ({ run, fixture, open }) => {
          const head = pullState(fixture.number).head;
          await sendFix(fixtures, open);
          const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
          await expect(ready).toBeVisible({ timeout: TURN_WAIT });
          const commit = String(latestTurn(run.home)?.sha);
          const turnId = String(
            readRows(run.home, "SELECT id FROM fixer_turns ORDER BY created_at DESC LIMIT 1")[0]
              ?.id,
          );
          expect(commit).toMatch(/^[0-9a-f]{40}$/);
          // The worktree's git dir is `<cache>/worktrees/<name>`.
          const config = NodePath.join(
            gitDirOf(checkoutOf(run.home, fixture.number)),
            "..",
            "..",
            "config",
          );
          git(["config", "--file", config, "prkit.check", "1"]);
          await push(ready);
          // The refusal goes in the turn's activity. The Push button's own error is gone by
          // the time the turn is back to ready, since its actions unmount while it pushes.
          await expect
            .poll(
              () =>
                readRows(
                  run.home,
                  `SELECT text FROM fixer_activity WHERE kind = 'error' AND turn_id = '${turnId}'`,
                )
                  .map((row) => String(row.text))
                  .join("\n"),
              { timeout: 60_000, interval: 1_000 },
            )
            .toContain("has git settings prkit didn't write (prkit.check)");
          await ready.getByText("Activity").tap();
          await expect(ready).toContainText("has git settings prkit didn't write (prkit.check)");
          await app.screenshot("cache-config-refused");
          expect(pullState(fixture.number).head).toBe(head);

          git(["config", "--file", config, "--unset", "prkit.check"]);
          await push(ready);
          await expect(screen.getByRole("article", "Fix 1 comment: Pushed")).toBeVisible({
            timeout: 120_000,
          });
          await expect
            .poll(() => pullState(fixture.number).head, { timeout: 60_000, interval: 3_000 })
            .toBe(commit);
          await app.screenshot("clean-fix-pushed");

          // The next fix fetches the head first, and the same check stops that fetch.
          git(["config", "--file", config, "prkit.check", "1"]);
          await screen
            .getByRole("navigation", "Pull request tabs")
            .getByRole("link", "Files")
            .tap();
          await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
          await draftOn(fixtures, 7, "Say where the limits come from.");
          await (
            await openSendToAgent(fixtures, 1)
          )
            .getByRole("button", "Send 1 comment to agent")
            .tap();
          await fixesTab(fixtures).tap();
          const refused = screen.getByRole("article", "Fix 1 comment: Failed");
          await expect(refused).toBeVisible({ timeout: TURN_WAIT });
          await expect(refused).toContainText("has git settings prkit didn't write (prkit.check)");
          await expect(refused).toContainText("Nothing was fetched or pushed.");
          await app.screenshot("cache-config-fetch-refused");
          git(["config", "--file", config, "--unset", "prkit.check"]);
        },
      );
    },
  );

  test(
    "a job the agent's command left running ends with the turn, before prkit commits",
    { timeout: 900_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      const left: { pid: number | null } = { pid: null };
      try {
        await withStandIn(
          fixtures,
          "git-turn-end",
          () => createFixFixture(`${Date.now()}`),
          async ({ claude, run, open }) => {
            claude.plant("linger", "");
            await sendFix(fixtures, open);
            await expect(screen.getByRole("article", "Fix 1 comment: Ready to review")).toBeVisible(
              { timeout: TURN_WAIT },
            );
            left.pid = claude.lingering();
            expect(left.pid).not.toBeNull();
            await app.screenshot("turn-ended-clean");
            expect({
              lingering: left.pid === null ? null : lingering(left.pid),
              committed: typeof latestTurn(run.home)?.sha,
            }).toEqual({ lingering: false, committed: "string" });
          },
        );
      } finally {
        // The stand-in started it, and its PID still names that `sleep`.
        if (left.pid !== null && lingering(left.pid)) process.kill(left.pid, "SIGKILL");
      }
    },
  );
});
