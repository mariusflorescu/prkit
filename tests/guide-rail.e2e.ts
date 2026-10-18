import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { type FakeChapter, setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NAME = "guide-rail";

const lines = (count: number, line: (index: number) => string) =>
  `${Array.from({ length: count }, (_, index) => line(index)).join("\n")}\n`;

const FILES = {
  "src/check.ts": lines(
    90,
    (i) => `export const check${i} = (slug: string) => slug.length > ${i};`,
  ),
  "src/wire.ts": lines(
    90,
    (i) => `export const wire${i} = () => import("./check").then((m) => m.check${i});`,
  ),
  "src/schema.sql": lines(40, (i) => `ALTER TABLE links ADD COLUMN slug_${i} TEXT;`),
  "src/config.json": `{\n${lines(30, (i) => `  "slug${i}": ${i},`)}  "end": true\n}\n`,
  "src/limits.test.ts": lines(
    60,
    (i) => `test("slug ${i}", () => expect(check${i}("a")).toBe(${i} < 1));`,
  ),
  "src/README.md": lines(12, (i) => `Slugs line ${i}.`),
};

const CHAPTERS: ReadonlyArray<FakeChapter> = [
  {
    title: "Limits get a slug",
    kind: "core",
    files: ["src/limits.ts", "src/check.ts"],
    risk: "high",
  },
  { title: "Wire the check in", kind: "supporting", files: ["src/wire.ts"] },
  { title: "A column for slugs", kind: "data", files: ["src/schema.sql"], risk: "medium" },
  { title: "Slug length in config", kind: "config", files: ["src/config.json"] },
  { title: "Tests for slugs", kind: "tests", files: ["src/limits.test.ts"] },
  { title: "Docs", kind: "docs", files: ["src/README.md"] },
  { title: "The generated fixture", kind: "generated", files: ["src/change-0.ts"] },
];

test(
  "the chapter rail shows where you are and what you reviewed, in step with j, k, r and clicks",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    try {
      const head = git.commit(9, FILES);
      await fake.gitHead(9, head);
      claude.chapters(CHAPTERS);
      const run = git.start(() => startFakeInstance(NAME, fake, ["--claude", claude.file]));
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`,
      );
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Limits get a slug")).toBeVisible({
        timeout: 90_000,
      });

      const rail = screen.getByRole("navigation", "Chapters");
      const tick = (index: number) =>
        rail.getByRole("button", new RegExp(`^Chapter ${index} of 7, `));
      const current = () =>
        browser.evaluate(
          () =>
            document
              .querySelector("[data-chapter-rail] [aria-current='location']")
              ?.getAttribute("aria-label") ?? null,
        );
      const focusedChapter = () =>
        browser.evaluate(
          () =>
            document.activeElement
              ?.closest("[data-guide-chapter]")
              ?.getAttribute("data-chapter-id") ?? null,
        );
      await expect(rail.getByRole("button")).toHaveCount(7);
      expect(
        await browser.evaluate(() =>
          Array.from(document.querySelectorAll("[data-chapter-rail] li")).flatMap((li, index) =>
            li.hasAttribute("data-gap") ? [index + 1] : [],
          ),
        ),
      ).toEqual([3, 5, 7]);
      await expect(tick(7)).toHaveAttribute("data-quiet", "true");
      await expect(tick(1)).not.toHaveAttribute("data-quiet");
      await expect(tick(1)).toHaveAttribute("data-state", "unreviewed");
      expect(
        await browser.evaluate(() =>
          Array.from(document.querySelectorAll("[data-chapter-rail] [data-rail-mark]")).map(
            (mark) => mark.getAttribute("data-risk"),
          ),
        ),
      ).toEqual(["high", "low", "medium", "low", "low", "low", "low"]);
      expect(await current()).toBeNull();
      await screenshotLightAndDark(app, browser, "rail-overview");

      await tick(3).tap();
      await expect(tick(3)).toHaveAttribute("aria-current", "location");
      await expect.poll(focusedChapter).toBe("a-column-for-slugs");
      await browser.keyboard.press("j");
      await expect(tick(4)).toHaveAttribute("aria-current", "location");
      await expect.poll(focusedChapter).toBe("slug-length-in-config");
      await browser.keyboard.press("k");
      await expect(tick(3)).toHaveAttribute("aria-current", "location");
      await browser.keyboard.press("r");
      await expect(
        screen.getByRole("checkbox", "Reviewed chapter A column for slugs"),
      ).toHaveAttribute("aria-checked", "true");
      await expect(tick(3)).toHaveAttribute("data-state", "reviewed");
      await expect(tick(3)).toHaveAccessibleName(
        "Chapter 3 of 7, A column for slugs, medium risk, reviewed",
      );

      await tick(1).tap();
      await expect(tick(1)).toHaveAttribute("aria-current", "location");
      await screen.getByRole("checkbox", "Reviewed src/check.ts").tap();
      await expect(tick(1)).toHaveAttribute("data-state", "partial");
      await expect(tick(1)).toHaveAccessibleName(
        "Chapter 1 of 7, Limits get a slug, high risk, 1 of 2 files reviewed",
      );
      await tick(1).hover();
      const tooltip = browser.locator('[data-slot="tooltip-popup"]');
      await expect(tooltip).toContainText("Limits get a slug");
      await expect(tooltip).toContainText("Core · High risk · 1 of 2 reviewed");
      await screenshotLightAndDark(app, browser, "rail-partial-tooltip");

      await browser.evaluate(() => {
        const scroller = document.querySelector("[data-pr-scroll]");
        const chapter = document.querySelector("[data-chapter-id='wire-the-check-in']");
        if (scroller === null || chapter === null) return false;
        const pinned = Number.parseFloat(
          getComputedStyle(scroller).getPropertyValue("--pr-pinned-height"),
        );
        scroller.scrollBy({
          top:
            chapter.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            pinned +
            40,
          behavior: "instant",
        });
        return true;
      });
      await expect(tick(2)).toHaveAttribute("aria-current", "location");

      await tick(6).tap();
      await expect(tick(6)).toHaveAttribute("aria-current", "location");
      await browser.keyboard.press("j");
      await expect(tick(7)).toHaveAttribute("aria-current", "location");
      await expect.poll(focusedChapter).toBe("the-generated-fixture");
      await browser.keyboard.press("j");
      await expect(tick(7)).toHaveAttribute("aria-current", "location");
      await browser.keyboard.press("k");
      await expect(tick(6)).toHaveAttribute("aria-current", "location");
      await app.screenshot("rail-end-of-guide");

      await tick(6).focus();
      await browser.keyboard.press("ArrowUp");
      await expect(tick(5)).toBeFocused();
      await browser.keyboard.press("Home");
      await expect(tick(1)).toBeFocused();
      await browser.keyboard.press("End");
      await expect(tick(7)).toBeFocused();
      await browser.keyboard.press("ArrowUp");
      await browser.keyboard.press("Enter");
      await expect(tick(6)).toHaveAttribute("aria-current", "location");
      await expect.poll(focusedChapter).toBe("docs");

      await browser.setViewport({ width: 900, height: 860 });
      await expect(tick(1)).toBeVisible();
      await screenshotLightAndDark(app, browser, "rail-900");
      await browser.setViewport({ width: 680, height: 860 });
      await expect(tick(1)).toBeHidden();
      await app.screenshot("rail-680-hidden");
      await browser.setViewport({ width: 1280, height: 860 });
      await expect(tick(1)).toBeVisible();
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
