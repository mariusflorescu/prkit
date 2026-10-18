import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { inboxOrder, readInboxRows } from "./inboxRows.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";
import { choose } from "./pickers.ts";

const REVIEW = "Needs your review";
const YOURS = "Yours";

const seed = async (fake: FakeGitHub) => {
  await fake.shape(1, { additions: 600, deletions: 100, files: 12 });
  await fake.shape(2, { additions: 3, deletions: 1, files: 1 });
  await fake.requestReview(2, { login: "budget-test" }, 30);
  await fake.shape(3, { additions: 120, deletions: 30, files: 6 });
  await fake.unrequest(3, { login: "budget-test" });
  await fake.requestReview(3, { team: "budget/web" }, 300);
  await fake.requestReview(3, { team: "budget/api" }, 2880);
  await fake.shape(4, { additions: 40, deletions: 10, files: 3 });
  await fake.requestReview(4, { login: "budget-test" }, 20);
  await fake.shape(5, { additions: 5, deletions: 5, files: 1, opened: 7200 });
  await fake.shape(6, { additions: 3, deletions: 1, files: 20, opened: 4320 });
};

const ORDERS = {
  "Recently updated": { [REVIEW]: [4, 3, 1, 2], [YOURS]: [6, 5], Involved: [] },
  "Waiting longest": { [REVIEW]: [3, 1, 2, 4], [YOURS]: [5, 6], Involved: [] },
  "Smallest first": { [REVIEW]: [1, 2, 4, 3], [YOURS]: [5, 6], Involved: [] },
};

type Fixtures = Pick<TestFixtures, "app" | "screen">;
const sortTrigger = (screen: Fixtures["screen"]) =>
  screen.getByRole("combobox", "Sort pull requests");
const refresh = async (screen: Fixtures["screen"]) => {
  await screen.getByRole("button", "Refresh").tap();
};
const requests = async (fake: FakeGitHub) => {
  const { byKind } = await fake.stats();
  return {
    inbox: byKind["graphql:inbox"] ?? 0,
    waits: byKind["graphql:review-waits"] ?? 0,
    failedWaits: byKind["graphql:review-waits:failed"] ?? 0,
  };
};
const rowOf = async (browser: Browser, number: number) => {
  const row = (await readInboxRows(browser))
    .flatMap((group) => group.rows)
    .find((r) => r.number === number);
  if (row === undefined) throw new Error(`Row #${number} is not on the page.`);
  return row;
};

test("each row shows its size and reading time, and the wait on a review request, with the evidence in their titles", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-rows");
  try {
    await seed(fake);
    const run = startFakeInstance("inbox-triage-rows", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });

    const all = (await readInboxRows(browser)).flatMap((group) => group.rows);
    expect(all.map((row) => row.number).toSorted()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(all.map((row) => row.left)).size).toBe(1);

    const expected = [
      [1, "L", "41 min", /^waiting 1 hour$/, /\.\sYour review was requested on /],
      [2, "XS", "1 min", /^waiting (30|31) minutes$/, /\.\sYour review was requested again on /],
      [3, "M", "11 min", /^waiting 5\+ hours$/, /doesn't say which team is yours/],
      [4, "S", "4 min", /^waiting (20|21) minutes$/, /\.\sYour review was requested on /],
      [5, "XS", "1 min", /^updated 5\d minutes ago$/, /\.\sLast updated /],
      [6, "L", "11 min", /^updated 5\d minutes ago$/, /\.\sLast updated /],
    ] as const;
    for (const [number, chip, reading, label, title] of expected) {
      const row = await rowOf(browser, number);
      expect({ number, chip, reading }).toEqual({ number, chip: row.chip, reading: row.reading });
      expect(row.label).toMatch(label);
      expect(row.title).toMatch(title);
    }
    expect((await rowOf(browser, 3)).title).toMatch(
      /^Medium: 150 changed lines \(\+120 -30\) in 6 files\. About 11 minutes to read, at about 20 lines a minute and half a minute per file\. A review was requested from /,
    );
    expect((await rowOf(browser, 6)).title).toContain("The number of files sets the size.");
    expect((await rowOf(browser, 1)).title).toMatch(
      /^Large: 700 changed lines \(\+600 -100\) in 12 files\./,
    );
    await app.screenshot("triage-rows-light");

    await setOsColorScheme(browser, "dark");
    await app.screenshot("triage-rows-dark");
    await setOsColorScheme(browser, "light");

    await browser.setViewport({ width: 900, height: 720 });
    const fits = () =>
      browser.evaluate(() => {
        const trigger = document
          .querySelector('[aria-label="Sort pull requests"]')
          ?.getBoundingClientRect();
        const search = document
          .querySelector('[aria-label="Search pull requests"]')
          ?.getBoundingClientRect();
        return {
          overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          sortRight: trigger?.right ?? Number.POSITIVE_INFINITY,
          sortWidth: trigger?.width ?? 0,
          searchWidth: search?.width ?? 0,
          width: document.documentElement.clientWidth,
        };
      });
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible();
    const narrow = await fits();
    expect(narrow.overflows).toBe(false);
    expect(narrow.sortRight).toBeLessThanOrEqual(narrow.width);
    expect(narrow.searchWidth).toBeGreaterThanOrEqual(160);
    await app.screenshot("triage-rows-900");

    await browser.setViewport({ width: 600, height: 720 });
    await expect(sortTrigger(screen)).toBeVisible();
    const small = await readInboxRows(browser);
    expect(small.flatMap((group) => group.rows).every((row) => !row.readingVisible)).toBe(true);
    expect(
      small.flatMap((group) => group.rows).every((row) => row.chip !== "" && row.label !== ""),
    ).toBe(true);
    expect((await fits()).overflows).toBe(false);
    await app.screenshot("triage-rows-600");
  } finally {
    stopFakeInstance("inbox-triage-rows", { keepHome: false });
    fake.stop();
  }
});

