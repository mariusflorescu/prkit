import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import { _electron } from "playwright";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import {
  type FakeGitHub,
  instanceHome,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const FIRST = "budget-test";
const SECOND = "budget-second";
const THIRD = "budget-third";
/** The first login as any directory spells it; an account row shows its login alone. */
const LOGIN_SPELLINGS = /^budget-test$/i;
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const desktopDir = NodePath.join(repoRoot, "apps/desktop");
const evidence = NodePath.join(repoRoot, ".e2e/evidence/accounts-discovery");

const hostsFor = (login: string) =>
  `github.com:\n  user: ${login}\n  users:\n    ${login}: {}\n  git_protocol: https\n`;
/** Writes a gh config directory under the fake's HOME that lists one login. */
const ghDir = (fake: FakeGitHub, relative: string, login: string) => {
  const dir = NodePath.join(fake.home, relative);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "hosts.yml"), hostsFor(login));
  return dir;
};
/** Each login and the gh config directory whose token read it, for every request since the last reset. */
const readers = async (fake: FakeGitHub) =>
  [
    ...new Set(
      (await fake.stats()).log
        .filter((entry) => entry.login !== "")
        .map((entry) => `${entry.login}@${entry.dir}`),
    ),
  ].sort();

const open = async (name: string, fake: FakeGitHub, { app, screen, browser }: Fixtures) => {
  const run = startFakeInstance(name, fake);
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", /#3 Budget fixture 3/)).toBeVisible({ timeout: 20_000 });
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  const accounts = screen.getByRole("region", "GitHub accounts");
  const settings = async () => {
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect(accounts).toBeVisible();
  };
  return {
    accounts,
    settings,
    /** Settings > GitHub accounts > Refresh, which looks into every directory again. */
    rediscover: async () => {
      await settings();
      await accounts.getByRole("button", "Refresh").tap();
      await expect(accounts.getByRole("button", "Refresh")).toBeEnabled({ timeout: 20_000 });
    },
  };
};

