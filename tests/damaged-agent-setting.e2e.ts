import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { pressShortcut } from "./shortcut.ts";

const ACCOUNT = "github.com/budget-test";
const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const guideUrl = (base: string, number: number) =>
  `${base}/pr/github.com/budget/fixtures/${number}?account=${encodeURIComponent(ACCOUNT)}&tab=guide`;
const SECOND_DAMAGED =
  "prkit couldn't read the setting for claude_second, so nothing runs on it. Remove it in Settings > Agents, then add it again.";
const CLAUDE_DAMAGED =
  "prkit couldn't read the setting for Claude, so nothing runs on it. Reset it to default in Settings > Agents.";

const write = (home: string, statement: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
};
/** An agent setting row; `not json` as its environment is what damage or a broken write leaves. */
const setting = (
  id: string,
  { kind = "claude", enabled = 1, configDir = "NULL", environment = "not json" } = {},
) => {
  const at = new Date().toISOString();
  return `INSERT INTO agent_instances (id, kind, label, accent, enabled, config_dir, binary_path,
    environment, login, created_at, updated_at)
    VALUES ('${id}', '${kind}', '${id}', NULL, ${enabled}, ${configDir}, NULL, '${environment}',
      'shared', '${at}', '${at}')`;
};
const revisions = (home: string, number: number) =>
  readRows(
    home,
    `SELECT count(*) AS n FROM review_revisions r JOIN reviews v ON v.id = r.review_id
     WHERE v.pr_key = '${keyOf(number)}'`,
  )[0]?.n;
const lastAttempt = (home: string, number: number) =>
  readRows(
    home,
    `SELECT a.instance_id AS instance, a.outcome AS outcome FROM review_attempts a
     JOIN reviews v ON v.id = a.review_id WHERE v.pr_key = '${keyOf(number)}'
     ORDER BY a.rowid DESC LIMIT 1`,
  )[0];

const openAgents = async ({ screen, browser }: { screen: Screen; browser: Browser }) => {
  await pressShortcut(screen, browser, "Comma");
  await screen.getByRole("link", "Agents").tap();
  await expect(screen.getByRole("list", "Agents")).toBeVisible({ timeout: 30_000 });
};

