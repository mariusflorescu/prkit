import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

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

/** The one review prkit posted to the fake, and nothing else written. */
const postedReview = async (fake: FakeGitHub) => {
  const writes = await fake.writes();
  expect(writes.map((write) => write.kind)).toEqual(["POST pulls/9/reviews"]);
  return Schema.decodeUnknownSync(Review)(writes[0]?.input);
};

const draftRows = (home: string) =>
  readRows(
    home,
    `SELECT start_side AS side, end_line AS line, body, state, note_key IS NOT NULL AS fromNote FROM pending_comments WHERE pr_key = '${KEY}' ORDER BY created_at`,
  );

/** The guide note of this tone and words in a chapter's diff of `path`. */
const noteIn = (browser: Browser, path: string, tone: FakeNote["tone"], text: string) =>
  browser
    .locator(`[data-path="${path}"] [data-guide-note][data-tone="${tone}"]`)
    .filter({ hasText: text });

/** A fresh fake GitHub, stand-in Claude and local git for one journey's own instance. */
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

/** Signs in, opens PR 9's Guide tab and has the stand-in write revision 1. */
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
      const review = await postedReview(fake);
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
