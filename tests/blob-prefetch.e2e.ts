import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { AGENT_RUNS, AGENT_SKIP, FIXTURE_REPO, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import { headSha } from "./reviewFixture.ts";

/**
 * A PR whose head and base branch never move, so GitHub serves both from its repacked
 * pack. Told that the blobless cache holds those commits, GitHub left the blobs prkit
 * asked for out of the pack, and the guide failed while preparing.
 */
const FIXTURE = { number: 447, title: "Retire short link 2500" };

describe("blob prefetch", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "a pull request on a base that never moves gets past preparing",
    { timeout: 240_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      await openInbox({ app, screen });
      await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE.title);
      await screen
        .getByRole("region", "Yours")
        .getByRole("link", new RegExp(`#${FIXTURE.number} ${FIXTURE.title}`))
        .tap({ timeout: 45_000 });
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      const settled = browser.locator(
        '[data-active-tab="true"] :is([data-review-status="writing"], [data-review-status="failed"])',
      );
      await expect(settled).toBeAttached({ timeout: 120_000 });
      await app.screenshot("after-preparing");
      await expect(settled).toHaveAttribute("data-review-status", "writing");
      // Preparing is what this proves; stop the agent before it spends the subscription.
      await screen.getByRole("button", "Stop").tap({ timeout: 30_000 });
      await expect(
        browser.locator('[data-active-tab="true"] [data-review-status="done"]'),
      ).toBeAttached({ timeout: 30_000 });

      expect(
        readRows(
          run.home,
          `SELECT a.head_sha FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = 'github.com/${FIXTURE_REPO}#${FIXTURE.number}'`,
        ),
      ).toEqual([{ head_sha: headSha(FIXTURE.number) }]);
    },
  );
});
