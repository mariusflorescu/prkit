import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import { AUTO_RESOLVE_LIMIT } from "../packages/contracts/src/fixer.ts";
import { runForUrl } from "../scripts/verify-run.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  AGENT_WAIT,
  CODEX_RUNS,
  CODEX_SKIP,
  draftOn,
  type Fixtures,
  fixerOf,
  fixesTab,
  openPull,
  openSendToAgent,
  pickModel,
  testsPassed,
  transcriptOf,
} from "./fixActions.ts";
import {
  CONFIG_PATH,
  closeFixFixture,
  commentBodies,
  createConflictFixture,
  createFixFixture,
  fileAt,
  type FixFixture,
  LOCKFILE_PATH,
  pullState,
  pushUnrelated,
  resolveOutside,
  reviewerThread,
} from "./fixFixture.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  FIXTURE_LOGIN,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  readRows,
} from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import { pickGuideRepository } from "./pickers.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";

const REPOSITORY = `github.com/${FIXTURE_REPO}`;

/** GitHub works out mergeability after the PR opens; the header reads it once. */
const conflicting = (fixture: FixFixture) =>
  expect
    .poll(() => pullState(fixture.number).mergeable, { timeout: 60_000, interval: 3_000 })
    .toBe(false);

/** The Settings > Guides > For one repository switches for the fixture repository. */
const setRepositoryOptIn = async (
  fixtures: Fixtures,
  label: "Push fixes automatically" | "Resolve conflicts automatically",
  on: boolean,
) => {
  const { app, screen, browser } = fixtures;
  // The repository picker offers repositories the inbox already loaded.
  await openInbox({ app, screen });
  await expect(screen.getByRole("searchbox", "Search pull requests")).toBeVisible({
    timeout: 60_000,
  });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("link", "Guides").tap();
  await pickGuideRepository(screen, FIXTURE_REPO);
  const panel = screen.getByRole("region", `Fix agent for ${FIXTURE_REPO}`);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const toggle = panel.getByRole("switch", `${label} for ${REPOSITORY}`);
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  return panel;
};

/**
 * What the fix watcher leaves after resolving a PR's conflicts automatically `count`
 * times in the last hours: an active session and one ended conflict turn per time,
 * each on an older head. Written straight into the instance's database, because four
 * real conflicts in a day would take four agent runs.
 *
 * A fix that is pushing holds the checkout, and Stop lets a push finish, so a resolution
 * the watcher starts only queues: it never fetches from github.com with the fake's token
 * or runs an agent.
 */
const seedAutomaticResolutions = (home: string, key: string, accountId: string, count: number) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    const now = Date.now();
    db.prepare(
      "INSERT INTO fixers (id, pr_key, account_id, provider, instance_id, model, model_options, session_id, ended, created_at, updated_at) VALUES ('seeded-fixer', ?, ?, 'claude', 'claude', NULL, '[]', NULL, NULL, ?, ?)",
    ).run(key, accountId, new Date(now - 4 * 3_600_000).toISOString(), new Date(now).toISOString());
    for (let index = 1; index <= count; index++) {
      const at = new Date(now - (count + 1 - index) * 3_600_000).toISOString();
      db.prepare(
        `INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, instance_id, head_sha, conflicted, created_at, started_at, finished_at)
          VALUES (?, 'seeded-fixer', 'conflicts', '{"_tag":"conflicts","strategy":"merge"}', 'auto',
            '{"_tag":"discarded","reason":"upstream","message":"The new head no longer conflicts"}', 'claude', 'claude', ?, '[]', ?, ?, ?)`,
      ).run(`seeded-turn-${index}`, `${index}`.repeat(40), at, at, at);
    }
    const pushing = new Date(now - 30 * 60_000).toISOString();
    db.prepare(
      `INSERT INTO fixer_turns (id, fixer_id, kind, work, trigger, status, provider, instance_id, head_sha, conflicted, created_at, started_at, finished_at)
        VALUES ('seeded-push', 'seeded-fixer', 'fix', ?, 'user', '{"_tag":"pushing"}', 'claude', 'claude', ?, '[]', ?, ?, NULL)`,
    ).run(
      JSON.stringify({
        _tag: "fix",
        comments: [
          {
            id: "c1",
            source: { _tag: "draft", draftId: "seeded-draft" },
            path: "src/change-0.ts",
            lines: null,
            snippet: "",
            body: "Name the change.",
          },
        ],
        note: null,
        replyAfterPush: false,
      }),
      "0".repeat(40),
      pushing,
      pushing,
    );
  } finally {
    db.close();
  }
};

const WAITS_FOR_YOU = `prkit already resolved this pull request's conflicts automatically ${AUTO_RESOLVE_LIMIT} times in the last 24 hours, so this one waits for you.`;

/**
 * The fake GitHub's PR 3 after `seeded` automatic resolutions: it conflicts, Settings turns
 * on Resolve conflicts automatically for its repository, and its Fixes tab opens. The
 * watcher reads every five seconds.
 */
