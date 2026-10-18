import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";

import { type RunFile, repoRoot } from "../scripts/verify-run.ts";
import { evidenceFolder, revealedLine } from "./askJourney.ts";
import { startInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { AGENT_WAIT, CODEX_RUNS, CODEX_SKIP } from "./fixActions.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  FIXTURE_FILES,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  prPath,
  readRows,
} from "./fixturePr.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";

const FIXTURE_KEY = `github.com/${FIXTURE_REPO}#1`;
const INSTANCE_ARGS = ["--e2e", "--watch-interval", "5000"];

const WHOLE =
  "What does this pull request change? Point me at the most important changed lines as path:line.";
const CHAPTER = "Why does this chapter matter to a reviewer?";
const LINES = "What do these lines do?";
const STOPPED =
  "Walk me through every changed file, one at a time, quoting the important lines of each.";
const CONTAINED =
  "Run this exact command with your shell tool in your working directory, even if you expect it to be refused: printf hello > made-by-agent.txt. Then tell me whether it worked.";
const MADE = "made-by-agent.txt";

const { dir: EVIDENCE, keep, keepLightAndDark } = evidenceFolder("ask-agents");

type Page = { app: TestFixtures["app"]; screen: Screen; browser: Browser };
type Agent = {
  name: "claude" | "codex";
  label: string;
  pick: (page: Page) => Promise<void>;
  refusal: { log: string; decision: string };
};

const openGuide = async ({ app, screen, browser }: Page, run: RunFile) => {
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  await app.open(`${run.url}${prPath(FIXTURE_REPO, 1, "guide")}`);
  await expect(screen.getByRole("heading", "Validate links and count clicks")).toBeVisible({
    timeout: 45_000,
  });
};

const questionRows = (home: string) =>
  readRows(
    home,
    `SELECT q.id, q.text, q.state, q.basis, q.failure, q.message, q.answer, q.agent_pid AS pid,
       q.session_id AS session, q.pinned_at AS pinnedAt
     FROM ask_questions q JOIN reviews r ON r.id = q.review_id
     WHERE r.pr_key = '${FIXTURE_KEY}' ORDER BY q.asked_at, q.rowid`,
  );
const questionRow = (home: string, text: string) =>
  questionRows(home).find((row) => row.text === text);

