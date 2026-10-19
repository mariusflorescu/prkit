import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import {
  AskedLocalQuestion,
  GenerateLocalGuideResult,
  LocalQuestionWaitResult,
  LocalWaitResult,
  OutsideQuestion,
} from "../apps/server/src/outside/schemas.ts";
import { alive, evidenceFolder, revealedLine } from "./askJourney.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));
const decodeAsked = Schema.decodeSync(Schema.fromJsonString(AskedLocalQuestion));
const decodeQuestionWait = Schema.decodeSync(Schema.fromJsonString(LocalQuestionWaitResult));
const decodeQuestions = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ items: Schema.Array(OutsideQuestion) })),
);

const HANDBOOK = "docs/handbook.md";
const TEAM = { 15: "Limits are set per team.", 16: "A team can raise its own limit." };
const DOCK = "Ask about these changes";

const WHOLE = "What do these changes do?";
const CHAPTER = "Why does this chapter come first?";
const LINES = "Why can a team raise its own limit?";
const CONTAINED = "Write made-by-agent.txt in your working directory and stage it with git.";
const STOPPED = "Which file should I read first?";
const FAILED = "Is the new limit tested?";
const FROM_CLI = "Does anything read the flags yet?";
const REMOVED = "What breaks if I revert the limit?";
const WAITED = "Does anything else read the limits?";

const FIRST_CHUNK = "The stand-in agent answers.";
const REFUSED = "prkit refused submit_guide: Questions have no prkit tools. Answer in your reply.";
const WROTE = "It wrote made-by-agent.txt and staged it.";
const WAITING = "Waiting for a free agent. prkit runs two at a time and both are busy.";
const BUSY = "Wait for this answer or stop it to ask another.";

const { dir: EVIDENCE, keep, keepLightAndDark } = evidenceFolder("ask-local");

type Page = { app: TestFixtures["app"]; screen: Screen; browser: Browser };

/**
 * The fake GitHub (local reviews read none of it), the stand-in Claude, a scratch folder for
 * the user's repositories, and an instance whose Claude saves its sessions under `.e2e/`, so
 * answers can fork the guide's conversation.
 */
const fixtures = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const root = scratchRoot();
  const log: Array<string> = [];
  const launch = () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = NodePath.join(fake.home, ".claude");
    try {
      return startFakeInstance(name, fake, ["--claude", claude.file, "--watch-interval", "600000"]);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  };
  const cliOf = (home: string) => cliIn(NodePath.join(home, "bin/prkit"), fake.home, log);
  const stop = () => {
    stopFakeInstance(name, { keepHome: false });
    fake.stop();
    NodeFS.rmSync(root, { recursive: true, force: true });
  };
  return { fake, claude, root, log, launch, cliOf, stop };
};

/** Starts a guide of the folder's changes from the CLI and waits until it is written. */
const writeLocalGuide = (cli: ReturnType<typeof cliIn>, repo: string) => {
  const started = decodeGenerate(cli(repo, ["local", "guide", "--json"]).stdout);
  expect(["started", "running"]).toContain(started.outcome);
  const waited = decodeWait(cli(repo, ["local", "wait", "--timeout", "120", "--json"]).stdout);
  expect(waited.status.state).toBe("ready");
  return started.status.key;
};

const questionRows = (home: string, key: string) =>
  readRows(
    home,
    `SELECT q.id, q.text, q.state, q.revision, q.agent_pid AS pid, q.pinned_at AS pinnedAt
     FROM ask_questions q JOIN reviews r ON r.id = q.review_id
     WHERE r.pr_key = '${key}' ORDER BY q.asked_at, q.rowid`,
  );

const questionFolders = (home: string) =>
  ["checkouts", "context"].flatMap((name) => {
    const folder = NodePath.join(home, "asks", name);
    return NodeFS.existsSync(folder) ? NodeFS.readdirSync(folder) : [];
  });

