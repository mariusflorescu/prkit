import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";

import { evidenceFolder, revealedLine } from "./askJourney.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const KEY = "github.com/budget/fixtures#9";
const ACCOUNT = "?account=github.com%2Fbudget-test";
const guideOf = (number: number) => `/pr/github.com/budget/fixtures/${number}${ACCOUNT}&tab=guide`;
const LIMITS = "src/limits.ts";
const CITED = "src/change-0.ts:1";

const WHOLE = "What does this pull request change?";
const CHAPTER = "Why is every change in one chapter?";
const LINES = "Why does the slug get its own limit?";
const STOPPED = "Which file should I read first?";
const FAILED = "Is the URL limit tested?";
const WAITED = "Does anything else read the limits?";

const FIRST_CHUNK = "The stand-in agent answers.";
const REFUSED = "prkit refused submit_guide: Questions have no prkit tools. Answer in your reply.";
const WAITING = "Waiting for a free agent. prkit runs two at a time and both are busy.";
const BUSY = "Wait for this answer or stop it to ask another.";

const { keep, keepLightAndDark } = evidenceFolder("ask");

/**
 * The fake GitHub, the stand-in Claude and the PRs' git objects. The stand-in saves its
 * sessions only in a config folder under `.e2e/`, so the instance gets one of its own there
 * and answers can fork the guide's conversation.
 */
const fixtures = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const git = outsideGit(name);
  const launch = () =>
    git.start(() => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = NodePath.join(fake.home, ".claude");
      try {
        return startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          "5000",
        ]);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  return { fake, claude, git, launch };
};

type Page = { app: TestFixtures["app"]; screen: Screen; browser: Browser };

const openGuide = async ({ app, screen, browser }: Page, run: { url: string; openUrl: string }) => {
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  await app.open(`${run.url}${guideOf(9)}`);
};

const writeGuide = async ({ screen }: Page, revision: string) => {
  await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
  await expect(screen.getByRole("combobox", "Guide revision")).toContainText(revision, {
    timeout: 120_000,
  });
};

const questionRows = (home: string) =>
  readRows(
    home,
    `SELECT q.text, q.state, q.revision, q.agent_pid AS pid, q.pinned_at AS pinnedAt
     FROM ask_questions q JOIN reviews r ON r.id = q.review_id
     WHERE r.pr_key = '${KEY}' ORDER BY q.asked_at, q.rowid`,
  );

