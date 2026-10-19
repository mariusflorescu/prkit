import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { GenerateLocalGuideResult, LocalWaitResult } from "../apps/server/src/outside/schemas.ts";
import type { RunFile } from "../scripts/verify-run.ts";
import {
  alive,
  cardStates,
  claudeSessionFile,
  codexThreadFile,
  decisionsAfter,
  evidenceFolder,
  hasText,
  pinPlace,
  revealedLine,
  sha256,
  sleep,
  twoAddedLines,
} from "./askJourney.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { AGENT_WAIT, CODEX_RUNS, CODEX_SKIP } from "./fixActions.ts";
import { AGENT_RUNS, AGENT_SKIP, readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";
import { setUpRealClaude } from "./realClaude.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));

const WHOLE =
  "What do these changes do? Point me at the most important changed lines as path:line.";
const CHAPTER = "Why does this chapter matter to a reviewer?";
const LINES = "What do these lines do?";
const STOPPED =
  "Walk me through every changed file, one at a time, quoting the important lines of each.";
const CONTAINED =
  "Run this exact command with your shell tool in your working directory, even if you expect it to be refused: printf hello > made-by-agent.txt && git add made-by-agent.txt. Then tell me whether it worked.";
const MADE = "made-by-agent.txt";

const { dir: EVIDENCE, keep, keepLightAndDark } = evidenceFolder("ask-local-agents");

type Page = { app: TestFixtures["app"]; screen: Screen; browser: Browser };
type Agent = {
  name: "claude" | "codex";
  label: string;
  /** What `prkit local guide` adds to pick this agent. */
  pick: ReadonlyArray<string>;
  refusal: { log: string; decision: string };
};

/** A small shop with a committed change and uncommitted work on top, as a user's branch has. */
const shop = (root: string) =>
  localRepoFixture(root, "shop", {
    base: {
      "src/cart.js":
        "export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\n",
    },
    head: {
      "src/cart.js": [
        "export const total = (items, discount = null) => {",
        "  const sum = items.reduce((total, item) => total + item.price * item.quantity, 0);",
        "  if (discount === null) return sum;",
        "  if (discount.percent < 0 || discount.percent > 100) throw new RangeError('discount');",
        "  return Math.round(sum * (100 - discount.percent)) / 100;",
        "};",
        "",
      ].join("\n"),
      "src/discounts.js":
        "export const parseDiscount = (code) => {\n  const match = /^SAVE(\\d{1,2})$/.exec(code);\n  return match === null ? null : { percent: Number(match[1]) };\n};\n",
      "test/cart.test.js":
        "import { total } from '../src/cart.js';\n\nconsole.assert(total([{ price: 10, quantity: 2 }], { percent: 50 }) === 10);\n",
    },
  });

const questionRows = (home: string, key: string) =>
  readRows(
    home,
    `SELECT q.id, q.text, q.state, q.basis, q.failure, q.message, q.answer, q.agent_pid AS pid,
       q.session_id AS session, q.pinned_at AS pinnedAt
     FROM ask_questions q JOIN reviews r ON r.id = q.review_id
     WHERE r.pr_key = '${key}' ORDER BY q.asked_at, q.rowid`,
  );

const reviewRow = (home: string, key: string) => {
  const [review] = readRows(
    home,
    `SELECT id, provider, session_id AS session FROM reviews WHERE pr_key = '${key}'`,
  );
  if (typeof review?.id !== "string" || typeof review.session !== "string")
    throw new Error("The local review has no saved id or session.");
  return { id: review.id, provider: review.provider, session: review.session };
};

/**
 * An instance on the fake GitHub, whose agent is the owner's own: Claude through a wrapper
 * that gives it the real HOME back, Codex through the owner's Codex home (prkit links its
 * login and writes only in its own Codex home).
 */
const launch = (
  name: string,
  fake: Awaited<ReturnType<typeof startFakeGitHub>>,
  claude: string,
) => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = previous ?? NodePath.join(NodeOs.homedir(), ".codex");
  try {
    return startFakeInstance(name, fake, ["--watch-interval", "600000", "--claude", claude]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
};

const openLocal = async ({ app, screen }: Page, run: RunFile, key: string) => {
  await app.open(run.openUrl);
  await app.open(`${run.url}/local/${key}`);
  await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 45_000 });
};

