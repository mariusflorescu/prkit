import * as NodeFS from "node:fs";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";

// Every journey here reads a fake GitHub (scripts/fake-github.ts) through its own
// instance; the run's default instance is never opened, so no real budget is spent.
describe("GitHub budget", () => {
  test("the Inbox says how old it is, answers from cache, and Refresh reads GitHub once", async ({
    app,
    screen,
  }) => {
    const fake = await startFakeGitHub("budget-cache");
    try {
      const run = startFakeInstance("budget-cache", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      await expect(screen.getByText("Updated just now")).toBeVisible();
      // A host with stacks: the fake's PRs 1 and 2 are one stack.
      await expect(screen.getByRole("link", /#1 Budget fixture 1 Stack 1\/2/)).toBeVisible();
      await app.screenshot("inbox-updated");
      expect((await fake.stats()).byKind["graphql:inbox"]).toBe(1);

      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
      expect((await fake.stats()).byKind["graphql:inbox"]).toBe(1);

      await screen.getByRole("button", "Refresh").tap();
      await expect.poll(async () => (await fake.stats()).byKind["graphql:inbox"]).toBe(2);
    } finally {
      stopFakeInstance("budget-cache", { keepHome: false });
      fake.stop();
    }
  });

  test(
    "a used-up limit pauses prkit, says when it resets, and Retry waits for the reset",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const fake = await startFakeGitHub("budget-limit");
      try {
        const run = startFakeInstance("budget-limit", fake);
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
          timeout: 20_000,
        });
        await fake.limit("graphql", 25);
        await screen.getByRole("button", "Refresh").tap();
        const banner = browser.locator('[data-github-problem="rate-limited"]');
        await expect(banner).toContainText("GitHub's limit for budget-test is used up.");
        await expect(banner).toContainText("Showing what prkit fetched just now.");
        await expect(banner).toContainText(/Resets at \d\d:\d\d/);
        const retry = screen.getByRole("button", "Retry");
        await expect(retry).toBeDisabled();
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
        await app.screenshot("rate-limited-banner");
        const refused = await fake.stats();
        expect(refused.refused).toBe(1);

        await screen.getByRole("button", "Refresh").tap();
        await expect(retry).toBeEnabled({ timeout: 40_000 });
        const paused = await fake.stats();
        expect(paused.refused).toBe(1);
        expect(paused.byKind["graphql:inbox"]).toBe(refused.byKind["graphql:inbox"]);

        await retry.tap();
        await expect(banner).toHaveCount(0, { timeout: 20_000 });
        expect((await fake.stats()).byKind["graphql:inbox"]).toBe(
          (paused.byKind["graphql:inbox"] ?? 0) + 1,
        );
        await app.screenshot("after-reset");
      } finally {
        stopFakeInstance("budget-limit", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "a comment or commit on an open tab shows up without a click, even before the first fingerprint, on a host without stacks",
    { timeout: 120_000 },
    async ({ app, screen }) => {
      const fake = await startFakeGitHub("budget-changes", { stacks: false });
      try {
        // A 5-second watcher tick instead of 60, so the journey waits seconds.
        const run = startFakeInstance("budget-changes", fake, [
          "--e2e",
          "--watch-interval",
          "5000",
        ]);
        await app.open(run.openUrl);
        await screen.getByRole("link", /#3 Budget fixture 3/).tap({ timeout: 20_000 });
        await expect(screen.getByText("First comment on 3")).toBeVisible({ timeout: 20_000 });
        await fake.comment(3);
        await expect(screen.getByText(/^Comment \d+ from the fake$/)).toBeVisible({
          timeout: 20_000,
        });
        await fake.push(3);
        await expect(screen.getByText("Commit 1 from the fake")).toBeVisible({ timeout: 20_000 });
        await app.screenshot("changes-shown");
        const stats = await fake.stats();
        expect(stats.byKind["graphql:inbox"]).toBe(1);
        expect(stats.byKind["rest:pull"]).toBe(3);
        // The host turned stacks down once (the inbox and the first tick may both ask),
        // and every later fingerprint went without them.
        expect(stats.byKind["graphql:no-stacks"]).toBeGreaterThanOrEqual(1);
        expect(stats.byKind["graphql:no-stacks"]).toBeLessThanOrEqual(2);
        expect(stats.byKind["graphql:fingerprint"]).toBeGreaterThanOrEqual(2);
      } finally {
        stopFakeInstance("budget-changes", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "five idle open tabs cost one point a tick, and switching between them reads nothing",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const fake = await startFakeGitHub("budget-idle");
      try {
        const run = startFakeInstance("budget-idle", fake, ["--e2e", "--watch-interval", "5000"]);
        await app.open(run.openUrl);
        const numbers = [1, 2, 3, 4, 5];
        for (const number of numbers) {
          await screen.getByRole("link", "Inbox").tap();
          await screen
            .getByRole("link", new RegExp(`#${number} Budget fixture ${number}\\b`))
            .tap({ timeout: 20_000 });
          await expect(screen.getByRole("heading", `Budget fixture ${number}`)).toBeVisible({
            timeout: 20_000,
          });
        }
        await fake.resetStats();
        const since = Date.now();
        for (const number of [...numbers, ...numbers]) {
          await browser.locator(`a[data-open-pr="github.com/budget/fixtures#${number}"]`).tap();
          await expect(screen.getByRole("heading", `Budget fixture ${number}`)).toBeVisible();
        }
        await expect
          .poll(async () => (await fake.stats()).byKind["graphql:fingerprint"] ?? 0, {
            timeout: 60_000,
          })
          .toBeGreaterThanOrEqual(3);
        const stats = await fake.stats();
        const { "graphql:fingerprint": ticks = 0, ...others } = stats.byKind;
        // Nothing but the watcher's fingerprints: switching tabs answered from prkit's cache.
        expect(others).toEqual({});
        // All five tabs ride in one request a tick, at one point.
        expect(stats.points).toBe(ticks);
        expect(ticks).toBeLessThanOrEqual(Math.ceil((Date.now() - since) / 5000) + 1);
        await app.screenshot("idle-tabs");
      } finally {
        stopFakeInstance("budget-idle", { keepHome: false });
        fake.stop();
      }
    },
  );

  test("after a relaunch the Inbox renders from prkit's cache without waiting for GitHub", async ({
    app,
    screen,
  }) => {
    const fake = await startFakeGitHub("budget-relaunch");
    try {
      const run = startFakeInstance("budget-relaunch", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      stopFakeInstance("budget-relaunch", { keepHome: true });

      await fake.latency(8_000);
      await fake.resetStats();
      const relaunched = startFakeInstance("budget-relaunch", fake);
      const opened = Date.now();
      await app.open(relaunched.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 4_000 });
      expect(Date.now() - opened).toBeLessThan(4_000);
      await expect(screen.getByText("Updated just now")).toBeVisible();
      await app.screenshot("relaunch-from-cache");
      expect((await fake.stats()).byKind["graphql:inbox"]).toBeUndefined();
    } finally {
      stopFakeInstance("budget-relaunch", { keepHome: false });
      fake.stop();
    }
  });

  test(
    "a pending check on the open pull request turns green within 20 seconds, and nothing asks while none is pending or the window is hidden",
    { timeout: 240_000 },
    async ({ app, screen, browser }) => {
      const fake = await startFakeGitHub("budget-checks");
      const asked = async () => {
        const { byKind } = await fake.stats();
        return Object.entries(byKind)
          .filter(([kind]) => /^rest:(check-runs|statuses)(:304)?$/.test(kind))
          .reduce((sum, [, count]) => sum + count, 0);
      };
      const setVisible = (visible: boolean) =>
        browser.evaluate((next: boolean) => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => (next ? "visible" : "hidden"),
          });
          document.dispatchEvent(new Event("visibilitychange"));
          return true;
        }, visible);
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        await fake.checks(3, "in_progress");
        await fake.checks(4, "in_progress");
        // The app's own 60-second watcher tick: only the checks loop can show this in time.
        const run = startFakeInstance("budget-checks", fake);
        await app.open(run.openUrl);
        await screen.getByRole("link", /#3 Budget fixture 3/).tap({ timeout: 20_000 });
        await expect(browser.locator('[data-checks-state="pending"]')).toBeVisible({
          timeout: 20_000,
        });
        await app.screenshot("check-pending");
        // Before prkit has asked even once, so the first answer must be compared, not taken as the baseline.
        await fake.checks(3, "completed");
        const flipped = Date.now();
        await expect(browser.locator('[data-checks-state="passing"]')).toBeVisible({
          timeout: 25_000,
        });
        const shownAfterMs = Date.now() - flipped;
        expect(shownAfterMs).toBeLessThan(20_000);
        NodeFS.mkdirSync(".e2e/evidence/github-budget", { recursive: true });
        NodeFS.writeFileSync(
          ".e2e/evidence/github-budget/check-turned-green.json",
          JSON.stringify({ shownAfterMs }),
        );
        await app.screenshot("check-passing");

        // Nothing pending on the active PR: no check reads at all.
        const settled = await asked();
        await pause(35_000);
        expect(await asked()).toBe(settled);

        await screen.getByRole("link", "Inbox").tap();
        await screen.getByRole("link", /#4 Budget fixture 4/).tap();
        await expect(browser.locator('[data-checks-state="pending"]')).toBeVisible({
          timeout: 20_000,
        });
        const opened = await asked();
        await expect.poll(asked, { timeout: 20_000 }).toBeGreaterThan(opened);

        // A hidden window: still pending, but nobody is looking.
        await setVisible(false);
        await pause(2_000);
        const hidden = await asked();
        await pause(35_000);
        expect(await asked()).toBe(hidden);
        await setVisible(true);
        await expect.poll(asked, { timeout: 20_000 }).toBeGreaterThan(hidden);
      } finally {
        stopFakeInstance("budget-checks", { keepHome: false });
        fake.stop();
      }
    },
  );
});
