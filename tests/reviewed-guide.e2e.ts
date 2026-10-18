import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  startFakeGitHub,
  startFakeInstance,
  startInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { FIXTURE_FILES, FIXTURE_NAME, NEEDS_FIXTURE } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NINE = ["src/change-0.ts", "src/limits.ts"];

test(
  "a chapter's checkbox follows its files, ticks them all, and keeps across a reload and revisions",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "reviewed-guide";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    try {
      const run = git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
      const guideUrl = `${run.url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`;
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(guideUrl);
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });

      const count = browser.locator("nav[aria-label='Pull request tabs'] [data-reviewed-count]");
      const chapterBox = (title: string) =>
        screen.getByRole("checkbox", `Reviewed chapter ${title}`);
      const chapterToggle = (title: string) => screen.getByRole("button", title, { exact: true });
      const fileBox = (path: string) => screen.getByRole("checkbox", `Reviewed ${path}`);
      const card = (path: string) => browser.locator(`[data-file-diff-card][data-path="${path}"]`);
      await expect(count).toHaveText("0 / 2 reviewed");
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "false");
      await expect(
        screen.getByText("j / k to move between chapters · r to mark reviewed"),
      ).toBeVisible();

      await fileBox("src/limits.ts").tap();
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "mixed");
      await expect(count).toHaveText("1 / 2 reviewed");
      await expect(card("src/limits.ts")).toHaveAttribute("data-open", "false");
      await expect(chapterToggle("Every change")).toHaveAttribute("aria-expanded", "true");
      await screenshotLightAndDark(app, browser, "guide-partial-chapter");

      await chapterBox("Every change").tap();
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "true");
      await expect(chapterToggle("Every change")).toHaveAttribute("aria-expanded", "false");
      await expect(count).toHaveText("All 2 reviewed");
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(0);
      await app.screenshot("guide-chapter-reviewed");
      await chapterToggle("Every change").tap();
      for (const path of NINE) {
        await expect(card(path)).toHaveAttribute("data-reviewed", "reviewed");
        await expect(card(path)).toHaveAttribute("data-open", "false");
      }
      await chapterBox("Every change").tap();
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "false");
      await expect(chapterToggle("Every change")).toHaveAttribute("aria-expanded", "true");
      await expect(count).toHaveText("0 / 2 reviewed");
      for (const path of NINE) {
        await expect(card(path)).toHaveAttribute("data-reviewed", "unreviewed");
        await expect(card(path)).toHaveAttribute("data-open", "true");
      }
      await chapterBox("Every change").tap();
      await expect(chapterToggle("Every change")).toHaveAttribute("aria-expanded", "false");
      await expect(count).toHaveText("All 2 reviewed");

      // Clicking the chapter's number focuses the chapter without opening it.
      await browser.locator("[data-guide-chapter] [data-chapter-meta] > span").first().tap();
      expect(
        await browser.evaluate(
          () => document.activeElement?.hasAttribute("data-guide-chapter") ?? false,
        ),
      ).toBe(true);
      await browser.keyboard.press("r");
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "false");
      await expect(chapterToggle("Every change")).toHaveAttribute("aria-expanded", "true");
      await expect(count).toHaveText("0 / 2 reviewed");
      for (const path of NINE) {
        await expect(card(path)).toHaveAttribute("data-reviewed", "unreviewed");
        await expect(card(path)).toHaveAttribute("data-open", "true");
      }

      await fileBox("src/limits.ts").tap();
      await expect(count).toHaveText("1 / 2 reviewed");
      await app.open(guideUrl);
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 30_000 });
      await expect(count).toHaveText("1 / 2 reviewed");
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "mixed");
      await expect(fileBox("src/limits.ts")).toHaveAttribute("aria-checked", "true");
      await expect(card("src/limits.ts")).toHaveAttribute("data-open", "false");
      await expect(card("src/change-0.ts")).toHaveAttribute("data-open", "true");

      claude.split(true);
      await screen.getByRole("button", "Generate again").tap();
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r2 · ", { timeout: 90_000 });
      await expect(screen.getByRole("heading", "Change in src/limits.ts")).toBeVisible();
      await expect(count).toHaveText("1 / 2 reviewed");
      await expect(chapterBox("Change in src/limits.ts")).toHaveAttribute("aria-checked", "true");
      await expect(chapterToggle("Change in src/limits.ts")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(chapterBox("Change in src/change-0.ts")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await app.screenshot("guide-r2-marks-kept");

      const focusedChapter = () =>
        browser.evaluate(
          () =>
            document.activeElement
              ?.closest("[data-guide-chapter]")
              ?.getAttribute("data-chapter-id") ?? null,
        );
      const press = async (key: string) => {
        await browser.keyboard.press(key);
        // Two frames cover the instant scroll and the focus that follows it.
        await browser.evaluate(
          () =>
            new Promise<boolean>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
            ),
        );
        return focusedChapter();
      };
      await chapterToggle("Change in src/limits.ts").tap();
      await browser.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return true;
      });
      expect(
        await browser.evaluate(() => document.querySelector("[data-pr-scroll]")?.scrollTop ?? 0),
      ).toBeGreaterThan(1000);
      expect(await press("j")).toBe("change-in-src-limits-ts");
      expect(await press("k")).toBe("change-in-src-change-0-ts");
      const belowPinned = await browser.evaluate(() => {
        const scroller = document.querySelector("[data-pr-scroll]");
        const chapter = document.querySelector("[data-chapter-id='change-in-src-change-0-ts']");
        if (scroller === null || chapter === null) return null;
        const pinned = Number.parseFloat(
          getComputedStyle(scroller).getPropertyValue("--pr-pinned-height"),
        );
        return Math.round(
          chapter.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pinned,
        );
      });
      expect(belowPinned).toBe(16);
      expect(await press("j")).toBe("change-in-src-limits-ts");
      await app.screenshot("guide-j-k-in-pr-view");

      await revision.tap();
      await screen.getByRole("option", /^r1 · /).tap();
      await expect(screen.getByRole("heading", "Every change")).toBeVisible();
      await expect(count).toHaveText("1 / 2 reviewed");
      await expect(chapterBox("Every change")).toHaveAttribute("aria-checked", "mixed");
      await expect(fileBox("src/limits.ts")).toHaveAttribute("aria-checked", "true");
      await app.screenshot("guide-r1-marks-kept");

      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      claude.split(false);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "files ticked through a guide's chapter read reviewed on the Files tab of the same PR",
  { skip: NEEDS_FIXTURE, timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const name = "reviewed-cross-surface";
    const claude = setUpFakeClaude(name);
    const run = startInstance(name, ["--claude", claude.file]);
    try {
      await app.open(run.openUrl);
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
      await screen
        .getByRole("region", "Yours")
        .getByRole("link", /#1 Validate links and count clicks/)
        .tap({ timeout: 45_000 });
      const tabs = screen.getByRole("navigation", "Pull request tabs");
      await tabs.getByRole("link", "Guide").tap();
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 120_000 });
      const count = browser.locator("nav[aria-label='Pull request tabs'] [data-reviewed-count]");
      const total = FIXTURE_FILES.length;
      await expect(count).toHaveText(`0 / ${total} reviewed`);
      await screen.getByRole("checkbox", "Reviewed chapter Every change").tap();
      await expect(count).toHaveText(`All ${total} reviewed`);
      await app.screenshot("cross-surface-guide");

      await tabs.getByRole("link", "Files").tap();
      await expect(count).toHaveText(`All ${total} reviewed`, { timeout: 30_000 });
      for (const path of FIXTURE_FILES) {
        await expect(screen.getByRole("checkbox", `Reviewed ${path}`)).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expect(screen.getByRole("region", path)).toHaveAttribute("data-reviewed", "reviewed");
      }
      await app.screenshot("cross-surface-files");
    } finally {
      stopFakeInstance(name, { keepHome: false });
    }
  },
);