const conflictWhileResolvingAutomatically = async (
  { app, screen, browser }: Fixtures,
  fake: FakeGitHub,
  name: string,
  seeded: number,
) => {
  const run = startFakeInstance(name, fake, ["--watch-interval", "5000", "--e2e"]);
  seedAutomaticResolutions(
    run.home,
    "github.com/budget/fixtures#3",
    "github.com/budget-test",
    seeded,
  );
  await fake.conflict(3);
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("link", "Guides").tap();
  await pickGuideRepository(screen, "budget/fixtures");
  const automatic = screen
    .getByRole("region", "Fix agent for budget/fixtures")
    .getByRole("switch", "Resolve conflicts automatically for github.com/budget/fixtures");
  await automatic.tap({ timeout: 30_000 });
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await app.open(
    `${run.url}/pr/github.com/budget/fixtures/3?account=github.com%2Fbudget-test&tab=fixes`,
  );
  return {
    run,
    banner: screen.getByRole("status").filter({ hasText: "This branch conflicts with main." }),
    reads: async () => (await fake.stats()).byKind["graphql:fingerprint"] ?? 0,
    conflictTurns: () =>
      readRows(
        run.home,
        "SELECT COUNT(*) AS turns, SUM(trigger = 'auto') AS automatic FROM fixer_turns WHERE kind = 'conflicts'",
      ),
  };
};

