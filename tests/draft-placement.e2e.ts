import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const KEY = "github.com/budget/fixtures#9";
const LIMITS = "src/limits.ts";
const FILES = "/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files";

/** Two checks whose `}` rows read the same, five lines apart (12 and 17). */
const WRITTEN = `export const limits = {
  url: 2048,
  title: 120,
};

export const schemes = ["http", "https"];
export const separator = "-";

export function check(url: string) {
  if (url.length === 0) return false;
  return url.length <= limits.url;
}

export function short(slug: string) {
  if (slug.length === 0) return false;
  return slug.length <= 64;
}

export function heading(text: string) {
  return text.trim().length <= limits.title;
}
`;
/** Six lines on top, the separator gone and check's return changed: check's `}` is now line 17. */
const SHIFTED = `// Limits for links, slugs and headings.
// Every value is a length in characters.
// Change them here and nowhere else.
// The checks below read them.
// An empty value never passes.
// Keep this file free of imports.
${WRITTEN.replace('export const separator = "-";\n', "").replace(
  "return url.length <= limits.url;",
  'return url.startsWith("https:") && url.length <= limits.url;',
)}`;

const SHORT = "Does short need a test of its own?";
const CHECK = "check could say why an empty URL fails.";
const HEADING = "Should heading count characters before trimming?";
const HEADING_EDITED = "Should heading count characters after trimming instead?";
const SEPARATOR = "Is the separator read anywhere?";
const URL_RISK = "Dropping the 1024 limit lets far longer links through.";

const LINES_CHANGED =
  "These lines changed after you wrote this, so it won't be sent until it is on a current line.";
const UNCHECKED =
  "This was written before prkit kept the lines around a comment, and new commits came in since. It won't be sent until you confirm its line.";

const pending = (where: string) => `Pending comment on ${LIMITS} ${where}`;

const Review = Schema.Struct({
  commit_id: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      body: Schema.String,
      line: Schema.Int,
      side: Schema.String,
      start_line: Schema.optional(Schema.Int),
    }),
  ),
});

const onlyReviewPosted = async (fake: FakeGitHub) => {
  const writes = await fake.writes();
  expect(writes.map((write) => write.kind)).toEqual(["POST pulls/9/reviews"]);
  return Schema.decodeUnknownSync(Review)(writes[0]?.input);
};

const served = (patch: string) => ({
  filename: LIMITS,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

const draftRows = (home: string) =>
  readRows(
    home,
    `SELECT body, start_side AS side, end_line AS line, state, commit_sha AS sha, context IS NOT NULL AS hasContext FROM pending_comments WHERE pr_key = '${KEY}' ORDER BY created_at, id`,
  );

const fixtures = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const git = outsideGit(name);
  /** Commits to PR 9 and has the fake serve its limits patch at that head. */
  const push = async (files: Record<string, string>) => {
    const sha = git.commit(9, files);
    await fake.files(9, [served(git.patch(9, LIMITS))]);
    await fake.gitHead(9, sha);
    return sha;
  };
  return { fake, push };
};

/**
 * A line number in the unified diff, `line 17` or `old line 2`. Only one of them is a
 * button at a time (the gutter's tab stop); a pointer's tap selects the line it numbers.
 */
const lineNumber = (browser: Browser, where: string) => {
  const [, old, line] = /^(old )?line (\d+)$/.exec(where) ?? [];
  const deletion = '[data-line-type="change-deletion"]';
  return browser.locator(
    `[data-path="${LIMITS}"] [data-gutter] > [data-column-number="${line}"]${old ? deletion : `:not(${deletion})`}`,
  );
};

const openFiles = async (
  { app, screen, browser }: { app: TestFixtures["app"]; screen: Screen; browser: Browser },
  run: { url: string; openUrl: string },
  lastLine: number,
) => {
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  await app.open(`${run.url}${FILES}`);
  await expect(lineNumber(browser, `line ${lastLine}`)).toBeVisible({ timeout: 30_000 });
};

const commentOn = async (browser: Browser, screen: Screen, where: string, body: string) => {
  const file = screen.getByRole("region", LIMITS);
  await lineNumber(browser, where).tap();
  const field = screen.getByRole("textbox", `Comment on ${where}`);
  await field.fill(body);
  await field.press("Meta+Enter");
  await expect(file.getByRole("article", pending(where))).toContainText(body);
};

/** Taps the PR's Refresh and waits until prkit read GitHub's files again. */
const refresh = async (screen: Screen, fake: FakeGitHub) => {
  const filesRead = async () => (await fake.stats()).byKind["rest:files"] ?? 0;
  const before = await filesRead();
  await screen.getByRole("navigation", "Pull request tabs").getByRole("button", "Refresh").tap();
  await expect.poll(filesRead, { timeout: 60_000 }).toBeGreaterThan(before);
};

const finishStatus = async (screen: Screen, pendingCount: number, status: string) => {
  await screen.getByRole("button", `Review, ${pendingCount} pending`).first().tap();
  const dialog = screen.getByRole("dialog", "Finish your review");
  await expect(dialog.getByRole("status")).toHaveText(status);
  return dialog;
};

// A toast lasts five seconds, and a loaded machine can keep e2e from reading the screen
// for longer, so the page records each toast as it appears.
const recordToasts = (browser: Browser) =>
  browser.evaluate(() => {
    const toasts = new Map<Element, string>();
    const textOf = (id: string | null) =>
      (id === null ? null : document.getElementById(id))?.textContent ?? "";
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('[aria-label="Notifications"] [role="dialog"]'))
        toasts.set(
          toast,
          `${textOf(toast.getAttribute("aria-labelledby"))} | ${textOf(toast.getAttribute("aria-describedby"))}`,
        );
      sessionStorage.setItem("e2e:toasts", JSON.stringify([...toasts.values()]));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    return null;
  });