test("sorting reorders each group without a GitHub request, and a new review request costs one inbox read and one waits read", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-sort");
  try {
    await seed(fake);
    const run = startFakeInstance("inbox-triage-sort", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });
    await expect(sortTrigger(screen)).toContainText("Recently updated");
    expect(await inboxOrder(browser)).toEqual(ORDERS["Recently updated"]);
    const loaded = await fake.stats();
    expect(await requests(fake)).toEqual({ inbox: 1, waits: 1, failedWaits: 0 });

    for (const sort of ["Waiting longest", "Smallest first", "Recently updated"] as const) {
      await choose(screen, sortTrigger(screen), sort);
      await expect(sortTrigger(screen)).toContainText(sort);
      expect(await inboxOrder(browser)).toEqual(ORDERS[sort]);
      if (sort === "Waiting longest") {
        expect((await rowOf(browser, 5)).label).toBe("opened 5 days ago");
        expect((await rowOf(browser, 6)).label).toBe("opened 3 days ago");
        expect((await rowOf(browser, 1)).label).toBe("waiting 1 hour");
        await app.screenshot("triage-sort-waiting-longest");
      }
      if (sort === "Smallest first") await app.screenshot("triage-sort-smallest-first");
    }
    const sorted = await fake.stats();
    expect({ ...sorted, log: undefined }).toEqual({ ...loaded, log: undefined });

    await fake.requestReview(5, { login: "budget-test" }, 3);
    await refresh(screen);
    await expect.poll(() => requests(fake)).toEqual({ inbox: 2, waits: 2, failedWaits: 0 });
    await expect(
      screen.getByRole("region", REVIEW).getByRole("link", /#5 Budget fixture 5/),
    ).toBeVisible();
    expect((await rowOf(browser, 5)).label).toMatch(/^waiting [34] minutes$/);
    await choose(screen, sortTrigger(screen), "Waiting longest");
    expect((await inboxOrder(browser))[REVIEW]).toEqual([3, 1, 2, 4, 5]);
    expect(await requests(fake)).toEqual({ inbox: 2, waits: 2, failedWaits: 0 });
    await app.screenshot("triage-new-review-request");
  } finally {
    stopFakeInstance("inbox-triage-sort", { keepHome: false });
    fake.stop();
  }
});

const storedFilters = (home: string) =>
  String(readRows(home, "SELECT inbox_filters AS filters FROM workspace")[0]?.filters ?? "");
const storeFilters = (home: string, filters: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.prepare("UPDATE workspace SET inbox_filters = ? WHERE id = 1").run(filters);
  } finally {
    db.close();
  }
};

