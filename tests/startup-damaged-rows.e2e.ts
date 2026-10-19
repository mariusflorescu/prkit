import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { GenerateLocalGuideResult } from "../apps/server/src/outside/schemas.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

type Page = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const ACCOUNT = "?account=github.com%2Fbudget-test";
const pull = (url: string, number: number, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${number}${ACCOUNT}&tab=${tab}`;
const TITLE = "prkit couldn't read this guide's record";
const MESSAGE =
  "prkit couldn't read what this guide was doing, so it stopped it. Retry to write it again.";
const LOCAL_TAB = "Open the local review of widgets · feature/limits";
const FIRST = "What does this pull request change?";
const SECOND = "Which file should I read first?";

/** Writes one stored value while prkit is closed, the way a crash, an edit or a newer prkit might. */
const damage = (home: string, query: string, ...values: ReadonlyArray<SQLInputValue>) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    expect(db.prepare(query).run(...values).changes).toBe(1);
  } finally {
    db.close();
  }
};

const reviewOf = (home: string, key: string) =>
  readRows(home, `SELECT id, status FROM reviews WHERE pr_key = '${key}'`)[0];
const attemptsOf = (home: string, key: string) =>
  readRows(
    home,
    `SELECT a.id FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '${key}'`,
  ).length;

const generate = async ({ screen }: Page, number: number) => {
  await screen.getByRole("link", new RegExp(`#${number} `)).hover();
  await screen.getByRole("button", `Generate guide for budget/fixtures #${number}`).tap();
  await expect(
    screen.getByRole("link", new RegExp(`#${number} Budget fixture ${number} Guide ready`)),
  ).toBeVisible({ timeout: 120_000 });
};

const ask = async ({ screen }: Page, question: string) => {
  const dock = screen.getByRole("region", "Ask about this pull request");
  const field = dock.getByRole("textbox", "Your question");
  await field.tap();
  await field.fill(question);
  await field.press("Meta+Enter");
  await expect(dock.getByRole("article", question)).toContainText("Claude answered", {
    timeout: 60_000,
  });
};

/** Sends one comment on #9 to the fix agent; the PR merges first, so the turn ends at once. */
const sendFix = async ({ app, screen, browser }: Page, url: string, merge: () => Promise<void>) => {
  await app.open(pull(url, 9, "files"));
  const file = screen.getByRole("region", "src/limits.ts");
  await expect(file.getByRole("button", "Comment on line 1")).toBeVisible({ timeout: 30_000 });
  await file.getByRole("button", "Comment on line 1").focus();
  await browser.keyboard.press("ArrowDown");
  await browser.keyboard.press("Enter");
  await browser.keyboard.type("Name the limit.");
  await browser.keyboard.press("Meta+Enter");
  await screen.getByRole("button", "Review, 1 pending").first().tap();
  await screen
    .getByRole("group", "Where your comments go")
    .getByRole("button", "Send to agent")
    .tap();
  const send = screen.getByRole("dialog", "Send to agent");
  await expect(send.getByRole("button", /^Agent and model: /)).toBeVisible({ timeout: 30_000 });
  await merge();
  await send.getByRole("button", "Send 1 comment to agent").tap();
  await expect(screen.getByText("Sent to the agent")).toBeVisible({ timeout: 30_000 });
};

const failure = (screen: Page["screen"]) => screen.getByRole("alert").filter({ hasText: TITLE });