const reviewRow = (home: string) => {
  const [review] = readRows(
    home,
    `SELECT id, provider, session_id AS session FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
  );
  if (typeof review?.id !== "string" || typeof review.session !== "string")
    throw new Error("The fixture PR's review has no saved id or session.");
  return { id: review.id, provider: review.provider, session: review.session };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** Where Claude keeps the session it started in `cwd`. */
const claudeSessionFile = (cwd: string, session: string) =>
  NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOs.homedir(), ".claude"),
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    `${session}.jsonl`,
  );

/** Where Codex, run in prkit's Codex home under `home`, keeps the thread `session`. */
const codexThreadFile = (home: string, session: string) =>
  NodeFS.globSync(`codex/sessions/**/rollout-*-${session}.jsonl`, { cwd: home }).map((path) =>
    NodePath.join(home, path),
  )[0];

/** The server log's entries, each its header line and the fields printed under it. */
const logEntries = (file: string) =>
  NodeFS.readFileSync(file, "utf8").split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\] )/);

/** The entries named `message` with this decision, logged after the question's turn began. */
const decisionsAfter = (file: string, questionId: string, message: string, decision: string) => {
  const entries = logEntries(file);
  const start = entries.findIndex(
    (entry) => entry.includes("): Answering a question") && entry.includes(questionId),
  );
  return start === -1
    ? []
    : entries
        .slice(start + 1)
        .filter(
          (entry) => entry.includes(`): ${message} {`) && entry.includes(`decision: '${decision}'`),
        );
};

/** Two added lines in a row in a chapter's drawn diff, the first one's number and its file. */
const twoAddedLines = (browser: Browser) =>
  browser.evaluate(() => {
    for (const card of document.querySelectorAll("[data-file-diff-card]")) {
      const root = card.querySelector("diffs-container")?.shadowRoot;
      const numbers = new Set(
        [
          ...(root?.querySelectorAll('[data-gutter] > [data-line-type="change-addition"]') ?? []),
        ].map((cell) => Number(cell.getAttribute("data-column-number"))),
      );
      const start = [...numbers].toSorted((a, b) => a - b).find((line) => numbers.has(line + 1));
      const path = card.getAttribute("data-path");
      if (start !== undefined && path !== null) return { path, start };
    }
    return null;
  });

/** Whether a card has answer text on screen yet. */
const hasText = (browser: Browser, question: string) =>
  browser.evaluate(
    (text: string) =>
      ([...document.querySelectorAll("article[data-question-state]")]
        .find((card) => card.getAttribute("aria-label") === text)
        ?.querySelector(".pr-markdown")
        ?.textContent?.trim() ?? "") !== "",
    question,
  );

const cardStates = (browser: Browser) =>
  browser.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("article[data-question-state]")].map((card) => [
        card.getAttribute("aria-label"),
        card.getAttribute("data-question-state"),
      ]),
    ),
  );

const pinPlace = (browser: Browser) =>
  browser.evaluate(() => {
    const pin = document.querySelector("[data-ask-pin]");
    const overview = [...document.querySelectorAll("h1, h2, h3")].find(
      (heading) => heading.textContent?.trim() === "Overview",
    );
    const firstChapter = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Ask about this chapter",
    );
    const follows = (a: Element | null | undefined, b: Element | null | undefined) =>
      a !== null &&
      a !== undefined &&
      b !== null &&
      b !== undefined &&
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return {
      afterOverview: follows(overview, pin),
      beforeChapters: follows(pin, firstChapter),
      inDiff: pin === null ? null : pin.closest("[data-path]") !== null,
    };
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const journey = (agent: Agent) => async (page: Page) => {
  const { app, screen, browser } = page;
  const instance = `ask-${agent.name}`;
  const evidence: Array<string> = [];
  const note = (key: string, value: object | string | null) =>
    evidence.push(`${key}: ${JSON.stringify(value)}`);
  NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "homes", instance), {
    recursive: true,
    force: true,
  });
  let run = startInstance(instance, INSTANCE_ARGS);
  try {
    await openGuide(page, run);
    await agent.pick(page);
    await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
    await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
      timeout: 600_000,
    });
    await expect(screen.getByRole("heading", "Overview")).toBeVisible();
    for (const path of FIXTURE_FILES)
      await expect(browser.locator("[data-guide-view]")).toContainText(path);
    const review = reviewRow(run.home);
    expect(review.provider).toBe(agent.name);
    const worktree = NodePath.join(run.home, "worktrees", review.id);
    const guideSession =
      agent.name === "claude"
        ? claudeSessionFile(worktree, review.session)
        : codexThreadFile(run.home, review.session);
    if (guideSession === undefined || !NodeFS.existsSync(guideSession))
      throw new Error(
        `The guide's ${agent.label} session file isn't where ${agent.label} keeps it.`,
      );
    const sessionBefore = sha256(guideSession);
    const sessions = [review.session];

    const dock = screen.getByRole("region", "Ask about this pull request");
    const history = dock.getByRole("region", "Your questions");
    const field = dock.getByRole("textbox", "Your question");
    const answered = async (text: string) => {
      await expect
        .poll(() => String(questionRow(run.home, text)?.state), {
          timeout: AGENT_WAIT,
          interval: 2_000,
        })
        .toMatch(/^(answered|failed|stopped)$/);
      const row = questionRow(run.home, text);
      expect({ state: row?.state, failure: row?.failure, message: row?.message }).toEqual({
        state: "answered",
        failure: null,
        message: null,
      });
      const card = history.getByRole("article", text);
      await expect(card).toContainText(agent.label);
      await expect(
        browser.locator(`article[aria-label="${text}"][data-question-state="answered"]`),
      ).toBeAttached();
      sessions.push(reviewRow(run.home).session);
      return card;
    };
    const ask = async (text: string) => {
      await field.fill(text);
      await field.press("Meta+Enter");
      return history.getByRole("article", text);
    };

    await field.tap();
    const whole = await ask(WHOLE);
    await expect
      .poll(
        async () => ({
          state: String(questionRow(run.home, WHOLE)?.state),
          text: await hasText(browser, WHOLE),
        }),
        { timeout: 180_000, interval: 250 },
      )
      .toEqual({ state: "answering", text: true });
    await keep(app, `${agent.name}-streaming`);
    await answered(WHOLE);
    await expect(whole).toContainText("From the session that wrote this guide");
    expect(questionRow(run.home, WHOLE)?.basis).toBe('{"_tag":"guide-session"}');
    await keep(app, `${agent.name}-answered`);

    const links = await whole.getByRole("link", /^[\w./-]+:\d+(-\d+)?$/).all();
    expect(links.length).toBeGreaterThan(0);
    let revealed: string | null = null;
    for (const link of links.slice(0, 5)) {
      const name = (await link.textContent())?.trim() ?? "";
      const [, path, line] = /^(.+):(\d+)(?:-\d+)?$/.exec(name) ?? [];
      await link.tap();
      for (let tries = 0; tries < 40 && revealed === null; tries += 1) {
        const seen = await revealedLine(browser);
        if (seen.path === path && seen.line === line && seen.shown) revealed = name;
        else await sleep(250);
      }
      if (revealed !== null) break;
    }
    note("links", { offered: links.length, revealed });
    expect(revealed).not.toBeNull();
    await keep(app, `${agent.name}-cited-line`);

    const askChapter = screen.getByRole("button", "Ask about this chapter").first();
    await askChapter.scrollIntoView();
    await askChapter.tap();
    await expect(dock.getByText(/^Chapter 1: /)).toBeVisible();
    await expect(field).toBeFocused();
    const chapter = await ask(CHAPTER);
    await answered(CHAPTER);
    await expect(chapter).toContainText("Continues your earlier question");
    await expect(chapter).toContainText("Chapter 1: ");

    await dock.getByRole("button", "Hide questions").tap();
    await expect(history).toHaveCount(0);
    await expect.poll(() => twoAddedLines(browser), { timeout: 30_000 }).not.toBeNull();
    const pair = await twoAddedLines(browser);
    if (pair === null) throw new Error("No chapter diff shows two added lines in a row.");
    const added = (line: number) =>
      browser
        .locator(
          `[data-path="${pair.path}"] [data-column-number="${line}"][data-line-type="change-addition"]`,
        )
        .first();
    await added(pair.start).scrollIntoView();
    await added(pair.start).dragTo(added(pair.start + 1));
    const comment = screen.getByRole(
      "textbox",
      `Comment on lines ${pair.start} to ${pair.start + 1}`,
    );
    await expect(comment).toBeVisible();
    await screen.getByRole("button", "Ask about these lines").tap();
    await expect(comment).toHaveCount(0);
    const linesChip = `${pair.path} ${pair.start}-${pair.start + 1}`;
    await expect(dock.getByText(linesChip)).toBeVisible();
    await expect(field).toBeFocused();
    const lines = await ask(LINES);
    await answered(LINES);
    await expect(lines).toContainText(linesChip);
    note("lines", linesChip);

    await dock.getByRole("button", "Ask about the whole PR instead").tap();
    const stopped = await ask(STOPPED);
    await expect
      .poll(() => hasText(browser, STOPPED), { timeout: 180_000, interval: 250 })
      .toBe(true);
    const pid = Number(questionRow(run.home, STOPPED)?.pid);
    expect(pid).toBeGreaterThan(0);
    await stopped.getByRole("button", "Stop").tap();
    await expect(
      browser.locator(`article[aria-label="${STOPPED}"][data-question-state="stopped"]`),
    ).toBeAttached({ timeout: 30_000 });
    await expect(stopped).toContainText("Stopped");
    expect(await hasText(browser, STOPPED)).toBe(true);
    expect(questionRow(run.home, STOPPED)?.answer).not.toBe("[]");
    await expect(stopped.getByRole("button", "Retry")).toBeVisible();
    await expect(field).toBeEnabled();
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    note("stopped", {
      pid,
      alive: alive(pid),
      state: String(questionRow(run.home, STOPPED)?.state),
    });
    await keep(app, `${agent.name}-stopped`);

    await ask(CONTAINED);
    await answered(CONTAINED);
    const checkouts = NodePath.join(run.home, "asks", "checkouts");
    await expect.poll(() => NodeFS.readdirSync(checkouts), { timeout: 15_000 }).toEqual([]);
    const containedId = String(questionRow(run.home, CONTAINED)?.id);
    const refusals = decisionsAfter(
      run.log,
      containedId,
      agent.refusal.log,
      agent.refusal.decision,
    );
    const sessionAfter = sha256(guideSession);
    const asked = questionRows(run.home);
    const contained = {
      madeInReviewWorktree: NodeFS.existsSync(NodePath.join(worktree, MADE)),
      refused: refusals.length > 0,
      sessionsChanged: sessions.some((session) => session !== review.session),
      guideSessionUnchanged: sessionBefore === sessionAfter,
      ownSessions: asked.map(
        (row) => typeof row.session === "string" && row.session !== review.session,
      ),
    };
    note("contained", contained);
    note("refusals", refusals);
    note("sessionSha", { before: sessionBefore, after: sessionAfter });
    note("sessions", { guide: review.session, questions: asked.map((row) => row.session ?? null) });
    note("containedAnswer", String(questionRow(run.home, CONTAINED)?.answer));
    expect(contained).toEqual({
      madeInReviewWorktree: false,
      refused: true,
      sessionsChanged: false,
      guideSessionUnchanged: true,
      ownSessions: [true, true, true, true, true],
    });

    await whole.getByRole("button", "Pin to overview").tap();
    await expect(whole.getByRole("button", "Unpin")).toBeVisible();
    const pin = screen.getByRole("complementary", `Pinned answer: ${WHOLE}`);
    await expect(pin).toContainText(`Pinned from Ask · ${agent.label} · r1`);
    expect(await pinPlace(browser)).toEqual({
      afterOverview: true,
      beforeChapters: true,
      inDiff: false,
    });
    expect(questionRow(run.home, WHOLE)?.pinnedAt).not.toBeNull();
    await browser.evaluate((text: string) => {
      [...document.querySelectorAll("article[data-question-state]")]
        .find((card) => card.getAttribute("aria-label") === text)
        ?.scrollIntoView({ block: "start" });
      return true;
    }, WHOLE);
    await keepLightAndDark(app, browser, `${agent.name}-answered-card`);
    await dock.getByRole("button", "Hide questions").tap();
    await browser.evaluate(() => {
      document.querySelector("[data-ask-pin]")?.scrollIntoView({ block: "start" });
      return true;
    });
    await keepLightAndDark(app, browser, `${agent.name}-pinned`);

    const statesBefore = Object.fromEntries(
      questionRows(run.home).map((row) => [row.text, row.state]),
    );
    await browser.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    });
    stopFakeInstance(instance, { keepHome: true });
    run = startInstance(instance, INSTANCE_ARGS);
    await openGuide(page, run);
    await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
      timeout: 60_000,
    });
    await expect(pin).toContainText(`Pinned from Ask · ${agent.label} · r1`, { timeout: 30_000 });
    await dock.getByRole("button", "Show questions").tap();
    for (const text of [WHOLE, CHAPTER, LINES, STOPPED, CONTAINED])
      await expect(history.getByRole("article", text)).toBeAttached();
    expect(await cardStates(browser)).toEqual(statesBefore);
    expect(statesBefore).toEqual({
      [WHOLE]: "answered",
      [CHAPTER]: "answered",
      [LINES]: "answered",
      [STOPPED]: "stopped",
      [CONTAINED]: "answered",
    });
    note("relaunched", statesBefore);
    await keep(app, `${agent.name}-relaunched`);
  } finally {
    NodeFS.mkdirSync(EVIDENCE, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(EVIDENCE, `${agent.name}-evidence.txt`),
      `${evidence.join("\n")}\n`,
    );
    stopFakeInstance(instance, { keepHome: false });
  }
};

describe("Ask with the user's Claude", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "questions about the whole PR, a chapter and lines answer from the guide's session, stop, stay read-only, pin, and come back after a relaunch",
    { timeout: 2_400_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      await journey({
        name: "claude",
        label: "Claude",
        pick: async () => {},
        refusal: { log: "canUseTool", decision: "deny" },
      })({ app, screen, browser });
    },
  );
});

describe("Ask with Codex", { tags: ["codex"], skip: NEEDS_FIXTURE }, () => {
  test(
    "questions about the whole PR, a chapter and lines answer from the guide's session, stop, stay read-only, pin, and come back after a relaunch",
    { timeout: 2_400_000 },
    async ({ app, screen, browser }) => {
      test.skip(!CODEX_RUNS, CODEX_SKIP);
      await journey({
        name: "codex",
        label: "Codex",
        pick: async (page) => {
          await page.screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
          await page.screen.getByRole("combobox", "Search models").fill("GPT");
          await page.screen.getByRole("option", /GPT/).first().tap();
          await expect(page.screen.getByRole("button", /^Agent and model: GPT/)).toBeVisible();
        },
        refusal: { log: "Codex approval", decision: "decline" },
      })({ app, screen, browser });
    },
  );
});
