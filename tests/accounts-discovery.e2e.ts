import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";
import { _electron, chromium, type Page } from "playwright";

import { childEnv } from "../packages/contracts/src/childEnv.ts";
import {
  type FakeGitHub,
  instanceHome,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const FIRST = "budget-test";
const SECOND = "budget-second";
const THIRD = "budget-third";
const LOGIN_SPELLINGS = /^budget-test$/i;
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const desktopDir = NodePath.join(repoRoot, "apps/desktop");
const evidence = NodePath.join(repoRoot, ".e2e/evidence/accounts-discovery");

const hostsFor = (login: string) =>
  `github.com:\n  user: ${login}\n  users:\n    ${login}: {}\n  git_protocol: https\n`;
const ghDir = (fake: FakeGitHub, relative: string, login: string) => {
  const dir = NodePath.join(fake.home, relative);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "hosts.yml"), hostsFor(login));
  return dir;
};
const readers = async (fake: FakeGitHub) =>
  [
    ...new Set(
      (await fake.stats()).log
        .filter((entry) => entry.login !== "")
        .map((entry) => `${entry.login}@${entry.dir}`),
    ),
  ].sort();

const open = async (
  name: string,
  fake: FakeGitHub,
  { app, screen, browser }: Fixtures,
  extra: ReadonlyArray<string> = [],
) => {
  const run = startFakeInstance(name, fake, extra);
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
    run,
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

      // An unreadable first directory keeps the login across a relaunch; the other spelling
      // never stands in.
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
  "an open pull request is read again through the gh directory its login moves to, and a read held across the move is never cached or shown",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "accounts-held-move";
    const fake = await startFakeGitHub(name);
    const home = instanceHome(name);
    const log = NodePath.join(repoRoot, ".e2e/logs", `${name}.log`);
    NodeFS.rmSync(log, { force: true });
    const first = NodePath.join(fake.home, ".config/gh/hosts.yml");
    ghDir(fake, ".config/gh-move", FIRST);
    await fake.describe(3, { body: "Description before the move" });
    const cached = () => {
      const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"), { readOnly: true });
      try {
        return db
          .prepare("SELECT config_dir, value FROM github_read_cache WHERE kind = 'detail'")
          .all()
          .map((row) => `${String(row.config_dir)}\n${String(row.value)}`);
      } finally {
        db.close();
      }
    };
    const tab = screen
      .getByRole("navigation", "Workspace tabs")
      .getByRole("link", /budget\/fixtures #3/);
    try {
      // The watcher reads the open tab's fingerprint every 5 seconds, one request per read.
      const prkit = await open(name, fake, { app, screen, browser }, [
        "--e2e",
        "--watch-interval",
        "5000",
      ]);
      await screen.getByRole("link", /#3 Budget fixture 3/).tap();
      await expect(screen.getByText("Description before the move")).toBeVisible({
        timeout: 20_000,
      });

      await fake.describe(3, { body: "Read through gh-move" });
      NodeFS.writeFileSync(first, "{}\n");
      await fake.resetStats();
      await prkit.rediscover();
      await expect(
        prkit.accounts.getByRole("listitem").filter({ hasText: FIRST }).first(),
      ).toContainText("~/.config/gh-move");
      await tab.tap();
      await expect(screen.getByText("Read through gh-move")).toBeVisible({ timeout: 20_000 });
      await expect(screen.getByText("Description before the move")).toHaveCount(0);
      const detailReads = (await fake.stats()).log.filter((entry) => entry.kind === "rest:pull");
      expect(detailReads.length).toBeGreaterThan(0);
      expect(detailReads.every((entry) => entry.dir === ".config/gh-move")).toBe(true);

      // The bodies of answers to ~/.config/gh-move's token wait, their headers already in, while
      // the login moves back to ~/.config/gh, which comes first.
      await fake.describe(3, { body: "Held description" });
      await fake.resetStats();
      await fake.hold("core", { dir: ".config/gh-move", body: true });
      await fake.hold("graphql", { dir: ".config/gh-move", body: true });
      await screen.getByRole("button", "Refresh").first().tap();
      for (const kind of ["rest:pull", "graphql:fingerprint"])
        await expect
          .poll(
            async () =>
              (await fake.stats()).log.some(
                (entry) => entry.kind === kind && entry.dir === ".config/gh-move",
              ),
            { timeout: 15_000 },
          )
          .toBe(true);

      await fake.describe(3, { body: "Fresh description" });
      NodeFS.writeFileSync(first, hostsFor(FIRST));
      await prkit.rediscover();
      await expect(
        prkit.accounts
          .getByRole("listitem")
          .filter({ hasText: FIRST })
          .first()
          .getByText("~/.config/gh", { exact: true }),
      ).toBeVisible();
      const moved = new Date().toISOString();
      await tab.tap();

      // The window reads #3 again through ~/.config/gh, so only the server's log shows what it
      // did with the held answers. The watcher's fingerprint read is one request with nothing
      // after it, so only the check made once its body is in can set it aside.
      await fake.release("core");
      await fake.release("graphql");
      await expect(screen.getByText("Fresh description")).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(
          () =>
            NodeFS.readFileSync(log, "utf8")
              .split("GitHub read set aside")
              .slice(1)
              .filter(
                (entry) =>
                  entry.includes("operation: 'PrkitWatch'") &&
                  entry.includes("when: 'on-answer'") &&
                  entry.includes(`configDir: '${fake.home}/.config/gh-move'`),
              ).length,
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      for (let check = 0; check < 6; check++) {
        await expect(screen.getByText("Held description")).toHaveCount(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await app.screenshot("held-read-set-aside");
      expect(
        (await fake.stats()).log.filter(
          (entry) => entry.at > moved && entry.dir === ".config/gh-move",
        ),
      ).toEqual([]);
      expect(cached().filter((row) => row.includes("Held description"))).toEqual([]);
      expect(
        cached().filter(
          (row) => row.includes("Fresh description") && row.startsWith(`${fake.home}/.config/gh\n`),
        ),
      ).toHaveLength(1);
    } finally {
      await fake.release("core");
      await fake.release("graphql");
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

/**
 * Keeps every set of tab names a page had since it loaded, painted or not, as JSON in `<html>`'s
 * `data-tab-names`, so a journey can tell a title that showed for a moment from one that never did.
 */
const RECORD_TAB_NAMES = `(() => {
  const names = [];
  new MutationObserver(() => {
    const now = [...document.querySelectorAll("[data-open-pr]")]
      .map((tab) => tab.getAttribute("aria-label"))
      .join(" | ");
    if (names[names.length - 1] === now) return;
    names.push(now);
    document.documentElement.dataset.tabNames = JSON.stringify(names);
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label"],
  });
})()`;
const decodeTabNames = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const START_HIDDEN = `(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
})()`;

test(
  "after an account's gh directory moves, no window shows a tab status read through the old one, on reconnect or otherwise",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "accounts-moved-statuses";
    const fake = await startFakeGitHub(name);
    const first = NodePath.join(fake.home, ".config/gh/hosts.yml");
    ghDir(fake, ".config/gh-move", FIRST);
    const before = "Open budget/fixtures #3 Title before the move";
    const listed = "Open budget/fixtures #3 Budget fixture 3";
    const loading = "Open budget/fixtures #3";
    const after = "Open budget/fixtures #3 Title after the move";
    const tabsOf = () =>
      [...document.querySelectorAll("[data-open-pr]")].map((tab) => tab.getAttribute("aria-label"));
    const namesOf = () => document.documentElement.dataset.tabNames ?? "[]";
    const setVisible = (visible: boolean) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (visible ? "visible" : "hidden"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const frames = NodePath.join(repoRoot, ".e2e/evidence/accounts-moved-statuses");
    NodeFS.rmSync(frames, { recursive: true, force: true });
    NodeFS.mkdirSync(frames, { recursive: true });
    /** The title bar of `page` with #3's tooltip open: what the tab says it shows. */
    const frame = async (page: Page, file: string) => {
      await page.getByRole("link", { name: /^Open budget\/fixtures #3/ }).hover();
      await page.getByRole("tooltip").waitFor();
      // Its details show after a moment's hover.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await page.screenshot({
        path: NodePath.join(frames, `${file}.png`),
        clip: { x: 0, y: 0, width: 640, height: 160 },
      });
      await page.mouse.move(640, 400);
    };
    const other = await chromium.launch({ headless: true, args: ["--use-mock-keychain"] });
    try {
      await browser.addInitScript(RECORD_TAB_NAMES);
      // The watcher reads the open tab's fingerprint every 5 seconds.
      const prkit = await open(name, fake, { app, screen, browser }, [
        "--e2e",
        "--watch-interval",
        "5000",
      ]);
      await screen.getByRole("link", /#3 Budget fixture 3/).tap();
      await fake.describe(3, { title: "Title before the move" });
      await expect.poll(() => browser.evaluate(tabsOf), { timeout: 20_000 }).toEqual([before]);
      // A window that keeps listening, and one opened hidden on the pull request, which reads it
      // but hears nothing until it is shown.
      const listening = await other.newPage();
      await listening.addInitScript(RECORD_TAB_NAMES);
      await listening.goto(prkit.run.openUrl);
      await listening
        .getByRole("link", { name: "Inbox", exact: true })
        .waitFor({ timeout: 30_000 });
      await expect.poll(() => listening.evaluate(tabsOf), { timeout: 20_000 }).toEqual([before]);
      await frame(listening, "before-the-move");
      const hidden = await other.newPage();
      await hidden.addInitScript(RECORD_TAB_NAMES);
      await hidden.addInitScript(START_HIDDEN);
      await hidden.goto(prkit.run.openUrl);
      await hidden.getByRole("link", { name: "Inbox", exact: true }).waitFor({ timeout: 30_000 });
      await hidden.goto(
        `${prkit.run.url}/pr/github.com/budget/fixtures/3?account=${encodeURIComponent(`github.com/${FIRST}`)}`,
      );
      await expect.poll(() => hidden.evaluate(tabsOf), { timeout: 20_000 }).toEqual([before]);

      // No fingerprint or inbox is read through ~/.config/gh-move until the release, so every
      // title a tab shows until then was read through ~/.config/gh.
      await fake.hold("graphql", { dir: ".config/gh-move" });
      NodeFS.writeFileSync(first, "{}\n");
      const heard = decodeTabNames(await listening.evaluate(namesOf)).length;
      await prkit.settings();
      await prkit.accounts.getByRole("button", "Refresh").tap();
      await expect(
        prkit.accounts
          .getByRole("listitem")
          .filter({ hasText: FIRST })
          .first()
          .getByText("~/.config/gh-move", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await fake.describe(3, { title: "Title after the move" });

      // The window that listens drops the status and the inbox row behind it at once.
      await expect.poll(() => listening.evaluate(tabsOf), { timeout: 10_000 }).toEqual([loading]);
      await expect.poll(() => browser.evaluate(tabsOf), { timeout: 10_000 }).toEqual([loading]);
      await frame(listening, "moved-read-again");
      const listened = decodeTabNames(await listening.evaluate(namesOf)).slice(heard);
      expect(listened.slice(listened.indexOf(loading))).toEqual([loading]);
      expect(listened.filter((names) => names !== before && names !== loading)).toEqual([]);
      // A window that reconnects, by a reload or by being hidden and shown, is sent the statuses again.
      await browser.reload();
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 20_000 });
      await listening.evaluate(setVisible, false);
      await listening.evaluate(setVisible, true);
      // The hidden window read the pull request through ~/.config/gh; shown, it reads it again.
      const shown = decodeTabNames(await hidden.evaluate(namesOf)).length;
      await hidden.evaluate(setVisible, true);
      await expect.poll(() => hidden.evaluate(tabsOf), { timeout: 10_000 }).not.toEqual([before]);
      for (let check = 0; check < 6; check++) {
        expect(await browser.evaluate(tabsOf)).toEqual([loading]);
        expect(await listening.evaluate(tabsOf)).toEqual([loading]);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(
        decodeTabNames(await browser.evaluate(namesOf)).filter(
          (names) => names !== "" && names !== loading,
        ),
      ).toEqual([]);
      expect(
        decodeTabNames(await hidden.evaluate(namesOf))
          .slice(shown)
          .filter((names) => names === before || names === listed),
      ).toEqual([]);

      await fake.release("graphql");
      await expect.poll(() => browser.evaluate(tabsOf), { timeout: 20_000 }).toEqual([after]);
      await expect.poll(() => listening.evaluate(tabsOf), { timeout: 20_000 }).toEqual([after]);
      await expect.poll(() => hidden.evaluate(tabsOf), { timeout: 20_000 }).toEqual([after]);
      await frame(listening, "read-through-the-new-directory");

      // Back to ~/.config/gh with nothing changed on GitHub: the same fingerprint, read through
      // the directory the account uses now, still brings the status back. No window shows the
      // pull request and the inbox leaves it out, so only its status can name it.
      await hidden.close();
      await fake.inboxOnly(FIRST, [1]);
      await fake.hold("graphql", { dir: ".config/gh" });
      NodeFS.writeFileSync(first, hostsFor(FIRST));
      await prkit.settings();
      await prkit.accounts.getByRole("button", "Refresh").tap();
      await expect(
        prkit.accounts
          .getByRole("listitem")
          .filter({ hasText: FIRST })
          .first()
          .getByText("~/.config/gh", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => listening.evaluate(tabsOf), { timeout: 10_000 }).not.toEqual([after]);
      await fake.release("graphql");
      await expect.poll(() => browser.evaluate(tabsOf), { timeout: 20_000 }).toEqual([after]);
      await expect.poll(() => listening.evaluate(tabsOf), { timeout: 20_000 }).toEqual([after]);
    } finally {
      await other.close();
      await fake.release("graphql");
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "an Inbox Refresh still reading another account when a login moves sends back no row read through the old directory",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "accounts-moved-refresh";
    const fake = await startFakeGitHub(name, { secondAccount: true });
    const first = NodePath.join(fake.home, ".config/gh/hosts.yml");
    ghDir(fake, ".config/gh-move", FIRST);
    // #3 belongs to budget-test's inbox alone.
    await fake.inboxOnly(SECOND, [5]);
    const other = await chromium.launch({ headless: true, args: ["--use-mock-keychain"] });
    try {
      const prkit = await open(name, fake, { app, screen, browser });
      // Every message the server sends the Inbox window, as it arrives.
      const inbox = await other.newPage();
      const frames: Array<string> = [];
      inbox.on("websocket", (socket) =>
        socket.on("framereceived", (frame) => frames.push(String(frame.payload))),
      );
      await inbox.goto(prkit.run.openUrl);
      await inbox.getByRole("link", { name: /#3 Budget fixture 3/ }).waitFor({ timeout: 30_000 });

      // budget-second's inbox read waits, so the Refresh is still out when budget-test moves, and
      // nothing reads through ~/.config/gh-move until the end.
      await fake.hold("graphql", { dir: [".config/gh-second", ".config/gh-move"] });
      await fake.resetStats();
      await inbox.getByRole("button", { name: "Refresh" }).first().click();
      await expect
        .poll(
          async () =>
            (await fake.stats()).log.filter(
              (entry) =>
                entry.kind === "graphql:inbox" &&
                ((entry.login === FIRST && entry.dir === ".config/gh") ||
                  (entry.login === SECOND && entry.dir === ".config/gh-second")),
            ).length,
          { timeout: 15_000 },
        )
        .toBe(2);

      NodeFS.writeFileSync(first, "{}\n");
      await fake.describe(3, { title: "Title after the move" });
      await prkit.rediscover();
      await expect(
        prkit.accounts
          .getByRole("listitem")
          .filter({ hasText: FIRST })
          .first()
          .getByText("~/.config/gh-move", { exact: true }),
      ).toBeVisible();
      await inbox
        .getByRole("link", { name: /#3 Budget fixture 3/ })
        .waitFor({ state: "detached", timeout: 10_000 });
      // Everything after the event that told the window about the move left the server after it.
      const moved = frames.findIndex(
        (frame) => frame.includes('"_tag":"accounts"') && frame.includes(".config/gh-move"),
      );
      expect(moved).toBeGreaterThan(-1);

      // The Refresh finishes with budget-second; what it answers for budget-test comes through
      // ~/.config/gh-move, where nothing is read yet.
      await fake.release("graphql", ".config/gh-second");
      await expect
        .poll(() => inbox.getByRole("button", { name: "Refresh" }).first().isEnabled(), {
          timeout: 20_000,
        })
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(
        frames
          .slice(moved)
          .filter((frame) => frame.includes("Budget fixture 3"))
          .map((frame) => frame.slice(0, 80)),
      ).toEqual([]);
      expect(await inbox.getByRole("link", { name: /#3 Budget fixture 3/ }).count()).toBe(0);

      await fake.release("graphql");
      await inbox
        .getByRole("link", { name: /#3 Title after the move/ })
        .first()
        .waitFor({ timeout: 20_000 });
    } finally {
      await other.close();
      await fake.release("graphql");
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "the desktop app started like Finder finds gh where the login shell's GH_CONFIG_DIR and XDG_CONFIG_HOME keep it, and a launch with its own keeps them",
  { timeout: 300_000 },
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
    /**
     * What a Dock launch gives: launchd's PATH and no gh variables, plus `own` for a launch that
     * brings its own. HOME and CFFIXED_USER_HOME keep the dev app's settings in the fake's home.
     */
    const launch = async (own: Record<string, string>) => {
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
          ...own,
        },
        timeout: 30_000,
      });
      const output = { text: "" };
      desktop.process().stdout?.on("data", (chunk: Buffer) => (output.text += chunk.toString()));
      const window = await desktop.firstWindow();
      await window.getByRole("link", { name: /#3 Budget fixture 3/ }).waitFor({ timeout: 30_000 });
      await window.keyboard.press("Meta+Comma");
      const accounts = window.getByRole("region", { name: "GitHub accounts" });
      await accounts.waitFor();
      await window
        .getByLabel("Loading GitHub accounts")
        .waitFor({ state: "detached", timeout: 30_000 });
      const found = async (expected: ReadonlyArray<readonly [string, string]>) => {
        for (const [login, dir] of expected) {
          const row = accounts.getByRole("listitem").filter({ hasText: login });
          await row.getByText(dir, { exact: true }).waitFor();
          await row.getByText("Ready").waitFor();
        }
        expect(await accounts.getByText(/^budget-(test|second|third)$/).count()).toBe(
          expected.length,
        );
      };
      return { desktop, window, found, output };
    };
    let running: Awaited<ReturnType<typeof launch>>["desktop"] | undefined;
    try {
      const finder = await launch({});
      running = finder.desktop;
      const userData = await finder.desktop.evaluate(({ app }) => app.getPath("userData"));
      expect(userData.startsWith(fake.home)).toBe(true);
      await finder.window.emulateMedia({ colorScheme: "light" });
      await finder.window.screenshot({
        path: NodePath.join(evidence, "settings-accounts-light.png"),
      });
      await finder.found([
        [THIRD, "~/custom/gh-own"],
        [FIRST, "~/xdg/gh"],
        [SECOND, "~/xdg/gh-second"],
      ]);
      expect(await readers(fake)).toEqual(
        [`${SECOND}@xdg/gh-second`, `${THIRD}@custom/gh-own`, `${FIRST}@xdg/gh`].sort(),
      );
      expect(finder.output.text).toContain("read PATH, GH_CONFIG_DIR, XDG_CONFIG_HOME from");
      await finder.window.emulateMedia({ colorScheme: "dark" });
      await finder.window.screenshot({
        path: NodePath.join(evidence, "settings-accounts-dark.png"),
      });
      await finder.desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(900, 720),
      );
      await finder.window.screenshot({
        path: NodePath.join(evidence, "settings-accounts-narrow.png"),
      });
      await finder.desktop.close();
      running = undefined;

      await fake.resetStats();
      const terminal = await launch({ XDG_CONFIG_HOME: NodePath.join(fake.home, "xdg") });
      running = terminal.desktop;
      await terminal.found([
        [FIRST, "~/xdg/gh"],
        [SECOND, "~/xdg/gh-second"],
      ]);
      expect(await readers(fake)).toEqual([`${SECOND}@xdg/gh-second`, `${FIRST}@xdg/gh`].sort());
      expect(terminal.output.text).toContain("read PATH from");
    } finally {
      await running?.close();
      fake.stop();
    }
  },
);
