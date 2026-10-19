import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

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
const FILES = "/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files";

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
/** Six lines on top and the separator gone: short's `}` goes from 17 to 22, heading's return from 20 to 25. */
const SHIFTED = `// Limits for links, slugs and headings.
// Every value is a length in characters.
// Change them here and nowhere else.
// The checks below read them.
// An empty value never passes.
// Keep this file free of imports.
${WRITTEN.replace('export const separator = "-";\n', "")}`;
/** Two lines on top and short gone: heading's return goes from 25 to 22. */
const DROPPED = `// Slugs are checked in slugs.ts now.
// Headings keep their own limit.
${SHIFTED.replace(
  "export function short(slug: string) {\n  if (slug.length === 0) return false;\n  return slug.length <= 64;\n}\n\n",
  "",
)}`;

const ASKED = "Does short need a test?";
const COMPOSING = "Is the separator read anywhere, or";
const COMPOSED = `${COMPOSING} is it left over?`;
const EDITING = "Does short need a test of its own, maybe";
const REPLYING = "Agreed, and the title limit should";
const HEADING = "Should heading trim before it";
const LEAVING = "These comments say where slugs went, but";
/** The base's limits, so a push that writes them takes the file out of the PR. */
const BASE_LIMITS =
  'export const limits = {\n  url: 1024,\n  title: 120,\n};\n\nexport const schemes = ["http", "https"];\n';

