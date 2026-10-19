import * as NodeChildProcess from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  MarkedFilesResult,
  ReviewedFilesResult,
} from "../apps/server/src/outside/paritySchemas.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const NAME = "reviewed-files";
const ACCOUNT = "github.com/budget-test";
const SECOND = "github.com/budget-second";
const KEY = "github.com/budget/fixtures#1";
const SUBJECT = `pull-request ${ACCOUNT} ${KEY}`;
const filesUrl = (base: string, account: string) =>
  `${base}/pr/github.com/budget/fixtures/1?account=${encodeURIComponent(account)}&tab=files`;

const marks = (home: string) =>
  readRows(
    home,
    `SELECT subject, path, reviewed, seq, decided_at FROM reviewed_files
     WHERE subject LIKE 'pull-request % ${KEY}' ORDER BY path, seq`,
  );

const tamper = (home: string, statement: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
};

test(
  "reviewed files fold, survive a push and a relaunch, follow the CLI live and stay with their account",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME, { secondAccount: true });
    try {
      for (let push = 0; push < 3; push++) await fake.push(1);
      let run = startFakeInstance(NAME, fake);
      const launcher = NodePath.join(run.home, "bin/prkit");
      const runCli = (args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync(launcher, args, {
          encoding: "utf8",
          env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
        });
      const cli = (args: ReadonlyArray<string>) => {
        const result = runCli(args);
        expect({ args, code: result.status, stderr: result.stderr }).toEqual({
          args,
          code: 0,
          stderr: "",
        });
        return result.stdout;
      };

      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(filesUrl(run.url, ACCOUNT));
      const count = browser.locator("nav[aria-label='Pull request tabs'] [data-reviewed-count]");
      const card = (path: string) => browser.locator(`[data-file-diff-card][data-path="${path}"]`);
      const box = (path: string) => screen.getByRole("checkbox", `Reviewed ${path}`);
      const changedMark = (path: string) =>
        screen.getByRole("region", path).getByText("Changed since you reviewed");
      await expect(count).toHaveText("0 / 4 reviewed", { timeout: 30_000 });
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(4);
      await app.screenshot("files-none-reviewed");

      await box("src/change-1.ts").tap();
      await expect(box("src/change-1.ts")).toHaveAttribute("aria-checked", "true");
      await expect(card("src/change-1.ts")).toHaveAttribute("data-open", "false");
      await expect(card("src/change-1.ts")).toHaveAttribute("data-reviewed", "reviewed");
      await expect(count).toHaveText("1 / 4 reviewed");

      const top = await browser.evaluate(
        () => document.querySelector("[data-file-diff-card]")?.getAttribute("data-path") ?? "",
      );
      expect(top).toBe("src/change-0.ts");
      await browser.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return document.activeElement === document.body;
      });
      await browser.keyboard.press("r");
      await expect(box(top)).toHaveAttribute("aria-checked", "true");
      await expect(card(top)).toHaveAttribute("data-open", "false");
      await expect(count).toHaveText("2 / 4 reviewed");
      await browser.keyboard.press("r");
      await expect(box("src/change-2.ts")).toHaveAttribute("aria-checked", "true");
      await expect(card("src/change-2.ts")).toHaveAttribute("data-open", "false");
      await expect(box(top)).toHaveAttribute("aria-checked", "true");
      await expect(count).toHaveText("3 / 4 reviewed");
      await screen.getByRole("button", "src/change-1.ts").tap();
      await expect(card("src/change-1.ts")).toHaveAttribute("data-open", "true");
      await expect(box("src/change-1.ts")).toHaveAttribute("aria-checked", "true");
      await expect(count).toHaveText("3 / 4 reviewed");
      await app.screenshot("files-three-reviewed");

      await fake.pushEdit(1, 0);
      await fake.pushShift(1, 2);
      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("button", "Refresh")
        .tap();
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(6, { timeout: 30_000 });
      await expect(box("src/change-0.ts")).toHaveAttribute("aria-checked", "false");
      await expect(card("src/change-0.ts")).toHaveAttribute("data-reviewed", "changed");
      await expect(changedMark("src/change-0.ts")).toBeVisible();
      await expect(card("src/change-0.ts")).toHaveAttribute("data-open", "true");
      await expect(card("src/change-2.ts")).toHaveAttribute("data-reviewed", "reviewed");
      await expect(card("src/change-2.ts")).toHaveAttribute("data-open", "false");
      await expect(card("src/change-1.ts")).toHaveAttribute("data-reviewed", "reviewed");
      for (const path of ["src/change-3.ts", "src/change-4.ts", "src/change-5.ts"])
        await expect(card(path)).toHaveAttribute("data-reviewed", "unreviewed");
      await expect(count).toHaveText("2 / 6 reviewed");
      await expect(count).toHaveAttribute("title", "1 changed since you reviewed");
      await screenshotLightAndDark(app, browser, "files-reviewed-changed-unreviewed");
      await browser.setViewport({ width: 900, height: 860 });
      const row = await browser.evaluate(() => {
        const nav = document.querySelector("nav[aria-label='Pull request tabs']");
        const header = document.querySelector(
          "[data-path='src/change-0.ts'] [data-file-diff-header]",
        );
        return {
          navScrolls: nav === null ? null : nav.scrollWidth > nav.clientWidth,
          headerOverflows: header === null ? null : header.scrollWidth > header.clientWidth,
          headerHeight: header?.getBoundingClientRect().height ?? 0,
          toggleInside:
            header?.querySelector("[data-reviewed-toggle]")?.getBoundingClientRect().right ??
            Infinity,
          headerRight: header?.getBoundingClientRect().right ?? 0,
        };
      });
      expect(row).toMatchObject({ navScrolls: false, headerOverflows: false });
      expect(row.toggleInside).toBeLessThanOrEqual(row.headerRight);
      await app.screenshot("files-narrow-900");
      await browser.setViewport({ width: 1280, height: 860 });

      await box("src/change-2.ts").tap();
      await expect(box("src/change-2.ts")).toHaveAttribute("aria-checked", "false");
      await expect(card("src/change-2.ts")).toHaveAttribute("data-open", "true");
      await expect(card("src/change-2.ts")).toHaveAttribute("data-reviewed", "unreviewed");
      await expect(
        screen.getByRole("region", "src/change-2.ts").getByText("Changed since you reviewed"),
      ).toHaveCount(0);
      await expect(count).toHaveText("1 / 6 reviewed");

      const expectRelaunched = async () => {
        await expect(count).toHaveText("1 / 6 reviewed", { timeout: 30_000 });
        await expect(card("src/change-0.ts")).toHaveAttribute("data-reviewed", "changed");
        await expect(card("src/change-0.ts")).toHaveAttribute("data-open", "true");
        await expect(card("src/change-1.ts")).toHaveAttribute("data-reviewed", "reviewed");
        await expect(card("src/change-1.ts")).toHaveAttribute("data-open", "false");
        await expect(card("src/change-2.ts")).toHaveAttribute("data-reviewed", "unreviewed");
      };
      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      expect(marks(run.home)).toEqual([
        expect.objectContaining({ subject: SUBJECT, path: "src/change-0.ts", reviewed: 1 }),
        expect.objectContaining({ subject: SUBJECT, path: "src/change-1.ts", reviewed: 1 }),
        expect.objectContaining({ subject: SUBJECT, path: "src/change-2.ts", reviewed: 1 }),
        expect.objectContaining({ subject: SUBJECT, path: "src/change-2.ts", reviewed: 0 }),
      ]);
      run = startFakeInstance(NAME, fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("heading", "Budget fixture 1")).toBeVisible({
        timeout: 30_000,
      });
      await app.open(filesUrl(run.url, ACCOUNT));
      await expectRelaunched();
      await app.screenshot("files-after-relaunch");

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      await browser.locator(`a[data-open-pr="${KEY}"]`).tap();
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
      await expect(count).toHaveText("1 / 6 reviewed");
      await expect(card("src/change-3.ts")).toHaveAttribute("data-open", "true");
      const before = marks(run.home).length;
      const readReport = (account: string) =>
        Schema.decodeSync(Schema.fromJsonString(ReviewedFilesResult))(
          cli(["pr", "reviewed", "budget/fixtures#1", "--account", account, "--json"]),
        );
      const { headSha } = readReport(ACCOUNT);
      const decode = Schema.decodeSync(Schema.fromJsonString(MarkedFilesResult));
      const marked = decode(
        cli([
          "pr",
          "reviewed",
          "set",
          "budget/fixtures#1",
          "--head-sha",
          headSha,
          "--paths",
          "src/change-3.ts",
          "--account",
          ACCOUNT,
          "--json",
        ]),
      );
      expect(marked.files).toEqual([
        { path: "src/change-3.ts", previousPath: null, state: "reviewed" },
      ]);
      expect(marked.progress).toEqual({ reviewed: 2, changed: 1, total: 6 });
      expect(marked).toMatchObject({ headSha, changedFiles: 6, githubTruncated: false });
      await expect(box("src/change-3.ts")).toHaveAttribute("aria-checked", "true");
      await expect(count).toHaveText("2 / 6 reviewed");
      await expect(card("src/change-3.ts")).toHaveAttribute("data-open", "true");
      await app.screenshot("files-marked-by-cli");
      const once = marks(run.home);
      expect(once.length).toBe(before + 1);
      const again = decode(
        cli([
          "pr",
          "reviewed",
          "set",
          "budget/fixtures#1",
          "--head-sha",
          headSha,
          "--paths",
          "src/change-3.ts",
          "--account",
          ACCOUNT,
          "--json",
        ]),
      );
      expect(again).toEqual(marked);
      expect(marks(run.home)).toEqual(once);

      const report = readReport(ACCOUNT);
      expect(Object.fromEntries(report.items.map((file) => [file.path, file.state]))).toEqual({
        "src/change-0.ts": "changed",
        "src/change-1.ts": "reviewed",
        "src/change-2.ts": "unreviewed",
        "src/change-3.ts": "reviewed",
        "src/change-4.ts": "unreviewed",
        "src/change-5.ts": "unreviewed",
      });
      expect(report.progress).toEqual({ reviewed: 2, changed: 1, total: 6 });
      expect(report.revision).toBe(null);
      expect(report).toMatchObject({ headSha, changedFiles: 6, githubTruncated: false });

      cli([
        "pr",
        "reviewed",
        "set",
        "budget/fixtures#1",
        "--head-sha",
        headSha,
        "--paths",
        "src/change-3.ts",
        "--no-reviewed",
        "--account",
        ACCOUNT,
        "--json",
      ]);
      await expect(box("src/change-3.ts")).toHaveAttribute("aria-checked", "false");
      await expect(count).toHaveText("1 / 6 reviewed");

      const secondReport = readReport(SECOND);
      expect(secondReport.progress).toEqual({ reviewed: 0, changed: 0, total: 6 });
      await screen.getByRole("button", "Close budget/fixtures #1").tap();
      await app.open(filesUrl(run.url, SECOND));
      await expect(browser.locator("[data-reading-account]")).toHaveText(SECOND, {
        timeout: 30_000,
      });
      await expect(count).toHaveText("0 / 6 reviewed", { timeout: 30_000 });
      await expect(
        browser.locator(
          "[data-file-diff-card][data-reviewed='reviewed'], [data-file-diff-card][data-reviewed='changed']",
        ),
      ).toHaveCount(0);
      await app.screenshot("files-second-account");
      expect(marks(run.home).every((row) => row.subject === SUBJECT)).toBe(true);
      await screen.getByRole("button", "Close budget/fixtures #1").tap();

      await app.open(filesUrl(run.url, ACCOUNT));
      await expect(count).toHaveText("1 / 6 reviewed", { timeout: 30_000 });
      tamper(
        run.home,
        "CREATE TRIGGER refuse_marks BEFORE INSERT ON reviewed_files BEGIN SELECT RAISE(ABORT, 'refused'); END;",
      );
      await box("src/change-4.ts").tap();
      await expect(screen.getByText("Couldn't save reviewed files")).toBeVisible();
      await expect(
        screen.getByText("prkit couldn't save your reviewed files. Try again."),
      ).toBeVisible();
      await expect(box("src/change-4.ts")).toHaveAttribute("aria-checked", "false");
      await expect(card("src/change-4.ts")).toHaveAttribute("data-open", "true");
      await expect(count).toHaveText("1 / 6 reviewed");
      await app.screenshot("files-save-refused");
      tamper(run.home, "DROP TRIGGER refuse_marks;");
      await box("src/change-4.ts").tap();
      await expect(box("src/change-4.ts")).toHaveAttribute("aria-checked", "true");
      await expect(count).toHaveText("2 / 6 reviewed");

      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      tamper(run.home, "ALTER TABLE reviewed_files RENAME TO reviewed_files_away;");
      run = startFakeInstance(NAME, fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("heading", "Budget fixture 1")).toBeVisible({
        timeout: 30_000,
      });
      await app.open(filesUrl(run.url, ACCOUNT));
      await expect(count).toHaveText(/^Reviewed files unavailable/, { timeout: 30_000 });
      await expect(count).toHaveAttribute("title", "prkit couldn't read your reviewed files.");
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(6);
      await expect(screen.getByRole("checkbox", /^Reviewed /)).toHaveCount(0);
      await app.screenshot("files-read-failed");
      tamper(run.home, "ALTER TABLE reviewed_files_away RENAME TO reviewed_files;");
      await screen.getByRole("navigation", "Pull request tabs").getByRole("button", "Retry").tap();
      await expect(count).toHaveText("2 / 6 reviewed", { timeout: 30_000 });
      await expect(box("src/change-4.ts")).toHaveAttribute("aria-checked", "true");

      const stale = readReport(ACCOUNT).headSha;
      await fake.push(1);
      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("button", "Refresh")
        .tap();
      await expect(browser.locator("[data-file-diff-card]")).toHaveCount(7, { timeout: 30_000 });
      expect(readReport(ACCOUNT).headSha).not.toBe(stale);
      const rows = marks(run.home);
      const refused = runCli([
        "pr",
        "reviewed",
        "set",
        "budget/fixtures#1",
        "--head-sha",
        stale,
        "--paths",
        "src/change-5.ts",
        "--account",
        ACCOUNT,
        "--json",
      ]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        "The pull request moved since you read it. Read it again with read_reviewed_files.",
      );
      expect(marks(run.home)).toEqual(rows);
      await expect(box("src/change-5.ts")).toHaveAttribute("aria-checked", "false");

      expect(await fake.writes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
