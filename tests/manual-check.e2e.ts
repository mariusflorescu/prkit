import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { TickManualCheckResult } from "../apps/server/src/outside/paritySchemas.ts";
import { GuideResult } from "../apps/server/src/outside/schemas.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NAME = "manual-check";
const ACCOUNT = "github.com/budget-test";
const KEY = "github.com/budget/fixtures#9";
const SUBJECT = `pull-request ${ACCOUNT} ${KEY}`;
const guideUrl = (base: string) =>
  `${base}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent(ACCOUNT)}&tab=guide`;

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
const UNSAFE = {
  action: "Shorten `javascript:alert(1)`.",
  expect: "A 400, and no new link.",
};

const ticks = (home: string) =>
  readRows(
    home,
    `SELECT subject, ticked FROM manual_check_ticks WHERE subject = '${SUBJECT}' ORDER BY seq, step`,
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
  "manual check ticks survive a relaunch, follow unchanged steps into a new revision and the CLI, and show their errors",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    const start = () => git.start(() => startFakeInstance(NAME, fake, ["--claude", claude.file]));
    try {
      claude.manualCheck({ setup: "Run `npm start`.", steps: [SHORTEN, STATS] });
      let run = start();
      const runCli = (args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync(NodePath.join(run.home, "bin/prkit"), args, {
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
      const tickByCli = (steps: ReadonlyArray<string>, extra: ReadonlyArray<string> = []) =>
        Schema.decodeSync(Schema.fromJsonString(TickManualCheckResult))(
          cli([
            "guide",
            "tick",
            "budget/fixtures#9",
            "--revision",
            "1",
            ...steps.flatMap((step) => ["--steps", step]),
            ...extra,
            "--account",
            ACCOUNT,
            "--json",
          ]),
        );

      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(guideUrl(run.url));
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });

      const plan = screen.getByRole("region", "How to check it");
      const progress = browser.locator("[data-guide-manual-check] [data-manual-check-progress]");
      const box = (step: number) => plan.getByRole("checkbox", `Checked step ${step}`);
      const rows = browser.locator("[data-guide-manual-check] [data-manual-check-step]");
      await expect(progress).toHaveText("0 of 2 checked");
      await expect(
        plan.getByText("The agent's suggestion from reading the code. It didn't run anything."),
      ).toBeVisible();
      await expect(plan.getByText("Watch for")).toHaveCount(1);
      await expect(box(1)).toHaveAttribute("aria-checked", "false");
      await plan.scrollIntoView();
      await screenshotLightAndDark(app, browser, "manual-check-unticked");

      await box(1).tap();
      await expect(box(1)).toHaveAttribute("aria-checked", "true");
      await expect(rows.nth(0)).toHaveAttribute("data-ticked", "true");
      await expect(progress).toHaveText("1 of 2 checked");
      expect(ticks(run.home)).toEqual([{ subject: SUBJECT, ticked: 1 }]);

      await plan.getByRole("button", "Open chapter 1: Every change").first().tap();
      await expect
        .poll(() =>
          browser.evaluate(() =>
            document.activeElement instanceof HTMLElement
              ? (document.activeElement.dataset.chapterId ?? null)
              : null,
          ),
        )
        .toBe("every-change");

      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      run = start();
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      await expect(progress).toHaveText("1 of 2 checked", { timeout: 30_000 });
      await expect(box(1)).toHaveAttribute("aria-checked", "true");
      await expect(box(2)).toHaveAttribute("aria-checked", "false");
      await plan.scrollIntoView();
      await app.screenshot("manual-check-after-relaunch");

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      await app.open(guideUrl(run.url));
      await expect(progress).toHaveText("1 of 2 checked", { timeout: 30_000 });
      const read = Schema.decodeSync(Schema.fromJsonString(GuideResult))(
        cli(["guide", "read", "budget/fixtures#9", "--account", ACCOUNT, "--json"]),
      );
      expect(read.guide?.manualCheckTicked).toEqual([1]);
      expect(read.guide?.content.manualCheck).toMatchObject({
        _tag: "steps",
        setup: "Run `npm start`.",
        steps: [{ action: SHORTEN.action }, { action: STATS.action }],
      });
      expect(tickByCli(["2"])).toEqual({ revision: 1, manualCheckTicked: [1, 2] });
      await expect(progress).toHaveText("All 2 checked");
      await expect(box(2)).toHaveAttribute("aria-checked", "true");
      const once = ticks(run.home);
      expect(tickByCli(["2"])).toEqual({ revision: 1, manualCheckTicked: [1, 2] });
      expect(ticks(run.home)).toEqual(once);
      expect(tickByCli(["2"], ["--no-ticked"])).toEqual({ revision: 1, manualCheckTicked: [1] });
      await expect(progress).toHaveText("1 of 2 checked");
      const missing = runCli([
        "guide",
        "tick",
        "budget/fixtures#9",
        "--revision",
        "1",
        "--steps",
        "5",
        "--account",
        ACCOUNT,
        "--json",
      ]);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("Revision 1 has steps 1-2, not 5.");
      await box(2).tap();
      await expect(progress).toHaveText("All 2 checked");

      claude.manualCheck({
        steps: [
          {
            action: SHORTEN.action,
            expect: SHORTEN.expect,
            watchFor: "The short link page showing instead.",
          },
          { ...STATS, expect: "It shows `1` click." },
          UNSAFE,
        ],
      });
      await screen.getByRole("button", "Generate again").tap();
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r2 · ", { timeout: 90_000 });
      await expect(progress).toHaveText("1 of 3 checked");
      await expect(box(1)).toHaveAttribute("aria-checked", "true");
      await expect(box(2)).toHaveAttribute("aria-checked", "false");
      await expect(box(3)).toHaveAttribute("aria-checked", "false");
      await plan.scrollIntoView();
      await screenshotLightAndDark(app, browser, "manual-check-r2-kept");

      await revision.tap();
      await screen.getByRole("option", /^r1 · /).tap();
      await expect(progress).toHaveText("All 2 checked", { timeout: 30_000 });
      await revision.tap();
      await screen.getByRole("option", /^r2 · /).tap();
      await expect(progress).toHaveText("1 of 3 checked", { timeout: 30_000 });

      tamper(
        run.home,
        "CREATE TRIGGER refuse_ticks BEFORE INSERT ON manual_check_ticks BEGIN SELECT RAISE(ABORT, 'refused'); END;",
      );
      await box(3).tap();
      await expect(screen.getByText("Couldn't save your tick")).toBeVisible();
      await expect(screen.getByText("prkit couldn't save your tick. Try again.")).toBeVisible();
      await expect(box(3)).toHaveAttribute("aria-checked", "false");
      await expect(progress).toHaveText("1 of 3 checked");
      await app.screenshot("manual-check-save-refused");
      tamper(run.home, "DROP TRIGGER refuse_ticks;");

      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      tamper(run.home, "ALTER TABLE manual_check_ticks RENAME TO manual_check_ticks_away;");
      run = start();
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      const unavailable = plan.getByRole("status");
      await expect(unavailable).toHaveText(/^Your ticks didn't load/, { timeout: 30_000 });
      await expect(unavailable).toHaveAttribute(
        "title",
        "prkit couldn't read your ticks. Try again.",
      );
      await expect(plan.getByRole("checkbox")).toHaveCount(0);
      await expect(rows).toHaveCount(3);
      await plan.scrollIntoView();
      await app.screenshot("manual-check-read-failed");
      tamper(run.home, "ALTER TABLE manual_check_ticks_away RENAME TO manual_check_ticks;");
      await plan.getByRole("button", "Retry").tap();
      await expect(progress).toHaveText("1 of 3 checked", { timeout: 30_000 });

      await browser.setViewport({ width: 640, height: 900 });
      await plan.scrollIntoView();
      expect(
        await browser.evaluate(() => {
          const section = document.querySelector("[data-guide-manual-check]");
          return section === null ? null : section.scrollWidth <= section.clientWidth;
        }),
      ).toBe(true);
      await screenshotLightAndDark(app, browser, "manual-check-640");
      await browser.setViewport({ width: 1280, height: 900 });

      claude.manualCheck({
        steps: [],
        reason: "Only renames `parseUrl` to `parseLink`, so nothing behaves differently.",
      });
      await screen.getByRole("button", "Generate again").tap();
      await expect(revision).toContainText("r3 · ", { timeout: 90_000 });
      await expect(
        plan.getByText(
          "Nothing to check by hand. Only renames parseUrl to parseLink, so nothing behaves differently.",
        ),
      ).toBeVisible();
      await expect(plan.getByRole("checkbox")).toHaveCount(0);
      await expect(progress).toHaveCount(0);
      await plan.scrollIntoView();
      await screenshotLightAndDark(app, browser, "manual-check-nothing");

      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
