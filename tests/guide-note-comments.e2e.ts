import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";

import { type FakeNote, setUpFakeClaude } from "./fakeClaude.ts";
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
const PR = "/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test";

const SLUG = "Why does a slug get its own limit here instead of in the shared config?";
const URL_RISK = "Dropping the 1024 limit lets far longer links through. Is that on purpose?";
const DOUBLED = "The URL limit doubles to 2048.";
const CHECK = "Should an empty URL pass this check?";
const BRACE = "Does short need a test of its own?";
const GENERATED = "Is this generated file meant to be in the PR?";

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
const note = (line: number, text: string): FakeNote => ({
  line,
  side: "additions",
  tone: "note",
  text,
});

const Review = Schema.Struct({
  commit_id: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      body: Schema.String,
      line: Schema.Int,
      side: Schema.String,
    }),
  ),
});

const onlyReviewPosted = async (fake: FakeGitHub) => {
  const writes = await fake.writes();
  expect(writes.map((write) => write.kind)).toEqual(["POST pulls/9/reviews"]);
  return Schema.decodeUnknownSync(Review)(writes[0]?.input);
};

const servedLimits = (patch: string) => ({
  filename: LIMITS,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

const revisionCount = (home: string) =>
  readRows(
    home,
    `SELECT COUNT(*) AS n FROM review_revisions r JOIN reviews v ON v.id = r.review_id WHERE v.pr_key = '${KEY}'`,
  )[0]?.n;

const draftRows = (home: string) =>
  readRows(
    home,
    `SELECT start_side AS side, end_line AS line, body, state, note_key IS NOT NULL AS fromNote FROM pending_comments WHERE pr_key = '${KEY}' ORDER BY created_at`,
  );

const noteIn = (browser: Browser, path: string, tone: FakeNote["tone"], text: string) =>
  browser
    .locator(`[data-path="${path}"] [data-guide-note][data-tone="${tone}"]`)
    .filter({ hasText: text });

const fixtures = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const git = outsideGit(name);
  const launch = () =>
    git.start(() =>
      startFakeInstance(name, fake, ["--claude", claude.file, "--e2e", "--watch-interval", "5000"]),
    );
  return { fake, claude, git, launch };
};

const openGuide = async (
  { app, screen, browser }: { app: TestFixtures["app"]; screen: Screen; browser: Browser },
  run: { url: string; openUrl: string },
  generate: boolean,
) => {
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  await app.open(`${run.url}${PR}&tab=guide`);
  if (generate) await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
  await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
    timeout: 120_000,
  });
};

