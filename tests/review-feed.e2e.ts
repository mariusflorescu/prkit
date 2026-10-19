import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { inboxOrder, readInboxRows } from "./inboxRows.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { choose } from "./pickers.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen">;
const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const sortTrigger = (screen: Fixtures["screen"]) =>
  screen.getByRole("combobox", "Sort pull requests");
const toastsGone = async (screen: Fixtures["screen"]) => {
  await sortTrigger(screen).hover();
  await expect(screen.getByRole("dialog", /.*/)).toHaveCount(0, { timeout: 15_000 });
};
const rowOf = async (browser: Browser, number: number) => {
  const row = (await readInboxRows(browser))
    .flatMap((group) => group.rows)
    .find((item) => item.number === number);
  if (row === undefined) throw new Error(`Row #${number} isn't in the Inbox.`);
  return row;
};
const marks = (browser: Browser) =>
  browser.evaluate(
    () => document.querySelectorAll("main [data-guide-mark], main [data-risk-tag]").length,
  );
/** The guide of a pull request's latest revision, as prkit stored it. */
const latestGuide = (home: string, number: number) =>
  String(
    readRows(
      home,
      `SELECT v.guide FROM review_revisions v JOIN reviews r ON v.review_id = r.id
       WHERE r.pr_key = '${keyOf(number)}' AND v.revision = r.latest_revision`,
    )[0]?.guide ?? "",
  );
/** Writes the guide of a pull request's latest revision, a damaged one included. */
const storeGuide = (home: string, number: number, guide: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.prepare(
      `UPDATE review_revisions SET guide = ?
       WHERE review_id = (SELECT id FROM reviews WHERE pr_key = ?)
         AND revision = (SELECT latest_revision FROM reviews WHERE pr_key = ?)`,
    ).run(guide, keyOf(number), keyOf(number));
  } finally {
    db.close();
  }
};