test(
  "the sort comes back after a reload and a relaunch with the waits on the first paint, and Clear filters keeps it",
  { timeout: 120_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub("inbox-triage-saved");
    try {
      await seed(fake);
      let run = startFakeInstance("inbox-triage-saved", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({
        timeout: 20_000,
      });
      await choose(screen, sortTrigger(screen), "Smallest first");
      await expect.poll(() => storedFilters(run.home)).toContain('"sort":"size"');
      const kept = async () => {
        await expect(sortTrigger(screen)).toContainText("Smallest first", { timeout: 20_000 });
        await expect.poll(() => inboxOrder(browser)).toEqual(ORDERS["Smallest first"]);
        await expect(screen.getByText("waiting 5+ hours")).toBeVisible();
      };
      await browser.reload();
      await kept();
      await app.screenshot("triage-sort-after-reload");

      stopFakeInstance("inbox-triage-saved", { keepHome: true });
      run = startFakeInstance("inbox-triage-saved", fake);
      await app.open(run.openUrl);
      await kept();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await requests(fake)).toEqual({ inbox: 1, waits: 1, failedWaits: 0 });
      await app.screenshot("triage-sort-after-relaunch");

      await screen
        .getByRole("searchbox", "Search pull requests")
        .fill("no pull request is called this");
      await expect(screen.getByRole("heading", "No matching pull requests")).toBeVisible();
      await expect(screen.getByRole("region", REVIEW)).toHaveCount(0);
      await app.screenshot("triage-sort-no-match");
      await screen.getByRole("button", "Clear filters").tap();
      await expect(sortTrigger(screen)).toContainText("Smallest first");
      expect(await inboxOrder(browser)).toEqual(ORDERS["Smallest first"]);

      await fake.limit("graphql", 120);
      await refresh(screen);
      await expect(screen.getByRole("alert")).toContainText(/used up/i, { timeout: 20_000 });
      expect(await inboxOrder(browser)).toEqual(ORDERS["Smallest first"]);
      expect((await rowOf(browser, 3)).label).toBe("waiting 5+ hours");
      await app.screenshot("triage-sort-limit-used-up");
    } finally {
      stopFakeInstance("inbox-triage-saved", { keepHome: false });
      fake.stop();
    }
  },
);

test("a draft has no wait until it is ready, and then waits from when it was marked ready", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-draft");
  try {
    await seed(fake);
    const run = startFakeInstance("inbox-triage-draft", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });
    await choose(screen, sortTrigger(screen), "Waiting longest");
    expect((await inboxOrder(browser))[REVIEW]).toEqual([3, 1, 2, 4]);

    await fake.draft(3);
    await refresh(screen);
    await expect.poll(async () => (await rowOf(browser, 3)).label).toMatch(/^updated /);
    expect((await rowOf(browser, 3)).title).toContain(
      "Still a draft, so it isn't waiting on you yet.",
    );
    expect((await inboxOrder(browser))[REVIEW]).toEqual([1, 2, 4, 3]);
    await app.screenshot("triage-draft");

    await fake.ready(3, 200);
    await refresh(screen);
    await expect.poll(async () => (await rowOf(browser, 3)).label).toBe("waiting 3 hours");
    expect((await rowOf(browser, 3)).title).toContain(
      "A review was requested from budget/web and budget/api while it was a draft. It was marked ready on ",
    );
    expect((await inboxOrder(browser))[REVIEW]).toEqual([3, 1, 2, 4]);
    await app.screenshot("triage-draft-ready");
  } finally {
    stopFakeInstance("inbox-triage-draft", { keepHome: false });
    fake.stop();
  }
});