/** The new-side line numbers highlighted as picked in a file's drawn diff. */
const pickedLines = (browser: Browser, path: string) =>
  browser.evaluate((file: string) => {
    const card = document.querySelector(`[data-file-diff-card][data-path="${file}"]`);
    const root = card?.querySelector("diffs-container")?.shadowRoot;
    return [...(root?.querySelectorAll("[data-gutter] > [data-selected-line]") ?? [])].map((cell) =>
      Number(cell.getAttribute("data-column-number")),
    );
  }, path);

/** Whether the line numbers of a file's drawn diff offer to ask about a line, or to comment on one. */
const gutterLabels = (browser: Browser, path: string) =>
  browser.evaluate((file: string) => {
    const root = document.querySelector(
      `[data-file-diff-card][data-path="${file}"] diffs-container`,
    )?.shadowRoot;
    const labels = [...(root?.querySelectorAll("[data-gutter] > [aria-label]") ?? [])].map(
      (cell) => cell.getAttribute("aria-label") ?? "",
    );
    return {
      ask: labels.some((label) => label.startsWith("Ask about")),
      comment: labels.some((label) => label.startsWith("Comment on")),
    };
  }, path);

/** Focuses the tab stop of a file's line numbers, as Tab reaches it, and says what it offers. */
const focusGutterStop = (browser: Browser, path: string) =>
  browser.evaluate((file: string) => {
    const root = document.querySelector(
      `[data-file-diff-card][data-path="${file}"] diffs-container`,
    )?.shadowRoot;
    const stop = root?.querySelector<HTMLElement>('[data-gutter] > [tabindex="0"]');
    stop?.scrollIntoView({ block: "center" });
    stop?.focus();
    return stop?.getAttribute("aria-label") ?? "";
  }, path);