test(
  "guide notes: a question and a risk become drafts the user edits, keep their status, and post as one review",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "note-comments";
    const { fake, claude, git, launch } = await fixtures(name);
    try {
      await fake.gitHead(9, git.head(9));
      claude.notes({
        [LIMITS]: [question(3, SLUG), risk(2, URL_RISK), note(2, DOUBLED)],
      });
      const run = launch();
      await openGuide({ app, screen, browser }, run, true);
      const file = screen.getByRole("region", LIMITS);
      const slug = noteIn(browser, LIMITS, "question", SLUG);
      const url = noteIn(browser, LIMITS, "risk", URL_RISK);
      const doubled = noteIn(browser, LIMITS, "note", DOUBLED);
      await doubled.scrollIntoView();
      await expect(doubled).toContainText(DOUBLED);
      await expect(doubled.getByRole("button")).toHaveCount(0);
      const addSlug = slug.getByRole("button", "Add as comment, question on line 3");
      await addSlug.scrollIntoView();
      await screenshotLightAndDark(app, browser, "button");

      await addSlug.tap();
      const slugField = screen.getByRole("textbox", "Comment on line 3");
      await expect(slugField).toHaveValue(SLUG);
      await expect(slugField).toBeFocused();
      await expect(
        file.getByText("Starts as the guide's note. Edit it before you add it."),
      ).toBeVisible();
      await expect(addSlug).toBeDisabled();
      await screenshotLightAndDark(app, browser, "prefilled-composer");
      const size = await browser.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      await browser.setViewport({ width: 760, height: 900 });
      await slugField.scrollIntoView();
      await screenshotLightAndDark(app, browser, "prefilled-composer-narrow");
      await browser.setViewport(size);
      await slugField.fill("Words that belong to the slug note");
      await url.getByRole("button", "Add as comment, risk on old line 2").tap();
      await expect(screen.getByRole("textbox", "Comment on old line 2")).toHaveValue(URL_RISK);
      await expect(slugField).toBeHidden();
      await addSlug.tap();
      await expect(slugField).toHaveValue(SLUG);
      await slugField.fill("Could the slug limit live in the shared config instead?");
      await screen.getByRole("button", "Add review comment").tap();
      await expect(
        file.getByRole("article", "Pending comment on src/limits.ts line 3"),
      ).toContainText("Could the slug limit live in the shared config instead?");
      await expect(slug.getByRole("status")).toHaveText("In your review.");

      await url.getByRole("button", "Add as comment, risk on old line 2").tap();
      const urlField = screen.getByRole("textbox", "Comment on old line 2");
      await expect(urlField).toHaveValue(URL_RISK);
      await urlField.press("Escape");
      await expect(urlField).toBeHidden();
      expect(draftRows(run.home)).toHaveLength(1);
      await url.getByRole("button", "Add as comment, risk on old line 2").tap();
      await urlField.press("Meta+Enter");
      await expect(url.getByRole("status")).toHaveText("In your review.");
      await expect(
        file.getByRole("article", "Pending comment on src/limits.ts old line 2"),
      ).toContainText(URL_RISK);
      expect(draftRows(run.home)).toEqual([
        {
          side: "new",
          line: 3,
          body: "Could the slug limit live in the shared config instead?",
          state: "draft",
          fromNote: 1,
        },
        { side: "old", line: 2, body: URL_RISK, state: "draft", fromNote: 1 },
      ]);
      await url.scrollIntoView();
      await screenshotLightAndDark(app, browser, "status-lines");

      await browser.reload();
      await slug.scrollIntoView({ timeout: 30_000 });
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      await expect(url.getByRole("status")).toHaveText("In your review.");

      stopFakeInstance(name, { keepHome: true });
      const restarted = launch();
      await openGuide({ app, screen, browser }, restarted, false);
      await slug.scrollIntoView({ timeout: 30_000 });
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      await expect(url.getByRole("status")).toHaveText("In your review.");

      await screen.getByRole("button", "Review, 2 pending").first().tap();
      const dialog = screen.getByRole("dialog", "Finish your review");
      await dialog.getByRole("button", "Submit review").tap();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(slug.getByRole("status")).toHaveText("Posted on GitHub.", { timeout: 30_000 });
      await expect(url.getByRole("status")).toHaveText("Posted on GitHub.");
      const review = await onlyReviewPosted(fake);
      expect(review.commit_id).toBe(git.head(9));
      expect(review.comments).toEqual([
        {
          path: LIMITS,
          body: "Could the slug limit live in the shared config instead?",
          line: 3,
          side: "RIGHT",
        },
        { path: LIMITS, body: URL_RISK, line: 2, side: "LEFT" },
      ]);
      await url.scrollIntoView();
      await screenshotLightAndDark(app, browser, "posted");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "guide notes: a note a second window already added is refused, and the first window keeps its words",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "note-comments-twice";
    const { fake, claude, git, launch } = await fixtures(name);
    const other = await chromium.launch({ headless: true, args: ["--use-mock-keychain"] });
    try {
      await fake.gitHead(9, git.head(9));
      claude.notes({ [LIMITS]: [question(3, SLUG)] });
      const run = launch();
      await openGuide({ app, screen, browser }, run, true);
      const slug = noteIn(browser, LIMITS, "question", SLUG);
      await slug.scrollIntoView();
      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      const field = screen.getByRole("textbox", "Comment on line 3");
      await field.fill("Words from the first window");

      const page = await other.newPage();
      await page.goto(run.openUrl);
      await page.getByRole("link", { name: "Inbox", exact: true }).waitFor({ timeout: 30_000 });
      await page.goto(`${run.url}${PR}&tab=guide`);
      await page.getByRole("button", { name: "Add as comment, question on line 3" }).click();
      await page.getByRole("button", { name: "Add review comment" }).click();
      await page
        .getByRole("article", { name: "Pending comment on src/limits.ts line 3" })
        .waitFor({ timeout: 30_000 });

      await screen.getByRole("button", "Add review comment").tap();
      await expect(screen.getByText("You already added this note to your review.")).toBeVisible();
      await expect(field).toHaveValue("Words from the first window");
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      expect(draftRows(run.home)).toEqual([
        { side: "new", line: 3, body: SLUG, state: "draft", fromNote: 1 },
      ]);
      await screenshotLightAndDark(app, browser, "duplicate-refused");

      await field.press("Escape");
      await expect(field).toBeHidden();
      await screen
        .getByRole("article", "Pending comment on src/limits.ts line 3")
        .getByRole("button", "Delete pending comment")
        .tap();
      await expect(slug.getByRole("button", "Add as comment, question on line 3")).toBeVisible();
      expect(draftRows(run.home)).toEqual([]);

      const tabs = screen.getByRole("navigation", "Pull request tabs");
      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      await field.fill("Words left behind with the Guide tab");
      await tabs.getByRole("link", "Files").tap();
      await tabs.getByRole("link", "Guide").tap();
      await slug.scrollIntoView({ timeout: 30_000 });
      await expect(field).toBeHidden();
      await expect(slug.getByRole("button", "Add as comment, question on line 3")).toBeEnabled();

      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      await field.fill("Words the server refuses");
      const pushed = git.commit(9, {
        [LIMITS]:
          'export const limits = {\n  url: 2048,\n  slug: 80,\n  title: 120,\n};\n\nexport const schemes = ["http", "https"];\n',
      });
      await fake.files(9, [servedLimits(git.patch(9, LIMITS))]);
      await fake.gitHead(9, pushed);
      await screen.getByRole("button", "Add review comment").tap();
      await expect(
        screen.getByText(
          "This line changed after the guide was written. prkit won't guess where the comment goes. Comment on the latest code in Files.",
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(field).toHaveValue("Words the server refuses");
      expect(draftRows(run.home)).toEqual([]);
      expect(await fake.writes()).toEqual([]);
    } finally {
      await other.close();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "guide notes: on a revision for an older head a note lands where its code is now or not at all, and a new revision waits for the comment",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "note-comments-moved";
    const { fake, claude, git, launch } = await fixtures(name);
    try {
      const first = git.commit(9, { [LIMITS]: CHECKS });
      await fake.files(9, [servedLimits(git.patch(9, LIMITS))]);
      await fake.gitHead(9, first);
      claude.notes({
        [LIMITS]: [question(3, SLUG), risk(2, URL_RISK), question(10, CHECK), question(15, BRACE)],
        "src/change-0.ts": [question(1, GENERATED)],
      });
      const run = launch();
      await openGuide({ app, screen, browser }, run, true);

      claude.hold();
      const moved = git.commit(9, { [LIMITS]: MOVED });
      await fake.files(9, [servedLimits(git.patch(9, LIMITS))]);
      await fake.gitHead(9, moved);
      const tabs = screen.getByRole("navigation", "Pull request tabs");
      await tabs.getByRole("link", "Files").tap();
      await expect(screen.getByRole("region", LIMITS)).toContainText("+14 -1", {
        timeout: 60_000,
      });
      await tabs.getByRole("link", "Guide").tap();
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r1 · ");

      const url = noteIn(browser, LIMITS, "risk", URL_RISK);
      await url.scrollIntoView();
      await url.getByRole("button", "Add as comment, risk on old line 2").tap();
      await screen.getByRole("textbox", "Comment on old line 2").press("Meta+Enter");
      await expect(url.getByRole("status")).toHaveText("In your review.");
      await expect(
        screen.getByRole("article", "Pending comment on src/limits.ts old line 2"),
      ).toBeVisible();

      const check = noteIn(browser, LIMITS, "question", CHECK);
      await check.getByRole("button", "Add as comment, question on line 10").tap();
      await expect(screen.getByText("This line changed after the guide was written")).toBeVisible();
      await expect(
        screen.getByText(
          "prkit won't guess where the comment goes. Comment on the latest code in Files.",
        ),
      ).toBeVisible();
      await screenshotLightAndDark(app, browser, "changed-line-toast");
      await expect(screen.getByRole("textbox", /^Comment on/)).toHaveCount(0);

      const brace = noteIn(browser, LIMITS, "question", BRACE);
      await brace.scrollIntoView();
      await brace.getByRole("button", "Add as comment, question on line 15").tap();
      await screen
        .getByRole("textbox", "Comment on line 19, where this line is now")
        .press("Meta+Enter");
      await expect(brace.getByRole("status")).toHaveText("In your review.");

      const generated = noteIn(browser, "src/change-0.ts", "question", GENERATED);
      await generated.scrollIntoView();
      await generated.getByRole("button", "Add as comment, question on line 1").tap();
      await expect(
        screen.getByText("prkit can only place a comment on a line GitHub shows in the diff."),
      ).toBeVisible();
      expect(draftRows(run.home)).toHaveLength(2);

      const slug = noteIn(browser, LIMITS, "question", SLUG);
      await slug.scrollIntoView();
      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      const field = screen.getByRole("textbox", "Comment on line 7, where this line is now");
      await expect(field).toHaveValue(SLUG);
      await screenshotLightAndDark(app, browser, "moved-composer");
      await field.fill("Could the slug limit live in the shared config instead?");

      claude.notes({
        [LIMITS]: [question(7, SLUG), risk(2, URL_RISK), question(14, CHECK), question(19, BRACE)],
        "src/change-0.ts": [question(1, GENERATED)],
      });
      claude.release();
      await expect.poll(() => revisionCount(run.home), { timeout: 120_000 }).toBe(2);
      await expect(revision).toContainText("r1 · ");
      await expect(field).toHaveValue("Could the slug limit live in the shared config instead?");
      await screenshotLightAndDark(app, browser, "held-revision");
      await field.press("Meta+Enter");
      await expect(revision).toContainText("r2 · ", { timeout: 30_000 });

      await slug.scrollIntoView();
      await expect(slug.getByRole("status")).toHaveText("In your review.");
      await expect(url.getByRole("status")).toHaveText("In your review.");
      await expect(brace.getByRole("status")).toHaveText("In your review.");
      await expect(check.getByRole("button", "Add as comment, question on line 14")).toBeVisible();
      await screenshotLightAndDark(app, browser, "revision-2");

      await revision.tap();
      await screen.getByRole("option", /^r1 · /).tap();
      await expect(revision).toContainText("r1 · ");
      await slug.scrollIntoView();
      await expect(slug.getByRole("status")).toHaveText(
        "In your review, on line 7 of the latest code.",
      );
      await screenshotLightAndDark(app, browser, "moved-status");

      await tabs.getByRole("link", "Files").tap();
      await expect(
        screen.getByRole("article", "Pending comment on src/limits.ts line 7"),
      ).toContainText("Could the slug limit live in the shared config instead?");
      await expect(
        screen.getByRole("article", "Pending comment on src/limits.ts line 19"),
      ).toBeVisible();

      await screen.getByRole("button", "Review, 3 pending").first().tap();
      const dialog = screen.getByRole("dialog", "Finish your review");
      await dialog.getByRole("button", "Submit review").tap();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      const review = await onlyReviewPosted(fake);
      expect(review.commit_id).toBe(moved);
      expect(review.comments).toEqual([
        { path: LIMITS, body: URL_RISK, line: 2, side: "LEFT" },
        { path: LIMITS, body: BRACE, line: 19, side: "RIGHT" },
        {
          path: LIMITS,
          body: "Could the slug limit live in the shared config instead?",
          line: 7,
          side: "RIGHT",
        },
      ]);
    } finally {
      claude.release();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "guide notes: a new revision after an unrelated push keeps what became of each remark",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "note-comments-again";
    const { fake, claude, git, launch } = await fixtures(name);
    try {
      await fake.gitHead(9, git.head(9));
      claude.notes({ [LIMITS]: [question(3, SLUG), risk(2, URL_RISK)] });
      const run = launch();
      await openGuide({ app, screen, browser }, run, true);
      const slug = noteIn(browser, LIMITS, "question", SLUG);
      const url = noteIn(browser, LIMITS, "risk", URL_RISK);
      await slug.scrollIntoView();
      await slug.getByRole("button", "Add as comment, question on line 3").tap();
      await screen.getByRole("textbox", "Comment on line 3").press("Meta+Enter");
      await url.getByRole("button", "Add as comment, risk on old line 2").tap();
      await screen.getByRole("textbox", "Comment on old line 2").press("Meta+Enter");
      await expect(url.getByRole("status")).toHaveText("In your review.");
      await screen.getByRole("button", "Review, 2 pending").first().tap();
      const dialog = screen.getByRole("dialog", "Finish your review");
      await dialog.getByRole("button", "Submit review").tap();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(slug.getByRole("status")).toHaveText("Posted on GitHub.", { timeout: 30_000 });

      claude.notes({
        [LIMITS]: [question(3, SLUG), risk(2, URL_RISK), question(2, DOUBLED)],
      });
      const generatedFile = `${Array.from({ length: 1600 }, (_, index) => `// Fixture detail ${index}`).join("\n")}\nexport const change0 = "Second fixture 9";\n`;
      await fake.gitHead(9, git.commit(9, { "src/change-0.ts": generatedFile }));
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r2 · ", { timeout: 120_000 });
      await slug.scrollIntoView();
      await expect(slug.getByRole("status")).toHaveText("Posted on GitHub.");
      await expect(url.getByRole("status")).toHaveText("Posted on GitHub.");
      await expect(slug.getByRole("button")).toHaveCount(0);
      await expect(url.getByRole("button")).toHaveCount(0);
      const doubled = noteIn(browser, LIMITS, "question", DOUBLED);
      await expect(doubled.getByRole("button", "Add as comment, question on line 2")).toBeVisible();
      await screenshotLightAndDark(app, browser, "revision-2-posted");
      expect((await onlyReviewPosted(fake)).comments).toHaveLength(2);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
