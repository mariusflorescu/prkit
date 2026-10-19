import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { choose } from "./pickers.ts";

/**
 * Every different thing the Inbox's list shows, from the page's first script on: its rows'
 * numbers, or the heading of the empty state in their place. A skeleton shows nothing.
 */
const FRAME_TRACE = `(() => {
  const seen = [];
  window.__inboxFrames = seen;
  const read = () => {
    const main = document.querySelector("main");
    if (main === null) return null;
    const rows = [...main.querySelectorAll("a[data-pr-number]")]
      .map((link) => Number(link.getAttribute("data-pr-number")))
      .sort((left, right) => left - right);
    if (rows.length > 0) return "rows " + rows.join(",");
    const empty = main.querySelector('[role="heading"][aria-level="2"]');
    return empty === null ? null : "empty " + empty.textContent;
  };
  new MutationObserver(() => {
    const now = read();
    if (now !== null && now !== seen[seen.length - 1]) seen.push(now);
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
})()`;
const decodeFrames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const frames = async (browser: Browser) =>
  decodeFrames(
    await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__inboxFrames") ?? [])),
  );

const SECOND = "budget-second";
const savedFilters = (home: string) =>
  String(
    readRows(home, "SELECT json_remove(inbox_filters, '$.savedAt') AS f FROM workspace")[0]?.f ??
      "",
  );
/** Changes a stopped instance's database, as an earlier run would have left it. */
const edit = (home: string, change: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    change(db);
  } finally {
    db.close();
  }
};
const secondConfig = (fake: FakeGitHub) => NodePath.join(fake.home, ".config", "gh-second");

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };
/** What a relaunch changes while prkit is stopped, and right after it has started. */
type Changes = { before?: () => void; started?: () => void };

/**
 * A fake GitHub with two accounts, the first with #1 to #4 in its inbox and the second with
 * #5 and #6, and an instance on it with the Inbox open.
 *
 * `relaunchHeld` holds GitHub's answers to the accounts' verification, stops the instance,
 * runs `before`, starts it again, runs `started`, and checks what the Inbox draws while they
 * are held: `held` within 4
 * seconds and still 5 seconds in, or with null the skeleton alone. `release` lets GitHub
 * answer and checks that the Inbox has drawn `settled` after `held`, and nothing more, once the
 * accounts are verified and the inbox read again. `relaunch` is both.
 */
const launch = async (name: string, { app, screen, browser }: Fixtures) => {
  const fake = await startFakeGitHub(name, { secondAccount: true });
  await fake.inboxOnly("budget-test", [1, 2, 3, 4]);
  await fake.inboxOnly(SECOND, [5, 6]);
  let run = startFakeInstance(name, fake);
  await browser.addInitScript(FRAME_TRACE);
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
  const relaunchHeld = async (
    held: string | null,
    { before = () => {}, started = () => {} }: Changes = {},
  ) => {
    // Before the stop, which blocks this worker: the next request would find its socket closed.
    await fake.hold("core");
    stopFakeInstance(name, { keepHome: true });
    before();
    run = startFakeInstance(name, fake);
    started();
    const opened = Date.now();
    await app.open(run.openUrl);
    const drawn = held === null ? [] : [held];
    await expect.poll(() => frames(browser), { timeout: 4_000 }).toEqual(drawn);
    expect(Date.now() - opened).toBeLessThan(4_000);
    // prkit gives up on an account GitHub hasn't verified in 10 seconds.
    await new Promise((resolve) => setTimeout(resolve, opened + 5_000 - Date.now()));
    expect(await frames(browser)).toEqual(drawn);
    return drawn;
  };
  const release = async (drawn: ReadonlyArray<string>, settled: string) => {
    await fake.release("core");
    const record = drawn.at(-1) === settled ? drawn : [...drawn, settled];
    await expect.poll(() => frames(browser), { timeout: 10_000 }).toEqual(record);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await frames(browser)).toEqual(record);
  };
  return {
    fake,
    home: () => run.home,
    relaunchHeld,
    release,
    relaunch: async (
      held: string | null,
      { settled, ...changes }: Changes & { settled?: string } = {},
    ) => {
      const drawn = await relaunchHeld(held, changes);
      const last = settled ?? held;
      if (last === null)
        throw new Error("A relaunch that draws nothing while held needs `settled`.");
      await release(drawn, last);
    },
    stop: () => {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    },
  };
};