test(
  "an agent setting prkit can't read is its own row with Remove or Reset, the others work, and nothing set to use it runs on another login",
  { timeout: 600_000 },
  async ({ app, screen, browser }) => {
    const name = "damaged-agent-setting";
    const claude = setUpFakeClaude(name);
    const fake = await startFakeGitHub(name);
    const git = outsideGit(name);
    const launch = () => git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
    try {
      for (const number of [4, 6]) await fake.gitHead(number, git.head(number));
      let run = launch();
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 800 });
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      for (const number of [4, 6]) {
        await screen.getByRole("link", new RegExp(`#${number} `)).hover();
        await screen.getByRole("button", `Generate guide for budget/fixtures #${number}`).tap();
        await expect.poll(() => revisions(run.home, number), { timeout: 120_000 }).toBe(1);
      }

      // While prkit is closed, #4's guide moves to an added Claude whose kind is all that is
      // damaged.
      stopFakeInstance(name, { keepHome: true });
      write(
        run.home,
        `${setting("claude_second", { kind: "garbage", environment: "[]" })};
         UPDATE reviews SET instance_id = 'claude_second' WHERE pr_key = '${keyOf(4)}';`,
      );
      run = launch();
      await app.open(run.openUrl);
      await openAgents({ screen, browser });
      const second = screen.getByRole("listitem", "claude_second");
      await expect(second.getByRole("status", "claude_second status")).toHaveText(
        "Its setting can't be read",
      );
      await expect(second).toContainText(SECOND_DAMAGED);
      await expect(second.getByRole("button", "Remove")).toBeVisible();
      await expect(screen.getByRole("listitem", "Claude")).toBeVisible();
      await expect(screen.getByRole("listitem", "Codex")).toBeVisible();
      await second.scrollIntoView();
      await app.screenshot("damaged-agent-row-light");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("damaged-agent-row-dark");
      await setOsColorScheme(browser, "light");
      await browser.setViewport({ width: 640, height: 800 });
      await second.scrollIntoView();
      await app.screenshot("damaged-agent-row-narrow");
      await browser.setViewport({ width: 1280, height: 800 });

      // #4's guide stays on it and says why, and nothing runs on the default Claude instead.
      const runsBefore = claude.runs().length;
      await app.open(guideUrl(run.url, 4));
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect(screen.getByText(SECOND_DAMAGED).first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => lastAttempt(run.home, 4), { timeout: 30_000 })
        .toEqual({ instance: "claude_second", outcome: "failed" });
      expect(revisions(run.home, 4)).toBe(1);
      expect(claude.runs()).toHaveLength(runsBefore);
      await app.screenshot("damaged-agent-guide-failed");

      // Every other agent works: #6's guide on the default Claude writes r2.
      await app.open(guideUrl(run.url, 6));
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect.poll(() => revisions(run.home, 6), { timeout: 120_000 }).toBe(2);

      // Removed, the setting goes, and #4's guide moves to the default Claude as a removed one's does.
      await app.open(run.openUrl);
      await openAgents({ screen, browser });
      await screen.getByRole("listitem", "claude_second").getByRole("button", "Remove").tap();
      const removing = screen.getByRole("alertdialog", "Remove claude_second?");
      await expect(removing).toContainText("deletes only the setting");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await app.screenshot("damaged-agent-remove-dialog");
      await removing.getByRole("button", "Remove").tap();
      await expect(screen.getByRole("listitem", "claude_second")).toHaveCount(0, {
        timeout: 15_000,
      });
      expect(readRows(run.home, "SELECT id FROM agent_instances")).toEqual([]);
      await app.open(guideUrl(run.url, 4));
      await screen
        .getByRole("alert")
        .filter({ hasText: SECOND_DAMAGED })
        .getByRole("button", "Retry")
        .tap({ timeout: 30_000 });
      await expect.poll(() => revisions(run.home, 4), { timeout: 120_000 }).toBe(2);

      // A damaged default never falls back to how it shipped, and an added Claude that is off
      // falls back to it rather than past it to a spare Claude on another login that is ready.
      stopFakeInstance(name, { keepHome: true });
      NodeFS.mkdirSync(NodePath.join(fake.home, ".claude-spare"), { recursive: true });
      write(
        run.home,
        `${setting("claude")};
         ${setting("claude_off", { enabled: 0, environment: "[]" })};
         ${setting("claude_spare", { configDir: `'${NodePath.join(fake.home, ".claude-spare")}'`, environment: "[]" })};
         UPDATE reviews SET instance_id = 'claude_off' WHERE pr_key = '${keyOf(4)}';`,
      );
      run = launch();
      await app.open(run.openUrl);
      await openAgents({ screen, browser });
      const claudeRow = screen.getByRole("listitem", "Claude");
      await expect(claudeRow.getByRole("status", "Claude status")).toHaveText(
        "Its setting can't be read",
      );
      await expect(claudeRow).toContainText(CLAUDE_DAMAGED);
      await expect(
        screen.getByRole("listitem", "claude_spare").getByRole("status", "claude_spare status"),
      ).toContainText("Signed in");
      await expect(screen.getByRole("listitem", "Codex")).toBeVisible();
      await app.screenshot("damaged-default-agent-row");
      const runsAtOff = claude.runs().length;
      await app.open(guideUrl(run.url, 4));
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect(screen.getByText(CLAUDE_DAMAGED).first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => lastAttempt(run.home, 4), { timeout: 30_000 })
        .toEqual({ instance: "claude", outcome: "failed" });
      expect(revisions(run.home, 4)).toBe(2);
      expect(claude.runs()).toHaveLength(runsAtOff);
      const runsAtDefault = claude.runs().length;
      await app.open(guideUrl(run.url, 6));
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect(screen.getByText(CLAUDE_DAMAGED).first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => lastAttempt(run.home, 6), { timeout: 30_000 })
        .toEqual({ instance: "claude", outcome: "failed" });
      expect(revisions(run.home, 6)).toBe(2);
      expect(claude.runs()).toHaveLength(runsAtDefault);

      await app.open(run.openUrl);
      await openAgents({ screen, browser });
      await screen.getByRole("listitem", "Claude").getByRole("button", "Reset to default").tap();
      const resetting = screen.getByRole("alertdialog", "Reset Claude to default?");
      await resetting.getByRole("button", "Reset").tap();
      await expect(
        screen.getByRole("listitem", "Claude").getByRole("button", "Reset to default"),
      ).toBeVisible({ timeout: 15_000 });
      await expect(screen.getByRole("status", "Claude status")).not.toHaveText(
        "Its setting can't be read",
      );
      expect(readRows(run.home, "SELECT id FROM agent_instances ORDER BY id")).toEqual([
        { id: "claude_off" },
        { id: "claude_spare" },
      ]);
      await app.open(guideUrl(run.url, 6));
      await screen
        .getByRole("alert")
        .filter({ hasText: CLAUDE_DAMAGED })
        .getByRole("button", "Retry")
        .tap({ timeout: 30_000 });
      await expect.poll(() => revisions(run.home, 6), { timeout: 120_000 }).toBe(3);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