const questionFolders = (home: string) =>
  ["checkouts", "context"].flatMap((name) => {
    const folder = NodePath.join(home, "asks", name);
    return NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder) : [];
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "ask: questions about the whole PR, a chapter and lines answer in forks of the guide, link into the diff, stop, fail, retry, pin, and come back after a relaunch",
  { timeout: 600_000 },
  async ({ app, screen, browser }) => {
    const name = "ask";
    const { fake, claude, git, launch } = await fixtures(name);
    const page = { app, screen, browser };
    try {
      await fake.gitHead(9, git.head(9));
      const run = launch();
      await openGuide(page, run);
      await writeGuide(page, "r1 · ");
      const guideRuns = claude.runs().length;

      const dock = screen.getByRole("region", "Ask about this pull request");
      const history = dock.getByRole("region", "Your questions");
      const field = dock.getByRole("textbox", "Your question");
      await expect(field).toHaveAttribute("placeholder", "Ask about this pull request");
      await expect(history).toHaveCount(0);
      await keep(app, "01-dock-closed");

      await field.tap();
      await expect(
        history.getByText(
          "Ask the agent that wrote this guide. It already read the whole pull request.",
        ),
      ).toBeVisible();
      await keep(app, "02-empty");

      claude.holdAnswers();
      await field.fill(WHOLE);
      await field.press("Meta+Enter");
      const whole = history.getByRole("article", WHOLE);
      await expect(whole).toContainText(FIRST_CHUNK, { timeout: 60_000 });
      await expect(whole).toContainText("Answering");
      await expect(whole).toContainText("From the session that wrote this guide");
      await expect(whole).not.toContainText("prkit refused");
      await expect(field).toBeDisabled();
      await expect(field).toHaveAttribute("placeholder", BUSY);
      await keep(app, "03-streaming");
      claude.releaseAnswers();
      await expect(whole).toContainText("Claude answered", { timeout: 30_000 });
      await expect(whole).toContainText(REFUSED);
      await expect(field).toBeEnabled();
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      expect(claude.runs()[guideRuns]).toMatchObject({ resumed: true, forked: true });
      await keep(app, "04-answered");

      await whole.getByRole("link", CITED).tap();
      await expect
        .poll(() => revealedLine(browser))
        .toEqual({
          path: "src/change-0.ts",
          line: "1",
          shown: true,
        });
      await keep(app, "05-cited-line");

      const askChapter = screen.getByRole("button", "Ask about this chapter");
      await askChapter.scrollIntoView();
      await keep(app, "06-before-chapter");
      await askChapter.tap();
      await expect(dock.getByText("Chapter 1: Every change")).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("placeholder", "Ask about this chapter");
      await field.fill(CHAPTER);
      await field.press("Meta+Enter");
      const chapter = history.getByRole("article", CHAPTER);
      await expect(chapter).toContainText("Claude answered", { timeout: 60_000 });
      await expect(chapter).toContainText("Continues your earlier question");
      await expect(chapter).toContainText("Chapter 1: Every change");
      await keep(app, "07-chapter-answered");

      await dock.getByRole("button", "Hide questions").tap();
      await expect(history).toHaveCount(0);
      const added = (line: number) =>
        browser.locator(
          `[data-path="${LIMITS}"] [data-column-number="${line}"][data-line-type="change-addition"]`,
        );
      await added(2).scrollIntoView();
      await added(2).dragTo(added(3));
      const comment = screen.getByRole("textbox", "Comment on lines 2 to 3");
      await expect(comment).toBeVisible();
      await keep(app, "08-lines-selected");
      await screen.getByRole("button", "Ask about these lines").tap();
      await expect(comment).toHaveCount(0);
      await expect(dock.getByText(`${LIMITS} 2-3`)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("placeholder", "Ask about these lines");
      await keep(app, "09-lines-scope");
      await field.fill(LINES);
      await field.press("Meta+Enter");
      const lines = history.getByRole("article", LINES);
      await expect(lines).toContainText("Claude answered", { timeout: 60_000 });
      await expect(lines).toContainText(`${LIMITS} 2-3`);
      await keep(app, "10-lines-answered");

      await dock.getByRole("button", "Ask about the whole PR instead").tap();
      await expect(field).toHaveAttribute("placeholder", "Ask about this pull request");
      claude.holdAnswers();
      await field.fill(STOPPED);
      await field.press("Meta+Enter");
      const stopped = history.getByRole("article", STOPPED);
      await expect(stopped).toContainText(FIRST_CHUNK, { timeout: 60_000 });
      await expect
        .poll(() => questionRows(run.home).find((row) => row.text === STOPPED)?.pid ?? null)
        .not.toBeNull();
      const pid = Number(questionRows(run.home).find((row) => row.text === STOPPED)?.pid);
      await keep(app, "11-before-stop");
      await stopped.getByRole("button", "Stop").tap();
      await expect(stopped).toContainText("Stopped");
      await expect(stopped).toContainText(FIRST_CHUNK);
      await expect(stopped).not.toContainText("It got");
      await expect(stopped.getByRole("button", "Retry")).toBeVisible();
      await expect(field).toBeEnabled();
      await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      await keep(app, "12-stopped");
      claude.releaseAnswers();
      await stopped.getByRole("button", "Retry").tap();
      await expect(stopped).toContainText("Claude answered", { timeout: 60_000 });
      await expect(stopped).not.toContainText(WAITING);
      await expect(stopped).toContainText(REFUSED);
      await keep(app, "13-retried");

      claude.failing(true);
      await field.fill(FAILED);
      await field.press("Meta+Enter");
      const failed = history.getByRole("article", FAILED);
      await expect(failed).toContainText("The stand-in agent was told to fail.", {
        timeout: 60_000,
      });
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      await keep(app, "14-failed");
      claude.failing(false);
      await failed.getByRole("button", "Retry").tap();
      await expect(failed).toContainText("Claude answered", { timeout: 60_000 });
      await keep(app, "15-failed-retried");

      await chapter.getByRole("button", "Pin to chapter").tap();
      await expect(chapter.getByRole("button", "Unpin")).toBeVisible();
      const pin = screen.getByRole("complementary", `Pinned answer: ${CHAPTER}`);
      await expect(pin).toContainText("Pinned from Ask · Claude · r1");
      await expect(pin).toContainText(FIRST_CHUNK);
      await expect(browser.locator(`[data-path] [data-ask-pin]`)).toHaveCount(0);
      expect(questionRows(run.home).find((row) => row.text === CHAPTER)?.pinnedAt).not.toBeNull();
      const pinToTop = () =>
        browser.evaluate(() => {
          document.querySelector("[data-ask-pin]")?.scrollIntoView({ block: "start" });
          return true;
        });
      await dock.getByRole("button", "Hide questions").tap();
      await pinToTop();
      await keep(app, "16-pinned");
      await dock.getByRole("button", "Show questions").tap();
      const size = await browser.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      await browser.setViewport({ width: 1280, height: 1000 });
      await chapter.scrollIntoView();
      await pinToTop();
      await keepLightAndDark(app, browser, "17-dock");
      await browser.setViewport({ width: 900, height: 900 });
      await chapter.scrollIntoView();
      await keep(app, "18-narrow");
      await browser.setViewport(size);

      stopFakeInstance(name, { keepHome: true });
      await expect(dock.getByText("Couldn't keep your questions up to date")).toBeVisible({
        timeout: 30_000,
      });
      await expect(history.getByRole("article", WHOLE)).toBeVisible();
      await keep(app, "19-lost-touch");

      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      const relaunched = launch();
      await openGuide(page, relaunched);
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 60_000,
      });
      await expect(pin).toContainText(FIRST_CHUNK, { timeout: 30_000 });
      await dock.getByRole("button", "Show questions").tap();
      // The relaunched guide draws its long diff first, which can hold the page on a busy machine.
      for (const text of [WHOLE, CHAPTER, LINES, STOPPED, FAILED])
        await expect(history.getByRole("article", text)).toContainText("Claude answered", {
          timeout: 30_000,
        });
      await keep(app, "20-relaunched");
      await pin.getByRole("button", "Unpin").tap();
      await expect(pin).toHaveCount(0);
      await expect(chapter.getByRole("button", "Pin to chapter")).toBeVisible();
      expect(
        questionRows(relaunched.home).find((row) => row.text === CHAPTER)?.pinnedAt,
      ).toBeNull();
      await keep(app, "21-unpinned");

      const generated = `${Array.from({ length: 1600 }, (_, index) => `// Fixture detail ${index}`).join("\n")}\nexport const change0 = "Second fixture 9";\n`;
      await fake.gitHead(9, git.commit(9, { "src/change-0.ts": generated }));
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2 · ", {
        timeout: 120_000,
      });
      await expect(history.getByRole("article", WHOLE)).toContainText("Asked on r1");
      await expect(
        browser.locator(
          `[data-path="${LIMITS}"] [data-column-number="3"][data-line-type="change-addition"]`,
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(field).toHaveAttribute("placeholder", "Ask about this pull request");
      await keep(app, "22-asked-on-r1");
      expect(questionRows(relaunched.home).map((row) => row.revision)).toEqual([1, 1, 1, 1, 1]);

      await history.getByRole("article", WHOLE).getByRole("link", CITED).tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ");
      await expect
        .poll(() => revealedLine(browser))
        .toEqual({
          path: "src/change-0.ts",
          line: "1",
          shown: true,
        });
      await expect(history.getByRole("article", WHOLE)).not.toContainText("Asked on r1");
      await keep(app, "23-link-back-to-r1");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "ask: a question waits for a free agent while two guides hold both slots, then answers",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "ask-waiting";
    const { fake, claude, git, launch } = await fixtures(name);
    const page = { app, screen, browser };
    try {
      for (const number of [1, 2, 9]) await fake.gitHead(number, git.head(number));
      const run = launch();
      await openGuide(page, run);
      await writeGuide(page, "r1 · ");

      claude.hold();
      for (const number of [1, 2]) {
        await app.open(`${run.url}${guideOf(number)}`);
        await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
        await expect
          .poll(
            () =>
              readRows(
                run.home,
                `SELECT a.agent_pid AS pid FROM review_attempts a JOIN reviews r ON r.id = a.review_id
                 WHERE r.pr_key = 'github.com/budget/fixtures#${number}' AND a.agent_pid IS NOT NULL`,
              ).length,
            { timeout: 60_000 },
          )
          .toBe(1);
      }

      await app.open(`${run.url}${guideOf(9)}`);
      const dock = screen.getByRole("region", "Ask about this pull request");
      const field = dock.getByRole("textbox", "Your question");
      await field.tap({ timeout: 60_000 });
      await field.fill(WAITED);
      await field.press("Meta+Enter");
      const waited = dock.getByRole("article", WAITED);
      await expect(waited).toContainText(WAITING, { timeout: 60_000 });
      await expect(waited.getByRole("button", "Stop")).toBeVisible();
      await keep(app, "24-waiting");

      claude.release();
      await expect(waited).toContainText("Claude answered", { timeout: 120_000 });
      await expect(waited).not.toContainText(WAITING);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      await keep(app, "25-waited-answered");
    } finally {
      claude.release();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
