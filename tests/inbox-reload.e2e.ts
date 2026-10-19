import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

const FIRST = "budget-test";
const SECOND = "budget-second";
/** How long GitHub takes to answer the second account's failing inbox reads, as in an outage. */
const FAIL_MS = 10_000;

/**
 * Every different thing the Inbox's list shows, from the page's first script on, with when it
 * showed: its rows' numbers, or the heading of the empty state in their place, then each
 * account's notice. A skeleton shows nothing.
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
    const empty = main.querySelector('[role="heading"][aria-level="2"]');
    const list = rows.length > 0 ? "rows " + rows.join(",") : empty === null ? null : "empty " + empty.textContent;
    if (list === null) return null;
    const notices = [...main.querySelectorAll("[data-github-problem]")].map(
      (notice) => notice.getAttribute("data-account") + " " + notice.getAttribute("data-github-problem"),
    );
    return notices.length === 0 ? list : list + "; " + notices.join("; ");
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

const failing = `github.com/${SECOND} unavailable`;
const notice = (browser: Browser) =>
  browser.locator(`[data-github-problem][data-account="github.com/${SECOND}"]`);

/** The inbox reads GitHub answered for `login` since the last reset, failed ones included. */
const inboxReads = async (fake: FakeGitHub, login: string) =>
  (await fake.stats()).log.filter(
    (entry) => entry.login === login && entry.kind.startsWith("graphql:inbox"),
  );
/** No two of the login's failing reads ran at once: each failure lands a full FAIL_MS after the last. */
const oneReadAtATime = async (fake: FakeGitHub, login: string) => {
  const failed = (await inboxReads(fake, login))
    .filter((entry) => entry.kind === "graphql:inbox:failed")
    .map((entry) => Date.parse(entry.at));
  return failed.every((at, index) => index === 0 || at - (failed[index - 1] ?? 0) >= FAIL_MS - 500);
};

/** A fake GitHub with two accounts, the first with #1 to #4 in its inbox and the second with #5 and #6. */
const twoAccounts = async (name: string) => {
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

      // A first load: the first account's rows as soon as it is read, then the second's notice.
      await app.open(run.openUrl);
      await expect.poll(() => frames(browser), { timeout: 5_000 }).toEqual(["rows 1,2,3,4"]);
      expect(await firstDrawnAt(browser)).toBeLessThan(5_000);
      await expect
        .poll(() => frames(browser), { timeout: FAIL_MS + 10_000 })
        .toEqual(["rows 1,2,3,4", `rows 1,2,3,4; ${failing}`]);
      await expect(notice(browser)).toContainText(
        `GitHub is temporarily unavailable for ${SECOND} (HTTP 502).`,
      );
      await expect(notice(browser).getByRole("button", "Retry")).toBeEnabled();

      // GitHub moves on to 504s. A reload draws both from its first frame, while a read of the
      // second account is still on its way.
      await failSecond(fake, 504);
      await browser.reload();
      await expect
        .poll(() => frames(browser), { timeout: 3_000 })
        .toEqual([`rows 1,2,3,4; ${failing}`]);
      expect(await firstDrawnAt(browser)).toBeLessThan(3_000);
      await screenshotLightAndDark(app, browser, "reload-account-failing");
      await new Promise((resolve) => setTimeout(resolve, FAIL_MS + 2_000));
      expect(await frames(browser)).toEqual([`rows 1,2,3,4; ${failing}`]);

      // GitHub answers again: the watcher's next read brings the second account's rows, with no click.
      await healSecond(fake);
      await expect
        .poll(() => frames(browser), { timeout: FAIL_MS + 15_000 })
        .toEqual([`rows 1,2,3,4; ${failing}`, "rows 1,2,3,4,5,6"]);
      await app.screenshot("reload-account-recovered");

      expect((await inboxReads(fake, FIRST)).map((entry) => entry.kind)).toEqual(["graphql:inbox"]);
      expect(await oneReadAtATime(fake, SECOND)).toBe(true);
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
        .toBe("rows 1,2,3,4,5,6");

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
      await expect.poll(() => frames(browser), { timeout: 4_000 }).toEqual(["rows 1,2,3,4,5,6"]);
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
        .toBe(`rows 1,2,3,4,5,6; ${failing}`);
      expect((await frames(browser)).every((frame) => frame.startsWith("rows 1,2,3,4,5,6"))).toBe(
        true,
      );
      await expect(notice(browser)).toContainText(
        `GitHub is temporarily unavailable for ${SECOND} (HTTP 502). Try refreshing in a moment. Showing what prkit fetched just now.`,
      );
      await screenshotLightAndDark(app, browser, "reload-kept-rows-failing");

      // Retry while GitHub still fails it: the notice stays, rows and all.
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
      expect((await frames(browser)).at(-1)).toBe("rows 1,2,3,4,5,6");
      await expect(screen.getByRole("link", /#5 Budget fixture 5/)).toBeVisible();
      expect(await oneReadAtATime(fake, SECOND)).toBe(true);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