test(
  "when prkit can't read its guides the Inbox says so with a Retry, keeps every row, offers no guide it can't vouch for, and recovers",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "review-feed";
    const claude = setUpFakeClaude(name);
    const fake = await startFakeGitHub(name);
    const git = outsideGit(name);
    const launch = () => git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
    try {
      for (const number of [4, 6]) await fake.gitHead(number, git.head(number));
      let run = launch();
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      for (const [number, risk] of [
        [4, "high"],
        [6, "low"],
      ] as const) {
        claude.chapters([{ title: `Change ${number}`, files: ["src/change-0.ts"], risk }]);
        await screen.getByRole("link", new RegExp(`#${number} `)).hover();
        await screen.getByRole("button", `Generate guide for budget/fixtures #${number}`).tap();
        await expect
          .poll(async () => (await rowOf(browser, number)).risk, { timeout: 120_000 })
          .toBe(risk);
        await toastsGone(screen);
      }
      claude.chapters([]);
      await choose(screen, sortTrigger(screen), "Waiting longest");
      const byWait = await inboxOrder(browser);
      await choose(screen, sortTrigger(screen), "Riskiest first");
      const byRisk = await inboxOrder(browser);
      expect(byRisk).not.toEqual(byWait);

      // #4's guide is damaged while prkit is closed, so the review feed fails before its first
      // index: every row still shows, in the order the sort falls back to without any levels.
      stopFakeInstance(name, { keepHome: true });
      const guide = latestGuide(run.home, 4);
      storeGuide(run.home, 4, "not a guide");
      run = launch();
      await app.open(run.openUrl);
      const opened = Date.now();
      const notice = screen.getByRole("alert", "Couldn't read your guides");
      await expect(notice).toContainText(
        "prkit can't read your guides right now. Guide marks and risk levels are hidden until it can, and Riskiest first orders by wait.",
        { timeout: 20_000 },
      );
      await expect(notice).not.toContainText("Try again");
      await expect(sortTrigger(screen)).toContainText("Riskiest first");
      expect(await inboxOrder(browser)).toEqual(byWait);
      expect(await marks(browser)).toBe(0);
      for (const number of [4, 3]) {
        await screen.getByRole("link", new RegExp(`#${number} `)).hover();
        await expect(
          screen.getByRole("button", `Generate guide for budget/fixtures #${number}`),
        ).toHaveCount(0);
      }
      await sortTrigger(screen).hover();
      await app.screenshot("feed-failed-light");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("feed-failed-dark");
      await setOsColorScheme(browser, "light");
      await browser.setViewport({ width: 600, height: 720 });
      await expect(notice.getByRole("button", "Retry")).toBeVisible();
      expect(
        await browser.evaluate(() => {
          const box = document.querySelector('main [role="alert"]')?.getBoundingClientRect();
          return box !== undefined && box.right <= document.documentElement.clientWidth;
        }),
      ).toBe(true);
      await app.screenshot("feed-failed-narrow");
      await browser.setViewport({ width: 1280, height: 720 });

      // The stack strip names no layer's guide, and Guide setup won't plan a stack scope.
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/1?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`,
      );
      const strip = screen.getByRole("navigation", "Stack");
      await expect(strip.getByRole("button", /^Layer 1 of 2/)).toBeVisible({ timeout: 30_000 });
      expect(
        await browser.evaluate(() =>
          [...document.querySelectorAll("[data-layer-guide]")].map((layer) => [
            layer.getAttribute("data-layer-guide"),
            layer.getAttribute("aria-label")?.includes("guide") ?? true,
          ]),
        ),
      ).toEqual([
        ["unknown", false],
        ["unknown", false],
      ]);
      await screen
        .getByRole("radiogroup", "Write guides for")
        .getByRole("radio", /^Whole stack/)
        .tap();
      const setupNotice = screen.getByRole("form", "Start a guide").getByRole("alert");
      await expect(setupNotice).toContainText(
        "prkit can't read your guides right now. Which layers already have a guide is unknown until it can.",
      );
      await expect(screen.getByRole("button", /^Generate 2 guides/)).toBeDisabled();
      await app.screenshot("feed-failed-stack-setup");
      await screen.getByRole("radiogroup", "Write guides for").getByRole("radio", "This PR").tap();
      await screen.getByRole("link", "Inbox").tap();

      // Repaired, the feed comes back on Retry. prkit tried by itself about 30 seconds in and
      // next tries about a minute in, and the notice outlasts the repair until Retry.
      await new Promise((resolve) => setTimeout(resolve, opened + 35_000 - Date.now()));
      await expect(notice).toBeVisible();
      storeGuide(run.home, 4, guide);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await expect(notice).toBeVisible();
      const retried = Date.now();
      await notice.getByRole("button", "Retry").tap();
      await expect(notice).toHaveCount(0, { timeout: 3_000 });
      expect(Date.now() - retried).toBeLessThan(3_000);
      await expect.poll(() => inboxOrder(browser)).toEqual(byRisk);
      expect((await rowOf(browser, 4)).risk).toBe("high");
      expect(await marks(browser)).toBeGreaterThan(0);

      // A failure after the feed was read keeps the last marks, says they may be out of date,
      // and clears by itself once prkit can read them again.
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/4?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`,
      );
      const again = screen.getByRole("button", "Generate again");
      await expect(again).toBeVisible({ timeout: 30_000 });
      claude.hold();
      storeGuide(run.home, 4, "not a guide");
      await again.tap();
      await screen.getByRole("link", "Inbox").tap();
      await expect(notice).toContainText(
        "prkit can't read your guides right now. Guide marks and risk levels may be out of date until it can.",
        { timeout: 20_000 },
      );
      expect(await marks(browser)).toBeGreaterThan(0);
      expect(await inboxOrder(browser)).toEqual(byRisk);
      await sortTrigger(screen).hover();
      await app.screenshot("feed-stale-light");
      storeGuide(run.home, 4, guide);
      await expect(notice).toHaveCount(0, { timeout: 10_000 });
      claude.release();
    } finally {
      claude.release();
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
