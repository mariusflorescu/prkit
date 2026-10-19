import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { instancePaths } from "../scripts/verify-run.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const FIRST = "budget-test";
const SECOND = "budget-second";
/** The only gh config directory each login's token may come from. */
const HOME_DIR: Record<string, string> = { [FIRST]: "gh", [SECOND]: "gh-second" };
/** How long GitHub takes to answer the second account's failing inbox reads, as in an outage. */
const FAIL_MS = 10_000;

/**
 * Every different thing the Inbox's list shows, from the page's first script on, with when it
 * showed: its rows' numbers by the account each row says it was read through, or the heading
 * of the empty state in their place, then each account's notice. The skeleton before the first
 * list shows nothing; one after it shows as `loading`.
 */
const FRAME_TRACE = `(() => {
  const seen = [];
  window.__inboxFrames = seen;
  const read = () => {
    const main = document.querySelector("main");
    if (main === null) return null;
    const byAccount = new Map();
    for (const link of main.querySelectorAll("a[data-pr-number]")) {
      const login = (link.getAttribute("data-account") ?? "").replace("github.com/", "");
      byAccount.set(login, [...(byAccount.get(login) ?? []), Number(link.getAttribute("data-pr-number"))]);
    }
    const rows = [...byAccount.keys()].sort().map((login) => login + " " + byAccount.get(login).sort((a, b) => a - b).join(","));
    const empty = main.querySelector('[role="heading"][aria-level="2"]');
    const list = rows.length > 0
      ? "rows " + rows.join(" + ")
      : empty !== null
        ? "empty " + empty.textContent
        : main.querySelector('[aria-busy="true"]') !== null && seen.length > 0
          ? "loading"
          : null;
    if (list === null) return null;
    const notices = [...main.querySelectorAll("[data-github-problem]")].map(
      (notice) => "notice " + (notice.getAttribute("data-account") ?? "").replace("github.com/", "") + " " + notice.getAttribute("data-github-problem"),
    );
    return [list, ...notices].join("; ");
  };
  new MutationObserver(() => {
    const now = read();
    if (now !== null && now !== seen[seen.length - 1]?.state)
      seen.push({ at: Math.round(performance.now()), state: now });
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
})()`;
const decodeFrames = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ at: Schema.Number, state: Schema.String }))),
);
const traced = async (browser: Browser) =>
  decodeFrames(
    await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__inboxFrames") ?? [])),
  );
const frames = async (browser: Browser) => (await traced(browser)).map((frame) => frame.state);
/** Milliseconds from the page's navigation to its first drawn list. */
const firstDrawnAt = async (browser: Browser) => (await traced(browser))[0]?.at ?? Infinity;

const FIRST_ROWS = `rows ${FIRST} 1,2,3,4`;
const BOTH_ROWS = `rows ${SECOND} 5,6 + ${FIRST} 1,2,3,4`;
const FAILING = `notice ${SECOND} unavailable`;
const notice = (browser: Browser) =>
  browser.locator(`[data-github-problem][data-account="github.com/${SECOND}"]`);

const inboxReads = async (fake: FakeGitHub, login: string) =>
  (await fake.stats()).log.filter(
    (entry) => entry.login === login && entry.kind.startsWith("graphql:inbox"),
  );
/** Every request since the last reset whose token came from another directory than its login's. */
const crossed = async (fake: FakeGitHub) =>
  (await fake.stats()).log.filter(
    (entry) => entry.login !== "" && HOME_DIR[entry.login] !== entry.dir,
  );
/**
 * The priority prkit sent each of the login's inbox reads at, from the instance's own log:
 * `interactive` for a window's, `background` for the watcher's.
 */
const inboxPriorities = (name: string, login: string) =>
  [
    ...NodeFS.readFileSync(instancePaths(name).log, "utf8").matchAll(
      /GitHub request \{\n([\s\S]*?)\n\}/g,
    ),
  ].flatMap(([, fields = ""]) =>
    fields.includes(`accountId: 'github.com/${login}'`) &&
    fields.includes("operation: 'PrkitInbox'")
      ? [/priority: '(\w+)'/.exec(fields)?.[1] ?? "none"]
      : [],
  );

