import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { isAlive, runForUrl } from "../scripts/verify-run.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  agentPid,
  FIXTURE_REPO,
  fixturePr,
  GUIDE_WAIT,
  NEEDS_FIXTURE,
  openFixtureGuide,
  prPath,
  processGroup,
  processStart,
  readRows,
  stopAgentGroup,
} from "./fixturePr.ts";
import { startInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  amendHead,
  closeReviewFixture,
  createReviewFixture,
  headSha,
  pushOutdatingChange,
} from "./reviewFixture.ts";

// e2e.config.ts runs the server with a 5 second watch interval, and so do the instances
// started here.
const TICK = 5_000;
const WATCH = ["--watch-interval", String(TICK), "--e2e"];
const FIXTURE_ONE = `github.com/${FIXTURE_REPO}#1`;
const evidence = (name: string, value: object) => {
  const dir = NodePath.resolve(import.meta.dirname, "../.e2e/evidence/review-watcher");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${name}.json`), JSON.stringify(value, null, 2));
};
const attemptsOf = (home: string, key: string) =>
  readRows(
    home,
    `SELECT a.revision, a.trigger, a.outcome, a.error FROM review_attempts a
     JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '${key}' ORDER BY a.rowid`,
  );

describe("the review watcher", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "a push writes revision 2 within two ticks, and a force-push starts a fresh guide",
    { timeout: 2 * GUIDE_WAIT + 5 * 60_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      const fixture = createReviewFixture(`${Date.now()}`, "review watcher");
      const key = `github.com/${FIXTURE_REPO}#${fixture.number}`;
      const status = screen.getByRole("status", "Guide status");
      const revision = screen.getByRole("combobox", "Guide revision");
      const running = browser.locator(
        '[data-active-tab="true"] :is([data-review-status="preparing"], [data-review-status="writing"])',
      );
      try {
        await app.open(run.openUrl);
        await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "guide")}`);
        await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
        await expect(status).toContainText("Watching for new commits", { timeout: GUIDE_WAIT });
        await expect(revision).toContainText("r1 · ");
        await app.screenshot("watching-r1");

        pushOutdatingChange(fixture.branch);
        const pushed = Date.now();
        await expect(running).toBeAttached({ timeout: 2 * TICK });
        const pushToRunningMs = Date.now() - pushed;
        await expect(status).toContainText("Updating for 1 new commit", { timeout: 60_000 });
        await expect(screen.getByRole("heading", "Overview")).toBeVisible();
        await app.screenshot("updating-for-1-new-commit");
        await expect(status).toContainText("Watching for new commits", { timeout: GUIDE_WAIT });
        const pushedHead = headSha(fixture.number);
        await expect(revision).toContainText(`r2 · ${pushedHead.slice(0, 7)} · new commits`);
        await app.screenshot("watching-r2");
        expect(attemptsOf(run.home, key)).toEqual([
          { revision: 1, trigger: "first", outcome: "accepted", error: null },
          { revision: 2, trigger: "new-commits", outcome: "accepted", error: null },
        ]);

        const amended = amendHead(fixture.branch);
        const forced = Date.now();
        await expect(running).toBeAttached({ timeout: 2 * TICK });
        const forceToRunningMs = Date.now() - forced;
        await expect(status).toContainText("Rewritten history, writing a fresh guide", {
          timeout: 60_000,
        });
        await expect
          .poll(() => attemptsOf(run.home, key).at(-1), { timeout: 60_000 })
          .toEqual({ revision: 3, trigger: "rewritten", outcome: null, error: null });
        await app.screenshot("rewritten-history");
        // Writing the fresh guide is the first journey's work; this one ends at its start.
        await screen.getByRole("button", "Stop").tap();
        await expect(
          browser.locator('[data-active-tab="true"] [data-review-status="done"]'),
        ).toBeAttached({ timeout: 30_000 });
        evidence("push-and-force-push", {
          tickMs: TICK,
          pushToRunningMs,
          forceToRunningMs,
          pushedHead,
          amended,
          attempts: attemptsOf(run.home, key),
        });
      } finally {
        closeReviewFixture(fixture);
      }
    },
  );

  test(
    "a server killed while writing marks the attempt interrupted, and its restart writes the guide",
    { timeout: GUIDE_WAIT + 5 * 60_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const stamp = `${Date.now()}`;
      const name = `restart-${stamp}`;
      const fixture = createReviewFixture(stamp, "review restart");
      const key = `github.com/${FIXTURE_REPO}#${fixture.number}`;
      const openGuide = async (url: string, openUrl: string) => {
        await app.open(openUrl);
        await app.open(`${url}${prPath(FIXTURE_REPO, fixture.number, "guide")}`);
      };
      let captured: { readonly pid: number; readonly startedAt: string } | null = null;
      try {
        const killed = startInstance(name, WATCH);
        await openGuide(killed.url, killed.openUrl);
        await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
        await expect(
          browser.locator('[role="log"][aria-label="Agent activity"] li[data-kind="tool"]').first(),
        ).toBeAttached({ timeout: 120_000 });
        await expect
          .poll(() => agentPid(killed.home, key), { timeout: 30_000 })
          .toEqual(expect.any(Number));
        const agent = agentPid(killed.home, key);
        if (agent === null) throw new Error("The attempt didn't record its agent's process.");
        captured = { pid: agent, startedAt: processStart(agent) };
        await app.screenshot("writing-before-the-kill");

        process.kill(killed.serverPid, "SIGKILL");
        // The supervisor exits once its server is gone and keeps the home: no --rm.
        await expect.poll(() => isAlive(killed.pid), { timeout: 15_000 }).toBe(false);
        const agentOutlivedServer = processGroup(agent).length > 0;

        const restarted = startInstance(name, WATCH);
        await openGuide(restarted.url, restarted.openUrl);
        const status = screen.getByRole("status", "Guide status");
        await expect(status).toContainText("Watching for new commits", { timeout: GUIDE_WAIT });
        await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ");
        await app.screenshot("written-after-the-restart");
        expect(attemptsOf(restarted.home, key)).toEqual([
          { revision: 1, trigger: "first", outcome: "failed", error: "interrupted" },
          { revision: 1, trigger: "retry", outcome: "accepted", error: null },
        ]);
        expect(processGroup(agent)).toEqual([]);
        const log = NodeFS.readFileSync(restarted.log, "utf8");
        // Claude can also exit by itself once its server is gone; one that didn't is the restart's to stop.
        if (agentOutlivedServer)
          expect(log).toContain("Stopped an agent the previous run left behind");
        const reconciled = log.split("\n").filter((line) => line.includes("Reconciled reviews"));
        expect(reconciled).toHaveLength(2);
        expect(reconciled[1]).toMatch(/interrupted\W+1\b/);
        expect(reconciled[1]).toMatch(/restarted\W+1\b/);
        evidence("kill-and-restart", {
          agentPid: agent,
          agentOutlivedServer,
          reconciled,
          attempts: attemptsOf(restarted.home, key),
        });
      } finally {
        // A failure between the kill and the restart leaves no server to stop the agent.
        if (captured !== null) stopAgentGroup(captured.pid, captured.startedAt);
        stopFakeInstance(name, { keepHome: false });
        closeReviewFixture(fixture);
      }
    },
  );

  test(
    "a closed PR ends its review, and Generate again after reopening brings it back",
    { timeout: 2 * GUIDE_WAIT + 60_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      const status = screen.getByRole("status", "Guide status");
      const reviewOfOne = `SELECT r.id, r.status FROM reviews r WHERE r.pr_key = '${FIXTURE_ONE}'`;
      await openFixtureGuide({ app, screen });
      // Tests in a run share one instance, so an earlier journey may have left a stopped review.
      await screen.getByRole("button", /^Generate (guide|again)$/).tap({ timeout: 30_000 });
      await expect(status).toContainText("Watching for new commits", { timeout: GUIDE_WAIT });
      await expect(
        browser.locator('[data-active-tab="true"] [data-review-status="watching"]'),
      ).toBeVisible();
      await app.screenshot("watching");
      const before = readRows(
        run.home,
        `SELECT v.revision FROM review_revisions v JOIN reviews r ON r.id = v.review_id WHERE r.pr_key = '${FIXTURE_ONE}'`,
      ).length;

      try {
        fixturePr("close");
        await expect(status).toContainText("PR closed · review closed", { timeout: 30_000 });
        await expect(
          browser.locator('[data-active-tab="true"] [data-review-status="done"]'),
        ).toBeAttached();
        // The PR header is read again, so a closed PR offers no Generate again.
        await expect(screen.getByRole("button", "Generate again")).toBeHidden({ timeout: 30_000 });
        await expect(screen.getByRole("heading", "Overview")).toBeVisible();
        await app.screenshot("done-closed");
        const [review] = readRows(run.home, reviewOfOne);
        expect(review?.status).toBe('{"_tag":"done","reason":"closed"}');
        expect(NodeFS.existsSync(NodePath.join(run.home, "worktrees", String(review?.id)))).toBe(
          false,
        );
      } finally {
        fixturePr("reopen");
      }

      await screen.getByRole("button", "Refresh").tap();
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect(status).toContainText("Writing the guide again", { timeout: 30_000 });
      await expect(
        browser.locator(
          '[data-active-tab="true"] :is([data-review-status="preparing"], [data-review-status="writing"])',
        ),
      ).toBeAttached();
      await expect(screen.getByRole("heading", "Overview")).toBeVisible();
      await app.screenshot("generating-again-over-the-last-guide");
      await expect(status).toContainText("Watching for new commits", { timeout: GUIDE_WAIT });
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText(
        `r${before + 1} · `,
      );
      expect(attemptsOf(run.home, FIXTURE_ONE).at(-1)).toEqual({
        revision: before + 1,
        trigger: "retry",
        outcome: "accepted",
        error: null,
      });
      await app.screenshot("watching-again");
    },
  );
});