describe("the fix agent, without running an agent", () => {
  test(
    "Send to agent offers the drafts, the agent and where the push goes, and the repository opt-ins save",
    { timeout: 300_000, skip: NEEDS_FIXTURE },
    async (fixtures) => {
      const { app, screen } = fixtures;
      const fixture = createFixFixture(`${Date.now()}`);
      try {
        // Nothing went to the agent yet: no Fixes tab, and a link to it opens Conversation.
        await openPull(fixtures, fixture, "fixes");
        const tabs = screen.getByRole("navigation", "Pull request tabs");
        await expect(tabs.getByRole("link", "Conversation")).toHaveAttribute(
          "aria-current",
          "page",
          { timeout: 30_000 },
        );
        await expect(fixesTab(fixtures)).toHaveCount(0);
        await app.screenshot("fixes-hidden");

        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(fixtures, 3, "Rename `MAX_CODE_LENGTH` to `CODE_LIMIT`.");
        await expect(
          screen.getByRole("button", `Send the comment on ${LIMITS_PATH} line 3 to agent`),
        ).toBeVisible();

        const dialog = await openSendToAgent(fixtures, 1);
        await expect(
          dialog.getByRole("checkbox", `Your draft on ${LIMITS_PATH} line 3`),
        ).toBeChecked();
        await expect(
          dialog.getByRole("status").filter({ hasText: "You review the changes" }),
        ).toContainText(`before prkit pushes them to ${fixture.head}`, { timeout: 30_000 });
        await expect(dialog.getByRole("button", "Send 1 comment to agent")).toBeEnabled();
        await app.screenshot("send-to-agent-form");
        await dialog.getByRole("checkbox", `Your draft on ${LIMITS_PATH} line 3`).tap();
        await expect(dialog.getByRole("button", "Send 0 comments to agent")).toBeVisible();
        await dialog.getByRole("button", "Cancel").tap();
        // Nothing went to the agent: the draft is still the owner's.
        expect(
          readRows(
            runForUrl(app.baseUrl).home,
            `SELECT state FROM pending_comments WHERE pr_key = 'github.com/${FIXTURE_REPO}#${fixture.number}'`,
          ),
        ).toEqual([{ state: "draft" }]);
        expect(
          readRows(runForUrl(app.baseUrl).home, "SELECT COUNT(*) AS turns FROM fixer_turns"),
        ).toEqual([{ turns: 0 }]);

        const panel = await setRepositoryOptIn(fixtures, "Push fixes automatically", true);
        await app.screenshot("repository-fix-settings");
        expect(
          readRows(
            runForUrl(app.baseUrl).home,
            `SELECT push_automatically AS push, resolve_automatically AS resolve FROM fixer_repository_settings WHERE repository = '${REPOSITORY}'`,
          ),
        ).toEqual([{ push: 1, resolve: 0 }]);
        await panel.getByRole("switch", `Push fixes automatically for ${REPOSITORY}`).tap();
        await expect(
          panel.getByRole("switch", `Push fixes automatically for ${REPOSITORY}`),
        ).toHaveAttribute("aria-checked", "false");

        // Journeys share an instance: leave no draft behind for the next one.
        await openPull(fixtures, fixture, "files");
        await screen.getByRole("button", "Delete pending comment").tap({ timeout: 60_000 });
        await expect(
          screen.getByRole("article", `Pending comment on ${LIMITS_PATH} line 3`),
        ).toHaveCount(0);
      } finally {
        closeFixFixture(fixture);
      }
    },
  );

  test(
    "Send to agent says whether the agent runs a pull request's scripts, and the repository opt-in lets it run them on a fork",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      // GitHub has no fork PR on the fixture repository, so this journey reads the fake GitHub.
      const fake = await startFakeGitHub("fix-scripts");
      try {
        const run = startFakeInstance("fix-scripts", fake);
        // Before anything went to the agent, Send to agent is where the notice shows.
        const sendToAgent = async (number: number) => {
          await app.open(
            `${run.url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=conversation`,
          );
          await screen.getByRole("button", "Review").first().tap({ timeout: 30_000 });
          await screen
            .getByRole("group", "Where your comments go")
            .getByRole("button", "Send to agent")
            .tap();
        };
        const notice = screen
          .getByRole("dialog", "Send to agent")
          .getByRole("status", "Check scripts");
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
          timeout: 20_000,
        });

        await sendToAgent(7);
        await expect(notice).toHaveText(
          "The agent runs none of this pull request's scripts: it comes from a fork, outsider/fixtures. It reads and edits files only.",
          { timeout: 30_000 },
        );
        await app.screenshot("fork-runs-no-scripts");

        await sendToAgent(1);
        await expect(notice).toHaveText(
          "The agent may run this repository's test, lint and type check scripts: you opened it.",
          { timeout: 30_000 },
        );
        await app.screenshot("own-pull-request-runs-scripts");
        await browser.keyboard.press("Escape");

        const modifier = await browser.evaluate(() =>
          /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
        );
        await browser.keyboard.press(`${modifier}+Comma`);
        await screen.getByRole("link", "Guides").tap();
        await pickGuideRepository(screen, "budget/fixtures");
        const panel = screen.getByRole("region", "Fix agent for budget/fixtures");
        const optIn = panel.getByRole(
          "switch",
          "Run check scripts on any pull request for github.com/budget/fixtures",
        );
        await expect(optIn).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
        await optIn.tap();
        await expect(optIn).toHaveAttribute("aria-checked", "true");
        await app.screenshot("run-scripts-on-any-pull-request");
        expect(
          readRows(
            run.home,
            "SELECT push_automatically AS push, run_scripts_anywhere AS scripts FROM fixer_repository_settings",
          ),
        ).toEqual([{ push: 0, scripts: 1 }]);

        await sendToAgent(7);
        await expect(notice).toHaveText(
          "The agent may run this repository's test, lint and type check scripts: you allowed it on every pull request in budget/fixtures.",
          { timeout: 30_000 },
        );
        await app.screenshot("fork-runs-scripts-after-opt-in");
      } finally {
        stopFakeInstance("fix-scripts", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "the Fixes tab shows once something went to the agent, a fix or a conflict resolution",
    { timeout: 240_000 },
    async ({ app, screen, browser }) => {
      // Each PR merges on the fake GitHub just before its turn starts, so the turn ends
      // at once: no checkout, no agent run, and still a turn for the Fixes tab to show.
      const fake = await startFakeGitHub("fixes-tab");
      const claude = setUpFakeClaude("fixes-tab");
      try {
        await fake.conflict(4);
        const run = startFakeInstance("fixes-tab", fake, ["--claude", claude.file]);
        const pull = (number: number, tab: string) =>
          `${run.url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=${tab}`;
        // Remembers any part of the Fixes tab that reached the page, even for one frame.
        await browser.addInitScript(`(() => {
          const fixes = () =>
            document.querySelector('[aria-label="Loading fixes"], ol[aria-label="Fixes"]') !== null ||
            [...document.querySelectorAll('nav[aria-label="Pull request tabs"] a')].some((node) =>
              /^Fixes/.test(node.textContent ?? ""));
          new MutationObserver(() => {
            if (fixes()) sessionStorage.setItem("fixes-painted", location.href);
          }).observe(document, { childList: true, subtree: true, characterData: true });
        })()`);
        const painted = () => browser.evaluate(() => sessionStorage.getItem("fixes-painted"));
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
          timeout: 20_000,
        });
        const tabs = screen.getByRole("navigation", "Pull request tabs");
        const fixes = tabs.getByRole("link", /^Fixes/);

        // Nothing sent: a Fixes link, or the tab remembered, opens Conversation, with no flash.
        await app.open(pull(3, "fixes"));
        await expect(tabs.getByRole("link", "Conversation")).toHaveAttribute(
          "aria-current",
          "page",
          { timeout: 30_000 },
        );
        await expect(fixes).toHaveCount(0);
        await expect.poll(() => browser.url()).toContain("tab=conversation");
        expect(await painted()).toBeNull();
        await app.screenshot("no-fixes-tab");

        // Send to agent.
        await app.open(pull(9, "files"));
        const file = screen.getByRole("region", "src/limits.ts");
        await expect(file.getByRole("button", "Comment on line 1")).toBeVisible({
          timeout: 30_000,
        });
        await file.getByRole("button", "src/limits.ts").focus();
        await browser.keyboard.press("Tab");
        await browser.keyboard.press("ArrowDown");
        await browser.keyboard.press("ArrowDown");
        await browser.keyboard.press("Enter");
        await expect(screen.getByRole("textbox", "Comment on line 2")).toBeFocused();
        await browser.keyboard.type("Name the limit.");
        await browser.keyboard.press("Meta+Enter");
        await expect(
          screen.getByRole("article", "Pending comment on src/limits.ts line 2"),
        ).toBeVisible();
        await expect(fixes).toHaveCount(0);
        expect(await painted()).toBeNull();
        await screen.getByRole("button", "Review, 1 pending").first().tap();
        await screen
          .getByRole("group", "Where your comments go")
          .getByRole("button", "Send to agent")
          .tap();
        const send = screen.getByRole("dialog", "Send to agent");
        await expect(send.getByRole("button", /^Agent and model: /)).toBeVisible({
          timeout: 30_000,
        });
        await fake.merge(9);
        await send.getByRole("button", "Send 1 comment to agent").tap();
        await expect(screen.getByText("Sent to the agent")).toBeVisible({ timeout: 30_000 });
        await expect(fixes).toBeVisible();
        await app.screenshot("fixes-tab-after-send");
        await screen.getByRole("button", "Open Fixes").tap();
        await expect(fixes).toHaveAttribute("aria-current", "page");
        await expect(screen.getByRole("list", "Fixes").getByRole("article")).toHaveCount(1, {
          timeout: 30_000,
        });
        // Once there, a link to it opens it.
        await app.open(pull(9, "fixes"));
        await expect(screen.getByRole("list", "Fixes")).toBeVisible({ timeout: 30_000 });

        // Resolve conflicts.
        await app.open(pull(4, "conversation"));
        await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 30_000 });
        const resolve = screen.getByRole("form", "Resolve conflicts");
        await expect(resolve.getByRole("button", /^Agent and model: /)).toBeVisible({
          timeout: 30_000,
        });
        await expect(fixes).toHaveCount(0);
        await fake.merge(4);
        await resolve.getByRole("button", "Resolve with the agent").tap();
        await expect(fixes).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
        const resolution = screen.getByRole("list", "Fixes").getByRole("article");
        await expect(resolution).toHaveCount(1, { timeout: 30_000 });
        await expect(resolution).not.toContainText("Preparing", { timeout: 30_000 });
        await app.screenshot("fixes-tab-after-resolve");
      } finally {
        stopFakeInstance("fixes-tab", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "below the daily limit the watcher starts an automatic resolution, which queues behind a push",
    { timeout: 180_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      const fake = await startFakeGitHub("auto-resolve-below-cap");
      try {
        const { run, banner, reads, conflictTurns } = await conflictWhileResolvingAutomatically(
          fixtures,
          fake,
          "auto-resolve-below-cap",
          AUTO_RESOLVE_LIMIT - 1,
        );
        const started = screen.getByRole("article", /^Merge .+ into this branch: Queued$/);
        await expect(started).toBeVisible({ timeout: 30_000 });
        await expect(started).toContainText("Started automatically");
        await expect(started).toContainText(
          "Waits for the turn above: push or discard it, and this one starts.",
        );
        await expect(banner).toHaveCount(0);
        await app.screenshot("auto-resolve-below-cap-queued");
        expect(
          readRows(
            run.home,
            "SELECT json_extract(status, '$._tag') AS status, trigger FROM fixer_turns WHERE kind = 'conflicts' ORDER BY created_at DESC LIMIT 1",
          ),
        ).toEqual([{ status: "queued", trigger: "auto" }]);
        // One queued resolution is enough: later reads of the same conflict add none.
        const before = await reads();
        await expect.poll(reads, { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 3);
        expect(conflictTurns()).toEqual([
          { turns: AUTO_RESOLVE_LIMIT, automatic: AUTO_RESOLVE_LIMIT },
        ]);
      } finally {
        stopFakeInstance("auto-resolve-below-cap", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "after three automatic resolutions in a day the next conflict waits for a click, even after Stop, and the Fixes tab says so",
    { timeout: 180_000 },
    async (fixtures) => {
      const { app, screen } = fixtures;
      const fake = await startFakeGitHub("auto-resolve-cap");
      try {
        const { run, banner, reads, conflictTurns } = await conflictWhileResolvingAutomatically(
          fixtures,
          fake,
          "auto-resolve-cap",
          AUTO_RESOLVE_LIMIT,
        );
        await expect(banner).toContainText(WAITS_FOR_YOU, { timeout: 30_000 });
        await expect(banner.getByRole("button", "Resolve conflicts")).toBeVisible();
        await app.screenshot("auto-resolve-cap-waits");
        // The watcher keeps reading the conflicting PR and starts nothing.
        const before = await reads();
        await expect.poll(reads, { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 3);
        expect(conflictTurns()).toEqual([
          { turns: AUTO_RESOLVE_LIMIT, automatic: AUTO_RESOLVE_LIMIT },
        ]);

        // The limit is the pull request's, not the session's: after Stop it still holds.
        await screen.getByRole("button", "Stop agent").tap();
        await expect(screen.getByRole("button", "Stop agent")).toHaveCount(0, { timeout: 30_000 });
        expect(readRows(run.home, "SELECT ended FROM fixers")).toEqual([{ ended: "stopped" }]);
        const stopped = await reads();
        await expect.poll(reads, { timeout: 30_000 }).toBeGreaterThanOrEqual(stopped + 3);
        expect(conflictTurns()).toEqual([
          { turns: AUTO_RESOLVE_LIMIT, automatic: AUTO_RESOLVE_LIMIT },
        ]);
        expect(readRows(run.home, "SELECT ended FROM fixers")).toEqual([{ ended: "stopped" }]);
        await expect(banner).toContainText(WAITS_FOR_YOU);
        await app.screenshot("auto-resolve-cap-after-stop");
      } finally {
        stopFakeInstance("auto-resolve-cap", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "a conflicting PR offers Resolve conflicts with the agent, and its tab shows the warning dot",
    { timeout: 240_000, skip: NEEDS_FIXTURE },
    async (fixtures) => {
      const { app, screen, browser } = fixtures;
      const fixture = createConflictFixture(`${Date.now()}`, { lockfile: false });
      try {
        await conflicting(fixture);
        await openPull(fixtures, fixture, "conversation");
        const resolve = screen.getByRole("button", "Resolve conflicts").first();
        await expect(resolve).toBeVisible({ timeout: 60_000 });
        await expect(browser.locator("[data-conflicting]").first()).toBeAttached();
        await resolve.tap();
        const form = screen.getByRole("form", "Resolve conflicts");
        await expect(form.getByRole("radio", /^Merge e2e\/fix-base-/)).toBeChecked();
        // The fixture PR is the account's own, so a rebase is offered too.
        await expect(form.getByRole("radio", /^Rebase onto e2e\/fix-base-/)).toBeEnabled();
        await expect(form.getByRole("link", "Resolve on GitHub instead")).toHaveAttribute(
          "href",
          `https://github.com/${FIXTURE_REPO}/pull/${fixture.number}/conflicts`,
        );
        await expect(form.getByRole("button", /^Agent and model: /)).toBeVisible({
          timeout: 30_000,
        });
        await app.screenshot("resolve-conflicts-popover");
      } finally {
        closeFixFixture(fixture);
      }
    },
  );
});

describe("the fix agent with Claude", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Copy patch puts a patch on the clipboard that git apply accepts on the PR head and that makes the fix's commit",
    { timeout: 900_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen, browser } = fixtures;
      const run = runForUrl(app.baseUrl);
      const fixture = createFixFixture(`${Date.now()}`);
      const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-patch-"));
      // The headless browser refuses clipboard writes, so the journey stands in for the
      // clipboard and keeps exactly what the app writes to it.
      await browser.addInitScript(() => {
        navigator.clipboard.writeText = async (text) => {
          sessionStorage.setItem("e2e-clipboard", text);
        };
      });
      try {
        await openPull(fixtures, fixture, "files");
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(
          fixtures,
          3,
          "Rename `MAX_CODE_LENGTH` to `CODE_LIMIT` everywhere it is used.",
        );
        const dialog = await openSendToAgent(fixtures, 1);
        await pickModel(fixtures, dialog, "sonnet", /Claude Sonnet/);
        await dialog.getByRole("button", "Send 1 comment to agent").tap();
        await fixesTab(fixtures).tap();
        const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
        await expect(ready).toBeVisible({ timeout: AGENT_WAIT });
        await ready.getByRole("button", "Copy patch").tap();
        await expect(screen.getByRole("region", "Notifications")).toContainText("Patch copied", {
          timeout: 30_000,
        });
        await app.screenshot("patch-copied");
        const patch = await browser.evaluate(() => sessionStorage.getItem("e2e-clipboard"));
        if (patch === null) throw new Error("Copy patch put nothing on the clipboard.");
        const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(
          (match) => match[1] ?? "",
        );
        expect(paths).toContain(LIMITS_PATH);
        // The PR head as GitHub has it: every file the patch touches, in a folder of its own.
        for (const path of paths) {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(scratch, path)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(scratch, path), fileAt(fixture.head, path));
        }
        NodeFS.writeFileSync(NodePath.join(scratch, "fix.patch"), patch);
        const apply = (args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", ["apply", ...args, "fix.patch"], {
            cwd: scratch,
            env: childEnv(process.env),
            encoding: "utf8",
          });
        apply(["--check"]);
        apply([]);
        const [turn] = readRows(
          run.home,
          "SELECT commit_sha AS sha FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
        );
        const fixer = fixerOf(run.home, fixture.number);
        if (typeof fixer?.id !== "string" || typeof turn?.sha !== "string")
          throw new Error("The fix has no session or commit.");
        for (const path of paths)
          expect(NodeFS.readFileSync(NodePath.join(scratch, path), "utf8")).toBe(
            NodeChildProcess.execFileSync(
              "git",
              ["-C", NodePath.join(run.home, "fixes", fixer.id), "show", `${turn.sha}:${path}`],
              { env: childEnv(process.env), encoding: "utf8" },
            ),
          );
        NodeFS.mkdirSync(".e2e/evidence/fix-agent", { recursive: true });
        NodeFS.writeFileSync(".e2e/evidence/fix-agent/copied.patch", patch);
        await ready.getByRole("button", "Discard").tap();
        await expect(screen.getByRole("article", "Fix 1 comment: Discarded")).toBeVisible({
          timeout: 30_000,
        });
      } finally {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
        closeFixFixture(fixture);
      }
    },
  );

  test(
    "Claude fixes two drafts and a GitHub thread and runs the tests; Push lands the commit, answers the thread, and the guide moves to revision 2; Discard leaves nothing",
    { timeout: 1_800_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen } = fixtures;
      const run = runForUrl(app.baseUrl);
      const fixture = createFixFixture(`${Date.now()}`);
      reviewerThread(
        fixture,
        12,
        "checkUrl returns null for a valid URL. Say so in a comment above the return.",
      );
      try {
        await openPull(fixtures, fixture, "guide");
        await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
        await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
          timeout: AGENT_WAIT,
        });

        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(
          fixtures,
          3,
          "Rename `MAX_CODE_LENGTH` to `CODE_LIMIT` everywhere it is used.",
        );
        await draftOn(
          fixtures,
          17,
          "Add a test in test/limits.test.js that checkCode rejects a code longer than the limit.",
        );
        const dialog = await openSendToAgent(fixtures, 2);
        // The fixture's thread is the account's own comment, so it waits on nobody and isn't
        // picked by default; picked, it is answered after the push by default on your own PR.
        const thread = dialog.getByRole(
          "checkbox",
          new RegExp(`^Thread by ${FIXTURE_LOGIN} on src/limits\\.js line 12$`),
        );
        await expect(thread).not.toBeChecked({ timeout: 30_000 });
        await thread.tap();
        await expect(
          dialog.getByRole(
            "checkbox",
            "Reply on GitHub threads with what was fixed, once it's pushed",
          ),
        ).toBeChecked();
        await pickModel(fixtures, dialog, "sonnet", /Claude Sonnet/);
        await dialog.getByRole("button", "Send 3 comments to agent").tap();
        await expect(screen.getByText("Sent to the agent")).toBeVisible({ timeout: 30_000 });
        expect(
          readRows(
            run.home,
            `SELECT state FROM pending_comments WHERE pr_key = 'github.com/${FIXTURE_REPO}#${fixture.number}'`,
          ),
        ).toEqual([{ state: "sent-to-agent" }, { state: "sent-to-agent" }]);
        await fixesTab(fixtures).tap();
        const ready = screen.getByRole("article", "Fix 3 comments: Ready to review");
        await expect(ready).toBeVisible({ timeout: AGENT_WAIT });
        await expect(ready.getByRole("list", "What the agent did")).toContainText("Fixed");
        await expect(ready.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 30_000 });
        // The account's own PR from the repository itself: its scripts run, and the
        // first turn lists them with their commands.
        await expect(screen.getByRole("status", "Check scripts")).toHaveText(
          "The agent may run this repository's test, lint and type check scripts: you opened it.",
        );
        await expect(ready.getByRole("list", "Scripts the agent may run")).toContainText(
          "npm test",
        );
        await app.screenshot("claude-fixes-ready");
        const [turn] = readRows(
          run.home,
          "SELECT commit_sha AS sha, report FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
        );
        const activity = readRows(run.home, "SELECT text, detail FROM fixer_activity").map(
          (row) => `${String(row.text)} ${String(row.detail)}`,
        );
        expect(activity.some((text) => /npm (run )?test/.test(text))).toBe(true);
        const fixer = fixerOf(run.home, fixture.number);
        if (typeof fixer?.id !== "string") throw new Error("No fix session was saved.");
        const checkout = NodePath.join(run.home, "fixes", fixer.id);
        // The PR's own tests ran, and passed, inside the turn's sandbox.
        expect(testsPassed(transcriptOf(run.home, "claude", checkout, String(fixer.session)))).toBe(
          true,
        );
        expect(
          readRows(
            run.home,
            "SELECT json_extract(scripts, '$._tag') AS scripts, json_extract(scripts, '$.reason') AS reason FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
          ),
        ).toEqual([{ scripts: "allowed", reason: "you opened it" }]);
        if (typeof turn?.sha !== "string") throw new Error("The fix has no commit.");

        await ready.getByRole("button", "Push").tap();
        await expect(screen.getByRole("article", "Fix 3 comments: Pushed")).toBeVisible({
          timeout: 120_000,
        });
        await expect.poll(() => pullState(fixture.number).head, { timeout: 60_000 }).toBe(turn.sha);
        await expect
          .poll(
            () =>
              commentBodies(fixture.number).some((body) =>
                body.startsWith(`Addressed in ${turn.sha}`),
              ),
            {
              timeout: 60_000,
              interval: 5_000,
            },
          )
          .toBe(true);
        expect(
          readRows(
            run.home,
            `SELECT state FROM pending_comments WHERE pr_key = 'github.com/${FIXTURE_REPO}#${fixture.number}'`,
          ),
        ).toEqual([{ state: "resolved-by-agent" }, { state: "resolved-by-agent" }]);
        await app.screenshot("claude-fixes-pushed");

        // The review watcher (5 seconds in e2e) picks up the pushed head on its own.
        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
        await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2 · ", {
          timeout: AGENT_WAIT,
        });
        expect(
          readRows(
            run.home,
            "SELECT revision, head_sha AS head FROM review_revisions ORDER BY revision",
          ).at(-1),
        ).toEqual({ revision: 2, head: turn.sha });
        await app.screenshot("guide-revision-2");

        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(fixtures, 7, "Add a JSDoc comment to checkUrl explaining each return value.");
        await (
          await openSendToAgent(fixtures, 1)
        )
          .getByRole("button", "Send 1 comment to agent")
          .tap();
        await fixesTab(fixtures).tap();
        const second = screen.getByRole("article", "Fix 1 comment: Ready to review");
        await expect(second).toBeVisible({ timeout: AGENT_WAIT });
        // Same scripts as the first turn, so only the first lists them.
        await expect(second.getByRole("list", "Scripts the agent may run")).toHaveCount(0);
        await second.getByRole("button", "Discard").tap();
        await expect(screen.getByRole("article", "Fix 1 comment: Discarded")).toBeVisible({
          timeout: 30_000,
        });
        await app.screenshot("claude-fix-discarded");
        expect(pullState(fixture.number).head).toBe(turn.sha);
        const git = (args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", ["-C", checkout, ...args], {
            env: childEnv(process.env),
            encoding: "utf8",
          }).trim();
        expect(git(["rev-parse", "HEAD"])).toBe(turn.sha);
        expect(git(["status", "--porcelain"])).toBe("");
        expect(git(["for-each-ref", "refs/prkit/fixes"])).toBe("");
        expect(
          readRows(run.home, "SELECT state FROM pending_comments WHERE body LIKE 'Add a JSDoc%'"),
        ).toEqual([{ state: "draft" }]);
      } finally {
        closeFixFixture(fixture);
      }
    },
  );

  test(
    "Claude resolves conflicts; a lockfile waits for the owner and is never pushed automatically",
    { timeout: 900_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen } = fixtures;
      const fixture = createConflictFixture(`${Date.now()}`, { lockfile: true });
      try {
        await setRepositoryOptIn(fixtures, "Push fixes automatically", true);
        await conflicting(fixture);
        await openPull(fixtures, fixture, "conversation");
        await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
        await screen.getByRole("button", "Resolve with the agent").tap({ timeout: 30_000 });
        const ready = screen.getByRole(
          "article",
          /^Merge e2e\/fix-base-.* into this branch: Ready to review$/,
        );
        await expect(ready).toBeVisible({ timeout: AGENT_WAIT });
        const files = ready.getByRole("list", "Conflicted files");
        await expect(files).toContainText(LOCKFILE_PATH);
        await expect(files).toContainText("Needs you");
        await expect(files).toContainText(CONFIG_PATH);
        await expect(ready).toContainText("prkit never pushes this automatically");
        await app.screenshot("conflicts-resolved-lockfile");
        // Auto-push is on for the repository, and still nothing was pushed.
        expect(pullState(fixture.number).mergeable).toBe(false);
        await ready.getByRole("button", "Push").tap();
        await expect(
          screen.getByRole("article", /^Merge e2e\/fix-base-.* into this branch: Pushed$/),
        ).toBeVisible({ timeout: 120_000 });
        await expect
          .poll(() => pullState(fixture.number).mergeable, { timeout: 120_000, interval: 5_000 })
          .toBe(true);
        await app.screenshot("conflicts-pushed");
      } finally {
        await setRepositoryOptIn(fixtures, "Push fixes automatically", false).catch(
          () => undefined,
        );
        closeFixFixture(fixture);
      }
    },
  );

  test(
    "a push to the branch first makes Push redo the merge; resolving it outside prkit drops the redo",
    { timeout: 1_200_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen } = fixtures;
      const fixture = createConflictFixture(`${Date.now()}`, { lockfile: false });
      try {
        await conflicting(fixture);
        await openPull(fixtures, fixture, "conversation");
        await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
        await screen.getByRole("button", "Resolve with the agent").tap({ timeout: 30_000 });
        const turns = screen.getByRole("list", "Fixes");
        await expect(turns.getByRole("article", /Ready to review$/)).toBeVisible({
          timeout: AGENT_WAIT,
        });
        const before = pullState(fixture.number).head;
        pushUnrelated(fixture, `${Date.now()}`);
        await turns
          .getByRole("article", /Ready to review$/)
          .getByRole("button", "Push")
          .tap();
        await expect(screen.getByText("The branch moved")).toBeVisible({ timeout: 60_000 });
        await expect(turns).toContainText("prkit pushed nothing and is redoing it on the new head");
        await app.screenshot("branch-moved-redo");
        const redo = turns.getByRole("article").first();
        await expect(redo).toContainText("Redone after the branch moved");
        await expect(redo).toContainText("Ready to review", { timeout: AGENT_WAIT });
        expect(pullState(fixture.number).head).not.toBe(before);

        resolveOutside(fixture, { lockfile: false });
        await expect(redo).toContainText("Resolved outside prkit", { timeout: 180_000 });
        await app.screenshot("resolved-outside-prkit");
      } finally {
        closeFixFixture(fixture);
      }
    },
  );
});

