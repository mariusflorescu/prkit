import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  MarkedFilesResult,
  ReviewedFilesResult,
} from "../apps/server/src/outside/paritySchemas.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { repoRoot } from "../scripts/verify-run.ts";

const NAME = "reading-state";
const ACCOUNT = "github.com/budget-test";
const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const subjectOf = (number: number) => `pull-request ${ACCOUNT} ${keyOf(number)}`;
const prUrl = (base: string, number: number, tab: string) =>
  `${base}/pr/github.com/budget/fixtures/${number}?account=${encodeURIComponent(ACCOUNT)}&tab=${tab}`;

const QUESTION = "Why is every change in one chapter?";
const SHORTEN = {
  action: "Shorten `https://example.com`, then open the short link.",
  expect: "It redirects to example.com.",
  watchFor: "A redirect loop on the short link.",
  chapter: 1,
};
const STATS = {
  action: "Open `/stats/<code>` for that link.",
  expect: "It shows `1`.",
  chapter: 1,
};

const marks = (home: string) => ({
  files: readRows(
    home,
    "SELECT subject, path, reviewed FROM reviewed_files ORDER BY subject, path",
  ),
  steps: readRows(home, "SELECT subject, ticked FROM manual_check_ticks ORDER BY subject, step"),
});

const kept = (home: string) =>
  readRows(
    home,
    `SELECT
       (SELECT count(*) FROM review_revisions) AS revisions,
       (SELECT count(*) FROM ask_questions) AS questions,
       (SELECT count(*) FROM ask_questions WHERE pinned_at IS NOT NULL) AS pins,
       (SELECT count(*) FROM reviews) AS reviews`,
  );

const reviewOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT json_extract(status, '$._tag') AS state, json_extract(status, '$.reason') AS reason
     FROM reviews WHERE pr_key = '${keyOf(number)}'`,
  );

const forgotten = (log: string) =>
  NodeFS.readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes("Forgot what was read"));

test(
  "what you read on a pull request stays until GitHub says it is merged or closed and no tab shows it",
  { timeout: 600_000 },
  async ({ app, screen, browser }) => {
    NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${NAME}.log`), { force: true });
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    const launch = () =>
      git.start(() => {
        const previous = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = NodePath.join(fake.home, ".claude");
        try {
          return startFakeInstance(NAME, fake, [
            "--claude",
            claude.file,
            "--e2e",
            "--watch-interval",
            "2000",
          ]);
        } finally {
          if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = previous;
        }
      });
    try {
      await fake.gitHead(9, git.head(9));
      claude.manualCheck({ steps: [SHORTEN, STATS] });
      let run = launch();
      const tabs = screen.getByRole("navigation", "Workspace tabs");
      const closeTab = (number: number) =>
        tabs.getByRole("button", `Close budget/fixtures #${number}`).tap();
      const relaunch = async () => {
        await browser.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
          return true;
        });
        stopFakeInstance(NAME, { keepHome: true });
        run = launch();
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      };

      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });

      await app.open(prUrl(run.url, 9, "guide"));
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });
      await screen.getByRole("checkbox", "Reviewed src/limits.ts").tap();
      const plan = screen.getByRole("region", "How to check it");
      const progress = browser.locator("[data-guide-manual-check] [data-manual-check-progress]");
      await plan.getByRole("checkbox", "Checked step 1").tap();
      await expect(progress).toHaveText("1 of 2 checked");
      const askChapter = screen.getByRole("button", "Ask about this chapter");
      await askChapter.scrollIntoView();
      await askChapter.tap();
      const dock = screen.getByRole("region", "Ask about this pull request");
      const field = dock.getByRole("textbox", "Your question");
      await field.fill(QUESTION);
      await field.press("Meta+Enter");
      const asked = dock.getByRole("region", "Your questions").getByRole("article", QUESTION);
      await expect(asked).toContainText("Claude answered", { timeout: 60_000 });
      await asked.getByRole("button", "Pin to chapter").tap();
      await expect(asked.getByRole("button", "Unpin")).toBeVisible();

      for (const number of [1, 2, 3]) {
        await app.open(prUrl(run.url, number, "files"));
        const box = screen.getByRole("checkbox", "Reviewed src/change-0.ts");
        await box.tap({ timeout: 30_000 });
        await expect(box).toHaveAttribute("aria-checked", "true");
      }
      await closeTab(3);
      await closeTab(2);
      await closeTab(9);
      await expect(tabs.getByRole("link", /^Open budget\/fixtures #(2|3|9)/)).toHaveCount(0);

      const everything = {
        files: [
          { subject: subjectOf(1), path: "src/change-0.ts", reviewed: 1 },
          { subject: subjectOf(2), path: "src/change-0.ts", reviewed: 1 },
          { subject: subjectOf(3), path: "src/change-0.ts", reviewed: 1 },
          { subject: subjectOf(9), path: "src/limits.ts", reviewed: 1 },
        ],
        steps: [{ subject: subjectOf(9), ticked: 1 }],
      };
      expect(marks(run.home)).toEqual(everything);
      const guideKept = kept(run.home);
      expect(guideKept).toEqual([{ revisions: 1, questions: 1, pins: 1, reviews: 1 }]);
      expect(reviewOf(run.home, 9)).toEqual([{ state: "watching", reason: null }]);

      // PR 1's tab is read every tick, so by the time PR 9's marks go it was read closed.
      await fake.close(1);
      await fake.merge(9);
      await expect
        .poll(() => marks(run.home), { timeout: 30_000, interval: 500 })
        .toEqual({
          files: everything.files.filter((row) => row.subject !== subjectOf(9)),
          steps: [],
        });
      expect(reviewOf(run.home, 9)).toEqual([{ state: "done", reason: "merged" }]);
      expect(kept(run.home)).toEqual(guideKept);
      await app.open(prUrl(run.url, 1, "files"));
      await expect(screen.getByText("Closed", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(screen.getByRole("checkbox", "Reviewed src/change-0.ts")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(forgotten(run.log)).toHaveLength(1);

      await fake.merge(2);
      await relaunch();
      await expect
        .poll(() => marks(run.home), { timeout: 30_000, interval: 500 })
        .toEqual({
          files: [
            { subject: subjectOf(1), path: "src/change-0.ts", reviewed: 1 },
            { subject: subjectOf(3), path: "src/change-0.ts", reviewed: 1 },
          ],
          steps: [],
        });
      expect(kept(run.home)).toEqual(guideKept);

      await app.open(prUrl(run.url, 9, "guide"));
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("complementary", `Pinned answer: ${QUESTION}`)).toBeVisible();
      await expect(progress).toHaveText("0 of 2 checked");
      await expect(
        browser.locator("nav[aria-label='Pull request tabs'] [data-reviewed-count]"),
      ).toHaveText("0 / 2 reviewed");
      await expect(screen.getByRole("checkbox", "Reviewed src/limits.ts")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await app.screenshot("merged-guide-after-forgetting");
      await closeTab(9);

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      const cli = (args: ReadonlyArray<string>) => {
        const result = NodeChildProcess.spawnSync(
          NodePath.join(run.home, "bin/prkit"),
          [...args, "--account", ACCOUNT, "--json"],
          {
            encoding: "utf8",
            env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
          },
        );
        expect({ args, code: result.status, stderr: result.stderr }).toEqual({
          args,
          code: 0,
          stderr: "",
        });
        return result.stdout;
      };
      await fake.merge(4);
      const { headSha } = Schema.decodeSync(Schema.fromJsonString(ReviewedFilesResult))(
        cli(["pr", "reviewed", "budget/fixtures#4"]),
      );
      const marked = Schema.decodeSync(Schema.fromJsonString(MarkedFilesResult))(
        cli([
          "pr",
          "reviewed",
          "set",
          "budget/fixtures#4",
          "--head-sha",
          headSha,
          "--paths",
          "src/change-0.ts",
        ]),
      );
      expect(marked.files).toEqual([
        { path: "src/change-0.ts", previousPath: null, state: "reviewed" },
      ]);
      await expect
        .poll(() => marks(run.home), { timeout: 30_000, interval: 500 })
        .toEqual({
          files: [
            { subject: subjectOf(1), path: "src/change-0.ts", reviewed: 1 },
            { subject: subjectOf(3), path: "src/change-0.ts", reviewed: 1 },
          ],
          steps: [],
        });
      expect(forgotten(run.log)).toHaveLength(3);

      await closeTab(1);
      await relaunch();
      await expect
        .poll(() => marks(run.home), { timeout: 30_000, interval: 500 })
        .toEqual({
          files: [{ subject: subjectOf(3), path: "src/change-0.ts", reviewed: 1 }],
          steps: [],
        });
      expect(kept(run.home)).toEqual(guideKept);
      expect(forgotten(run.log)).toHaveLength(4);
      for (const line of forgotten(run.log)) expect(line).toMatch(/pullRequests\W+1\b/);

      const fingerprints = async () => (await fake.stats()).byKind["graphql:fingerprint"] ?? 0;
      const before = await fingerprints();
      stopFakeInstance(NAME, { keepHome: true });
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await expect.poll(fingerprints, { timeout: 30_000 }).toBeGreaterThan(before);
      // The pass that sent that read settles after it, so wait out two more ticks.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(marks(run.home)).toEqual({
        files: [{ subject: subjectOf(3), path: "src/change-0.ts", reviewed: 1 }],
        steps: [],
      });
      expect(kept(run.home)).toEqual(guideKept);
      expect(forgotten(run.log)).toHaveLength(4);

      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "what you read on a pull request GitHub no longer shows its account goes once that lasts a month, and a removed account's too",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "reading-state-lost";
    NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });
    const fake = await startFakeGitHub(name);
    const launch = () => startFakeInstance(name, fake, ["--e2e", "--watch-interval", "2000"]);
    const GONE = "pull-request github.com/gone-account github.com/budget/fixtures#7";
    const write = (home: string, statement: string) => {
      const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
      try {
        db.exec(statement);
      } finally {
        db.close();
      }
    };
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const files = (home: string) =>
      readRows(home, "SELECT subject FROM reviewed_files ORDER BY subject").map(
        (row) => row.subject,
      );
    const lost = (home: string) =>
      readRows(home, "SELECT subject FROM lost_pull_requests ORDER BY subject").map(
        (row) => row.subject,
      );
    try {
      let run = launch();
      await browser.setViewport({ width: 1280, height: 900 });
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      const tabs = screen.getByRole("navigation", "Workspace tabs");
      for (const number of [5, 6, 7]) {
        await app.open(prUrl(run.url, number, "files"));
        const box = screen.getByRole("checkbox", "Reviewed src/change-0.ts");
        await box.tap({ timeout: 30_000 });
        await expect(box).toHaveAttribute("aria-checked", "true");
        await tabs.getByRole("button", `Close budget/fixtures #${number}`).tap();
      }
      await expect(tabs.getByRole("link", /^Open budget\/fixtures #(5|6|7)/)).toHaveCount(0);
      expect(files(run.home)).toEqual([subjectOf(5), subjectOf(6), subjectOf(7)]);

      stopFakeInstance(name, { keepHome: true });
      write(
        run.home,
        `UPDATE reviewed_files SET subject = '${GONE}' WHERE subject = '${subjectOf(7)}'`,
      );
      await fake.lose(5);
      run = launch();
      await expect
        .poll(() => lost(run.home), { timeout: 30_000, interval: 500 })
        .toEqual([subjectOf(5), GONE]);
      const noted = readRows(run.home, "SELECT since FROM lost_pull_requests").map((row) =>
        Date.parse(String(row.since)),
      );
      for (const since of noted) expect(Date.now() - since).toBeLessThan(5 * 60_000);
      expect(files(run.home)).toEqual([subjectOf(5), subjectOf(6), GONE]);

      stopFakeInstance(name, { keepHome: true });
      write(
        run.home,
        `UPDATE lost_pull_requests SET since = '${daysAgo(31)}' WHERE subject = '${subjectOf(5)}';
         UPDATE lost_pull_requests SET since = '${daysAgo(29)}' WHERE subject = '${GONE}';
         INSERT INTO lost_pull_requests (subject, since) VALUES ('${subjectOf(6)}', '${daysAgo(31)}');`,
      );
      const emptied = async () => (await fake.stats()).byKind["graphql:fingerprint:failed"] ?? 0;
      const before = await emptied();
      await fake.fail("graphql:fingerprint", 1, 200);
      run = launch();
      await expect.poll(emptied, { timeout: 30_000 }).toBeGreaterThan(before);
      // The pass that sent that read settles after it, so wait out two more ticks.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(files(run.home)).toEqual([subjectOf(5), subjectOf(6), GONE]);
      expect(lost(run.home)).toEqual([subjectOf(5), subjectOf(6), GONE]);

      stopFakeInstance(name, { keepHome: true });
      run = launch();
      await expect
        .poll(() => files(run.home), { timeout: 30_000, interval: 500 })
        .toEqual([subjectOf(6), GONE]);
      await expect.poll(() => lost(run.home), { timeout: 30_000, interval: 500 }).toEqual([GONE]);
      expect(forgotten(run.log)).toHaveLength(1);

      stopFakeInstance(name, { keepHome: true });
      write(
        run.home,
        `UPDATE lost_pull_requests SET since = '${daysAgo(31)}' WHERE subject = '${GONE}'`,
      );
      run = launch();
      await expect
        .poll(() => files(run.home), { timeout: 30_000, interval: 500 })
        .toEqual([subjectOf(6)]);
      await expect.poll(() => lost(run.home), { timeout: 30_000, interval: 500 }).toEqual([]);
      expect(forgotten(run.log)).toHaveLength(2);
      expect(await fake.writes()).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
