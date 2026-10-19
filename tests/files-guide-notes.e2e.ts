import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { type FakeNote, setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NAME = "files-guide-notes";
const KEY = "github.com/budget/fixtures#9";
const LIMITS = "src/limits.ts";
const PR = "/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test";

const SLUG = "Why does a slug get its own limit here instead of in the shared config?";
const URL_RISK = "Dropping the 1024 limit lets far longer links through. Is that on purpose?";
const CHECK = "Should an empty URL pass this check?";
const BRACE = "Does short need a test of its own?";
const GENERATED = "Is this generated file meant to be in the PR?";
const FILE_NOTE = "The limits gain a slug, and two checks read them.";

/** PR 9's limits with two checks, whose `}` rows read the same four lines apart. */
const CHECKS = `export const limits = {
  url: 2048,
  slug: 64,
  title: 120,
};

export const schemes = ["http", "https"];

export function check(url: string) {
  return url.length <= limits.url;
}

export function short(slug: string) {
  return slug.length <= limits.slug;
}
`;
const MOVED = `// Limits for links and slugs.
// Every value is a length in characters.
// Change them here and nowhere else.
// The checks below read them.
${CHECKS.replace("return url.length <= limits.url;", "return url.length > 0 && url.length <= limits.url;")}`;

const question = (line: number, text: string): FakeNote => ({
  line,
  side: "additions",
  tone: "question",
  text,
});
const risk = (line: number, text: string): FakeNote => ({
  line,
  side: "deletions",
  tone: "risk",
  text,
});

const servedLimits = (patch: string) => ({
  filename: LIMITS,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

const noteIn = (browser: Browser, tone: FakeNote["tone"], text: string) =>
  browser
    .locator(`[data-path="${LIMITS}"] [data-guide-note][data-tone="${tone}"]`)
    .filter({ hasText: text });

const revisionCount = (home: string) =>
  readRows(
    home,
    `SELECT COUNT(*) AS n FROM review_revisions r JOIN reviews v ON v.id = r.review_id WHERE v.pr_key = '${KEY}'`,
  )[0]?.n;

test(
  "guide notes on Files: placed where they still apply, hidden on request across a relaunch, and honest about an older guide",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    const launch = () =>
      git.start(() =>
        startFakeInstance(NAME, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          "5000",
        ]),
      );
    try {
      const first = git.commit(9, { [LIMITS]: CHECKS });
      await fake.files(9, [servedLimits(git.patch(9, LIMITS))]);
      await fake.gitHead(9, first);
      claude.notes({
        [LIMITS]: [question(3, SLUG), risk(2, URL_RISK), question(10, CHECK), question(15, BRACE)],
        "src/change-0.ts": [question(1, GENERATED)],
      });
      claude.fileNotes({ [LIMITS]: FILE_NOTE });
      let run = launch();
      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}${PR}&tab=guide`);
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r1 · ", { timeout: 120_000 });

      const tabs = screen.getByRole("navigation", "Pull request tabs");
      await tabs.getByRole("link", "Files").tap();
      const file = screen.getByRole("region", LIMITS);
      const slug = noteIn(browser, "question", SLUG);
      const brace = noteIn(browser, "question", BRACE);
      const check = noteIn(browser, "question", CHECK);
      const url = noteIn(browser, "risk", URL_RISK);
      const fileNote = browser.locator(`[data-path="${LIMITS}"] [data-file-diff-note]`);
      const labelled = (label: string) =>
        browser.locator(`[data-guide-note][aria-label="${label}"]`);
      const hiddenOne = tabs.getByRole("button", "1 guide note hidden");
      const notesStatus = browser.locator("nav [data-guide-notes-status]");
      const hide = tabs.getByRole("button", "Hide guide notes");
      const show = tabs.getByRole("button", "Show guide notes");
      await expect(slug).toBeVisible({ timeout: 30_000 });
      await expect(labelled("Guide question")).toHaveCount(3);
      await expect(labelled("Guide risk")).toHaveCount(1);
      await expect(slug).toContainText("Guide");
      await expect(fileNote).toContainText("Guide");
      await expect(fileNote).toContainText(FILE_NOTE);
      await expect(hide).toHaveAttribute("aria-pressed", "true");
      await expect(hiddenOne).toBeVisible();
      await expect(notesStatus).toContainText(
        "1 guide note is hidden: GitHub's diff doesn't show its line now.",
      );
      await expect(file).toContainText("3 questions");
      await expect(file).toContainText("1 risk");
      await slug.scrollIntoView();
      await screenshotLightAndDark(app, browser, "files-notes");

      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      const slugField = screen.getByRole("textbox", "Comment on line 3");
      await expect(slugField).toHaveValue(SLUG);
      await screenshotLightAndDark(app, browser, "files-note-composer");
      await slugField.press("Meta+Enter");
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      expect(
        readRows(
          run.home,
          `SELECT end_line AS line, note_key IS NOT NULL AS fromNote FROM pending_comments WHERE pr_key = '${KEY}'`,
        ),
      ).toEqual([{ line: 3, fromNote: 1 }]);
      await tabs.getByRole("link", "Guide").tap();
      const guideSlug = noteIn(browser, "question", SLUG);
      await guideSlug.scrollIntoView({ timeout: 30_000 });
      await expect(guideSlug.getByRole("status")).toHaveText("In your review.");
      await expect(labelled("Guide question")).toHaveCount(0);
      await tabs.getByRole("link", "Files").tap();

      await hide.tap();
      await expect(show).toHaveAttribute("aria-pressed", "false");
      await expect(browser.locator("[data-pr-files] [data-guide-note]")).toHaveCount(0);
      await expect(fileNote).toHaveCount(0);
      await expect(hiddenOne).toHaveCount(0);
      await app.screenshot("files-notes-hidden");
      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      expect(
        readRows(run.home, "SELECT value FROM settings WHERE key = 'appearance.guideNotesOnFiles'"),
      ).toEqual([{ value: "false" }]);
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}${PR}&tab=files`);
      await expect(file).toBeVisible({ timeout: 30_000 });
      await expect(show).toHaveAttribute("aria-pressed", "false");
      await expect(browser.locator("[data-pr-files] [data-guide-note]")).toHaveCount(0);
      await show.tap();
      await expect(slug).toBeVisible({ timeout: 30_000 });
      await expect(hide).toHaveAttribute("aria-pressed", "true");

      claude.hold();
      const moved = git.commit(9, { [LIMITS]: MOVED });
      await fake.files(9, [servedLimits(git.patch(9, LIMITS))]);
      await fake.gitHead(9, moved);
      await expect(file).toContainText("+14 -1", { timeout: 60_000 });
      await expect(brace.getByRole("button", "Add as comment, question on line 19")).toBeVisible({
        timeout: 30_000,
      });
      await expect(url.getByRole("button", "Add as comment, risk on old line 2")).toBeVisible();
      await expect(check).toHaveCount(0);
      await expect(fileNote).toHaveCount(0);
      await expect(tabs.getByRole("button", "Guide notes from an older commit")).toBeVisible();
      await expect(notesStatus).toContainText(
        "Guide notes come from r1, written for an older commit. They show only where the code still reads the same. 3 no longer match and are hidden. prkit is updating the guide.",
        { timeout: 30_000 },
      );
      await expect(slug.getByRole("button", "Add as comment, question on line 7")).toHaveCount(0);
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      await browser.evaluate(() => {
        document.querySelector("[data-pr-scroll]")?.scrollTo({ top: 0, behavior: "instant" });
        return true;
      });
      await screenshotLightAndDark(app, browser, "files-notes-older");
      await brace.scrollIntoView();
      await screenshotLightAndDark(app, browser, "files-notes-older-moved");

      await brace.getByRole("button", "Add as comment, question on line 19").tap();
      const braceField = screen.getByRole("textbox", "Comment on line 19");
      await expect(braceField).toHaveValue(BRACE);
      const words = "Does short need its own test, or does the check above cover it?";
      await braceField.fill(words);
      await hide.tap();
      const hiding = tabs.getByText("Guide notes hide after your comment");
      await expect(hiding).toBeVisible();
      await expect(brace).toBeVisible();
      await expect(braceField).toHaveValue(words);
      await show.tap();
      await expect(hiding).toHaveCount(0);
      await expect(braceField).toHaveValue(words);
      await braceField.press("Meta+Enter");
      await expect(brace.getByRole("status")).toHaveText("In your review.");

      claude.notes({
        [LIMITS]: [question(7, SLUG), risk(2, URL_RISK), question(14, CHECK), question(19, BRACE)],
        "src/change-0.ts": [question(1, GENERATED)],
      });
      claude.release();
      await expect.poll(() => revisionCount(run.home), { timeout: 120_000 }).toBe(2);
      const newer = tabs.getByRole("button", "Show newer notes");
      await expect(newer).toBeVisible({ timeout: 30_000 });
      await expect(notesStatus).toContainText("A newer guide is ready.");
      await expect(check).toHaveCount(0);
      await browser.evaluate(() => {
        document.querySelector("[data-pr-scroll]")?.scrollTo({ top: 0, behavior: "instant" });
        return true;
      });
      await screenshotLightAndDark(app, browser, "files-notes-newer");
      await newer.tap();
      await expect(check.getByRole("button", "Add as comment, question on line 14")).toBeVisible({
        timeout: 30_000,
      });
      await expect(fileNote).toContainText(FILE_NOTE);
      await expect(brace.getByRole("status")).toHaveText("In your review.");
      await expect(hiddenOne).toBeVisible();
      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