const served = (patch: string, filename = LIMITS) => ({
  filename,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

/** A thread GitHub has on heading's return, at `line` now, or outdated with `null`. */
const headingThread = (line: number | null) => ({
  checks: [],
  issues: [],
  threads: [
    {
      id: "thread-heading",
      path: LIMITS,
      line,
      originalLine: 20,
      resolved: false,
      comments: [{ id: 1, login: "octocat", body: "Should heading trim first?" }],
    },
  ],
});

const lineNumber = (browser: Browser, line: number) =>
  browser.locator(
    `[data-path="${LIMITS}"] [data-gutter] > [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
  );

/** Scrolls the card labelled `label` to the middle, clear of the sticky headers, for a frame. */
const centre = (browser: Browser, label: string) =>
  browser.evaluate((name: string) => {
    for (const card of document.querySelectorAll("article"))
      if (card.getAttribute("aria-label") === name)
        card.scrollIntoView({ block: "center", behavior: "instant" });
    return null;
  }, label);

const reads = async (fake: FakeGitHub, kind: string) => (await fake.stats()).byKind[kind] ?? 0;
const filesRead = (fake: FakeGitHub) => reads(fake, "rest:files");

const draftRows = (home: string) =>
  readRows(
    home,
    `SELECT body, end_line AS line FROM pending_comments WHERE pr_key = '${KEY}' ORDER BY created_at, id`,
  );

test(
  "comment push: words being written on Files survive pushes that keep, move or delete their lines",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "comment-push";
    const fake = await startFakeGitHub(name);
    const git = outsideGit(name);
    const commit = async (files: Record<string, string>) => {
      const sha = git.commit(9, files);
      await fake.files(9, [served(git.patch(9, LIMITS))]);
      await fake.gitHead(9, sha);
    };
    /** Commits to PR 9, and resolves once the open tab has read the new head's files. */
    const push = async (files: Record<string, string>) => {
      const before = await filesRead(fake);
      await commit(files);
      await expect.poll(() => filesRead(fake), { timeout: 60_000 }).toBeGreaterThan(before);
    };
    try {
      await commit({ [LIMITS]: WRITTEN });
      await fake.context(9, headingThread(20));
      await emulateOsColorScheme(browser, "light");
      // A 5-second watcher tick, so a push reaches the open tab with no click taking focus.
      const run = startFakeInstance(name, fake, ["--e2e", "--watch-interval", "5000"]);
      await browser.setViewport({ width: 1280, height: 900 });
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}${FILES}`);
      await expect(lineNumber(browser, 21)).toBeVisible({ timeout: 30_000 });
      const file = screen.getByRole("region", LIMITS);
      const outdated = screen.getByRole("region", `Outdated comments on ${LIMITS}`);

      await lineNumber(browser, 17).tap();
      await screen.getByRole("textbox", "Comment on line 17").fill(ASKED);
      await screen.getByRole("textbox", "Comment on line 17").press("Meta+Enter");
      const draft = file.getByRole("article", `Pending comment on ${LIMITS} line 17`);
      await draft.getByRole("button", "Edit pending comment").tap();
      await draft.getByRole("textbox", "Edit pending comment").fill(EDITING);
      const thread = file.getByRole("article", `Thread by octocat on ${LIMITS} line 20`);
      await thread.getByRole("button", "Reply").tap();
      await thread.getByRole("textbox", "Reply to octocat").fill(REPLYING);
      await lineNumber(browser, 6).tap();
      await screen.getByRole("textbox", "Comment on line 6").fill("Is the separator");
      // A click on other lines takes the words typed so far along.
      await lineNumber(browser, 7).tap();
      const composer = screen.getByRole("textbox", "Comment on line 7");
      await expect(composer).toHaveValue("Is the separator");
      await composer.fill(COMPOSING);
      await expect(composer).toBeFocused();

      // A push that leaves the file alone still hides the thread until it is read again.
      await push({ "src/change-0.ts": 'export const change0 = "Second fixture 9";\n' });
      await expect(composer).toHaveValue(COMPOSING);
      await expect(composer).toBeFocused();
      await expect(draft.getByRole("textbox", "Edit pending comment")).toHaveValue(EDITING);
      await expect(thread.getByRole("textbox", "Reply to octocat")).toHaveValue(REPLYING);

      // The composer's line is deleted; the draft and the thread move with their code.
      await fake.context(9, headingThread(25));
      await push({ [LIMITS]: SHIFTED });
      await expect(lineNumber(browser, 26)).toBeVisible({ timeout: 30_000 });
      const lost = outdated.getByRole("textbox", "Comment written on line 7");
      await expect(lost).toHaveValue(COMPOSING);
      await expect(lost).toBeFocused();
      const lostCard = outdated.getByRole("article", `New comment written on line 7, in ${LIMITS}`);
      await expect(lostCard).toContainText(
        "A new commit changed these lines while you were writing. Add the comment to keep it with your drafts, then move it to a current line.",
      );
      await expect(lostCard).toContainText('+export const separator = "-";');
      await expect(screen.getByRole("textbox", "Comment on line 7")).toHaveCount(0);
      const movedDraft = file.getByRole(
        "article",
        `Pending comment on ${LIMITS} line 22, written on line 17`,
      );
      await expect(movedDraft.getByRole("textbox", "Edit pending comment")).toHaveValue(EDITING);
      const movedThread = file.getByRole("article", `Thread by octocat on ${LIMITS} line 25`);
      await expect(movedThread.getByRole("textbox", "Reply to octocat")).toHaveValue(REPLYING);
      await centre(browser, `New comment written on line 7, in ${LIMITS}`);
      await screenshotLightAndDark(app, browser, "lost-line-composer");
      await lost.focus();
      await browser.keyboard.type(" is it left over?");
      await expect(lost).toHaveValue(COMPOSED);
      await lost.press("Meta+Enter");
      const added = outdated.getByRole("article", `Pending comment on ${LIMITS} line 7`);
      await expect(added).toContainText(COMPOSED);
      await expect(added.getByRole("button", "Pick a new line")).toBeVisible();

      // The composer's line moves; the draft's line is deleted and GitHub outdates the thread.
      await lineNumber(browser, 25).tap();
      const heading = screen.getByRole("textbox", "Comment on line 25");
      await heading.fill(HEADING);
      await fake.context(9, headingThread(null));
      await push({ [LIMITS]: DROPPED });
      await expect(lineNumber(browser, 23)).toBeVisible({ timeout: 30_000 });
      const followed = file.getByRole("textbox", "Comment on line 22, written on line 25");
      await expect(followed).toHaveValue(HEADING);
      await expect(followed).toBeFocused();
      await expect(
        file.getByRole("article", `New comment on line 22, written on line 25, in ${LIMITS}`),
      ).toContainText("A new commit moved this code, and your comment with it.");
      const lostDraft = outdated.getByRole("article", `Pending comment on ${LIMITS} line 17`);
      await expect(lostDraft.getByRole("textbox", "Edit pending comment")).toHaveValue(EDITING);
      const lostThread = outdated.getByRole(
        "article",
        `Thread by octocat on ${LIMITS} line 20 (outdated)`,
      );
      await expect(lostThread.getByRole("textbox", "Reply to octocat")).toHaveValue(REPLYING);
      const shots = [
        ["moved-line-composer", `New comment on line 22, written on line 25, in ${LIMITS}`],
        ["lost-edit", `Pending comment on ${LIMITS} line 17`],
        ["lost-reply", `Thread by octocat on ${LIMITS} line 20 (outdated)`],
      ] as const;
      for (const [shot, card] of shots) {
        await centre(browser, card);
        await screenshotLightAndDark(app, browser, shot);
      }
      await browser.setViewport({ width: 760, height: 900 });
      await expect(followed).toHaveValue(HEADING);
      for (const [shot, card] of shots) {
        await centre(browser, card);
        await screenshotLightAndDark(app, browser, `${shot}-narrow`);
      }
      await browser.setViewport({ width: 1280, height: 900 });

      await followed.focus();
      await browser.keyboard.type(" counts?");
      await followed.press("Meta+Enter");
      await expect(
        file.getByRole("article", `Pending comment on ${LIMITS} line 22, written on line 25`),
      ).toContainText(`${HEADING} counts?`);
      await lostDraft.getByRole("button", "Save").tap();
      await expect(lostDraft).toContainText(EDITING);
      await expect(lostDraft.getByRole("textbox", "Edit pending comment")).toHaveCount(0);
      await lostThread.getByRole("textbox", "Reply to octocat").focus();
      await browser.keyboard.press("Escape");
      await expect(lostThread.getByRole("textbox", "Reply to octocat")).toHaveCount(0);
      expect(draftRows(run.home)).toEqual([
        { body: EDITING, line: 17 },
        { body: COMPOSED, line: 7 },
        { body: `${HEADING} counts?`, line: 25 },
      ]);

      // A push that takes the file out of the PR leaves the composer above the list of files.
      await lineNumber(browser, 1).tap();
      await screen.getByRole("textbox", "Comment on line 1").fill(LEAVING);
      const before = await filesRead(fake);
      const reverted = git.commit(9, {
        [LIMITS]: BASE_LIMITS,
        "src/slugs.ts": "export const slugLimit = 64;\n",
      });
      await fake.files(9, [served(git.patch(9, "src/slugs.ts"), "src/slugs.ts")]);
      await fake.gitHead(9, reverted);
      await expect.poll(() => filesRead(fake), { timeout: 60_000 }).toBeGreaterThan(before);
      await expect(file).toHaveCount(0, { timeout: 30_000 });
      const stray = screen.getByRole("region", `Comment on ${LIMITS}`);
      const strayField = stray.getByRole("textbox", "Comment written on line 1");
      await expect(strayField).toHaveValue(LEAVING);
      await expect(strayField).toBeFocused();
      await expect(stray).toContainText(
        `GitHub shows no diff for ${LIMITS} now. Add the comment to keep it with your drafts.`,
      );
      await expect(stray).toContainText("+// Slugs are checked in slugs.ts now.");
      await screenshotLightAndDark(app, browser, "file-left-composer");
      await browser.setViewport({ width: 760, height: 900 });
      await screenshotLightAndDark(app, browser, "file-left-composer-narrow");
      await browser.setViewport({ width: 1280, height: 900 });
      await strayField.press("Meta+Enter");
      await expect(stray).toHaveCount(0);
      expect(draftRows(run.home).at(-1)).toEqual({ body: LEAVING, line: 1 });
      expect(await fake.writes()).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

/** PR 9's limits with two checks. */
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
/** Four lines on top: the slug limit goes from 3 to 7, short's `}` from 15 to 19. */
const MOVED = `// Limits for links and slugs.
// Every value is a length in characters.
// Change them here and nowhere else.
// The checks below read them.
${CHECKS}`;
/** Short gone, so its `}` with it. */
const GONE = MOVED.replace(
  "\nexport function short(slug: string) {\n  return slug.length <= limits.slug;\n}\n",
  "",
);

const SLUG = "Why does a slug get its own limit here instead of in the shared config?";
const SLUG_EDIT = "Why does a slug get its own limit here, when";
const BRACE = "Does short need a test of its own?";
const BRACE_EDIT = "Does short need a test, or does";
const ON_GUIDE = "This chapter could say why the url limit";
const ON_THREAD = "I checked, and the url limit";

const question = (line: number, text: string): FakeNote => ({
  line,
  side: "additions",
  tone: "question",
  text,
});

const noteIn = (browser: Browser, text: string) =>
  browser.locator(`[data-path="${LIMITS}"] [data-guide-note]`).filter({ hasText: text });

test(
  "comment push: a guide note's comment follows its line or waits, the Guide holds its revision, and replies survive the tabs",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "comment-push-notes";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const commit = async (files: Record<string, string>) => {
      const sha = git.commit(9, files);
      await fake.files(9, [served(git.patch(9, LIMITS))]);
      await fake.gitHead(9, sha);
    };
    const push = async (files: Record<string, string>) => {
      const before = await filesRead(fake);
      await commit(files);
      await expect.poll(() => filesRead(fake), { timeout: 60_000 }).toBeGreaterThan(before);
    };
    const revisions = () =>
      readRows(
        run.home,
        `SELECT COUNT(*) AS n FROM review_revisions r JOIN reviews v ON v.id = r.review_id WHERE v.pr_key = '${KEY}'`,
      )[0]?.n;
    let run = { home: "", url: "", openUrl: "" };
    try {
      await commit({ [LIMITS]: CHECKS });
      await fake.context(9, {
        checks: [],
        issues: [],
        threads: [
          {
            id: "thread-check",
            path: LIMITS,
            line: 10,
            originalLine: 10,
            resolved: false,
            comments: [{ id: 2, login: "octocat", body: "Is 2048 enough for signed links?" }],
          },
        ],
      });
      claude.notes({ [LIMITS]: [question(3, SLUG), question(15, BRACE)] });
      run = git.start(() =>
        startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          "5000",
        ]),
      );
      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}${FILES.replace("tab=files", "tab=guide")}`);
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r1 · ", { timeout: 120_000 });
      const tabs = screen.getByRole("navigation", "Pull request tabs");

      // A reply on Conversation keeps its words through a push and a trip to Files, where the
      // same thread shows the same reply.
      await tabs.getByRole("link", "Conversation").tap();
      const conversation = screen.getByRole("region", "Activity");
      const thread = conversation.getByRole("article", `Thread by octocat on ${LIMITS} line 10`);
      await thread.getByRole("button", "Reply").tap();
      const reply = thread.getByRole("textbox", "Reply to octocat");
      await reply.fill(ON_THREAD);
      // Files isn't open, so the watcher's read of the moved PR says the push arrived.
      const pullReads = await reads(fake, "rest:pull");
      await commit({ "src/change-0.ts": 'export const change0 = "Second fixture 9";\n' });
      await expect
        .poll(() => reads(fake, "rest:pull"), { timeout: 60_000 })
        .toBeGreaterThan(pullReads);
      await expect(reply).toHaveValue(ON_THREAD);
      await expect(reply).toBeFocused();
      await app.screenshot("conversation-reply-after-push");
      await tabs.getByRole("link", "Files").tap();
      const onFiles = screen
        .getByRole("region", LIMITS)
        .getByRole("article", `Thread by octocat on ${LIMITS} line 10`)
        .getByRole("textbox", "Reply to octocat");
      await expect(onFiles).toHaveValue(ON_THREAD, { timeout: 30_000 });
      await tabs.getByRole("link", "Conversation").tap();
      await expect(reply).toHaveValue(ON_THREAD);
      await reply.focus();
      await browser.keyboard.press("Escape");
      await expect(reply).toHaveCount(0);

      // A note's comment on Files follows its line when a push moves it.
      await tabs.getByRole("link", "Files").tap();
      const file = screen.getByRole("region", LIMITS);
      const outdated = screen.getByRole("region", `Outdated comments on ${LIMITS}`);
      const slug = noteIn(browser, SLUG);
      await slug.getByRole("button", "Add as comment, question on line 3").tap({ timeout: 30_000 });
      const slugField = screen.getByRole("textbox", "Comment on line 3");
      await expect(slugField).toHaveValue(SLUG);
      await slugField.fill(SLUG_EDIT);
      claude.hold();
      await push({ [LIMITS]: MOVED });
      const slugMoved = file.getByRole("textbox", "Comment on line 7, written on line 3");
      await expect(slugMoved).toHaveValue(SLUG_EDIT, { timeout: 30_000 });
      await expect(slugMoved).toBeFocused();
      const slugCard = `New comment on line 7, written on line 3, in ${LIMITS}`;
      await expect(file.getByRole("article", slugCard)).toContainText(
        "A new commit moved this code, and your comment with it.",
      );
      await centre(browser, slugCard);
      await screenshotLightAndDark(app, browser, "moved-note-composer");
      await slugMoved.press("Meta+Enter");
      await expect(slug.getByRole("status")).toHaveText("In your review.");

      // A note's comment whose line a push deletes waits under the file with its words.
      const brace = noteIn(browser, BRACE);
      await brace.getByRole("button", "Add as comment, question on line 19").tap();
      const braceField = screen.getByRole("textbox", "Comment on line 19");
      await expect(braceField).toHaveValue(BRACE);
      await braceField.fill(BRACE_EDIT);
      await push({ [LIMITS]: GONE });
      const braceLost = outdated.getByRole("textbox", "Comment written on line 19");
      await expect(braceLost).toHaveValue(BRACE_EDIT, { timeout: 30_000 });
      await expect(braceLost).toBeFocused();
      await expect(brace).toHaveCount(0);
      const braceCard = `New comment written on line 19, in ${LIMITS}`;
      await centre(browser, braceCard);
      await screenshotLightAndDark(app, browser, "lost-note-composer");
      await browser.setViewport({ width: 760, height: 900 });
      await centre(browser, braceCard);
      await screenshotLightAndDark(app, browser, "lost-note-composer-narrow");
      await browser.setViewport({ width: 1280, height: 900 });
      await braceLost.focus();
      await browser.keyboard.press("Meta+Enter");
      await expect(
        outdated.getByRole("article", `Pending comment on ${LIMITS} line 19`),
      ).toContainText(BRACE_EDIT);
      expect(
        readRows(
          run.home,
          `SELECT body, end_line AS line, note_key IS NOT NULL AS fromNote FROM pending_comments WHERE pr_key = '${KEY}' ORDER BY created_at, id`,
        ),
      ).toEqual([
        { body: SLUG_EDIT, line: 7, fromNote: 1 },
        { body: BRACE_EDIT, line: 19, fromNote: 0 },
      ]);

      // A comment on the Guide holds its revision while a new one is accepted, and across a
      // trip to Files.
      await tabs.getByRole("link", "Guide").tap();
      await expect(revision).toContainText("r1 · ", { timeout: 30_000 });
      const stop = screen
        .getByRole("region", LIMITS)
        .getByRole("button", /^Comment on (old )?line \d+$/);
      const at = (await stop.getAttribute("aria-label"))?.replace("Comment on ", "") ?? "";
      await stop.tap();
      const onGuide = screen.getByRole("textbox", `Comment on ${at}`);
      await onGuide.fill(ON_GUIDE);
      await tabs.getByRole("link", "Files").tap();
      await expect(file).toBeVisible();
      await tabs.getByRole("link", "Guide").tap();
      await expect(onGuide).toHaveValue(ON_GUIDE, { timeout: 30_000 });
      await onGuide.focus();
      claude.release();
      await expect.poll(revisions, { timeout: 120_000 }).toBeGreaterThan(1);
      await expect(revision).toContainText("r1 · ");
      await expect(onGuide).toHaveValue(ON_GUIDE);
      await expect(onGuide).toBeFocused();
      await centre(browser, `New comment on ${at}, in ${LIMITS}`);
      await screenshotLightAndDark(app, browser, "guide-composer-held");
      await browser.keyboard.press("Escape");
      await expect(onGuide).toHaveCount(0);
      await expect(revision).not.toContainText("r1 · ", { timeout: 30_000 });
      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