describe("the fix agent with Codex", { tags: ["codex"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Codex fixes a draft and resolves a conflict, and a second batch resumes its thread",
    { timeout: 1_500_000 },
    async (fixtures) => {
      test.skip(!CODEX_RUNS, CODEX_SKIP);
      const { app, screen } = fixtures;
      const run = runForUrl(app.baseUrl);
      const fixture = createFixFixture(`${Date.now()}`);
      const conflict = createConflictFixture(`${Date.now()}`, { lockfile: false });
      try {
        await openPull(fixtures, fixture, "files");
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(
          fixtures,
          3,
          "Rename `MAX_CODE_LENGTH` to `CODE_LIMIT` everywhere it is used.",
        );
        const dialog = await openSendToAgent(fixtures, 1);
        await pickModel(fixtures, dialog, "GPT", /GPT/);
        await dialog.getByRole("button", "Send 1 comment to agent").tap();
        await fixesTab(fixtures).tap();
        const first = screen.getByRole("article", "Fix 1 comment: Ready to review");
        await expect(first).toBeVisible({ timeout: AGENT_WAIT });
        await first.getByRole("button", "Push").tap();
        await expect(screen.getByRole("article", "Fix 1 comment: Pushed")).toBeVisible({
          timeout: 120_000,
        });
        // This PR's own session: a codex-tagged run's earlier journeys leave theirs too.
        const session = fixerOf(run.home, fixture.number);
        expect(session?.provider).toBe("codex");
        // The PR's own tests ran, and passed, inside the turn's sandbox profile.
        expect(
          transcriptOf(
            run.home,
            "codex",
            NodePath.join(run.home, "fixes", String(session?.id)),
            String(session?.session),
          )
            .flatMap((text) => text.split("\n"))
            .some(
              (line) =>
                line.includes('"CommandExecution"') &&
                /npm (run )?test/.test(line) &&
                line.includes('"exit_code":0') &&
                /pass 2\b/.test(line),
            ),
        ).toBe(true);

        await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(fixtures, 7, "Add a JSDoc comment to checkUrl explaining each return value.");
        await (
          await openSendToAgent(fixtures, 1)
        )
          .getByRole("button", "Send 1 comment to agent")
          .tap();
        await fixesTab(fixtures).tap();
        await expect(screen.getByRole("article", "Fix 1 comment: Ready to review")).toBeVisible({
          timeout: AGENT_WAIT,
        });
        // The same Codex thread: no new conversation, and the stored session didn't change.
        expect(fixerOf(run.home, fixture.number)?.session).toBe(session?.session);
        expect(
          readRows(
            run.home,
            "SELECT COUNT(*) AS fresh FROM fixer_activity WHERE text LIKE '%starts a new one%'",
          ),
        ).toEqual([{ fresh: 0 }]);
        await app.screenshot("codex-second-batch");

        await conflicting(conflict);
        await openPull(fixtures, conflict, "conversation");
        await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
        const form = screen.getByRole("form", "Resolve conflicts");
        await pickModel(fixtures, form, "GPT", /GPT/);
        await form.getByRole("button", "Resolve with the agent").tap();
        const resolved = screen.getByRole(
          "article",
          /^Merge e2e\/fix-base-.* into this branch: Ready to review$/,
        );
        await expect(resolved).toBeVisible({ timeout: AGENT_WAIT });
        await expect(resolved.getByRole("list", "Conflicted files")).toContainText(CONFIG_PATH);
        await app.screenshot("codex-conflicts-resolved");
        await resolved.getByRole("button", "Push").tap();
        await expect
          .poll(() => pullState(conflict.number).mergeable, { timeout: 120_000, interval: 5_000 })
          .toBe(true);
      } finally {
        closeFixFixture(fixture);
        closeFixFixture(conflict);
      }
    },
  );
});