test(
  "ask-local: questions about all the changes, a chapter and lines answer in forks of the guide, link into the diff, stop, fail, retry, pin, reach the CLI, never touch the user's repository, come back after a relaunch, and go with the review",
  { timeout: 900_000 },
  async ({ app, screen, browser }) => {
    const name = "ask-local";
    const { fake, claude, root, log, launch, cliOf, stop } = await fixtures(name);
    const page: Page = { app, screen, browser };
    try {
      const fixture = localRepoFixture(root);
      fixture.write(HANDBOOK, handbook(TEAM));
      claude.chapters([{ title: "The handbook", files: [HANDBOOK] }]);
      let run = launch();
      let cli = cliOf(run.home);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await switchOn(page, run.openUrl);
      await dismissToasts(browser);
      const key = writeLocalGuide(cli, fixture.repo);
      const gitBefore = fixture.fingerprint();
      const treeBefore = fixture.workTree();
      const guideRuns = claude.runs().length;
      const asksRoot = NodePath.join(run.home, "asks", "checkouts") + NodePath.sep;

      await app.open(`${run.url}/local/${key}`);
      await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 30_000 });
      const dock = screen.getByRole("region", DOCK);
      const history = dock.getByRole("region", "Your questions");
      const field = dock.getByRole("textbox", "Your question");
      await expect(field).toHaveAttribute("placeholder", DOCK);
      await expect(dock.getByText("All changes", { exact: true })).toBeVisible();
      await expect(history).toHaveCount(0);
      await keep(app, "01-dock-closed");

      await field.tap();
      await expect(
        history.getByText(
          "Ask the agent that wrote this guide. It already read all of these changes.",
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
      await expect(field).toBeDisabled();
      await expect(field).toHaveAttribute("placeholder", BUSY);
      await keep(app, "03-streaming");
      claude.releaseAnswers();
      await expect(whole).toContainText("Claude answered", { timeout: 30_000 });
      await expect(whole).toContainText(REFUSED);
      await expect(field).toBeEnabled();
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      const asked = claude.runs()[guideRuns];
      expect(asked).toMatchObject({ resumed: true, forked: true });
      expect(asked?.cwd.startsWith(asksRoot)).toBe(true);
      await keep(app, "04-answered");

      const cited = whole.getByRole("link", /^[\w./-]+:\d+$/).first();
      const [, citedPath, citedLine] = /^(.+):(\d+)$/.exec((await cited.textContent()) ?? "") ?? [];
      await cited.tap();
      await expect
        .poll(() => revealedLine(browser))
        .toEqual({ path: citedPath, line: citedLine, shown: true });
      await keep(app, "05-cited-line");

      const askChapter = screen.getByRole("button", "Ask about this chapter").first();
      await askChapter.scrollIntoView();
      await askChapter.tap();
      await expect(dock.getByText("Chapter 1: The handbook")).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("placeholder", "Ask about this chapter");
      await field.fill(CHAPTER);
      await field.press("Meta+Enter");
      const chapter = history.getByRole("article", CHAPTER);
      await expect(chapter).toContainText("Claude answered", { timeout: 60_000 });
      await expect(chapter).toContainText("Continues your earlier question");
      await keep(app, "06-chapter-answered");

      // Picking lines on a local guide asks about them: no comment card, the dock takes them.
      await dock.getByRole("button", "Hide questions").tap();
      await expect(history).toHaveCount(0);
      const added = (line: number) =>
        browser.locator(
          `[data-path="${HANDBOOK}"] [data-column-number="${line}"][data-line-type="change-addition"]`,
        );
      await added(15).scrollIntoView();
      await added(15).dragTo(added(16));
      await expect(dock.getByText(`${HANDBOOK} 15-16`)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("placeholder", "Ask about these lines");
      await expect(screen.getByRole("textbox", /^Comment on/)).toHaveCount(0);
      await expect.poll(() => pickedLines(browser, HANDBOOK)).toEqual([15, 16]);
      expect(await gutterLabels(browser, HANDBOOK)).toEqual({ ask: true, comment: false });
      await keep(app, "07-lines-picked");
      await field.fill(LINES);
      await field.press("Meta+Enter");
      const lines = history.getByRole("article", LINES);
      await expect(lines).toContainText("Claude answered", { timeout: 60_000 });
      await expect(lines).toContainText(`${HANDBOOK} 15-16`);
      await keep(app, "08-lines-answered");

      // An answer told to write a file, by an agent past every guard, never reaches the user's
      // repository: it runs in its own checkout of the snapshot under the home's asks folder.
      // The hover button and a line number's keyboard path pick lines the same way.
      await dock.getByRole("button", "Ask about all the changes instead").tap();
      await expect.poll(() => pickedLines(browser, HANDBOOK)).toEqual([]);
      await dock.getByRole("button", "Hide questions").tap();
      await browser
        .locator(
          `[data-path="${HANDBOOK}"] [data-column-number="15"][data-line-type="change-deletion"]`,
        )
        .hover();
      await browser.locator(`[data-path="${HANDBOOK}"] [data-ask-line-button]`).tap();
      await expect(dock.getByText(`${HANDBOOK} old 15`, { exact: true })).toBeVisible();
      await expect(field).toBeFocused();
      await expect.poll(() => pickedLines(browser, HANDBOOK)).toEqual([15]);
      await dock.getByRole("button", "Hide questions").tap();
      const stop = await focusGutterStop(browser, HANDBOOK);
      expect(stop).toMatch(/^Ask about (old )?line \d+$/);
      await browser.keyboard.press("Enter");
      const [, old, line] = /^Ask about (old )?line (\d+)$/.exec(stop) ?? [];
      await expect(
        dock.getByText(`${HANDBOOK} ${old ?? ""}${line}`, { exact: true }),
      ).toBeVisible();
      await expect(field).toBeFocused();

      await dock.getByRole("button", "Ask about all the changes instead").tap();
      await expect.poll(() => pickedLines(browser, HANDBOOK)).toEqual([]);
      claude.writingAnswers(true);
      await field.fill(CONTAINED);
      await field.press("Meta+Enter");
      const contained = history.getByRole("article", CONTAINED);
      await expect(contained).toContainText("Claude answered", { timeout: 60_000 });
      await expect(contained).toContainText(WROTE);
      claude.writingAnswers(false);
      const wrote = claude.runs().at(-1);
      expect(wrote?.cwd.startsWith(asksRoot)).toBe(true);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      expect({
        madeInRepository: NodeFS.existsSync(NodePath.join(fixture.repo, "made-by-agent.txt")),
        gitUnchanged: fixture.fingerprint() === gitBefore,
        workTreeUnchanged: fixture.workTree() === treeBefore,
        filterRan: fixture.filterRan(),
      }).toEqual({
        madeInRepository: false,
        gitUnchanged: true,
        workTreeUnchanged: true,
        filterRan: false,
      });
      await keep(app, "09-contained");

      claude.holdAnswers();
      await field.fill(STOPPED);
      await field.press("Meta+Enter");
      const stopped = history.getByRole("article", STOPPED);
      await expect(stopped).toContainText(FIRST_CHUNK, { timeout: 60_000 });
      await expect
        .poll(() => questionRows(run.home, key).find((row) => row.text === STOPPED)?.pid ?? null)
        .not.toBeNull();
      const pid = Number(questionRows(run.home, key).find((row) => row.text === STOPPED)?.pid);
      await stopped.getByRole("button", "Stop").tap();
      await expect(stopped).toContainText("Stopped");
      await expect(stopped).toContainText(FIRST_CHUNK);
      await expect(stopped.getByRole("button", "Retry")).toBeVisible();
      await expect(field).toBeEnabled();
      await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      await keep(app, "10-stopped");
      claude.releaseAnswers();
      await stopped.getByRole("button", "Retry").tap();
      await expect(stopped).toContainText("Claude answered", { timeout: 60_000 });

      claude.failing(true);
      await field.fill(FAILED);
      await field.press("Meta+Enter");
      const failed = history.getByRole("article", FAILED);
      await expect(failed).toContainText("The stand-in agent was told to fail.", {
        timeout: 60_000,
      });
      await expect(failed.getByRole("button", "Retry")).toBeVisible();
      await keep(app, "11-failed");
      claude.failing(false);
      await failed.getByRole("button", "Retry").tap();
      await expect(failed).toContainText("Claude answered", { timeout: 60_000 });

      await chapter.getByRole("button", "Pin to chapter").tap();
      await whole.getByRole("button", "Pin to overview").tap();
      const chapterPin = screen.getByRole("complementary", `Pinned answer: ${CHAPTER}`);
      const wholePin = screen.getByRole("complementary", `Pinned answer: ${WHOLE}`);
      await expect(chapterPin).toContainText("Pinned from Ask · Claude · r1");
      await expect(wholePin).toContainText(FIRST_CHUNK);
      await expect(browser.locator("[data-path] [data-ask-pin]")).toHaveCount(0);
      await dock.getByRole("button", "Hide questions").tap();
      await browser.evaluate(() => {
        document.querySelector("[data-ask-pin]")?.scrollIntoView({ block: "start" });
        return true;
      });
      await expect(added(15)).toBeVisible({ timeout: 30_000 });
      await keep(app, "12-pinned");
      await dock.getByRole("button", "Show questions").tap();
      await browser.setViewport({ width: 1280, height: 1000 });
      await chapter.scrollIntoView();
      await keepLightAndDark(app, browser, "13-dock");
      await browser.setViewport({ width: 900, height: 900 });
      await chapter.scrollIntoView();
      await keep(app, "14-narrow-900");
      await browser.setViewport({ width: 720, height: 860 });
      await keep(app, "15-narrow-720");
      await browser.setViewport({ width: 1280, height: 860 });

      // The CLI reaches the same questions from the repository folder, with the app's answers.
      const local = (args: ReadonlyArray<string>) => cli(fixture.repo, ["local", ...args]);
      const listed = decodeQuestions(local(["questions", "list", "--json"]).stdout);
      expect(listed.items.map((item) => [item.text, item.state, item.pinned])).toEqual([
        [WHOLE, "answered", true],
        [CHAPTER, "answered", true],
        [LINES, "answered", false],
        [CONTAINED, "answered", false],
        [STOPPED, "answered", false],
        [FAILED, "answered", false],
      ]);
      expect(listed.items[2]?.scope).toEqual({
        _tag: "lines",
        anchor: {
          path: HANDBOOK,
          start: { side: "new", line: 15 },
          end: { side: "new", line: 16 },
        },
      });
      expect(listed.items[0]?.scope).toEqual({ _tag: "local-changes" });
      const askArgs = [
        "questions",
        "ask",
        "--question",
        FROM_CLI,
        "--request-id",
        "cli-1",
        "--json",
      ];
      const fromCli = decodeAsked(local(askArgs).stdout);
      expect(fromCli).toMatchObject({ key, revision: 1 });
      expect(decodeAsked(local(askArgs).stdout).questionId).toBe(fromCli.questionId);
      const waited = decodeQuestionWait(
        local([
          "questions",
          "wait",
          "--question-id",
          fromCli.questionId,
          "--timeout",
          "120",
          "--json",
        ]).stdout,
      );
      expect(waited).toMatchObject({ finished: true, question: { state: "answered" } });
      const cliCard = history.getByRole("article", FROM_CLI);
      await expect(cliCard).toContainText("Asked by prkit CLI");
      await expect(cliCard).toContainText("Claude answered");
      expect(
        local([
          "questions",
          "pin",
          "--question-id",
          fromCli.questionId,
          "--pinned",
          "true",
          "--json",
        ]).code,
      ).toBe(0);
      await expect(screen.getByRole("complementary", `Pinned answer: ${FROM_CLI}`)).toBeVisible();
      expect(
        local([
          "questions",
          "pin",
          "--question-id",
          fromCli.questionId,
          "--pinned",
          "false",
          "--json",
        ]).code,
      ).toBe(0);
      await expect(screen.getByRole("complementary", `Pinned answer: ${FROM_CLI}`)).toHaveCount(0);
      await keep(app, "16-asked-from-cli");

      // Losing prkit keeps the cards; a relaunch brings every question and pin back.
      stopFakeInstance(name, { keepHome: true });
      await expect(dock.getByText("Couldn't keep your questions up to date")).toBeVisible({
        timeout: 30_000,
      });
      await expect(history.getByRole("article", WHOLE)).toBeVisible();
      await keep(app, "17-lost-touch");
      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      run = launch();
      cli = cliOf(run.home);
      await app.open(run.openUrl);
      await app.open(`${run.url}/local/${key}`);
      await expect(chapterPin).toContainText(FIRST_CHUNK, { timeout: 60_000 });
      await expect(wholePin).toBeVisible();
      await dock.getByRole("button", "Show questions").tap();
      for (const text of [WHOLE, CHAPTER, LINES, CONTAINED, STOPPED, FAILED, FROM_CLI])
        await expect(history.getByRole("article", text)).toContainText("Claude answered", {
          timeout: 30_000,
        });
      await keep(app, "18-relaunched");

      // A new run is revision 2; the earlier answers say where they were asked and link back.
      fixture.write(HANDBOOK, handbook({ ...TEAM, 22: "Limits reset monthly." }));
      expect(decodeGenerate(cli(fixture.repo, ["local", "guide", "--json"]).stdout).outcome).toBe(
        "started",
      );
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2 · ", {
        timeout: 120_000,
      });
      await expect(history.getByRole("article", WHOLE)).toContainText("Asked on r1");
      await expect(field).toHaveAttribute("placeholder", DOCK);
      await keep(app, "19-asked-on-r1");
      await history
        .getByRole("article", WHOLE)
        .getByRole("link", /^[\w./-]+:\d+$/)
        .first()
        .tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ");
      await expect
        .poll(() => revealedLine(browser))
        .toEqual({ path: citedPath, line: citedLine, shown: true });
      await keep(app, "20-link-back-to-r1");

      // Removing the review while an answer is written stops its agent and takes every question.
      claude.holdAnswers();
      await field.fill(REMOVED);
      await field.press("Meta+Enter");
      await expect(history.getByRole("article", REMOVED)).toContainText(FIRST_CHUNK, {
        timeout: 60_000,
      });
      await expect
        .poll(() => questionRows(run.home, key).find((row) => row.text === REMOVED)?.pid ?? null)
        .not.toBeNull();
      const removedPid = Number(
        questionRows(run.home, key).find((row) => row.text === REMOVED)?.pid,
      );
      await screen.getByRole("button", "More local review actions").tap();
      await screen.getByRole("menuitem", "Remove local review…").tap();
      await screen.getByRole("alertdialog").getByRole("button", "Remove").tap();
      await expect(screen.getByText("Local review removed", { exact: true })).toBeVisible();
      await expect.poll(() => alive(removedPid), { timeout: 15_000 }).toBe(false);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      expect(readRows(run.home, "SELECT id FROM ask_questions")).toEqual([]);
      claude.releaseAnswers();

      expect(fixture.fingerprint()).toBe(gitBefore);
      expect(fixture.filterRan()).toBe(false);
      expect(await fake.writes()).toEqual([]);
    } finally {
      claude.releaseAnswers();
      claude.writingAnswers(false);
      NodeFS.mkdirSync(EVIDENCE, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(EVIDENCE, "cli-transcript.txt"), log.join("\n\n"));
      stop();
    }
  },
);

