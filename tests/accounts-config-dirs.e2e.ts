import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const FIRST = "budget-test";
const SECOND = "budget-second";
const THIRD = "budget-third";
/** Reads every account makes for its inbox, apart from any one pull request. */
const INBOX_READS = new Set(["rest:user", "graphql:inbox", "graphql:review-waits"]);
/** The only gh config directory each login's token may come from. */
const HOME_DIR: Record<string, string> = {
  [FIRST]: "gh",
  [SECOND]: "gh-second",
  [THIRD]: "gh-third",
};

const rows = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll("main a[data-pr-number]")]
      .map((link) => Number(link.getAttribute("data-pr-number")))
      .sort((left, right) => left - right)
      .join(","),
  );
const hostsFor = (login: string) =>
  `github.com:\n  user: ${login}\n  users:\n    ${login}: {}\n  git_protocol: https\n`;
/** What gh writes when the token is in the keyring: the user with no value. */
const keyringHostsFor = (login: string) =>
  `github.com:\n  user: ${login}\n  users:\n    ${login}:\n  git_protocol: https\n`;

/** Every request since the last reset whose token came from another directory than its login's. */
const crossed = async (fake: FakeGitHub) =>
  (await fake.stats()).log.filter(
    (entry) => entry.login !== "" && HOME_DIR[entry.login] !== entry.dir,
  );
/** Requests since the last reset about one pull request, not an account's inbox. */
const pullRequestReads = async (fake: FakeGitHub) =>
  (await fake.stats()).log.filter((entry) => !INBOX_READS.has(entry.kind));

const launch = async (
  name: string,
  { app, screen, browser }: Fixtures,
  extra: ReadonlyArray<string> = [],
) => {
  const fake = await startFakeGitHub(name, { secondAccount: true });
  await fake.inboxOnly(FIRST, [1, 2, 3, 4]);
  await fake.inboxOnly(SECOND, [5, 6]);
  await fake.inboxOnly(THIRD, [6]);
  const dir = (base: string) => NodePath.join(fake.home, ".config", base);
  const locked = new Set<string>();
  /** Takes away every permission on a path, or gives them back, and remembers to undo it. */
  const lock = (path: string) => {
    NodeFS.chmodSync(path, 0o000);
    locked.add(path);
  };
  const unlock = (path: string) => {
    NodeFS.chmodSync(path, NodeFS.statSync(path).isDirectory() ? 0o755 : 0o644);
    locked.delete(path);
  };
  let run = startFakeInstance(name, fake, extra);
  await emulateOsColorScheme(browser, "light");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => rows(browser), { timeout: 20_000 }).toBe("1,2,3,4,5,6");
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  const accounts = screen.getByRole("region", "GitHub accounts");
  return {
    fake,
    dir,
    lock,
    unlock,
    accounts,
    settings: async () => {
      await browser.keyboard.press(`${modifier}+Comma`);
      await expect(accounts).toBeVisible();
    },
    /** Settings > GitHub accounts > Refresh, which looks into every directory again. */
    rediscover: async () => {
      await browser.keyboard.press(`${modifier}+Comma`);
      await accounts.getByRole("button", "Refresh").tap();
      await expect(accounts.getByRole("button", "Refresh")).toBeEnabled({ timeout: 20_000 });
    },
    inbox: () => screen.getByRole("link", "Inbox").tap(),
    /** Stops prkit, changes the directories while it is closed, and opens it again. */
    relaunch: async (change: () => void) => {
      stopFakeInstance(name, { keepHome: true });
      change();
      run = startFakeInstance(name, fake, extra);
      await app.open(run.openUrl);
    },
    stop: () => {
      for (const path of locked) unlock(path);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    },
  };
};