test(
  "one damaged row fails alone: prkit starts, the damaged reviews, question, fix and tab say so or step aside, and everything else works across a relaunch",
  { timeout: 720_000 },
  async ({ app, screen, browser }) => {
    const name = "startup-damaged-rows";
    const page = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    const launch = () => git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
    try {
      for (const number of [1, 4, 6, 9]) await fake.gitHead(number, git.head(number));
      let run = launch();
      await emulateOsColorScheme(browser, "light");
      await switchOn(page, run.openUrl);

      // A local review written from a terminal, guides for #4 and #6, two answered questions
      // on #6, a fix sent on #9, and a tab for #3.
      const fixture = localRepoFixture(root);
      fixture.write("docs/handbook.md", handbook({ 15: "Limits are set per team." }));
      const local = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      const localKey = decodeGenerate(
        local(fixture.repo, ["local", "guide", "--description", "Set limits per team", "--json"])
          .stdout,
      ).status.key;
      await expect
        .poll(() => String(reviewOf(run.home, localKey)?.status ?? ""), { timeout: 60_000 })
        .toContain('"watching"');
      await screen.getByRole("link", "Inbox").tap();
      await dismissToasts(browser);
      for (const number of [4, 6]) await generate(page, number);
      await app.open(pull(run.url, 6, "guide"));
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1", {
        timeout: 30_000,
      });
      await ask(page, FIRST);
      await ask(page, SECOND);
      await sendFix(page, run.url, () => fake.merge(9));
      await app.open(pull(run.url, 3, "conversation"));
      await expect(screen.getByRole("link", /#3 Budget fixture 3/).first()).toBeVisible({
        timeout: 30_000,
      });
      const tabsBefore = readRows(run.home, "SELECT key FROM open_pull_requests ORDER BY key");
      expect(tabsBefore).toEqual([{ key: keyOf(3) }, { key: keyOf(6) }, { key: keyOf(9) }]);

      // While prkit is closed, one row of each kind is damaged.
      stopFakeInstance(name, { keepHome: true });
      const turn = readRows(
        run.home,
        `SELECT t.id FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(9)}'`,
      );
      expect(turn).toHaveLength(1);
      const turnId = String(turn[0]?.id);
      const [first] = readRows(
        run.home,
        `SELECT q.id FROM ask_questions q WHERE q.text = '${FIRST}'`,
      );
      damage(run.home, "UPDATE reviews SET status = 'garbage' WHERE pr_key = ?", keyOf(4));
      damage(
        run.home,
        "UPDATE reviews SET status = ? WHERE pr_key = ?",
        '{"_tag":"reviewing","since":"2026-10-19T10:00:00.000Z"}',
        keyOf(6),
      );
      damage(run.home, "UPDATE reviews SET status = 'garbage' WHERE pr_key = ?", localKey);
      damage(run.home, "UPDATE fixer_turns SET status = 'garbage' WHERE id = ?", turnId);
      damage(
        run.home,
        "UPDATE ask_questions SET scope = 'not json' WHERE id = ?",
        String(first?.id),
      );
      damage(run.home, "UPDATE open_pull_requests SET position = 'first' WHERE key = ?", keyOf(3));
      const attemptsOf6 = attemptsOf(run.home, keyOf(6));

      // prkit starts, and the Inbox lists every pull request.
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 30_000,
      });

      // #4's state was not JSON: it says so with a Retry, which writes the guide again.
      await app.open(pull(run.url, 4, "guide"));
      await expect(failure(screen)).toContainText(MESSAGE, { timeout: 30_000 });
      await app.screenshot("damaged-review-light");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("damaged-review-dark");
      await setOsColorScheme(browser, "light");
      await browser.setViewport({ width: 600, height: 720 });
      await expect(failure(screen).getByRole("button", "Retry")).toBeVisible();
      await app.screenshot("damaged-review-narrow");
      await browser.setViewport({ width: 1280, height: 720 });

      // #6's state came from a newer prkit: its guide stays readable under the same notice,
      // and of its two questions the damaged one steps aside.
      await app.open(pull(run.url, 6, "guide"));
      await expect(failure(screen)).toContainText(MESSAGE, { timeout: 30_000 });
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1");
      const dock = screen.getByRole("region", "Ask about this pull request");
      await dock.getByRole("textbox", "Your question").tap();
      await expect(dock.getByRole("article", SECOND)).toContainText("Claude answered", {
        timeout: 30_000,
      });
      await expect(dock.getByRole("article", FIRST)).toHaveCount(0);
      await app.screenshot("damaged-review-with-guide");

      // The fix whose state can't be read is left as it was, and its tab says why.
      await app.open(pull(run.url, 9, "fixes"));
      await expect(screen.getByRole("alert")).toContainText(
        "prkit read a damaged fix record. Try again.",
        { timeout: 30_000 },
      );

      // The damaged tab steps aside; the others are still open.
      const tabs = screen.getByRole("navigation", "Workspace tabs");
      await expect(tabs.getByRole("link", /#6 /)).toBeVisible();
      await expect(tabs.getByRole("link", /#9 /)).toBeVisible();
      await expect(tabs.getByRole("link", /#3 /)).toHaveCount(0);

      // The local review says so too, and Retry writes that run's snapshot again.
      await screen.getByRole("link", LOCAL_TAB).tap();
      const localFailure = failure(screen);
      await expect(localFailure).toContainText(MESSAGE, { timeout: 30_000 });
      await app.screenshot("damaged-local-light");
      await localFailure.getByRole("button", "Retry").tap();
      await expect(screen.getByRole("status", "Guide status")).toContainText("Ready", {
        timeout: 60_000,
      });

      // Retry on #4 writes its guide again, and a guide for a pull request without one works.
      await app.open(pull(run.url, 4, "guide"));
      await failure(screen).getByRole("button", "Retry").tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2", {
        timeout: 120_000,
      });
      await screen.getByRole("link", "Inbox").tap();
      await generate(page, 1);

      // A relaunch: the damaged rows are kept as they were, #6 is still stopped, nothing
      // restarted it, and prkit starts again.
      stopFakeInstance(name, { keepHome: true });
      expect(String(reviewOf(run.home, keyOf(6))?.status)).toContain('"damaged"');
      expect(attemptsOf(run.home, keyOf(6))).toBe(attemptsOf6);
      expect(readRows(run.home, `SELECT status FROM fixer_turns WHERE id = '${turnId}'`)).toEqual([
        { status: '"garbage"' },
      ]);
      expect(
        readRows(run.home, `SELECT scope FROM ask_questions WHERE id = '${String(first?.id)}'`),
      ).toEqual([{ scope: "not json" }]);
      expect(
        readRows(run.home, `SELECT position FROM open_pull_requests WHERE key = '${keyOf(3)}'`),
      ).toEqual([{ position: "first" }]);
      const serverLog = NodeFS.readFileSync(run.log, "utf8");
      expect(serverLog).toContain("Stopped a review whose state prkit can't read");
      expect(serverLog).toContain("Left a fix turn whose state prkit can't read as it was");
      expect(serverLog).toContain("Left out a stored row prkit can't read");
      run = launch();
      await app.open(pull(run.url, 6, "guide"));
      await expect(failure(screen)).toContainText(MESSAGE, { timeout: 30_000 });
      await app.open(pull(run.url, 4, "guide"));
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2", {
        timeout: 30_000,
      });
      await expect(failure(screen)).toHaveCount(0);
      expect(attemptsOf(run.home, keyOf(6))).toBe(attemptsOf6);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
