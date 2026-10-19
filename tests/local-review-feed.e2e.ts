import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { GenerateLocalGuideResult } from "../apps/server/src/outside/schemas.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const TITLE = "widgets · feature/limits";
const DAMAGED = "prkit can't read this local review right now, because its record is damaged.";

/** The tab's mark: the progress ring, the warning dot, or neither. */
const tabMark = (browser: Browser) =>
  browser.evaluate(() => {
    const tab = document.querySelector("[data-local-tab]");
    if (tab === null) return "no tab";
    if (tab.querySelector("[data-guide-progress]") !== null) return "progress";
    return tab.querySelector("[data-guide-warning]") !== null ? "warning" : "none";
  });

test(
  "a local review prkit can't read while it is open says so with a Retry, offers no run on a reading it can't vouch for, and recovers",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const name = "local-review-feed";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    const run = startFakeInstance(name, fake, [
      "--claude",
      claude.file,
      "--watch-interval",
      "600000",
    ]);
    const database = NodePath.join(run.home, "prkit.sqlite");
    /** Damages the record of the run under way, while prkit reads it, and gives back the undo. */
    const damageRun = (key: string) => {
      const [latest] = readRows(
        run.home,
        `SELECT id, capture FROM review_attempts
         WHERE review_id = (SELECT id FROM reviews WHERE pr_key = '${key}') ORDER BY rowid DESC LIMIT 1`,
      );
      const id = String(latest?.id ?? "");
      const capture = String(latest?.capture ?? "");
      const write = (value: string) => {
        const db = new DatabaseSync(database);
        try {
          db.prepare("UPDATE review_attempts SET capture = ? WHERE id = ?").run(value, id);
        } finally {
          db.close();
        }
      };
      write('{"broken');
      return () => write(capture);
    };
    const failed = (key: string) =>
      String(readRows(run.home, `SELECT status FROM reviews WHERE pr_key = '${key}'`)[0]?.status);
    try {
      const fixture = localRepoFixture(root);
      const team = "Limits are set per team, not per user.";
      fixture.write("docs/handbook.md", handbook({ 15: team }));
      const local = (args: ReadonlyArray<string>) =>
        cliIn(
          NodePath.join(run.home, "bin/prkit"),
          fake.home,
          log,
        )(fixture.repo, ["local", ...args]);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await switchOn({ app, screen, browser }, run.openUrl);
      await dismissToasts(browser);

      const notice = screen.getByRole("alert", "Couldn't read this local review");
      const status = screen.getByRole("status", "Guide status");

      // The first run's record is damaged while the agent writes: the page stops showing the
      // run as under way and says what happened, and offers neither Stop nor Run again.
      claude.hold();
      const started = decodeGenerate(local(["guide", "--json"]).stdout);
      const key = started.status.key;
      const tab = screen.getByRole("link", `Open the local review of ${TITLE}`);
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.tap();
      await expect(screen.getByRole("status", "What the agent is doing")).toBeVisible({
        timeout: 30_000,
      });
      let repair = damageRun(key);
      claude.release();
      await expect.poll(() => failed(key), { timeout: 30_000 }).toContain('"failed"');
      await expect(notice).toContainText(DAMAGED, { timeout: 15_000 });
      await expect(screen.getByRole("status", "What the agent is doing")).toHaveCount(0);
      await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
      await expect(screen.getByRole("button", "Run again")).toHaveCount(0);
      await expect.poll(() => tabMark(browser)).toBe("warning");
      await screenshotLightAndDark(app, browser, "local-feed-failed");
      await browser.setViewport({ width: 600, height: 860 });
      await expect(notice.getByRole("button", "Retry")).toBeVisible();
      await app.screenshot("local-feed-failed-narrow");
      await browser.setViewport({ width: 1280, height: 860 });

      // Repaired, Retry reads it again: the run failed, and its own Retry writes the guide.
      repair();
      await notice.getByRole("button", "Retry").tap();
      await expect(notice).toHaveCount(0, { timeout: 15_000 });
      const runFailure = screen.getByRole("alert").filter({ hasText: "Retry" });
      await expect(runFailure).toBeVisible();
      await runFailure.getByRole("button", "Retry").tap();
      await expect(screen.getByText("A guide written by the stand-in agent.")).toBeVisible({
        timeout: 60_000,
      });
      await expect(status).toContainText("Ready");
      await dismissToasts(browser);

      // A second run's record is damaged under the first guide: the guide stays readable, the
      // page says it may be out of date, and offers no Retry of the run it can't read.
      claude.hold();
      fixture.write("docs/handbook.md", handbook({ 15: team, 22: "Teams can raise their own." }));
      await screen.getByRole("button", "Run again").tap();
      await expect(screen.getByRole("button", "Stop")).toBeVisible({ timeout: 30_000 });
      repair = damageRun(key);
      claude.release();
      await expect.poll(() => failed(key), { timeout: 30_000 }).toContain('"failed"');
      await expect(notice).toContainText(DAMAGED, { timeout: 15_000 });
      await expect(notice).toContainText("The guide below may be out of date until it can.");
      await expect(screen.getByText("A guide written by the stand-in agent.")).toBeVisible();
      await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
      await expect(screen.getByRole("button", "Run again")).toHaveCount(0);
      await expect(screen.getByRole("alert").filter({ hasText: "Retry" })).toHaveCount(1);
      await expect.poll(() => tabMark(browser)).toBe("warning");
      await screenshotLightAndDark(app, browser, "local-feed-stale");

      // Repaired, prkit's own next try clears the notice without a click.
      repair();
      await expect(notice).toHaveCount(0, { timeout: 30_000 });
      await expect(screen.getByRole("button", "Run again")).toBeVisible();
      await expect(status).toContainText("The guide couldn't be updated");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
