import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { TickManualCheckResult } from "../apps/server/src/outside/paritySchemas.ts";
import { GuideResult } from "../apps/server/src/outside/schemas.ts";
import { NormalizedGuide } from "../packages/contracts/src/guide.ts";
import { repoRoot, runForUrl } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  openFixtureGuide,
  readRows,
} from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { setUpRealClaude } from "./realClaude.ts";

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

const EVIDENCE = NodePath.join(repoRoot, ".e2e", "evidence", "manual-check");
const decodeGuide = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));

/** The newest accepted guide of a pull request, kept as evidence. */
const acceptedGuide = (home: string, key: string, evidence: string) => {
  const [stored] = readRows(
    home,
    `SELECT rr.guide FROM review_revisions rr JOIN reviews r ON r.id = rr.review_id
     WHERE r.pr_key = '${key}' ORDER BY rr.revision DESC LIMIT 1`,
  );
  if (typeof stored?.guide !== "string") throw new Error(`${key} has no accepted guide.`);
  NodeFS.mkdirSync(EVIDENCE, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(EVIDENCE, `${evidence}.json`), stored.guide);
  return decodeGuide(stored.guide);
};

const focusedChapter = (browser: Browser) =>
  browser.evaluate(() =>
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.dataset.chapterId ?? null)
      : null,
  );

const LINKS = [
  "export type Link = { readonly id: number; readonly url: string };",
  "",
  "const links: Array<Link> = [];",
  "",
  "export const addLink = (url: string): Link => {",
  "  const link = { id: links.length + 1, url };",
  "  links.push(link);",
  "  return link;",
  "};",
  "",
].join("\n");
const SERVER = (name: string) =>
  [
    `import { ${name} } from "./links.ts";`,
    "",
    "export const handle = (method: string, url: URL, body: string) => {",
    `  if (method === "POST" && url.pathname === "/links") return { status: 201, body: ${name}(body) };`,
    '  return { status: 404, body: "not found" };',
    "};",
    "",
  ].join("\n");
const TEST = (name: string) =>
  [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "",
    `import { ${name} } from "../src/links.ts";`,
    "",
    'test("a new link gets the next id", () => {',
    `  assert.equal(${name}("https://example.com").id, 1);`,
    "});",
    "",
  ].join("\n");

/** Renames `addLink` and pulls the id out into a helper: nothing behaves differently. */
const REFACTOR = {
  base: {
    "README.md":
      "# Links\n\nA tiny link shortener.\n\n## Run it\n\n`npm start` serves it on port 3000.\n",
    "package.json": '{ "scripts": { "start": "node src/main.ts", "test": "node --test" } }\n',
    "src/links.ts": LINKS,
    "src/server.ts": SERVER("addLink"),
    "test/links.test.ts": TEST("addLink"),
  },
  head: {
    "src/links.ts": [
      "export type Link = { readonly id: number; readonly url: string };",
      "",
      "const links: Array<Link> = [];",
      "",
      "const nextId = () => links.length + 1;",
      "",
      "export const createLink = (url: string): Link => {",
      "  const link = { id: nextId(), url };",
      "  links.push(link);",
      "  return link;",
      "};",
      "",
    ].join("\n"),
    "src/server.ts": SERVER("createLink"),
    "test/links.test.ts": TEST("createLink"),
  },
};

describe("a real Claude guide says how to check it", { tags: ["agent"] }, () => {
  test(
    "the fixture pull request gets concrete steps that point at its chapters",
    { skip: NEEDS_FIXTURE, timeout: 900_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      await browser.setViewport({ width: 1440, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await openFixtureGuide({ app, screen });
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 840_000,
      });
      const guide = acceptedGuide(run.home, `github.com/${FIXTURE_REPO}#1`, "fixture");
      const plan = guide.manualCheck;
      console.info(`fixture plan: ${JSON.stringify(plan, null, 2)}`);
      if (plan?._tag !== "steps") throw new Error("The fixture's guide has no steps to check.");
      expect(plan.steps.length).toBeGreaterThanOrEqual(2);
      expect(plan.steps.length).toBeLessThanOrEqual(5);
      const chapters = new Set(guide.chapters.map((chapter) => chapter.id));
      expect(plan.steps.some((step) => step.chapter !== null)).toBe(true);
      for (const step of plan.steps)
        if (step.chapter !== null) expect(chapters.has(step.chapter)).toBe(true);
      expect(plan.steps.some((step) => step.watchFor !== null)).toBe(true);
      const said = JSON.stringify(plan).toLowerCase();
      expect(said).toMatch(/stats|click/);
      expect(said).toMatch(/400|javascript:|rejected|invalid/);
      expect(said).not.toMatch(/\bi (ran|tested|tried)\b/);
      expect(NodeFS.readFileSync(run.log, "utf8")).toContain("manual-check");

      const section = screen.getByRole("region", "How to check it");
      await section.scrollIntoView();
      await expect(section.getByRole("checkbox")).toHaveCount(plan.steps.length);
      await screenshotLightAndDark(app, browser, "manual-check-agent-fixture");
      for (const [index, step] of plan.steps.entries()) {
        if (step.chapter === null) continue;
        await section.scrollIntoView();
        await section
          .getByRole("listitem")
          .nth(index)
          .getByRole("button", /^Open chapter \d+: /)
          .tap();
        await expect.poll(() => focusedChapter(browser)).toBe(step.chapter);
      }
      await section.scrollIntoView();
      await section.getByRole("checkbox", "Checked step 1").tap();
      await expect(
        browser.locator("[data-guide-manual-check] [data-manual-check-progress]"),
      ).toHaveText(`1 of ${plan.steps.length} checked`);
      await browser.setViewport({ width: 640, height: 900 });
      await section.scrollIntoView();
      await app.screenshot("manual-check-agent-fixture-640");
    },
  );

  test(
    "a refactor gets nothing to check by hand",
    { timeout: 900_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const name = "manual-check-refactor";
      NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });
      const claude = setUpRealClaude(name);
      const fake = await startFakeGitHub(name);
      const git = await cliFixture(fake, REFACTOR);
      const path = process.env.PATH;
      const restorePath = () => {
        if (path === undefined) delete process.env.PATH;
        else process.env.PATH = path;
      };
      process.env.PATH = git.path;
      try {
        const run = startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]);
        restorePath();
        await emulateOsColorScheme(browser, "light");
        await browser.setViewport({ width: 1440, height: 900 });
        await app.open(run.openUrl);
        await app.open(guideUrl(run.url));
        await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
        await expect
          .poll(
            () => {
              const [review] = readRows(
                run.home,
                `SELECT json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${KEY}'`,
              );
              return review?.state === "watching" || review?.state === "failed"
                ? review.state
                : "running";
            },
            { timeout: 840_000, interval: 1_000 },
          )
          .toBe("watching");
        const guide = acceptedGuide(run.home, KEY, "refactor");
        console.info(`refactor plan: ${JSON.stringify(guide.manualCheck)}`);
        expect(guide.manualCheck).toMatchObject({ _tag: "nothing", reason: expect.any(String) });
        const section = screen.getByRole("region", "How to check it");
        await expect(section.getByText(/^Nothing to check by hand\. /)).toBeVisible({
          timeout: 30_000,
        });
        await expect(section.getByRole("checkbox")).toHaveCount(0);
        await section.scrollIntoView();
        await screenshotLightAndDark(app, browser, "manual-check-agent-refactor");
      } finally {
        restorePath();
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );
});