test(
  "a gh config directory prkit can't read mid-run keeps every other account, says what's wrong with a Retry, and reads its account through no other token",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    // The watcher reads open tabs every 5 seconds, through each tab's account.
    const prkit = await launch("accounts-config-dirs-midrun", { app, screen, browser }, [
      "--e2e",
      "--watch-interval",
      "5000",
    ]);
    const second = prkit.dir("gh-second");
    const hosts = NodePath.join(second, "hosts.yml");
    try {
      const notice = screen
        .getByRole("alert")
        .filter({ hasText: `prkit can't open ~/.config/gh-second, so it can't check ${SECOND}.` });

      await prkit.fake.resetStats();
      prkit.lock(second);
      await prkit.rediscover();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(1);
      await expect(prkit.accounts.getByText("Needs attention")).toHaveCount(1);
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        `prkit can't open ~/.config/gh-second, so it can't check ${SECOND}. Check the directory's permissions, then retry.`,
      );
      await app.screenshot("settings-account-dir-unreadable");

      // The Inbox keeps every account's rows, the second's as prkit last read them, with its reason.
      await prkit.inbox();
      await expect(notice).toBeVisible();
      await expect.poll(() => rows(browser)).toBe("1,2,3,4,5,6");
      await expect(screen.getByRole("alert")).toHaveCount(1);
      await app.screenshot("inbox-account-dir-unreadable-light");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("inbox-account-dir-unreadable-dark");
      await browser.setViewport({ width: 600, height: 720 });
      await expect(notice.getByRole("button", "Retry")).toBeVisible();
      await app.screenshot("inbox-account-dir-unreadable-narrow");
      await browser.setViewport({ width: 1280, height: 720 });
      await setOsColorScheme(browser, "light");

      // Its pull request opens, but nothing reads it: not its own token, not the first account's.
      await screen.getByRole("link", /#5 Budget fixture 5/).tap();
      await expect(
        screen.getByRole("alert").filter({ hasText: "Couldn't load this pull request" }),
      ).toContainText(`Account github.com/${SECOND} isn't ready.`, { timeout: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await pullRequestReads(prkit.fake)).toEqual([]);
      expect(await crossed(prkit.fake)).toEqual([]);
      expect((await prkit.fake.stats()).log.filter((entry) => entry.login === SECOND)).toEqual([]);
      await app.screenshot("tab-account-dir-unreadable");
      await screen
        .getByRole("navigation", "Workspace tabs")
        .getByRole("button", "Close budget/fixtures #5")
        .tap();

      // The directory is readable again: Retry in the Inbox brings the account back.
      prkit.unlock(second);
      await prkit.fake.resetStats();
      await notice.getByRole("button", "Retry").tap();
      await expect(screen.getByRole("alert")).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => rows(browser)).toBe("1,2,3,4,5,6");
      await screen.getByRole("link", /#5 Budget fixture 5/).tap();
      await expect(screen.getByRole("heading", "Budget fixture 5")).toBeVisible({
        timeout: 20_000,
      });
      const reads = await pullRequestReads(prkit.fake);
      expect(reads.length).toBeGreaterThan(0);
      expect([...new Set(reads.map((entry) => `${entry.login}@${entry.dir}`))]).toEqual([
        `${SECOND}@gh-second`,
      ]);
      expect(await crossed(prkit.fake)).toEqual([]);

      // A hosts.yml prkit can't read, then one cut off mid-write: each says so on the account.
      prkit.lock(hosts);
      await prkit.rediscover();
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        `prkit can't read ~/.config/gh-second/hosts.yml, so it can't check ${SECOND}. Check the file's permissions, then retry.`,
      );
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(1);
      prkit.unlock(hosts);
      const original = NodeFS.readFileSync(hosts, "utf8");
      NodeFS.writeFileSync(hosts, `github.com:\n  user: ${SECOND}\n  users: budg`);
      await prkit.rediscover();
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        `~/.config/gh-second/hosts.yml is incomplete or isn't valid YAML, so prkit can't check ${SECOND}.`,
      );
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(1);
      await app.screenshot("settings-account-hosts-damaged");
      // gh could still print a token from that file, but the watcher's reads of #5's open tab get
      // none: not from this directory, not from any other.
      await prkit.fake.resetStats();
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      expect(
        (await prkit.fake.stats()).log.filter(
          (entry) => entry.login === SECOND || entry.dir === "gh-second",
        ),
      ).toEqual([]);
      // gh empties the file before it writes it, so an empty file is one it is still writing.
      NodeFS.writeFileSync(hosts, "");
      await prkit.rediscover();
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        `~/.config/gh-second/hosts.yml is incomplete or isn't valid YAML, so prkit can't check ${SECOND}.`,
      );

      // gh finishes writing it, with the token in the keyring: the account's Retry finds it ready.
      NodeFS.writeFileSync(hosts, keyringHostsFor(SECOND));
      await prkit.accounts.getByRole("alert").getByRole("button", "Retry").tap();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(2, { timeout: 20_000 });
      await expect(prkit.accounts.getByRole("alert")).toHaveCount(0);
      NodeFS.writeFileSync(hosts, original);
      expect(await crossed(prkit.fake)).toEqual([]);
    } finally {
      prkit.stop();
    }
  },
);

