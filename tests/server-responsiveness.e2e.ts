import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { readHealth, runForUrl } from "../scripts/verify-run.ts";
import { FIXTURE_ACCOUNT, FIXTURE_REPO, NEEDS_FIXTURE, prPath } from "./fixturePr.ts";

test(
  "inbox refreshes and PR reads keep the server responsive",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    // Three forced refreshes per run: each one spends real GitHub budget (standing order 13).
    for (let refresh = 0; refresh < 3; refresh++) {
      await app.open(run.openUrl);
      // An earlier journey in the same run can leave a PR tab active, which the app restores.
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("button", "Refresh").tap({ timeout: 45_000 });
      await expect(screen.getByRole("button", "Refreshing...")).toHaveCount(0, { timeout: 45_000 });
      await expect(
        browser.locator(`a[data-repository="${FIXTURE_REPO}"][data-pr-number="1"]`),
      ).toHaveCount(1);
      const health = await readHealth(run.url);
      expect(health.ok).toBe(true);
      expect(health.home).toBe(run.home);
    }
    for (const [repository, number] of [
      [FIXTURE_REPO, 1],
      ["pingdotgg/t3code", 16782],
    ] as const) {
      await app.open(`${run.url}${prPath(repository, number, "conversation")}`);
      await expect(browser.locator("[data-reading-account]")).toHaveText(FIXTURE_ACCOUNT, {
        timeout: 45_000,
      });
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
      await expect(browser.locator("[data-file-diff-card]").first()).toBeVisible({
        timeout: 45_000,
      });
      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("link", "Conversation")
        .tap();
      await expect(
        browser.locator('section[aria-label="Activity"] [data-timeline-kind]').first(),
      ).toBeVisible({ timeout: 45_000 });
      expect((await readHealth(run.url)).ok).toBe(true);
    }
    await app.screenshot("server-responsive-after-refreshes");
  },
);
