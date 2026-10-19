import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { RevisionResult, TickManualCheckResult } from "../apps/server/src/outside/paritySchemas.ts";
import { GuideResult } from "../apps/server/src/outside/schemas.ts";
import {
  ManualCheckCode,
  manualCheckStepVersion,
} from "../packages/contracts/src/manualCheckTicks.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NAME = "manual-check-code-changed";
const ACCOUNT = "github.com/budget-test";
const KEY = "github.com/budget/fixtures#9";
const SUBJECT = `pull-request ${ACCOUNT} ${KEY}`;
const guideUrl = (base: string) =>
  `${base}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent(ACCOUNT)}&tab=guide`;

const LIMITS = "src/limits.ts";
const DETAIL = "src/change-0.ts";
const PILL = "Code changed since you checked";

const SHORTEN = {
  action: "Shorten `https://example.com`, then open the short link.",
  expect: "It redirects to example.com.",
  watchFor: "A redirect loop on the short link.",
  chapter: 1,
};
const STATS = {
  action: "Open `/stats/<code>` for that link.",
  expect: "It shows `1`.",
  chapter: 2,
};
const UNSAFE = {
  action: "Shorten `javascript:alert(1)`.",
  expect: "A 400, and nothing new at http://localhost:3000/<code>.",
};
const FRESH = {
  action: "Open `/stats/<code>` for a link nobody opened.",
  expect: "It shows `0`.",
  chapter: 2,
};

const STEPS = [SHORTEN, STATS, UNSAFE, FRESH];
const numberOf = new Map(
  STEPS.map((step, index): [string, number] => [manualCheckStepVersion(step), index + 1]),
);
const decodeCode = Schema.decodeUnknownSync(Schema.fromJsonString(ManualCheckCode));

/** What the table holds for this pull request, oldest decision first, by step number. */
const decisions = (home: string) =>
  readRows(
    home,
    `SELECT step, code, ticked FROM manual_check_ticks WHERE subject = '${SUBJECT}' ORDER BY seq, step`,
  ).map((row) => ({
    step: numberOf.get(String(row.step)) ?? 0,
    paths: row.code === "" ? null : decodeCode(row.code).map((file) => file.path),
    ticked: row.ticked,
  }));

const codesOf = (home: string, step: number) =>
  readRows(
    home,
    `SELECT code FROM manual_check_ticks WHERE subject = '${SUBJECT}' AND step = '${manualCheckStepVersion(STEPS[step - 1] ?? SHORTEN)}'`,
  ).map((row) => row.code);

const tamper = (home: string, statement: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
};

const BASE_LIMITS =
  'export const limits = {\n  url: 1024,\n  title: 120,\n};\n\nexport const schemes = ["http", "https"];\n';
const MORE_SCHEMES = BASE_LIMITS.replace('"https"]', '"https", "ftp"]');
const HEADER = [
  "// Limits for the link shortener.",
  "// Keep them in step with the docs.",
  "// url is in bytes.",
  "// slug is in characters.",
  "// title is in characters.",
  "",
].join("\n");
const detail = (start: string) =>
  `${Array.from({ length: 1600 }, (_, index) => `// Fixture detail ${index}`).join("\n")}\nexport const change0 = "${start}";\n`;

const withoutLineNumbers = (patch: string) => patch.replace(/^@@.*$/gm, "@@");

