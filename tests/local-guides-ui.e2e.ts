import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { GenerateLocalGuideResult } from "../apps/server/src/outside/schemas.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { savedScreenshots } from "./savedScreenshots.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const TITLE = "widgets · feature/limits";
const EVIDENCE = NodePath.join(repoRoot, ".e2e/evidence/local-guides-ui");

/** This run's named frames (`003-local-ready-dark.png`), copied as `local-ready-dark.png`. */
const keepEvidence = (log: ReadonlyArray<string>, since: number) => {
  NodeFS.mkdirSync(EVIDENCE, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(EVIDENCE, "cli-transcript.txt"), log.join("\n\n"));
  for (const shot of savedScreenshots()) {
    const name = shot.file.replace(/^\d+-/, "");
    if (
      shot.test.startsWith("local-guides-ui-") &&
      shot.savedAt >= since &&
      name.startsWith("local-")
    )
      NodeFS.copyFileSync(shot.path, NodePath.join(EVIDENCE, name));
  }
};

const pageText = async (screen: TestFixtures["screen"]) =>
  (await screen.getByRole("main").textContent()) ?? "";

test(
  "a local review has its own tab and page: progress, the guide, Run again, Stop, Remove and relaunch",
  { timeout: 420_000 },
  async ({ app, screen, browser }) => {
    const started = Date.now();
    const name = "local-guides-ui";
    const fake: FakeGitHub = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    const start = () =>
      startFakeInstance(name, fake, ["--claude", claude.file, "--watch-interval", "600000"]);
    const both = (label: string) => screenshotLightAndDark(app, browser, label);
    try {
      const fixture = localRepoFixture(root);
      const team = "Limits are set per team, not per user.";
      fixture.write("docs/handbook.md", handbook({ 15: team }));
      let run = start();
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      const local = (args: ReadonlyArray<string>) => cli(fixture.repo, ["local", ...args]);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 860 });
      await switchOn({ app, screen, browser }, run.openUrl);
      await dismissToasts(browser);
      // Settings > Appearance prints no paths of this machine, unlike Outside agents.
      await screen.getByRole("link", "Appearance").tap();
      const fingerprint = fixture.fingerprint();

      // An agent in a terminal starts the guide: its tab shows up, and the user stays put.
      claude.hold();
      const started = decodeGenerate(
        local(["guide", "--description", "Set limits per team", "--json"]).stdout,
      );
      expect(started.outcome).toBe("started");
      const key = started.status.key;
      const tab = screen.getByRole("link", `Open the local review of ${TITLE}`);
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("heading", "Appearance", { level: 2 })).toBeVisible();
      await app.screenshot("local-tab-light");

      // The page shows what the agent is doing while it writes.
      await tab.tap();
      const heading = screen.getByRole("heading", TITLE);
      await expect(heading).toBeVisible();
      await expect(screen.getByText("Local changes", { exact: true })).toBeVisible();
      await expect(screen.getByRole("status", "What the agent is doing")).toHaveText(
        "Reading the change with a stand-in agent",
        { timeout: 30_000 },
      );
      await expect(screen.getByRole("list", "Changed files")).toBeVisible({ timeout: 30_000 });
      await both("local-progress");

      // The guide, with the left-out files listed calmly and any file open in full.
      claude.release();
      await expect(screen.getByText("A guide written by the stand-in agent.")).toBeVisible({
        timeout: 60_000,
      });
      const status = screen.getByRole("status", "Guide status");
      await expect(status).toContainText("Ready");
      await expect(screen.getByText("2 files left out of the snapshot")).toBeVisible();
      expect(await pageText(screen)).not.toMatch(/watching|pull request/i);
      await both("local-ready");
      const code = browser.locator('[data-path="docs/handbook.md"] diffs-container pre').first();
      await screen.getByRole("region", "docs/handbook.md").scrollIntoView();
      await expect(code).toContainText("unmodified lines", { timeout: 30_000 });
      await expect(code).not.toContainText("Line 1 of the handbook.");
      await browser.locator('[data-path="docs/handbook.md"] [data-unmodified-lines]').first().tap();
      await expect(code).toContainText("Line 1 of the handbook.", { timeout: 30_000 });
      await app.screenshot("local-expanded-light");

      // Run again with nothing new starts nothing and says so quietly.
      const runAgain = screen.getByRole("button", "Run again");
      const turns = claude.runs().length;
      await runAgain.tap();
      await expect(
        screen.getByText("Nothing changed since revision 1", { exact: true }),
      ).toBeVisible();
      expect(claude.runs().length).toBe(turns);
      await app.screenshot("local-unchanged-light");
      await dismissToasts(browser);

      // A change, then Run again, is revision 2 in the switcher.
      fixture.write(
        "docs/handbook.md",
        handbook({ 15: team, 22: "Teams can raise their own limit." }),
      );
      await runAgain.tap();
      const revision = screen.getByRole("combobox", "Guide revision");
      await expect(revision).toContainText("r2 · ", { timeout: 60_000 });
      await expect(status).toContainText("Ready");
      await revision.tap();
      await expect(screen.getByRole("option", "r1 · first guide")).toBeVisible();
      await both("local-revisions");
      await browser.keyboard.press("Escape");

      // Stop ends a run while it writes; the revisions stay readable.
      claude.hold();
      fixture.write(
        "docs/handbook.md",
        handbook({ 15: team, 22: "Teams can raise their own limit.", 28: "Limits reset monthly." }),
      );
      await runAgain.tap();
      const stop = screen.getByRole("button", "Stop");
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await expect(status).toContainText(/Writing the guide again|writing the update/);
      await app.screenshot("local-updating-light");
      await stop.tap();
      await expect(status).toContainText("Stopped");
      await expect(runAgain).toBeVisible();
      claude.release();
      await expect(screen.getByText("A guide written by the stand-in agent.")).toBeVisible();
      await both("local-stopped");

      // A run that fails says why above the guide it leaves readable, and Retry runs it again.
      claude.failing(true);
      fixture.write(
        "docs/handbook.md",
        handbook({ 15: team, 22: "Teams can raise their own limit.", 28: "Limits reset daily." }),
      );
      await runAgain.tap();
      const failure = screen
        .getByRole("alert")
        .filter({ hasText: "The agent stopped with an error" });
      await expect(failure).toContainText("The stand-in agent was told to fail.", {
        timeout: 60_000,
      });
      await expect(status).toContainText("The guide couldn't be updated");
      await both("local-failed");
      claude.failing(false);
      await failure.getByRole("button", "Retry").tap();
      await expect(status).toContainText("Ready", { timeout: 60_000 });
      await expect(failure).toHaveCount(0);

      // A narrow window keeps the header on two lines, the path giving way first.
      await browser.setViewport({ width: 720, height: 860 });
      await expect(heading).toBeVisible();
      await both("local-narrow");
      await browser.setViewport({ width: 1280, height: 860 });

      // The palette lists local reviews; Cmd+2 counts PR tabs only; Cmd+W closes the local
      // tab, and the palette brings it back.
      const palette = async () => {
        await browser.keyboard.press("Meta+k");
        await screen.getByRole("searchbox", "Find a pull request").fill("widgets");
        const group = screen.getByRole("region", "Local reviews");
        await expect(group).toBeVisible();
        return group.getByRole("button").filter({ hasText: TITLE });
      };
      await expect(await palette()).toContainText("Open");
      await both("local-palette");
      await browser.keyboard.press("Escape");
      await browser.keyboard.press("Meta+2");
      await expect(heading).toBeVisible();
      await browser.keyboard.press("Meta+w");
      await expect(tab).toHaveCount(0);
      await (await palette()).tap();
      await expect(tab).toBeVisible();
      await expect(heading).toBeVisible();

      // A relaunch keeps the tab: the server holds it.
      stopFakeInstance(name, { keepHome: true });
      expect(readRows(run.home, "SELECT key FROM open_local_reviews")).toEqual([{ key }]);
      run = start();
      await app.open(run.openUrl);
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.tap();
      await expect(screen.getByText("A guide written by the stand-in agent.")).toBeVisible();
      await app.screenshot("local-relaunch-light");

      // A guide that lands while the user reads something else says so, and opens on a click.
      await browser.keyboard.press("Meta+Comma");
      await screen.getByRole("link", "Appearance").tap();
      fixture.write(
        "docs/handbook.md",
        handbook({ 15: team, 22: "Teams can raise their own limit.", 28: "Limits reset weekly." }),
      );
      expect(decodeGenerate(local(["guide", "--json"]).stdout).outcome).toBe("started");
      const toast = screen.getByText(`${TITLE} · 1 chapter`, { exact: true });
      await expect(toast).toBeVisible({ timeout: 60_000 });
      await expect(screen.getByText("Guide updated", { exact: true })).toBeVisible();
      await app.screenshot("local-notified-light");
      await screen.getByRole("button", "Open").tap();
      await expect(heading).toBeVisible();
      await dismissToasts(browser);

      // Remove, behind a confirmation: the tab goes, and the palette no longer lists it.
      await screen.getByRole("button", "More local review actions").tap();
      await screen.getByRole("menuitem", "Remove local review…").tap();
      const dialog = screen.getByRole("alertdialog");
      await expect(dialog).toContainText(`Remove the local review of ${TITLE}?`);
      await both("local-remove");
      await dialog.getByRole("button", "Remove").tap();
      await expect(tab).toHaveCount(0);
      await expect(screen.getByText("Local review removed", { exact: true })).toBeVisible();
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
      expect(readRows(run.home, "SELECT key FROM open_local_reviews")).toEqual([]);
      await browser.keyboard.press("Meta+k");
      await screen.getByRole("searchbox", "Find a pull request").fill("widgets");
      await expect(screen.getByText("No matching pull requests", { exact: true })).toBeVisible();
      await expect(screen.getByRole("region", "Local reviews")).toHaveCount(0);
      await browser.keyboard.press("Escape");

      // A link to the removed review says it is gone, with a way back.
      await app.open(`${run.url}/local/${key}`);
      await expect(screen.getByRole("heading", "This local review was removed")).toBeVisible({
        timeout: 30_000,
      });
      await both("local-removed");
      await screen.getByRole("link", "Go to Inbox").tap();
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
      // Cmd+W leaves it too, though it has no tab left.
      await app.open(`${run.url}/local/${key}`);
      await expect(screen.getByRole("heading", "This local review was removed")).toBeVisible({
        timeout: 30_000,
      });
      await browser.keyboard.press("Meta+w");
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();

      expect(fixture.fingerprint()).toBe(fingerprint);
      expect(fixture.filterRan()).toBe(false);
      expect(await fake.writes()).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
      keepEvidence(log, started);
    }
  },
);