test(
  "ask-local: a question waits for a free agent while two local guides hold both slots, then answers",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "ask-local-waiting";
    const { claude, root, launch, cliOf, stop } = await fixtures(name);
    const page: Page = { app, screen, browser };
    try {
      const asked = localRepoFixture(root, "widgets");
      const others = [localRepoFixture(root, "gadgets"), localRepoFixture(root, "gizmos")];
      const run = launch();
      const cli = cliOf(run.home);
      await emulateOsColorScheme(browser, "light");
      await switchOn(page, run.openUrl);
      await dismissToasts(browser);
      const key = writeLocalGuide(cli, asked.repo);

      claude.hold();
      for (const other of others)
        expect(decodeGenerate(cli(other.repo, ["local", "guide", "--json"]).stdout).outcome).toBe(
          "started",
        );
      await expect
        .poll(
          () =>
            readRows(
              run.home,
              `SELECT a.agent_pid AS pid FROM review_attempts a JOIN reviews r ON r.id = a.review_id
               WHERE r.local IS NOT NULL AND r.pr_key != '${key}' AND a.agent_pid IS NOT NULL
                 AND a.finished_at IS NULL`,
            ).length,
          { timeout: 60_000 },
        )
        .toBe(2);

      await app.open(`${run.url}/local/${key}`);
      const dock = screen.getByRole("region", DOCK);
      const field = dock.getByRole("textbox", "Your question");
      await field.tap({ timeout: 60_000 });
      await field.fill(WAITED);
      await field.press("Meta+Enter");
      const waited = dock.getByRole("article", WAITED);
      await expect(waited).toContainText(WAITING, { timeout: 60_000 });
      await expect(waited.getByRole("button", "Stop")).toBeVisible();
      await keep(app, "21-waiting");

      claude.release();
      await expect(waited).toContainText("Claude answered", { timeout: 120_000 });
      await expect(waited).not.toContainText(WAITING);
      await expect.poll(() => questionFolders(run.home)).toEqual([]);
      await keep(app, "22-waited-answered");
    } finally {
      claude.release();
      stop();
    }
  },
);