test(
  "a ticked step reads 'Code changed since you checked' after a real edit to its chapter, and only then",
  { timeout: 900_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    const start = () =>
      git.start(() =>
        startFakeInstance(NAME, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          "5000",
        ]),
      );
    try {
      await fake.gitHead(9, git.head(9));
      claude.chapters([
        { title: "Limits", files: [LIMITS] },
        { title: "Detail", files: [DETAIL] },
      ]);
      claude.manualCheck({ setup: "Run `npm start`.", steps: STEPS });
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
      const tickByCli = (revision: number, steps: ReadonlyArray<string>) =>
        Schema.decodeSync(Schema.fromJsonString(TickManualCheckResult))(
          cli([
            "guide",
            "tick",
            "budget/fixtures#9",
            "--revision",
            String(revision),
            ...steps.flatMap((step) => ["--steps", step]),
            "--account",
            ACCOUNT,
            "--json",
          ]),
        );
      const readByCli = () => {
        const read = Schema.decodeSync(Schema.fromJsonString(GuideResult))(
          cli(["guide", "read", "budget/fixtures#9", "--account", ACCOUNT, "--json"]),
        );
        if (read.guide === null) throw new Error("The guide has no revision to read.");
        return read.guide;
      };

      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      await app.open(guideUrl(run.url));
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r1 · ", { timeout: 120_000 });

      const plan = screen.getByRole("region", "How to check it");
      const progress = browser.locator("[data-guide-manual-check] [data-manual-check-progress]");
      const box = (step: number) => plan.getByRole("checkbox", `Checked step ${step}`);
      const step = (number: number) => plan.getByRole("listitem").nth(number - 1);
      const pills = plan.getByText(PILL);
      const progressTitle = () =>
        browser.evaluate(
          () =>
            document
              .querySelector("[data-guide-manual-check] [data-manual-check-progress]")
              ?.getAttribute("title") ?? null,
        );
      const ticked = async (...states: ReadonlyArray<"true" | "false">) => {
        for (const [index, state] of states.entries())
          await expect(box(index + 1)).toHaveAttribute("aria-checked", state);
      };

      await expect(progress).toHaveText("0 of 4 checked");
      await box(1).tap();
      await expect(progress).toHaveText("1 of 4 checked");
      await box(3).tap();
      await expect(progress).toHaveText("2 of 4 checked");
      expect(tickByCli(1, ["2"])).toEqual({ revision: 1, manualCheckTicked: [1, 2, 3] });
      await expect(progress).toHaveText("3 of 4 checked");
      expect(decisions(run.home)).toEqual([
        { step: 1, paths: [LIMITS], ticked: 1 },
        { step: 3, paths: null, ticked: 1 },
        { step: 2, paths: [DETAIL], ticked: 1 },
      ]);

      stopFakeInstance(NAME, { keepHome: true });
      tamper(
        run.home,
        `INSERT INTO manual_check_ticks (subject, step, ticked, seq, decided_at)
         VALUES ('${SUBJECT}', '${manualCheckStepVersion(FRESH)}', 1, 100, '2026-01-01T00:00:00.000Z')`,
      );
      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      run = start();
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      await expect(progress).toHaveText("All 4 checked", { timeout: 30_000 });
      await expect(pills).toHaveCount(0);
      expect(decisions(run.home).at(-1)).toEqual({ step: 4, paths: null, ticked: 1 });

      const edited = git.commit(9, { [LIMITS]: MORE_SCHEMES });
      const before = git.patch(9, LIMITS);
      await fake.gitHead(9, edited);
      await expect(revision).toContainText("r2 · ", { timeout: 120_000 });
      await ticked("false", "true", "true", "true");
      await expect(step(1).getByText(PILL)).toBeVisible();
      await expect(pills).toHaveCount(1);
      await expect(progress).toHaveText("3 of 4 checked");
      await expect(progress).toHaveAttribute("title", "1 changed since you checked");
      expect(
        await browser.evaluate(() => {
          const checkbox = document.querySelector("[aria-label='Checked step 1']");
          const pillId = [...document.querySelectorAll("[data-manual-check-step] span")].find(
            (element) => element.textContent === "Code changed since you checked",
          )?.id;
          return (
            pillId !== undefined &&
            pillId !== "" &&
            (checkbox?.getAttribute("aria-describedby")?.split(" ").includes(pillId) ?? false)
          );
        }),
      ).toBe(true);
      expect(decisions(run.home)).toHaveLength(4);
      await plan.scrollIntoView();
      await screenshotLightAndDark(app, browser, "manual-check-code-changed-pill");

      const read = readByCli();
      expect(read.revision).toBe(2);
      expect(read.manualCheckTicked).toEqual([2, 3, 4]);
      expect(read.manualCheckChanged).toEqual([1]);
      const revisionRead = Schema.decodeSync(Schema.fromJsonString(RevisionResult))(
        cli([
          "guide",
          "revision",
          "budget/fixtures#9",
          "--revision",
          "1",
          "--account",
          ACCOUNT,
          "--json",
        ]),
      );
      expect(revisionRead.manualCheckTicked).toEqual([1, 2, 3, 4]);
      expect(revisionRead.manualCheckChanged).toEqual([]);

      await revision.tap();
      await screen.getByRole("option", /^r1 · /).tap();
      await expect(progress).toHaveText("All 4 checked", { timeout: 30_000 });
      await expect(pills).toHaveCount(0);
      await revision.tap();
      await screen.getByRole("option", /^r2 · /).tap();
      await expect(progress).toHaveText("3 of 4 checked", { timeout: 30_000 });
      await expect(pills).toHaveCount(1);

      await browser.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        return true;
      });
      stopFakeInstance(NAME, { keepHome: true });
      run = start();
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      await expect(progress).toHaveText("3 of 4 checked", { timeout: 30_000 });
      await expect(step(1).getByText(PILL)).toBeVisible();
      await ticked("false", "true", "true", "true");

      await box(1).tap();
      await expect(progress).toHaveText("All 4 checked");
      await expect(pills).toHaveCount(0);
      expect(await progressTitle()).toBeNull();
      expect(decisions(run.home).filter((row) => row.step === 1)).toEqual([
        { step: 1, paths: [LIMITS], ticked: 1 },
        { step: 1, paths: [LIMITS], ticked: 1 },
      ]);
      expect(new Set(codesOf(run.home, 1)).size).toBe(2);
      const saved = decisions(run.home);
      expect(tickByCli(2, ["1"])).toEqual({ revision: 2, manualCheckTicked: [1, 2, 3, 4] });
      expect(decisions(run.home)).toEqual(saved);

      git.commit(9, { [DETAIL]: detail("Edited fixture 9") });
      await fake.gitHead(9, git.head(9));
      await expect(revision).toContainText("r3 · ", { timeout: 120_000 });
      await ticked("true", "false", "true", "true");
      await expect(step(2).getByText(PILL)).toBeVisible();
      await expect(pills).toHaveCount(1);
      await expect(progress).toHaveText("3 of 4 checked");
      await expect(progress).toHaveAttribute("title", "1 changed since you checked");
      await plan.scrollIntoView();
      await screenshotLightAndDark(app, browser, "manual-check-code-changed-other-chapter");

      claude.chapters([{ title: "Limits", files: [LIMITS, DETAIL] }]);
      claude.manualCheck({
        setup: "Run `npm start`.",
        steps: [SHORTEN, { ...STATS, chapter: 1 }, UNSAFE, { ...FRESH, chapter: 1 }],
      });
      await screen.getByRole("button", "Generate again").tap();
      await expect(revision).toContainText("r4 · ", { timeout: 120_000 });
      await expect(plan.getByRole("button", /^Open chapter 1: Limits/)).toHaveCount(3);
      await ticked("true", "false", "true", "true");
      await expect(step(1).getByText(PILL)).toHaveCount(0);
      await expect(pills).toHaveCount(1);
      await expect(progress).toHaveText("3 of 4 checked");

      const merged = git.mergeBase(9, { [LIMITS]: `${HEADER}${BASE_LIMITS}` });
      const after = git.patch(9, LIMITS);
      expect(after).not.toEqual(before);
      expect(withoutLineNumbers(after)).toEqual(withoutLineNumbers(before));
      await fake.gitHead(9, merged);
      await expect(revision).toContainText("r5 · ", { timeout: 120_000 });
      await ticked("true", "false", "true", "true");
      await expect(step(1).getByText(PILL)).toHaveCount(0);
      await expect(pills).toHaveCount(1);
      await expect(progress).toHaveText("3 of 4 checked");

      await browser.setViewport({ width: 640, height: 900 });
      await plan.scrollIntoView();
      expect(
        await browser.evaluate(() =>
          [
            document.querySelector("[data-guide-manual-check]"),
            ...document.querySelectorAll("[data-manual-check-step]"),
          ].every((element) => element !== null && element.scrollWidth <= element.clientWidth),
        ),
      ).toBe(true);
      await screenshotLightAndDark(app, browser, "manual-check-code-changed-640");
      await browser.setViewport({ width: 1280, height: 900 });

      expect(await fake.writes()).toEqual([]);
      expect(git.pushes()).toEqual([]);
    } finally {
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