/** A fake GitHub with two accounts, the first with #1 to #4 in its inbox and the second with #5 and #6. */
const twoAccounts = async (name: string) => {
  NodeFS.rmSync(instancePaths(name).log, { force: true });
  const fake = await startFakeGitHub(name, { secondAccount: true });
  await fake.inboxOnly(FIRST, [1, 2, 3, 4]);
  await fake.inboxOnly(SECOND, [5, 6]);
  return fake;
};
const failSecond = (fake: FakeGitHub, status: number) =>
  fake.fail("graphql:inbox", 99, status, undefined, { login: SECOND, ms: FAIL_MS });
const healSecond = (fake: FakeGitHub) =>
  fake.fail("graphql:inbox", 0, 502, undefined, { login: SECOND });

test(
  "a reload draws the healthy account's rows at once while the other account's inbox reads fail",
  { timeout: 240_000 },
  async ({ app, browser }) => {
    const name = "inbox-reload-unread";
    const fake = await twoAccounts(name);
    try {
      await failSecond(fake, 502);
      const run = startFakeInstance(name, fake, ["--e2e", "--watch-interval", "5000"]);
      await browser.addInitScript(FRAME_TRACE);
      await emulateOsColorScheme(browser, "light");

      await app.open(run.openUrl);
      await expect.poll(() => frames(browser), { timeout: 5_000 }).toEqual([FIRST_ROWS]);
      expect(await firstDrawnAt(browser)).toBeLessThan(5_000);
      await expect
        .poll(() => frames(browser), { timeout: FAIL_MS + 10_000 })
        .toEqual([FIRST_ROWS, `${FIRST_ROWS}; ${FAILING}`]);
      await expect(notice(browser)).toContainText(
        `GitHub is temporarily unavailable for ${SECOND} (HTTP 502).`,
      );
      await expect(notice(browser).getByRole("button", "Retry")).toBeEnabled();

      // A read of the second account may still be on its way: the reload doesn't wait for it.
      await failSecond(fake, 504);
      await browser.reload();
      await expect
        .poll(() => frames(browser), { timeout: 3_000 })
        .toEqual([`${FIRST_ROWS}; ${FAILING}`]);
      expect(await firstDrawnAt(browser)).toBeLessThan(3_000);
      await screenshotLightAndDark(app, browser, "reload-account-failing");
      await new Promise((resolve) => setTimeout(resolve, FAIL_MS + 2_000));
      expect(await frames(browser)).toEqual([`${FIRST_ROWS}; ${FAILING}`]);

      await healSecond(fake);
      await expect
        .poll(() => frames(browser), { timeout: FAIL_MS + 15_000 })
        .toEqual([`${FIRST_ROWS}; ${FAILING}`, BOTH_ROWS]);
      await app.screenshot("reload-account-recovered");

      expect((await inboxReads(fake, FIRST)).map((entry) => entry.kind)).toEqual(["graphql:inbox"]);
      const priorities = inboxPriorities(name, SECOND);
      expect(priorities.length).toBeGreaterThanOrEqual(3);
      expect(priorities.slice(1).every((priority) => priority === "background")).toBe(true);
      expect(await crossed(fake)).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "an account's kept rows stay under it with its notice while GitHub fails it, and Retry clears it",
  { timeout: 240_000 },
  async ({ app, screen, browser }) => {
    const name = "inbox-reload-kept";
    const fake = await twoAccounts(name);
    try {
      let run = startFakeInstance(name, fake);
      await browser.addInitScript(FRAME_TRACE);
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect
        .poll(async () => (await frames(browser)).at(-1), { timeout: 20_000 })
        .toBe(BOTH_ROWS);

      // A prkit write to the second account's pull request marked its kept inbox stale right
      // before prkit closed, and GitHub fails it from the next start on.
      await failSecond(fake, 502);
      // Before the stop, which blocks this worker: the next request would find its socket closed.
      await fake.resetStats();
      stopFakeInstance(name, { keepHome: true });
      const db = new DatabaseSync(NodePath.join(run.home, "prkit.sqlite"));
      try {
        db.prepare(
          "UPDATE github_read_cache SET invalidated = 1 WHERE kind = 'inbox' AND account_id = ?",
        ).run(`github.com/${SECOND}`);
      } finally {
        db.close();
      }
      run = startFakeInstance(name, fake);
      await app.open(run.openUrl);
      await expect.poll(() => frames(browser), { timeout: 4_000 }).toEqual([BOTH_ROWS]);
      // Both accounts are verified, so the next answer no longer comes before discovery.
      await expect
        .poll(
          async () => (await fake.stats()).log.filter((entry) => entry.kind === "rest:user").length,
        )
        .toBeGreaterThanOrEqual(2);

      await browser.reload();
      await expect
        .poll(async () => (await frames(browser)).length, { timeout: 3_000 })
        .toBeGreaterThan(0);
      expect(await firstDrawnAt(browser)).toBeLessThan(3_000);
      await expect
        .poll(async () => (await frames(browser)).at(-1), { timeout: FAIL_MS * 2 + 5_000 })
        .toBe(`${BOTH_ROWS}; ${FAILING}`);
      expect(
        (await frames(browser)).every(
          (frame) => frame === BOTH_ROWS || frame === `${BOTH_ROWS}; ${FAILING}`,
        ),
      ).toBe(true);
      await expect(notice(browser)).toContainText(
        `GitHub is temporarily unavailable for ${SECOND} (HTTP 502). Try refreshing in a moment. Showing what prkit fetched just now.`,
      );
      await screenshotLightAndDark(app, browser, "reload-kept-rows-failing");

      const drawn = await frames(browser);
      await notice(browser).getByRole("button", "Retry").tap();
      await expect(notice(browser).getByRole("button", "Retrying...")).toBeVisible();
      await expect(notice(browser).getByRole("button", "Retry")).toBeVisible({
        timeout: FAIL_MS * 2 + 5_000,
      });
      expect(await frames(browser)).toEqual(drawn);

      await healSecond(fake);
      await notice(browser).getByRole("button", "Retry").tap();
      await expect(notice(browser)).toHaveCount(0, { timeout: FAIL_MS * 2 + 5_000 });
      expect(await frames(browser)).toEqual([...drawn, BOTH_ROWS]);
      await expect(screen.getByRole("link", /#5 Budget fixture 5/)).toBeVisible();
      expect(await crossed(fake)).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

/** The page starts hidden, as a window opened behind others does, until `show`. */
const START_HIDDEN = `(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
})()`;
const show = (browser: Browser) =>
  browser.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    return true;
  });

test(
  "a window that opens hidden draws the rows read while nobody looked once it is shown",
  { timeout: 120_000 },
  async ({ app, browser }) => {
    const name = "inbox-reload-hidden";
    const fake = await twoAccounts(name);
    try {
      const run = startFakeInstance(name, fake);
      await browser.addInitScript(FRAME_TRACE);
      await browser.addInitScript(START_HIDDEN);
      await app.open(run.openUrl);
      // Its first answer had nothing kept to show, and both reads landed while it heard nothing.
      await expect
        .poll(
          async () =>
            (await inboxReads(fake, FIRST)).length + (await inboxReads(fake, SECOND)).length,
          { timeout: 20_000 },
        )
        .toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await frames(browser)).toEqual([]);

      await show(browser);
      await expect.poll(() => frames(browser), { timeout: 3_000 }).toEqual([BOTH_ROWS]);
      expect((await fake.stats()).byKind["graphql:inbox"]).toBe(2);
      expect(await crossed(fake)).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