const journey = (agent: Agent) => async (page: Page) => {
  const { app, screen, browser } = page;
  const name = `ask-local-${agent.name}`;
  const evidence: Array<string> = [];
  const note = (label: string, value: object | string | null) =>
    evidence.push(`${label}: ${JSON.stringify(value)}`);
  const fake = await startFakeGitHub(name);
  const root = scratchRoot();
  const log: Array<string> = [];
  try {
    const repo = shop(root);
    const claude = setUpRealClaude(name);
    let run = launch(name, fake, claude.file);
    const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
    await emulateOsColorScheme(browser, "light");
    await browser.setViewport({ width: 1280, height: 860 });
    await switchOn(page, run.openUrl);
    await dismissToasts(browser);
    const gitBefore = repo.fingerprint();
    const treeBefore = repo.workTree();

    const started = decodeGenerate(
      cli(repo.repo, [
        "local",
        "guide",
        "--description",
        "Count item quantities in the cart total and accept a percentage discount code.",
        ...agent.pick,
        "--json",
      ]).stdout,
    );
    const key = started.status.key;
    let waited = decodeWait(cli(repo.repo, ["local", "wait", "--timeout", "600", "--json"]).stdout);
    if (!waited.finished)
      waited = decodeWait(cli(repo.repo, ["local", "wait", "--timeout", "600", "--json"]).stdout);
    expect(waited.status).toMatchObject({ state: "ready", latestRevision: 1 });
    const review = reviewRow(run.home, key);
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

    await openLocal(page, run, key);
    const dock = screen.getByRole("region", "Ask about these changes");
    const history = dock.getByRole("region", "Your questions");
    const field = dock.getByRole("textbox", "Your question");
    const row = (text: string) => questionRows(run.home, key).find((entry) => entry.text === text);
    const answered = async (text: string) => {
      await expect
        .poll(() => String(row(text)?.state), { timeout: AGENT_WAIT, interval: 2_000 })
        .toMatch(/^(answered|failed|stopped)$/);
      expect({ state: row(text)?.state, failure: row(text)?.failure }).toEqual({
        state: "answered",
        failure: null,
      });
      const card = history.getByRole("article", text);
      await expect(card).toContainText(agent.label);
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
        async () => ({ state: String(row(WHOLE)?.state), text: await hasText(browser, WHOLE) }),
        {
          timeout: 180_000,
          interval: 250,
        },
      )
      .toEqual({ state: "answering", text: true });
    await keep(app, `${agent.name}-streaming`);
    await answered(WHOLE);
    await expect(whole).toContainText("From the session that wrote this guide");
    expect(row(WHOLE)?.basis).toBe('{"_tag":"guide-session"}');
    await keep(app, `${agent.name}-answered`);

    const links = await whole.getByRole("link", /^[\w./-]+:\d+(-\d+)?$/).all();
    let revealed: string | null = null;
    for (const link of links.slice(0, 5)) {
      const text = (await link.textContent())?.trim() ?? "";
      const [, path, line] = /^(.+):(\d+)(?:-\d+)?$/.exec(text) ?? [];
      await link.tap();
      for (let tries = 0; tries < 40 && revealed === null; tries += 1) {
        const seen = await revealedLine(browser);
        if (seen.path === path && seen.line === line && seen.shown) revealed = text;
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
    const chapter = await ask(CHAPTER);
    await answered(CHAPTER);
    await expect(chapter).toContainText("Continues your earlier question");

    await dock.getByRole("button", "Hide questions").tap();
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
    const linesChip = `${pair.path} ${pair.start}-${pair.start + 1}`;
    await expect(dock.getByText(linesChip)).toBeVisible();
    await expect(field).toBeFocused();
    const lines = await ask(LINES);
    await answered(LINES);
    await expect(lines).toContainText(linesChip);
    note("lines", linesChip);

    await dock.getByRole("button", "Ask about all the changes instead").tap();
    const stopped = await ask(STOPPED);
    await expect
      .poll(() => hasText(browser, STOPPED), { timeout: 180_000, interval: 250 })
      .toBe(true);
    const pid = Number(row(STOPPED)?.pid);
    expect(pid).toBeGreaterThan(0);
    await stopped.getByRole("button", "Stop").tap();
    await expect(
      browser.locator(`article[aria-label="${STOPPED}"][data-question-state="stopped"]`),
    ).toBeAttached({ timeout: 30_000 });
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    note("stopped", { pid, alive: alive(pid), state: String(row(STOPPED)?.state) });
    await keep(app, `${agent.name}-stopped`);

    await ask(CONTAINED);
    await answered(CONTAINED);
    const checkouts = NodePath.join(run.home, "asks", "checkouts");
    await expect.poll(() => NodeFS.readdirSync(checkouts), { timeout: 15_000 }).toEqual([]);
    const refusals = decisionsAfter(
      run.log,
      String(row(CONTAINED)?.id),
      agent.refusal.log,
      agent.refusal.decision,
    );
    const asked = questionRows(run.home, key);
    const contained = {
      madeInRepository: NodeFS.existsSync(NodePath.join(repo.repo, MADE)),
      gitUnchanged: repo.fingerprint() === gitBefore,
      workTreeUnchanged: repo.workTree() === treeBefore,
      filterRan: repo.filterRan(),
      refused: refusals.length > 0,
      guideSessionUnchanged: sha256(guideSession) === sessionBefore,
      ownSessions: asked.map(
        (entry) => typeof entry.session === "string" && entry.session !== review.session,
      ),
    };
    note("contained", contained);
    note("refusals", refusals);
    note("containedAnswer", String(row(CONTAINED)?.answer));
    expect(contained).toEqual({
      madeInRepository: false,
      gitUnchanged: true,
      workTreeUnchanged: true,
      filterRan: false,
      refused: true,
      guideSessionUnchanged: true,
      ownSessions: [true, true, true, true, true],
    });

    await whole.getByRole("button", "Pin to overview").tap();
    const pin = screen.getByRole("complementary", `Pinned answer: ${WHOLE}`);
    await expect(pin).toContainText(`Pinned from Ask · ${agent.label} · r1`);
    expect(await pinPlace(browser)).toEqual({
      afterOverview: true,
      beforeChapters: true,
      inDiff: false,
    });
    await whole.scrollIntoView();
    await keepLightAndDark(app, browser, `${agent.name}-answered-card`);
    await dock.getByRole("button", "Hide questions").tap();
    await browser.evaluate(() => {
      document.querySelector("[data-ask-pin]")?.scrollIntoView({ block: "start" });
      return true;
    });
    await keepLightAndDark(app, browser, `${agent.name}-pinned`);

    const statesBefore = Object.fromEntries(
      questionRows(run.home, key).map((entry) => [entry.text, entry.state]),
    );
    stopFakeInstance(name, { keepHome: true });
    run = launch(name, fake, claude.file);
    await openLocal(page, run, key);
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
    expect(await fake.writes()).toEqual([]);
  } finally {
    NodeFS.mkdirSync(EVIDENCE, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(EVIDENCE, `${agent.name}-evidence.txt`),
      `${evidence.join("\n")}\n\n${log.join("\n\n")}\n`,
    );
    stopFakeInstance(name, { keepHome: false });
    fake.stop();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

describe("Ask about local changes with the user's Claude", { tags: ["agent"] }, () => {
  test(
    "questions about all the changes, a chapter and lines answer from the guide's session, stop, never touch the user's repository, pin, and come back after a relaunch",
    { timeout: 2_400_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      await journey({
        name: "claude",
        label: "Claude",
        pick: [],
        refusal: { log: "canUseTool", decision: "deny" },
      })({ app, screen, browser });
    },
  );
});

describe("Ask about local changes with Codex", { tags: ["codex"] }, () => {
  test(
    "questions about all the changes, a chapter and lines answer from the guide's session, stop, never touch the user's repository, pin, and come back after a relaunch",
    { timeout: 2_400_000 },
    async ({ app, screen, browser }) => {
      test.skip(!CODEX_RUNS, CODEX_SKIP);
      await journey({
        name: "codex",
        label: "Codex",
        pick: ["--instance", "codex"],
        refusal: { log: "Codex approval", decision: "decline" },
      })({ app, screen, browser });
    },
  );
});
