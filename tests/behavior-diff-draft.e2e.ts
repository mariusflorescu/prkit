import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { lineOpener } from "./guideLines.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NAME = "behavior-diff-draft";
const ACCOUNT = "github.com/budget-test";
const LIMITS = "src/limits.ts";
const at = (line: number) => ({ path: LIMITS, line });

/** Each behavior row and its location, as `[left, top, width, height]` from the list's corner, and the list's own corner. */
const rowPlaces = () => {
  const list = document.querySelector("[data-behavior-diff]");
  if (list === null) return null;
  const origin = list.getBoundingClientRect();
  const box = (element: Element | null) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height].map(
      Math.round,
    );
  };
  return {
    list: [Math.round(origin.left), Math.round(origin.top)],
    rows: [...list.querySelectorAll("[data-behavior-row]")].map((row) => ({
      row: box(row),
      at: box(row.querySelector("[data-line-link]")),
    })),
  };
};

test(
  "a behavior row's location stays text until its chapter is written, then opens its line from the same place",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    try {
      claude.flow({
        title: "What the limits allow",
        rows: [
          { text: "`limits` holds each length limit", at: at(1) },
          {
            text: "a URL can be 1024 characters",
            status: "removed",
            depth: 1,
            at: at(2),
            chapter: 1,
          },
          {
            text: "a URL can be 2048 characters",
            status: "added",
            depth: 1,
            at: at(2),
            chapter: 1,
          },
          { text: "a slug can be 64 characters", status: "added", depth: 1, at: at(3), chapter: 1 },
        ],
      });
      claude.drafting();
      const run = git.start(() => startFakeInstance(NAME, fake, ["--claude", claude.file]));
      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent(ACCOUNT)}&tab=guide`,
      );
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });

      const writing = browser.locator('[data-review-status="writing"]');
      const asTextLocations = browser.locator("[data-behavior-diff] span[data-line-link]");
      const asLinks = browser.locator("[data-behavior-diff] button[data-line-link]");
      const openSlug = screen.getByRole("button", `Open ${LIMITS} line 3`);
      await expect(browser.locator("[data-behavior-row]")).toHaveCount(4, { timeout: 90_000 });
      await expect(writing).toBeAttached();
      await expect(asTextLocations).toHaveText([
        "limits.ts:1",
        "limits.ts:2",
        "limits.ts:2",
        "limits.ts:3",
      ]);
      await expect(asLinks).toHaveCount(0);
      const asText = await browser.evaluate(rowPlaces);
      await browser.locator("[data-flow-card]").scrollIntoView();
      await screenshotLightAndDark(app, browser, "behavior-draft-location-text");

      claude.releaseDraft("overview");
      await expect(openSlug).toBeVisible({ timeout: 30_000 });
      await expect(writing).toBeAttached();
      await expect(asLinks).toHaveCount(4);
      expect(await browser.evaluate(rowPlaces)).toEqual(asText);
      await screenshotLightAndDark(app, browser, "behavior-draft-location-link");
      const opened = await lineOpener(screen, browser)(LIMITS, 3);
      expect(opened.late.selected).toEqual([3]);
      await expect(writing).toBeAttached();

      claude.releaseDraft("chapter");
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 60_000,
      });
      const accepted = await browser.evaluate(rowPlaces);
      expect(accepted?.rows).toEqual(asText?.rows);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
