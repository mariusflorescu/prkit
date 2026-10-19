import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
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
const OLDER = "Guide notes from an older commit";
const WORDS = "Should short reject an empty slug too?";
const STORY =
  "Guide notes come from r1, written for an older commit. They show only where the code still reads the same.";

const CHECKS = `export const limits = {
  url: 2048,
  slug: 64,
  title: 120,
};

export const schemes = ["http", "https"];

export function short(slug: string) {
  return slug.length <= limits.slug;
}
`;
/** A push GitHub's diff of the PR doesn't show: Files keeps its one card as it was. */
const ELSEWHERE = { "src/change-0.ts": 'export const change0 = "Second fixture 9";\n' };

const question = (line: number, text: string): FakeNote => ({
  line,
  side: "additions",
  tone: "question",
  text,
});

const served = (patch: string) => ({
  filename: LIMITS,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

/**
 * From now on, one entry each time a painted frame differs: where the list's first file card
 * starts in the window, how many guide notes it shows, and what the tab row says beside the
 * notes toggle. A ResizeObserver made after the app's own runs after them in the same frame, so
 * one watching a probe resized every frame reads the frame as painted.
 */
const recordFrames = (browser: Browser) =>
  browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const frames: Array<string> = [];
        Reflect.set(window, "__listFrames", frames);
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
        document.body.append(probe);
        const read = () => {
          const card = document.querySelector("[data-pr-files] [data-file-diff-card]");
          const toggle = document.querySelector("nav [aria-label$='guide notes']");
          const said = document.querySelector(
            "[data-guide-notes-status] [data-slot='tooltip-trigger']",
          );
          const words = toggle === null ? "no toggle" : `"${said?.textContent ?? ""}"`;
          const now =
            card === null
              ? "no card"
              : `${Math.round(card.getBoundingClientRect().top)} | ${card.querySelectorAll("[data-guide-note]").length} notes | ${words}`;
          if (frames.at(-1) !== now) frames.push(now);
          resolve(true);
        };
        const observer = new ResizeObserver(read);
        observer.observe(probe);
        let wide = false;
        const tick = () => {
          wide = !wide;
          probe.style.width = wide ? "2px" : "1px";
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

const decodeFrames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const frames = async (browser: Browser) =>
  decodeFrames(
    await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__listFrames") ?? [])),
  );
/** Starts the record again from the next painted frame. */
const restart = (browser: Browser) =>
  browser.evaluate(() => {
    const recorded = Reflect.get(window, "__listFrames");
    if (Array.isArray(recorded)) recorded.length = 0;
    return null;
  });
/** Where the list's first file card started, in every frame since the record started. */
const tops = async (browser: Browser) => [
  ...new Set((await frames(browser)).map((frame) => frame.split(" | ")[0])),
];
/** What the tab row says about the notes, which the keyboard can reach. */
const SAID = "[data-guide-notes-status] [data-slot='tooltip-trigger']";
const tabTo = async (browser: Browser, selector: string) => {
  for (let presses = 0; presses < 20; presses++) {
    const there = await browser.evaluate(
      (match: string) => document.activeElement?.matches(match) ?? false,
      selector,
    );
    if (there) return;
    await browser.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${selector}.`);
};

/** What the tab row says beside the notes toggle now, or null without the toggle. */
const notesWords = (browser: Browser) =>
  browser.evaluate(() =>
    document.querySelector("nav [aria-label$='guide notes']") === null
      ? null
      : (document.querySelector("[data-guide-notes-status] [data-slot='tooltip-trigger']")
          ?.textContent ?? ""),
  );

const lineNumber = (browser: Browser, line: number) =>
  browser.locator(
    `[data-path="${LIMITS}"] [data-gutter] > [data-column-number="${line}"]:not([data-line-type="change-deletion"])`,
  );

const reads = async (fake: FakeGitHub, kind: string) => (await fake.stats()).byKind[kind] ?? 0;
const revisionCount = (home: string) =>
  readRows(
    home,
    `SELECT COUNT(*) AS n FROM review_revisions r JOIN reviews v ON v.id = r.review_id WHERE v.pr_key = '${KEY}'`,
  )[0]?.n;
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_000));

/** Whether the tab row needs scrolling to show all of itself. */
const tabRowOverflows = (browser: Browser) =>
  browser.evaluate(() => {
    const row = document.querySelector("nav[aria-label='Pull request tabs']");
    return row === null || row.scrollWidth > row.clientWidth;
  });

/** This screen light and dark, at 1280 and at 760 wide, then back at 1280 and recording again. */
const shots = async (app: TestFixtures["app"], browser: Browser, name: string) => {
  await screenshotLightAndDark(app, browser, name);
  await browser.setViewport({ width: 760, height: 900 });
  await expect.poll(() => tabRowOverflows(browser)).toBe(false);
  await screenshotLightAndDark(app, browser, `${name}-narrow`);
  await browser.setViewport({ width: 1280, height: 900 });
  await settle();
  await restart(browser);
};

/** PR 9 on the fake GitHub, with a stand-in Claude that holds its guides until released. */
const setUp = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const git = outsideGit(name);
  const commit = async (files: Record<string, string>) => {
    const sha = git.commit(9, files);
    await fake.files(9, [served(git.patch(9, LIMITS))]);
    await fake.gitHead(9, sha);
  };
  /** Pushes, and resolves once Files read the new head's files. */
  const push = async (files: Record<string, string>) => {
    const filesRead = await reads(fake, "rest:files");
    await commit(files);
    await expect
      .poll(() => reads(fake, "rest:files"), { timeout: 60_000 })
      .toBeGreaterThan(filesRead);
  };
  await commit({ [LIMITS]: CHECKS });
  claude.hold();
  const run = git.start(() =>
    startFakeInstance(name, fake, ["--claude", claude.file, "--e2e", "--watch-interval", "5000"]),
  );
  return { fake, claude, run, push };
};

test(
  "notes line on Files: the list never moves as a guide lands, a push makes it older, and a newer guide is shown",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "files-notes-line";
    const { fake, claude, run, push } = await setUp(name);
    try {
      claude.notes({ [LIMITS]: [question(3, SLUG)] });
      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      const tabs = screen.getByRole("navigation", "Pull request tabs");
      const file = screen.getByRole("region", LIMITS);
      const note = browser.locator(`[data-path="${LIMITS}"] [data-guide-note]`);
      const hide = tabs.getByRole("button", "Hide guide notes");

      // No guide: no toggle and nothing about notes.
      await app.open(`${run.url}${PR}&tab=files`);
      await expect(file).toBeVisible({ timeout: 30_000 });
      await expect(tabs.getByRole("button", /guide notes$/)).toHaveCount(0);
      await screenshotLightAndDark(app, browser, "files-notes-line-no-guide");

      // The reader starts a guide and reads Files while it is written.
      await tabs.getByRole("link", "Guide").tap();
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      await tabs.getByRole("link", "Files").tap();
      await expect(file).toBeVisible({ timeout: 30_000 });
      await expect(tabs.getByRole("button", /guide notes$/)).toHaveCount(0);
      await recordFrames(browser);
      const [start = ""] = await tops(browser);

      // It lands: its note shows in the card and the toggle in the tab row, and the list stays.
      claude.release();
      await expect(note).toBeVisible({ timeout: 120_000 });
      await expect(hide).toHaveAttribute("aria-pressed", "true");
      await settle();
      expect(await tops(browser)).toEqual([start]);
      expect(await notesWords(browser)).toBe("");
      await shots(app, browser, "files-notes-line-landed");

      // A push leaves the guide for an older commit while prkit writes the next one.
      claude.hold();
      await push(ELSEWHERE);
      await settle();
      expect(await tops(browser)).toEqual([start]);
      const older = tabs.getByRole("button", OLDER);
      const notesStatus = browser.locator("nav [data-guide-notes-status]");
      const story = `${STORY} prkit is updating the guide.`;
      await expect(notesStatus).toContainText(story, { timeout: 30_000 });
      await expect(note).toBeVisible();
      expect(await tops(browser)).toEqual([start]);
      await shots(app, browser, "files-notes-line-older");

      // The whole of it shows when the keyboard reaches the words.
      await tabs.getByRole("link", "Files").focus();
      await tabTo(browser, SAID);
      await expect(older).toBeFocused();
      const tooltip = browser.locator('[data-slot="tooltip-popup"]');
      await expect(tooltip).toHaveText(story);
      await settle();
      await screenshotLightAndDark(app, browser, "files-notes-line-older-story");
      await browser.keyboard.press("Shift+Tab");
      await expect(tooltip).toHaveCount(0);

      // The next guide is ready while a comment is being written: it waits for the comment.
      await note.getByRole("button", "Add as comment, question on line 3").tap();
      const field = screen.getByRole("textbox", "Comment on line 3");
      await expect(field).toHaveValue(SLUG);
      claude.release();
      await expect(tabs.getByRole("button", "Newer notes after your comment")).toBeVisible({
        timeout: 120_000,
      });
      await expect(notesStatus).toContainText(
        `${STORY} A newer guide is ready. You can show its notes once your comment is done.`,
      );
      expect(await tops(browser)).toEqual([start]);
      await screenshotLightAndDark(app, browser, "files-notes-line-newer-writing");
      await field.press("Meta+Enter");
      await expect(note.getByRole("status")).toHaveText("In your review.");

      // Then the tab row offers it, and the notes stay until asked.
      const newer = tabs.getByRole("button", "Show newer notes");
      await expect(newer).toBeVisible({ timeout: 30_000 });
      await expect(notesStatus).toContainText(`${STORY} A newer guide is ready.`);
      await expect(older).toHaveCount(0);
      expect(await tops(browser)).toEqual([start]);
      await shots(app, browser, "files-notes-line-newer");

      await newer.tap();
      await expect(newer).toHaveCount(0);
      await expect(note.getByRole("status")).toHaveText("In your review.");
      await settle();
      expect(await tops(browser)).toEqual([start]);
      expect(await notesWords(browser)).toBe("");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "notes line on Files: a guide with no notes here says nothing at 760 wide in dark, and the next one's notes come in",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "files-notes-line-none";
    const { fake, claude, run, push } = await setUp(name);
    try {
      await browser.setViewport({ width: 760, height: 900 });
      await emulateOsColorScheme(browser, "dark");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      const tabs = screen.getByRole("navigation", "Pull request tabs");
      const file = screen.getByRole("region", LIMITS);
      const note = browser.locator(`[data-path="${LIMITS}"] [data-guide-note]`);
      const hide = tabs.getByRole("button", "Hide guide notes");
      await app.open(`${run.url}${PR}&tab=guide`);
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      await tabs.getByRole("link", "Files").tap();
      await expect(file).toBeVisible({ timeout: 30_000 });
      await recordFrames(browser);
      const [start = ""] = await tops(browser);

      claude.release();
      await expect(hide).toHaveAttribute("aria-pressed", "true", { timeout: 120_000 });
      await expect.poll(() => notesWords(browser), { timeout: 30_000 }).toBe("");
      await settle();
      expect(await tops(browser)).toEqual([start]);
      expect(await notesWords(browser)).toBe("");
      await expect(note).toHaveCount(0);
      await app.screenshot("files-notes-line-none-landed-dark");

      // Older, but with nothing of its own here there is nothing to qualify.
      claude.hold();
      await push(ELSEWHERE);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(await tops(browser)).toEqual([start]);
      expect(await notesWords(browser)).toBe("");
      await app.screenshot("files-notes-line-none-older-dark");

      // The next guide has a note here. It waits for the comment being written, then comes in
      // the way a first guide's would.
      await lineNumber(browser, 9).tap();
      const field = screen.getByRole("textbox", "Comment on line 9");
      await field.fill(WORDS);
      claude.notes({ [LIMITS]: [question(3, SLUG)] });
      claude.release();
      await expect.poll(() => revisionCount(run.home), { timeout: 120_000 }).toBe(2);
      await expect(tabs.getByRole("button", "Newer notes show after your comment")).toBeVisible({
        timeout: 30_000,
      });
      await expect(note).toHaveCount(0);
      await expect(field).toHaveValue(WORDS);
      expect(await tops(browser)).toEqual([start]);
      await app.screenshot("files-notes-line-none-newer-writing-dark");
      await field.press("Meta+Enter");
      await expect(note).toBeVisible({ timeout: 30_000 });
      await expect(file.getByRole("article", `Pending comment on ${LIMITS} line 9`)).toContainText(
        WORDS,
      );
      await expect(tabs.getByRole("button", "Show newer notes")).toHaveCount(0);
      await settle();
      expect(await tops(browser)).toEqual([start]);
      expect(await notesWords(browser)).toBe("");
      await app.screenshot("files-notes-line-none-newer-dark");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