test(
  "a directory unreadable at launch hides no other account, one prkit never read gets its own notice, and a login two directories name never falls back to the second",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const prkit = await launch("accounts-config-dirs-launch", { app, screen, browser });
    const first = prkit.dir("gh");
    const second = prkit.dir("gh-second");
    const third = prkit.dir("gh-third");
    try {
      // The second directory can't be read while prkit starts: its account keeps its place, and
      // its reason shows with the first rows, before GitHub verifies the first account.
      await prkit.fake.resetStats();
      await prkit.fake.hold("core");
      await prkit.relaunch(() => prkit.lock(second));
      await expect.poll(() => rows(browser), { timeout: 4_000 }).toBe("1,2,3,4,5,6");
      await expect(
        screen.getByRole("alert").filter({
          hasText: `prkit can't open ~/.config/gh-second, so it can't check ${SECOND}.`,
        }),
      ).toBeVisible({ timeout: 4_000 });
      await prkit.fake.release("core");
      expect((await prkit.fake.stats()).log.filter((entry) => entry.login === SECOND)).toEqual([]);
      expect(await crossed(prkit.fake)).toEqual([]);
      prkit.unlock(second);

      // A directory prkit never read can't be opened at launch: it has a notice of its own.
      const dirNotice = screen.getByRole("alert").filter({
        hasText: "prkit can't open ~/.config/gh-third, so it can't find the accounts there.",
      });
      await prkit.relaunch(() => {
        NodeFS.mkdirSync(third, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(third, "hosts.yml"), hostsFor(THIRD));
        prkit.lock(third);
      });
      await expect(dirNotice).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => rows(browser), { timeout: 20_000 }).toBe("1,2,3,4,5,6");
      await expect(screen.getByRole("alert")).toHaveCount(1);
      await app.screenshot("inbox-dir-unreadable-light");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("inbox-dir-unreadable-dark");
      await browser.setViewport({ width: 600, height: 720 });
      await expect(dirNotice.getByRole("button", "Retry")).toBeVisible();
      await app.screenshot("inbox-dir-unreadable-narrow");
      await browser.setViewport({ width: 1280, height: 720 });
      await setOsColorScheme(browser, "light");
      await prkit.settings();
      const dirRow = prkit.accounts.getByRole("alert").filter({ hasText: "~/.config/gh-third" });
      await expect(dirRow).toContainText(
        "prkit can't open ~/.config/gh-third, so it can't find the accounts there. Check the directory's permissions, then retry.",
      );
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(2);
      await expect(prkit.accounts.getByRole("button", "Remove")).toHaveCount(0);
      await app.screenshot("settings-dir-unreadable");
      await setOsColorScheme(browser, "dark");
      await app.screenshot("settings-dir-unreadable-dark");
      await setOsColorScheme(browser, "light");

      // Readable again: Retry in the Inbox finds its account and reads it through it alone.
      prkit.unlock(third);
      await prkit.fake.resetStats();
      await prkit.inbox();
      await dirNotice.getByRole("button", "Retry").tap();
      await expect(screen.getByRole("alert")).toHaveCount(0, { timeout: 20_000 });
      await prkit.settings();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(3);
      expect(
        (await prkit.fake.stats()).log.filter((entry) => entry.login === THIRD).length,
      ).toBeGreaterThan(0);
      expect(await crossed(prkit.fake)).toEqual([]);
      NodeFS.rmSync(third, { recursive: true });

      // Both directories name the first login: it is read through the first, as before.
      NodeFS.writeFileSync(NodePath.join(second, "hosts.yml"), hostsFor(FIRST));
      await prkit.rediscover();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(1);
      await expect(prkit.accounts.getByText(SECOND, { exact: true })).toHaveCount(0);
      await prkit.fake.resetStats();
      await prkit.inbox();
      await screen.getByRole("button", "Refresh").first().tap();
      await expect.poll(() => rows(browser), { timeout: 20_000 }).toBe("1,2,3,4");
      const firstReads = (await prkit.fake.stats()).log.filter((entry) => entry.login === FIRST);
      expect(firstReads.length).toBeGreaterThan(0);
      expect([...new Set(firstReads.map((entry) => entry.dir))]).toEqual(["gh"]);

      // The first can't be read: the login waits for it, and nothing reads through the second.
      await prkit.fake.resetStats();
      prkit.lock(first);
      await prkit.rediscover();
      await expect(prkit.accounts.getByText("Ready")).toHaveCount(0);
      await expect(prkit.accounts.getByRole("alert")).toContainText(
        `prkit can't open ~/.config/gh, so it can't check ${FIRST}.`,
      );
      await prkit.inbox();
      await expect(
        screen
          .getByRole("alert")
          .filter({ hasText: `prkit can't open ~/.config/gh, so it can't check ${FIRST}.` }),
      ).toBeVisible();
      await expect.poll(() => rows(browser)).toBe("1,2,3,4");
      await prkit.relaunch(() => {});
      await expect.poll(() => rows(browser), { timeout: 10_000 }).toBe("1,2,3,4");
      await expect(
        screen
          .getByRole("alert")
          .filter({ hasText: `prkit can't open ~/.config/gh, so it can't check ${FIRST}.` }),
      ).toBeVisible({ timeout: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect((await prkit.fake.stats()).log.filter((entry) => entry.dir === "gh-second")).toEqual(
        [],
      );
      expect((await prkit.fake.stats()).log.filter((entry) => entry.login === FIRST)).toEqual([]);

      // Readable again: the login is read through the first directory once more.
      prkit.unlock(first);
      await screen
        .getByRole("alert")
        .filter({ hasText: `prkit can't open ~/.config/gh, so it can't check ${FIRST}.` })
        .getByRole("button", "Retry")
        .tap();
      await expect(screen.getByRole("alert")).toHaveCount(0, { timeout: 20_000 });
      const repaired = (await prkit.fake.stats()).log.filter((entry) => entry.login === FIRST);
      expect(repaired.length).toBeGreaterThan(0);
      expect([...new Set(repaired.map((entry) => entry.dir))]).toEqual(["gh"]);
    } finally {
      prkit.stop();
    }
  },
);
