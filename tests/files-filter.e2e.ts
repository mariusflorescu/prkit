import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const NAME = "files-filter";
const ACCOUNT = "github.com/budget-test";
const PATHS = [
  "src/inbox/InboxRow.tsx",
  "src/inbox/inboxStore.ts",
  "src/guide/GuideView.tsx",
  "src/guide/chapterRail.ts",
  "server/reviews/Reviews.ts",
  "docs/inbox.md",
];

const served = (path: string, index: number) => ({
  filename: path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: `@@ -1,3 +1,3 @@\n export const id = ${index};\n-export const name = "old";\n+export const name = "${path}";\n export const done = true;`,
});

test(
  "the Files tree filter narrows by path and to files left to review, from the keyboard too",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    try {
      await fake.files(1, PATHS.map(served));
      const run = startFakeInstance(NAME, fake);
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/1?account=${encodeURIComponent(ACCOUNT)}&tab=files`,
      );
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(PATHS.length, {
        timeout: 30_000,
      });

      const tree = screen.getByRole("navigation", "Changed files");
      const panel = browser.locator("[data-file-tree-panel]");
      const field = screen.getByRole("searchbox", "Filter files");
      const rows = browser.locator(
        "nav[aria-label='Changed files'] [data-file-tree-row][data-path]",
      );
      const heading = tree.getByRole("heading");
      await expect(heading).toHaveText(`Files ${PATHS.length}`);
      await expect(field).toHaveAttribute("placeholder", "Filter by path");

      await field.fill("inbox");
      await expect(rows).toHaveCount(3);
      await expect(heading).toHaveText(`Files 3 of ${PATHS.length}`);
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(PATHS.length);
      await tree.getByRole("button", "docs").tap();
      await field.focus();
      await browser.keyboard.press("Enter");
      await expect(
        browser.locator("[data-file-diff-card][data-path='docs/inbox.md']"),
      ).toBeFocused();
      await field.fill("guide view");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toHaveAttribute("data-path", "src/guide/GuideView.tsx");
      await app.screenshot("filter-one-match");

      await field.fill("nothing like this");
      const empty = panel.getByRole("status");
      await expect(empty).toContainText("No files match");
      await expect(tree).toHaveCount(0);
      await screenshotLightAndDark(app, browser, "filter-no-match");
      await empty.getByRole("button", "Clear filter").tap();
      await expect(field).toHaveValue("");
      await expect(field).toBeFocused();
      await expect(rows).toHaveCount(PATHS.length);

      await browser.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return document.activeElement === document.body;
      });
      await browser.keyboard.press("/");
      await expect(field).toBeFocused();
      await browser.keyboard.type("reviews");
      await expect(rows).toHaveCount(1);
      await browser.keyboard.press("Enter");
      const card = (path: string) => browser.locator(`[data-file-diff-card][data-path="${path}"]`);
      await expect(card("server/reviews/Reviews.ts")).toBeFocused();
      await expect
        .poll(() =>
          browser.evaluate(() => {
            const scroller = document.querySelector("[data-pr-scroll]");
            const target = document.querySelector(
              "[data-file-diff-card][data-path='server/reviews/Reviews.ts']",
            );
            if (scroller === null || target === null) return null;
            const pinned = Number.parseFloat(
              getComputedStyle(scroller).getPropertyValue("--pr-pinned-height"),
            );
            return Math.round(
              target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pinned,
            );
          }),
        )
        .toBeLessThan(40);
      await browser.keyboard.press("r");
      await expect(
        screen.getByRole("checkbox", "Reviewed server/reviews/Reviews.ts"),
      ).toHaveAttribute("aria-checked", "true");

      await field.focus();
      await browser.keyboard.press("Escape");
      await expect(field).toHaveValue("");
      await browser.keyboard.press("Escape");
      await expect(field).not.toBeFocused();

      const toReview = screen.getByRole("button", "Only files to review");
      await toReview.tap();
      await expect(toReview).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(PATHS.length - 1);
      await expect(
        browser.locator("nav[aria-label='Changed files'] [data-path='server/reviews/Reviews.ts']"),
      ).toHaveCount(0);
      await screen.getByRole("checkbox", "Reviewed docs/inbox.md").tap();
      await expect(rows).toHaveCount(PATHS.length - 2);
      await field.fill("inbox");
      await expect(rows).toHaveCount(2);
      await expect(heading).toHaveText(`Files 2 of ${PATHS.length}`);
      await screenshotLightAndDark(app, browser, "filter-to-review");

      const tabs = screen.getByRole("navigation", "Pull request tabs");
      await tabs.getByRole("link", "Conversation").tap();
      await tabs.getByRole("link", "Files").tap();
      await expect(field).toHaveValue("inbox");
      await expect(screen.getByRole("button", "Only files to review")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(rows).toHaveCount(2);

      await screen.getByRole("button", "Hide file tree").tap();
      await expect(field).toHaveCount(0);
      await browser.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return document.activeElement === document.body;
      });
      await browser.keyboard.press("/");
      await expect(field).toBeFocused();
      await expect(screen.getByRole("button", "Hide file tree")).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      await browser.setViewport({ width: 900, height: 860 });
      await app.screenshot("filter-900");
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