test(
  "two gh directories that spell one login in different case are one account, read through the first alone",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "accounts-login-case";
    const fake = await startFakeGitHub(name);
    const first = ghDir(fake, ".config/gh", "Budget-Test");
    ghDir(fake, ".config/gh-work", FIRST);
    let locked = false;
    try {
      const prkit = await open(name, fake, { app, screen, browser });
      await prkit.settings();
      await expect(prkit.accounts.getByText(LOGIN_SPELLINGS)).toHaveCount(1);
      await expect(prkit.accounts.getByText("Budget-Test", { exact: true })).toBeVisible();
      await expect(prkit.accounts.getByText("~/.config/gh", { exact: true })).toBeVisible();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(1);
      await app.screenshot("login-case-one-account");
      expect(await readers(fake)).toEqual([`${FIRST}@.config/gh`]);

      // The first directory can't be read: the login it listed waits for it, and the directory
      // that spells it another way never stands in, before and after a relaunch.
      await fake.resetStats();
      NodeFS.chmodSync(first, 0o000);
      locked = true;
      await prkit.rediscover();
      await expect(prkit.accounts.getByText(LOGIN_SPELLINGS)).toHaveCount(1);
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(0);
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        "prkit can't open ~/.config/gh, so it can't check Budget-Test.",
      );
      stopFakeInstance(name, { keepHome: true });
      const again = await open(name, fake, { app, screen, browser });
      await again.settings();
      await expect(again.accounts.getByText(LOGIN_SPELLINGS)).toHaveCount(1);
      await expect(again.accounts.getByRole("alert")).toContainText(
        "prkit can't open ~/.config/gh, so it can't check Budget-Test.",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await readers(fake)).toEqual([]);

      // Readable again: the account comes back through the first directory.
      NodeFS.chmodSync(first, 0o755);
      locked = false;
      await again.accounts.getByRole("alert").getByRole("button", "Retry").tap();
      await expect(again.accounts.getByText("Ready")).toHaveCount(1, { timeout: 20_000 });
      await expect(again.accounts.getByText(LOGIN_SPELLINGS)).toHaveCount(1);
      expect(await readers(fake)).toEqual([`${FIRST}@.config/gh`]);
    } finally {
      if (locked) NodeFS.chmodSync(first, 0o755);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "a read held while its login moves to another gh directory is never cached or shown, and the next read goes through the new one",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "accounts-held-move";
    const fake = await startFakeGitHub(name);
    const home = instanceHome(name);
    ghDir(fake, ".config/gh-move", FIRST);
    await fake.describe(3, { body: "Description before the move" });
    try {
      const prkit = await open(name, fake, { app, screen, browser });
      await screen.getByRole("link", /#3 Budget fixture 3/).tap();
      await expect(screen.getByText("Description before the move")).toBeVisible({
        timeout: 20_000,
      });

      // A refresh reads #3 through ~/.config/gh, and GitHub's answers to that token wait.
      await fake.describe(3, { body: "Held description" });
      await fake.resetStats();
      await fake.hold("core", ".config/gh");
      await screen.getByRole("button", "Refresh").first().tap();
      await expect
        .poll(async () =>
          (await fake.stats()).log.some(
            (entry) => entry.kind === "rest:pull" && entry.dir === ".config/gh",
          ),
        )
        .toBe(true);

      // The login leaves ~/.config/gh, so Refresh in Settings binds it to ~/.config/gh-move.
      await fake.describe(3, { body: "Fresh description" });
      NodeFS.writeFileSync(NodePath.join(fake.home, ".config/gh/hosts.yml"), "{}\n");
      await prkit.rediscover();
      await expect(
        prkit.accounts.getByRole("listitem").filter({ hasText: FIRST }).first(),
      ).toContainText(".config/gh-move");
      const moved = new Date().toISOString();
      await screen
        .getByRole("navigation", "Workspace tabs")
        .getByRole("link", /budget\/fixtures #3/)
        .tap();

      // The held answers land after the move: prkit sets them aside and says why.
      await fake.release("core");
      const failure = screen
        .getByRole("alert")
        .filter({ hasText: "Couldn't load this pull request" });
      await expect(failure).toContainText(
        `${FIRST}'s gh directory changed while prkit was reading GitHub. Try again.`,
        { timeout: 15_000 },
      );
      for (let check = 0; check < 6; check++) {
        await expect(screen.getByText("Held description")).toHaveCount(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await app.screenshot("held-read-set-aside");
      const afterMove = (await fake.stats()).log.filter((entry) => entry.at > moved);
      expect(afterMove.filter((entry) => entry.dir === ".config/gh")).toEqual([]);
      expect(
        afterMove.filter((entry) => entry.kind.startsWith("rest:") && entry.kind !== "rest:user"),
      ).toEqual([]);

      const cached = () => {
        const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"), { readOnly: true });
        try {
          return db
            .prepare("SELECT config_dir, value FROM github_read_cache WHERE kind = 'detail'")
            .all()
            .map((row) => `${String(row["config_dir"])}\n${String(row["value"])}`);
        } finally {
          db.close();
        }
      };
      expect(cached().filter((row) => row.includes("Held description"))).toEqual([]);

      // Retry reads #3 again, through the directory that holds the login now.
      await fake.resetStats();
      await failure.getByRole("button", "Retry").tap();
      await expect(screen.getByText("Fresh description")).toBeVisible({ timeout: 20_000 });
      expect(await readers(fake)).toEqual([`${FIRST}@.config/gh-move`]);
      expect(
        cached().filter(
          (row) =>
            row.includes("Fresh description") && row.startsWith(`${fake.home}/.config/gh-move\n`),
        ),
      ).toHaveLength(1);
      expect(cached().filter((row) => row.includes("Held description"))).toEqual([]);
    } finally {
      await fake.release("core");
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "the desktop app started like Finder finds gh where the login shell's GH_CONFIG_DIR and XDG_CONFIG_HOME keep it",
  { timeout: 240_000 },
  async () => {
    const name = "accounts-login-shell";
    const fake = await startFakeGitHub(name);
    const home = instanceHome(name);
    // gh's own order: GH_CONFIG_DIR, then $XDG_CONFIG_HOME/gh, then ~/.config/gh.
    ghDir(fake, "custom/gh-own", THIRD);
    ghDir(fake, "xdg/gh", FIRST);
    ghDir(fake, "xdg/gh-second", SECOND);
    const shell = NodePath.join(fake.home, "login-shell");
    NodeFS.writeFileSync(
      shell,
      `#!/bin/sh\nexport XDG_CONFIG_HOME="$HOME/xdg"\nexport GH_CONFIG_DIR="$HOME/custom/gh-own"\nexec /bin/sh -c "$2"\n`,
      { mode: 0o755 },
    );
    NodeFS.rmSync(evidence, { recursive: true, force: true });
    NodeFS.mkdirSync(evidence, { recursive: true });
    const electron = NodePath.join(
      desktopDir,
      "node_modules/electron/dist",
      NodeFS.readFileSync(
        NodePath.join(desktopDir, "node_modules/electron/path.txt"),
        "utf8",
      ).trim(),
    );
    // What a Dock launch gives: launchd's PATH and no gh variables. HOME and CFFIXED_USER_HOME keep
    // the dev app's settings in the fake's home.
    const desktop = await _electron.launch({
      executablePath: electron,
      args: [desktopDir],
      env: {
        ...childEnv(process.env),
        HOME: fake.home,
        CFFIXED_USER_HOME: fake.home,
        SHELL: shell,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PRKIT_HOME: home,
        PRKIT_GH_PATH: NodePath.join(fake.home, "gh"),
        PRKIT_GITHUB_API_URL: fake.url,
      },
      timeout: 30_000,
    });
    let output = "";
    desktop.process().stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    try {
      const userData = await desktop.evaluate(({ app }) => app.getPath("userData"));
      expect(userData.startsWith(fake.home)).toBe(true);
      const window = await desktop.firstWindow();
      await window.getByRole("link", { name: /#3 Budget fixture 3/ }).waitFor({ timeout: 30_000 });
      await window.keyboard.press("Meta+Comma");
      const accounts = window.getByRole("region", { name: "GitHub accounts" });
      await accounts.waitFor();
      await window
        .getByLabel("Loading GitHub accounts")
        .waitFor({ state: "detached", timeout: 30_000 });
      await window.emulateMedia({ colorScheme: "light" });
      await window.screenshot({ path: NodePath.join(evidence, "settings-accounts-light.png") });
      for (const [login, dir] of [
        [THIRD, "~/custom/gh-own"],
        [FIRST, "~/xdg/gh"],
        [SECOND, "~/xdg/gh-second"],
      ] as const) {
        const row = accounts.getByRole("listitem").filter({ hasText: login });
        await row.getByText(dir, { exact: true }).waitFor();
        await row.getByText("Ready").waitFor();
      }
      expect(await accounts.getByText(/^budget-(test|second|third)$/).count()).toBe(3);
      expect(await readers(fake)).toEqual(
        [`${SECOND}@xdg/gh-second`, `${THIRD}@custom/gh-own`, `${FIRST}@xdg/gh`].sort(),
      );
      expect(output).toMatch(/GH_CONFIG_DIR, XDG_CONFIG_HOME/);

      await window.emulateMedia({ colorScheme: "dark" });
      await window.screenshot({ path: NodePath.join(evidence, "settings-accounts-dark.png") });
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(900, 720),
      );
      await window.screenshot({ path: NodePath.join(evidence, "settings-accounts-narrow.png") });
    } finally {
      await desktop.close();
      fake.stop();
    }
  },
);