test("a waits read that fails never fails the inbox, adds no account problem, and keeps the last waits", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-failing");
  try {
    await seed(fake);
    await fake.fail("graphql:review-waits", 99);
    const run = startFakeInstance("inbox-triage-failing", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });
    expect((await readInboxRows(browser)).flatMap((group) => group.rows)).toHaveLength(6);
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect((await rowOf(browser, 1)).label).toMatch(/^updated /);
    expect((await rowOf(browser, 1)).title).toContain(
      "prkit couldn't read when your review was requested",
    );
    expect(await requests(fake)).toMatchObject({ inbox: 1, waits: 0 });
    expect((await requests(fake)).failedWaits).toBeGreaterThanOrEqual(1);
    await app.screenshot("triage-waits-failing");

    await fake.fail("graphql:review-waits", 0);
    await refresh(screen);
    await expect.poll(async () => (await rowOf(browser, 1)).label).toBe("waiting 1 hour");

    await fake.fail("graphql:review-waits", 99);
    await fake.requestReview(5, { login: "budget-test" }, 3);
    await refresh(screen);
    await expect(
      screen.getByRole("region", REVIEW).getByRole("link", /#5 Budget fixture 5/),
    ).toBeVisible();
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect((await rowOf(browser, 1)).label).toBe("waiting 1 hour");
    expect((await rowOf(browser, 3)).label).toBe("waiting 5+ hours");
    expect((await rowOf(browser, 5)).label).toMatch(/^updated /);
    expect((await rowOf(browser, 5)).title).toContain("prkit couldn't read");
    await app.screenshot("triage-waits-failing-after-success");
  } finally {
    stopFakeInstance("inbox-triage-failing", { keepHome: false });
    fake.stop();
  }
});

test("GitHub giving nothing for one pull request costs only that row its wait", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-unreadable");
  try {
    await seed(fake);
    await fake.unreadable(3);
    const run = startFakeInstance("inbox-triage-unreadable", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect((await rowOf(browser, 3)).label).toMatch(/^updated /);
    expect((await rowOf(browser, 3)).title).toContain(
      "GitHub gave nothing for this pull request's history",
    );
    expect((await rowOf(browser, 1)).label).toBe("waiting 1 hour");
    expect(await requests(fake)).toEqual({ inbox: 1, waits: 1, failedWaits: 0 });
    await choose(screen, sortTrigger(screen), "Waiting longest");
    expect((await inboxOrder(browser))[REVIEW]).toEqual([1, 2, 4, 3]);
  } finally {
    stopFakeInstance("inbox-triage-unreadable", { keepHome: false });
    fake.stop();
  }
});

test("a request older than the 20 events GitHub shows reads as at least that long, and one team's request is exact", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-triage-window");
  try {
    await fake.requestReview(4, { login: "budget-test" }, 4000);
    for (let ago = 100; ago > 80; ago--) await fake.requestReview(4, { login: "octocat" }, ago);
    await fake.requestReview(6, { team: "budget/web" }, 1500);
    const run = startFakeInstance("inbox-triage-window", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({ timeout: 20_000 });
    expect((await rowOf(browser, 4)).label).toBe("waiting 1+ hour");
    expect((await rowOf(browser, 4)).title).toContain(
      "Your review was requested before the 20 latest review events prkit reads, so it has waited at least since ",
    );
    expect((await rowOf(browser, 6)).label).toBe("waiting 1 day");
    expect((await rowOf(browser, 6)).title).toContain("A review was requested from budget/web on ");
    await app.screenshot("triage-wait-bounds");
  } finally {
    stopFakeInstance("inbox-triage-window", { keepHome: false });
    fake.stop();
  }
});

test(
  "filters saved before the sort still read",
  { timeout: 120_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub("inbox-triage-old");
    try {
      await seed(fake);
      let run = startFakeInstance("inbox-triage-old", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({
        timeout: 20_000,
      });

      stopFakeInstance("inbox-triage-old", { keepHome: true });
      storeFilters(
        run.home,
        JSON.stringify({
          search: "fixture",
          account: null,
          repository: null,
          savedAt: new Date().toISOString(),
        }),
      );
      run = startFakeInstance("inbox-triage-old", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#4 Budget fixture 4/)).toBeVisible({
        timeout: 20_000,
      });
      await expect(screen.getByRole("searchbox", "Search pull requests")).toHaveValue("fixture");
      await expect(sortTrigger(screen)).toContainText("Recently updated");
      await expect.poll(async () => (await rowOf(browser, 1)).label).toBe("waiting 1 hour");
      expect((await inboxOrder(browser))[REVIEW]).toEqual(ORDERS["Recently updated"][REVIEW]);
      await app.screenshot("triage-old-state");
    } finally {
      stopFakeInstance("inbox-triage-old", { keepHome: false });
      fake.stop();
    }
  },
);