const toasts = (browser: Browser) =>
  browser.evaluate(() => JSON.parse(sessionStorage.getItem("e2e:toasts") ?? "[]"));

test(
  "draft placement: drafts follow their code after a push, and GitHub gets exactly those lines",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "draft-placement";
    const { fake, push } = await fixtures(name);
    try {
      const written = await push({ [LIMITS]: WRITTEN });
      await emulateOsColorScheme(browser, "light");
      const run = startFakeInstance(name, fake);
      await openFiles({ app, screen, browser }, run, 21);
      await commentOn(browser, screen, "line 17", SHORT);
      await commentOn(browser, screen, "line 12", CHECK);
      await commentOn(browser, screen, "line 20", HEADING);
      await commentOn(browser, screen, "line 7", SEPARATOR);
      await commentOn(browser, screen, "old line 2", URL_RISK);
      expect(draftRows(run.home).map((row) => [row.body, row.hasContext])).toEqual([
        [SHORT, 1],
        [CHECK, 1],
        [HEADING, 1],
        [SEPARATOR, 1],
        [URL_RISK, 1],
      ]);

      await push({ "src/change-0.ts": 'export const change0 = "Second fixture 9";\n' });
      await refresh(screen, fake);
      const file = screen.getByRole("region", LIMITS);
      for (const [where, body] of [
        ["line 17", SHORT],
        ["line 12", CHECK],
        ["line 20", HEADING],
        ["line 7", SEPARATOR],
        ["old line 2", URL_RISK],
      ] as const)
        await expect(file.getByRole("article", pending(where))).toContainText(body);
      await expect(file.getByText("Moved")).toHaveCount(0);
      await expect(screen.getByRole("region", `Outdated comments on ${LIMITS}`)).toHaveCount(0);
      await finishStatus(screen, 5, "5 pending comments will be posted.");
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("dialog", "Finish your review")).toBeHidden();

      const shifted = await push({ [LIMITS]: SHIFTED });
      await refresh(screen, fake);
      await expect(lineNumber(browser, "line 26")).toBeVisible({
        timeout: 30_000,
      });
      const outdated = screen.getByRole("region", `Outdated comments on ${LIMITS}`);
      const movedShort = file.getByRole("article", pending("line 22, written on line 17"));
      const movedHeading = file.getByRole("article", pending("line 25, written on line 20"));
      const check = outdated.getByRole("article", pending("line 12"));
      const expectShifted = async () => {
        await expect(movedShort).toContainText(SHORT);
        await expect(movedShort).toContainText("Moved");
        await expect(movedShort).toContainText("line 22, written on line 17");
        await expect(movedHeading).toContainText(HEADING);
        await expect(movedHeading).toContainText("line 25, written on line 20");
        await expect(file.getByRole("article", pending("old line 2"))).toContainText(URL_RISK);
        await expect(file.getByText("Moved")).toHaveCount(2);
        await expect(outdated.getByRole("article")).toHaveCount(2);
        await expect(check).toContainText(CHECK);
        await expect(check).toContainText(LINES_CHANGED);
        await expect(check).toContainText("export function check(url: string) {");
        const separator = outdated.getByRole("article", pending("line 7"));
        await expect(separator).toContainText(SEPARATOR);
        await expect(separator).toContainText(LINES_CHANGED);
        await expect(outdated.getByRole("button", "Pick a new line")).toHaveCount(2);
        await expect(outdated.getByRole("button", /^(Move to|Keep on) /)).toHaveCount(0);
        await expect(screen.getByRole("article", pending("line 17"))).toHaveCount(0);
      };
      await expectShifted();

      await movedShort.scrollIntoView();
      await screenshotLightAndDark(app, browser, "moved-card");
      await check.scrollIntoView();
      await screenshotLightAndDark(app, browser, "outdated-region");
      const size = await browser.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      await browser.setViewport({ width: 760, height: 900 });
      await movedShort.scrollIntoView();
      await screenshotLightAndDark(app, browser, "moved-card-narrow");
      await browser.setViewport(size);

      await finishStatus(
        screen,
        5,
        "3 pending comments will be posted. 2 moved with their code. 2 outdated drafts stay in prkit until moved to a current line.",
      );
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("dialog", "Finish your review")).toBeHidden();

      stopFakeInstance(name, { keepHome: true });
      const restarted = startFakeInstance(name, fake);
      await openFiles({ app, screen, browser }, restarted, 26);
      await expectShifted();

      await movedHeading.getByRole("button", "Edit pending comment").tap();
      await movedHeading.getByRole("textbox", "Edit pending comment").fill(HEADING_EDITED);
      await movedHeading.getByRole("button", "Save").tap();
      await expect(movedHeading).toContainText(HEADING_EDITED);
      await expect(movedHeading).toContainText("Moved");
      expect(draftRows(restarted.home)[2]).toMatchObject({
        body: HEADING_EDITED,
        line: 20,
        sha: written,
        hasContext: 1,
      });

      await recordToasts(browser);
      const dialog = await finishStatus(
        screen,
        5,
        "3 pending comments will be posted. 2 moved with their code. 2 outdated drafts stay in prkit until moved to a current line.",
      );
      await dialog.getByRole("button", "Submit review").tap();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      const review = await onlyReviewPosted(fake);
      expect(review.commit_id).toBe(shifted);
      expect(review.comments).toEqual([
        { path: LIMITS, body: SHORT, line: 22, side: "RIGHT" },
        { path: LIMITS, body: HEADING_EDITED, line: 25, side: "RIGHT" },
        { path: LIMITS, body: URL_RISK, line: 2, side: "LEFT" },
      ]);
      await expect
        .poll(() => toasts(browser))
        .toEqual([
          "Review submitted | 3 comments posted on GitHub. 2 moved with their code. 2 outdated drafts stay in prkit.",
        ]);
      expect(draftRows(restarted.home).map((row) => [row.body, row.state])).toEqual([
        [SHORT, "published"],
        [CHECK, "draft"],
        [HEADING_EDITED, "published"],
        [SEPARATOR, "draft"],
        [URL_RISK, "published"],
      ]);
      await expect(screen.getByRole("button", "Review, 2 pending").first()).toBeVisible();
      await expect(outdated.getByRole("article")).toHaveCount(2);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "draft placement: a draft from before prkit kept its lines waits for the user after a push",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "draft-placement-legacy";
    const { fake, push } = await fixtures(name);
    try {
      await push({ [LIMITS]: WRITTEN });
      await emulateOsColorScheme(browser, "light");
      const run = startFakeInstance(name, fake);
      await openFiles({ app, screen, browser }, run, 21);
      await commentOn(browser, screen, "line 20", HEADING);
      await commentOn(browser, screen, "line 17", SHORT);
      await commentOn(browser, screen, "old line 2", URL_RISK);
      stopFakeInstance(name, { keepHome: true });
      // Stands in for a row an older prkit wrote, which no path in the app can make.
      const db = new DatabaseSync(NodePath.join(run.home, "prkit.sqlite"));
      try {
        db.prepare("UPDATE pending_comments SET context = NULL WHERE pr_key = ?").run(KEY);
      } finally {
        db.close();
      }
      expect(draftRows(run.home).map((row) => row.hasContext)).toEqual([0, 0, 0]);

      const restarted = startFakeInstance(name, fake);
      await openFiles({ app, screen, browser }, restarted, 21);
      const file = screen.getByRole("region", LIMITS);
      const outdated = screen.getByRole("region", `Outdated comments on ${LIMITS}`);
      await expect(file.getByRole("article", pending("line 20"))).toContainText(HEADING);
      await expect(file.getByRole("article", pending("line 17"))).toContainText(SHORT);
      await expect(outdated.getByRole("article")).toHaveCount(1);
      const url = outdated.getByRole("article", pending("old line 2"));
      await expect(url).toContainText(UNCHECKED);
      await expect(url.getByRole("button", "Keep on old line 2")).toBeVisible();

      const shifted = await push({ [LIMITS]: SHIFTED });
      await refresh(screen, fake);
      await expect(lineNumber(browser, "line 26")).toBeVisible({
        timeout: 30_000,
      });
      await expect(outdated.getByRole("article")).toHaveCount(3);
      const heading = outdated.getByRole("article", pending("line 20"));
      const short = outdated.getByRole("article", pending("line 17"));
      for (const card of [heading, short, url]) await expect(card).toContainText(UNCHECKED);
      await expect(heading.getByRole("button", "Move to line 25")).toBeVisible();
      await expect(short.getByRole("button", "Pick a new line")).toBeVisible();
      await expect(short.getByRole("button", /^(Move to|Keep on) /)).toHaveCount(0);
      await expect(url.getByRole("button", "Keep on old line 2")).toBeVisible();
      await heading.scrollIntoView();
      await screenshotLightAndDark(app, browser, "unchecked-drafts");

      const dialog = await finishStatus(
        screen,
        3,
        "No pending comments. 3 outdated drafts stay in prkit until moved to a current line.",
      );
      await dialog.getByRole("button", "Submit review").tap();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Write a summary or add comments to the diff first.",
      );
      expect(await fake.writes()).toEqual([]);
      await browser.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      await heading.getByRole("button", "Move to line 25").tap();
      await expect(file.getByRole("article", pending("line 25"))).toContainText(HEADING);
      await url.getByRole("button", "Keep on old line 2").tap();
      await expect(outdated.getByRole("article")).toHaveCount(1);
      await short.getByRole("button", "Pick a new line").tap();
      await lineNumber(browser, "line 22").tap();
      await expect(file.getByRole("article", pending("line 22"))).toContainText(SHORT);
      await expect(file.getByRole("article", pending("old line 2"))).toContainText(URL_RISK);
      await expect(outdated).toHaveCount(0);
      await expect(file.getByText("Moved")).toHaveCount(0);
      expect(draftRows(restarted.home)).toEqual([
        { body: HEADING, side: "new", line: 25, state: "draft", sha: shifted, hasContext: 1 },
        { body: SHORT, side: "new", line: 22, state: "draft", sha: shifted, hasContext: 1 },
        { body: URL_RISK, side: "old", line: 2, state: "draft", sha: shifted, hasContext: 1 },
      ]);

      await screen.getByRole("button", "Review, 3 pending").first().tap();
      await screen
        .getByRole("dialog", "Finish your review")
        .getByRole("button", "Submit review")
        .tap();
      await expect(screen.getByRole("dialog", "Finish your review")).toBeHidden({
        timeout: 30_000,
      });
      const review = await onlyReviewPosted(fake);
      expect(review.commit_id).toBe(shifted);
      expect(review.comments).toEqual([
        { path: LIMITS, body: HEADING, line: 25, side: "RIGHT" },
        { path: LIMITS, body: SHORT, line: 22, side: "RIGHT" },
        { path: LIMITS, body: URL_RISK, line: 2, side: "LEFT" },
      ]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