test(
  "a relaunch draws its first rows from prkit's cache with each saved filter already on, while GitHub is slow",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const inbox = await launch("inbox-relaunch-filters", { app, screen, browser });
    try {
      const search = screen.getByRole("searchbox", "Search pull requests");
      const accountFilter = screen.getByRole("combobox", "Filter by GitHub account");

      await search.fill("fixture 2");
      await expect.poll(() => savedFilters(inbox.home())).toContain('"search":"fixture 2"');
      await inbox.relaunch("rows 2");
      await expect(search).toHaveValue("fixture 2");
      await app.screenshot("relaunch-search");

      await search.fill("");
      await choose(
        screen,
        screen.getByRole("button", "Filter by repository: All repositories"),
        "tools",
      );
      await expect.poll(() => savedFilters(inbox.home())).toContain('"name":"tools"');
      await inbox.relaunch("empty Nothing in budget/tools needs you");
      await expect(screen.getByRole("button", "Filter by repository: budget/tools")).toBeVisible();
      await app.screenshot("relaunch-repository");

      await screen.getByRole("button", "Clear filters").tap();
      await choose(screen, accountFilter, SECOND);
      await expect
        .poll(() => savedFilters(inbox.home()))
        .toContain(`"account":"github.com/${SECOND}"`);
      await inbox.relaunch("rows 5,6");
      await expect(accountFilter).toContainText(SECOND);
      await app.screenshot("relaunch-account");

      await browser.reload();
      await expect.poll(() => frames(browser)).toEqual(["rows 5,6"]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await frames(browser)).toEqual(["rows 5,6"]);
    } finally {
      inbox.stop();
    }
  },
);

test(
  "a relaunch lets go of a saved filter's account that logged out, and waits for one it kept nothing of",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const inbox = await launch("inbox-relaunch-accounts", { app, screen, browser });
    try {
      const accountFilter = screen.getByRole("combobox", "Filter by GitHub account");
      await choose(screen, accountFilter, SECOND);
      await choose(
        screen,
        screen.getByRole("button", "Filter by repository: All repositories"),
        "tools",
      );
      await expect
        .poll(() => savedFilters(inbox.home()))
        .toContain(`"accountIds":["github.com/${SECOND}"]`);

      // The second account logs out of gh while prkit is closed. Its inbox is still in prkit's
      // cache, and it was the only account the saved repository filter read through.
      const config = NodeFS.readFileSync(NodePath.join(secondConfig(inbox.fake), "hosts.yml"));
      await inbox.relaunch("rows 1,2,3,4", {
        before: () => NodeFS.rmSync(secondConfig(inbox.fake), { recursive: true }),
      });
      await expect
        .poll(() => savedFilters(inbox.home()))
        .toBe('{"search":"","account":null,"repository":null,"sort":"updated"}');
      await expect(accountFilter).toHaveCount(0);
      await expect(screen.getByText(SECOND, { exact: true })).toHaveCount(0);
      await app.screenshot("relaunch-account-gone");

      // It logs in again, but prkit kept nothing of its inbox, so its rows wait for GitHub, with
      // its account filter and then with a search that only its rows match.
      const forget = (filters: { search: string; account: string | null }) => () => {
        NodeFS.mkdirSync(secondConfig(inbox.fake), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(secondConfig(inbox.fake), "hosts.yml"), config);
        edit(inbox.home(), (db) => {
          db.prepare("DELETE FROM github_read_cache WHERE account_id = ?").run(
            `github.com/${SECOND}`,
          );
          db.prepare("UPDATE workspace SET inbox_filters = ? WHERE id = 1").run(
            JSON.stringify({
              ...filters,
              repository: null,
              sort: "updated",
              savedAt: new Date().toISOString(),
            }),
          );
        });
      };
      await inbox.relaunch(null, {
        settled: "rows 5,6",
        before: forget({ search: "", account: `github.com/${SECOND}` }),
      });
      await expect(accountFilter).toContainText(SECOND);
      await app.screenshot("relaunch-account-uncached");
      await inbox.relaunch(null, {
        settled: "rows 5",
        before: forget({ search: "fixture 5", account: null }),
      });
    } finally {
      inbox.stop();
    }
  },
);

/** Reads every account makes for its inbox, apart from any one pull request. */
const INBOX_READS = new Set(["rest:user", "graphql:inbox", "graphql:review-waits"]);

