import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { AGENT_RUNS, AGENT_SKIP, NEEDS_FIXTURE, openFixtureGuide, readRows } from "./fixturePr.ts";

const CODEX_RUNS = process.env.PRKIT_E2E_CODEX === "1";

const MARKS = {
  // The first line about what the agent did: a tool call in the activity log, or its own words.
  activity:
    '[role="log"][aria-label="Agent activity"] li[data-kind="tool"], [data-narration="agent"]',
  narration: '[data-narration="agent"]',
  overview: "[data-guide-summary]",
  chapter: "[data-guide-chapter]:not([data-pending])",
  accepted: '[data-review-status="watching"]',
} as const;

const FIRST_ACTIVITY_MS = 12_000;

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { readonly browser: Browser };

/** Clicks Generate, records when each mark first shows, and files the attempt with its timings. */
const timeFirstGuide = async ({ app, screen, browser }: Fixtures) => {
  const run = runForUrl(app.baseUrl);
  await browser.evaluate((marks) => {
    const seen: Record<string, number> = {};
    const chapters: Array<{ t: number; count: number }> = [];
    const state = { clickedAt: 0, clickedAtWall: 0, seen, chapters };
    Object.assign(window, { __timing: state });
    document.addEventListener(
      "click",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button")?.textContent?.includes("Generate guide")
        ) {
          state.clickedAt = performance.now();
          // Wall time, to line the marks up with the server log and the agent's transcript.
          state.clickedAtWall = Date.now();
        }
      },
      { capture: true },
    );
    const check = () => {
      if (state.clickedAt === 0) return;
      const t = performance.now() - state.clickedAt;
      for (const [name, selector] of Object.entries(marks))
        if (seen[name] === undefined && document.querySelector(selector) !== null) seen[name] = t;
      const count = document.querySelectorAll(marks.chapter).length;
      if (seen.accepted === undefined && count > (chapters.at(-1)?.count ?? 0))
        chapters.push({ t, count });
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    return null;
  }, MARKS);

  // The 1-, 5- and 15-minute load averages: a timing taken on a busy machine says so.
  const loadAtClick = NodeOS.loadavg();
  await screen.getByRole("button", "Generate guide").tap();
  await expect(browser.locator(MARKS.overview).first()).toBeVisible({ timeout: 600_000 });
  await app.screenshot("timing-overview");
  await expect(browser.locator(MARKS.chapter).first()).toBeVisible({ timeout: 600_000 });
  await browser.locator(MARKS.chapter).first().scrollIntoView();
  await app.screenshot("timing-first-chapter");
  await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
    timeout: 600_000,
  });
  await expect(browser.locator(MARKS.accepted).first()).toBeAttached();
  await app.screenshot("timing-accepted");

  const marks = await browser.evaluate(() => Reflect.get(window, "__timing"));
  const [attempt] = readRows(
    run.home,
    "SELECT id, outcome, draft_version, started_at, finished_at, changed_lines FROM review_attempts ORDER BY rowid DESC LIMIT 1",
  );
  const [review] = readRows(
    run.home,
    "SELECT provider, session_id, model, model_options FROM reviews",
  );
  const [revision] = readRows(run.home, "SELECT guide FROM review_revisions");
  const activity = readRows(run.home, "SELECT at, kind, text FROM review_activity ORDER BY id");
  expect(attempt?.outcome).toBe("accepted");
  const out = NodePath.resolve(import.meta.dirname, "../.e2e/evidence/guide-timing");
  NodeFS.mkdirSync(out, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(out, `${new Date().toISOString().replaceAll(":", "-")}.json`),
    JSON.stringify(
      {
        marks,
        load: { atClick: loadAtClick, atEnd: NodeOS.loadavg() },
        attempt,
        review,
        revision,
        activity,
        log: run.log,
      },
      null,
      2,
    ),
  );
  expect(marks.seen.activity).toBeLessThan(FIRST_ACTIVITY_MS);
};

describe("guide generation timing", { tags: ["timing"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Claude Fable 5.1 Medium writes fixture #1's first guide, timed from the click",
    { timeout: 660_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen, browser } = fixtures;
      await openFixtureGuide({ app, screen });
      await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("fable");
      await screen.getByRole("option", /Claude Fable 5\.1/).tap();
      await screen.getByRole("button", /^Claude Fable 5\.1 settings: /).tap();
      await screen.getByRole("menuitemradio", /^Medium/).tap();
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("button", "Claude Fable 5.1 settings: Medium")).toBeVisible();
      await timeFirstGuide(fixtures);
    },
  );

  test(
    "Codex GPT-6.1-Sol on its default settings writes fixture #1's first guide, timed from the click",
    { timeout: 660_000 },
    async (fixtures) => {
      test.skip(
        !CODEX_RUNS,
        "Spends your ChatGPT subscription. Run with PRKIT_E2E_CODEX=1 --tag timing.",
      );
      const { app, screen } = fixtures;
      await openFixtureGuide({ app, screen });
      await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("GPT-6.1-Sol");
      await screen
        .getByRole("option", /GPT-6\.1-Sol/)
        .first()
        .tap();
      await expect(screen.getByRole("button", /^Agent and model: GPT-6\.1-Sol/)).toBeVisible();
      await timeFirstGuide(fixtures);
    },
  );
});