test(
  "a relaunch shows each account only what was kept for it from its own gh config directory, and a tab opened before verification reads through its row's account",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const inbox = await launch("inbox-relaunch-directories", { app, screen, browser });
    const directory = secondConfig(inbox.fake);
    const hosts = NodePath.join(directory, "hosts.yml");
    const original = NodeFS.readFileSync(hosts, "utf8");
    const write = (text: string) => () => NodeFS.writeFileSync(hosts, text);
    try {
      await inbox.relaunchHeld("rows 1,2,3,4,5,6");
      const since = (await inbox.fake.stats()).log.length;
      const pullRequestReads = async () =>
        (await inbox.fake.stats()).log.slice(since).filter((entry) => !INBOX_READS.has(entry.kind));
      await screen.getByRole("link", /#5 Budget fixture 5/).tap();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await pullRequestReads()).toEqual([]);
      await inbox.fake.release("core");
      await expect(screen.getByRole("heading", "Budget fixture 5")).toBeVisible({
        timeout: 30_000,
      });
      expect(await browser.evaluate(() => location.search)).toContain(
        `account=${encodeURIComponent(`github.com/${SECOND}`)}`,
      );
      const reads = await pullRequestReads();
      expect(reads.length).toBeGreaterThan(0);
      expect([...new Set(reads.map((entry) => entry.login))]).toEqual([SECOND]);
      await app.screenshot("relaunch-tab-account");
      await screen
        .getByRole("navigation", "Workspace tabs")
        .getByRole("button", "Close budget/fixtures #5")
        .tap();

      // The second directory now names a login it never named: nothing kept for that login, so
      // only the first account's rows, until the new login is read.
      await inbox.fake.inboxOnly("budget-third", [6]);
      await inbox.relaunch("rows 1,2,3,4", {
        settled: "rows 1,2,3,4,6",
        before: write(original.replaceAll(SECOND, "budget-third")),
      });

      // Both directories name the first account: it is read through the first directory, and
      // the second account's kept rows never show.
      await inbox.relaunch("rows 1,2,3,4", {
        before: write(original.replaceAll(SECOND, "budget-test")),
      });

      // A hosts file cut off mid-write before any login, then one prkit can't read. The login it
      // listed last is the first directory's, so the other's rows show alone, and the directory
      // says what's wrong with it.
      await inbox.relaunch("rows 1,2,3,4", { before: write("github.com:\n  users:\n    budg") });
      await expect(screen.getByRole("alert")).toHaveCount(1);
      await expect(screen.getByRole("alert")).toContainText(
        "~/.config/gh-second/hosts.yml is incomplete or isn't valid YAML",
      );
      await inbox.relaunch("rows 1,2,3,4", {
        before: () => {
          write(original)();
          NodeFS.chmodSync(hosts, 0o000);
        },
      });
      await expect(screen.getByRole("alert")).toHaveCount(1);
      await expect(screen.getByRole("alert")).toContainText(
        "prkit can't read ~/.config/gh-second/hosts.yml",
      );
      NodeFS.chmodSync(hosts, 0o644);

      // Each directory names the other's login: nothing was kept for either from its directory,
      // so the skeleton until both are read.
      const first = NodePath.join(inbox.fake.home, ".config", "gh", "hosts.yml");
      const firstHosts = NodeFS.readFileSync(first, "utf8");
      await inbox.relaunch(null, {
        settled: "rows 1,2,3,4,5,6",
        before: () => {
          NodeFS.writeFileSync(first, original);
          NodeFS.writeFileSync(hosts, firstHosts);
        },
      });

      // Both directories name the second account, whose rows were last kept from the first, the
      // directory that listed it last. The first's hosts file can't be read while prkit starts, so
      // the account keeps its place there: the rows kept from the first show with its reason, and
      // nothing reads through the second, even once that file is readable again before the Inbox
      // asks.
      await inbox.fake.resetStats();
      await inbox.relaunch("rows 5,6", {
        before: () => {
          NodeFS.writeFileSync(hosts, original);
          NodeFS.chmodSync(first, 0o000);
        },
        started: () => NodeFS.chmodSync(first, 0o644),
      });
      await expect(screen.getByRole("alert")).toContainText(
        `prkit can't read ~/.config/gh/hosts.yml, so it can't check ${SECOND}.`,
      );
      expect((await inbox.fake.stats()).log.filter((entry) => entry.dir === "gh-second")).toEqual(
        [],
      );
      NodeFS.writeFileSync(first, firstHosts);
    } finally {
      inbox.stop();
    }
  },
);
