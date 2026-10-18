import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { inboxOrder, readInboxRows } from "./inboxRows.ts";
import { emulateOsColorScheme, setOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
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

const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const numberOf = (key: string) => Number(key.slice(key.lastIndexOf("#") + 1));
/** A toast lasts five seconds unless the pointer rests on it, and it covers the rows' actions and screenshots. */
const toastsGone = async (screen: Fixtures["screen"]) => {
  await sortTrigger(screen).hover();
  await expect(screen.getByRole("dialog", /.*/)).toHaveCount(0, { timeout: 15_000 });
};
const reviewState = (home: string, number: number) =>
  readRows(
    home,
    `SELECT latest_revision AS revision, json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${keyOf(number)}'`,
  );
/** A guide from before risk: its latest revision with the level taken out. */
const stripRisk = (home: string, number: number) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.prepare(
      `UPDATE review_revisions SET guide = json_remove(guide, '$.risk')
       WHERE review_id = (SELECT id FROM reviews WHERE pr_key = ?)
         AND revision = (SELECT latest_revision FROM reviews WHERE pr_key = ?)`,
    ).run(keyOf(number), keyOf(number));
  } finally {
    db.close();
  }
};
/** Every different order the page shows its groups in, from the page's first script on. */
const ORDER_TRACE = `(() => {
  const seen = [];
  window.__inboxOrders = seen;
  const read = () => {
    const groups = [...document.querySelectorAll("main section[aria-label]")].map((section) => [
      section.getAttribute("aria-label"),
      [...section.querySelectorAll("a[data-pr-number]")].map((link) => Number(link.getAttribute("data-pr-number"))),
    ]);
    return groups.some(([, rows]) => rows.length > 0) ? JSON.stringify(Object.fromEntries(groups)) : null;
  };
  new MutationObserver(() => {
    const now = read();
    if (now !== null && now !== seen[seen.length - 1]) seen.push(now);
  }).observe(document, { childList: true, subtree: true, attributes: true });
})()`;
const Rows = Schema.Struct({ key: Schema.String, risk: Schema.NullOr(Schema.String) });
const decodeInbox = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          sections: Schema.Array(
            Schema.Struct({ reason: Schema.String, pullRequests: Schema.Array(Rows) }),
          ),
        }),
      ),
    }),
  ),
);
const decodeGuides = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ items: Schema.Array(Rows) })),
);
const prkit = (home: string, fake: FakeGitHub, args: ReadonlyArray<string>) => {
  const done = NodeChildProcess.spawnSync(NodePath.join(home, "bin/prkit"), args, {
    encoding: "utf8",
    env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
  });
  expect(done.status, done.stderr).toBe(0);
  return done.stdout;
};

/** Reads in the fake's request log that one inbox row never causes: the watcher's batched head read of watched reviews. */
const WATCHER_KINDS = new Set(["graphql:fingerprint"]);

test(
  "a guide's risk shows on its inbox row, Riskiest first orders by it with the longest wait first inside a level, nothing reads GitHub per row, an old guide drops to the end after a relaunch, and a new revision moves the row live",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "inbox-risk";
    const claude = setUpFakeClaude(name);
    const fake = await startFakeGitHub(name);
    const git = outsideGit(name);
    const launch = () => git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
    try {
      await seed(fake);
      await fake.requestReview(9, { login: "budget-test" }, 15);
      for (const number of [1, 2, 4, 6, 9]) await fake.gitHead(number, git.head(number));
      await fake.comment(9);
      let run = launch();
      await browser.addInitScript(ORDER_TRACE);

      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#9 Keyboard fixture 9/)).toBeVisible({
        timeout: 20_000,
      });
      const rowsNow = async () => (await readInboxRows(browser)).flatMap((group) => group.rows);
      expect((await rowsNow()).map((row) => row.risk)).toEqual(Array(7).fill(""));
      const unrated = await inboxOrder(browser);
      const recent = unrated[REVIEW] ?? [];
      expect(recent.toSorted()).toEqual([1, 2, 3, 4, 9]);
      expect(recent.indexOf(9)).toBeLessThan(recent.indexOf(4));
      const before = new Map((await rowsNow()).map((row) => [row.number, row]));

      const levels = { 4: "high", 9: "high", 1: "medium", 6: "low" } as const;
      for (const [number, level] of [
        [4, levels[4]],
        [9, levels[9]],
        [1, levels[1]],
        [6, levels[6]],
      ] as const) {
        claude.chapters([
          {
            title: `Change ${number}`,
            files: [number === 9 ? "src/limits.ts" : "src/change-0.ts"],
            risk: level,
          },
        ]);
        await screen.getByRole("link", new RegExp(`#${number} `)).hover();
        await screen.getByRole("button", `Generate guide for budget/fixtures #${number}`).tap();
        await expect
          .poll(async () => (await rowOf(browser, number)).risk, { timeout: 120_000 })
          .toBe(level);
        expect(reviewState(run.home, number)).toEqual([{ revision: 1, state: "watching" }]);
        await toastsGone(screen);
      }
      claude.chapters([]);

      const word = { high: "Risk: High", medium: "Risk: Medium", low: "Risk: Low" } as const;
      for (const [number, level] of Object.entries(levels)) {
        const row = await rowOf(browser, Number(number));
        const first = before.get(Number(number));
        expect({ number, guide: row.guide, text: row.riskText, inside: row.riskInside }).toEqual({
          number,
          guide: "ready",
          text: word[level],
          inside: true,
        });
        expect({ height: row.height, left: row.left }).toEqual({
          height: first?.height,
          left: first?.left,
        });
      }
      const bare = await rowOf(browser, 3);
      expect({ guide: bare.guide, risk: bare.risk, riskText: bare.riskText }).toEqual({
        guide: "",
        risk: "",
        riskText: "",
      });
      expect(
        (await rowsNow())
          .filter((row) => row.risk !== "")
          .map((row) => row.number)
          .toSorted(),
      ).toEqual([1, 4, 6, 9]);
      await toastsGone(screen);
      await app.screenshot("risk-inbox-light");

      await setOsColorScheme(browser, "dark");
      await app.screenshot("risk-inbox-dark");
      await setOsColorScheme(browser, "light");

      await browser.setViewport({ width: 600, height: 720 });
      await expect(sortTrigger(screen)).toBeVisible();
      const plain = await rowOf(browser, 3);
      for (const row of (await rowsNow()).filter((r) => r.risk !== "")) {
        expect({ number: row.number, inside: row.riskInside }).toEqual({
          number: row.number,
          inside: true,
        });
        expect(row.height).toBe(plain.height);
        expect(row.titleWidth).toBeGreaterThanOrEqual(60);
      }
      expect(
        await browser.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
      ).toBe(false);
      await app.screenshot("risk-inbox-narrow");
      await browser.setViewport({ width: 1280, height: 720 });

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
      await app.open(run.url);
      await expect(screen.getByRole("link", /#9 Keyboard fixture 9/)).toBeVisible({
        timeout: 20_000,
      });
      await expect.poll(async () => (await rowOf(browser, 9)).risk).toBe("high");
      await toastsGone(screen);
      const settled = (await fake.stats()).byKind;

      await choose(screen, sortTrigger(screen), "Riskiest first");
      await expect(sortTrigger(screen)).toContainText("Riskiest first");
      // #1 and #2 are one stack: it sits where its best layer ranks (#1, medium) with #2 behind it.
      const ranked = { [REVIEW]: [4, 9, 1, 2, 3], [YOURS]: [6, 5], Involved: [] };
      expect(await inboxOrder(browser)).toEqual(ranked);
      expect((await rowOf(browser, 4)).label).toMatch(/^waiting (20|21) minutes$/);
      expect((await rowOf(browser, 5)).label).toBe("opened 5 days ago");
      await app.screenshot("risk-inbox-sorted");
      await expect.poll(() => storedFilters(run.home)).toContain('"sort":"risk"');
      await browser.reload();
      await expect(sortTrigger(screen)).toContainText("Riskiest first", { timeout: 20_000 });
      await expect.poll(() => inboxOrder(browser)).toEqual(ranked);

      const cli = decodeInbox(
        prkit(run.home, fake, [
          "inbox",
          "--reason",
          "review-requested",
          "--sort",
          "risk",
          "--json",
        ]),
      )
        .accounts.flatMap((account) => account.sections)
        .flatMap((section) => section.pullRequests);
      expect(cli.map((row) => [numberOf(row.key), row.risk])).toEqual([
        [4, "high"],
        [9, "high"],
        [1, "medium"],
        [2, null],
        [3, null],
      ]);
      const listed = decodeGuides(prkit(run.home, fake, ["guide", "list", "--json"])).items;
      expect(listed.map((row) => [numberOf(row.key), row.risk])).toEqual([
        [1, "medium"],
        [4, "high"],
        [6, "low"],
        [9, "high"],
      ]);

      const after = (await fake.stats()).byKind;
      const grew = Object.keys(after).filter(
        (kind) => (after[kind] ?? 0) > (settled[kind] ?? 0) && !WATCHER_KINDS.has(kind),
      );
      expect(grew).toEqual([]);

      stopFakeInstance(name, { keepHome: true });
      stripRisk(run.home, 1);
      run = launch();
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#9 Keyboard fixture 9/)).toBeVisible({
        timeout: 20_000,
      });
      const relaunched = { [REVIEW]: [4, 9, 3, 1, 2], [YOURS]: [6, 5], Involved: [] };
      const traced = async () =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
          await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__inboxOrders") ?? [])),
        );
      await expect(sortTrigger(screen)).toContainText("Riskiest first");
      await expect.poll(() => inboxOrder(browser)).toEqual(relaunched);
      const orders = await traced();
      expect(orders.length).toBeGreaterThan(0);
      expect(orders).toEqual([JSON.stringify(relaunched)]);
      const old = await rowOf(browser, 1);
      expect({ guide: old.guide, risk: old.risk }).toEqual({ guide: "ready", risk: "" });
      expect((await rowOf(browser, 4)).risk).toBe("high");
      await toastsGone(screen);
      await app.screenshot("risk-inbox-relaunch");

      claude.chapters([{ title: "Change 4", files: ["src/change-0.ts"], risk: "low" }]);
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/4?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`,
      );
      claude.hold();
      await screen.getByRole("button", "Generate again").tap({ timeout: 30_000 });
      await expect(browser.locator('[data-review-status="writing"]')).toBeVisible({
        timeout: 30_000,
      });
      await screen.getByRole("link", "Inbox").tap();
      await expect(sortTrigger(screen)).toContainText("Riskiest first");
      await expect(
        screen.getByRole("region", REVIEW).getByRole("link", /#4 Budget fixture 4/),
      ).toBeVisible();
      const origin = await browser.evaluate(() => performance.timeOrigin);
      expect((await rowOf(browser, 4)).risk).toBe("high");
      expect((await inboxOrder(browser))[REVIEW]).toEqual([4, 9, 3, 1, 2]);

      claude.release();
      await expect
        .poll(async () => (await rowOf(browser, 4)).risk, { timeout: 120_000 })
        .toBe("low");
      expect(await browser.evaluate(() => performance.timeOrigin)).toBe(origin);
      expect(reviewState(run.home, 4)).toEqual([{ revision: 2, state: "watching" }]);
      expect((await rowOf(browser, 4)).riskText).toBe("Risk: Low");
      expect(await inboxOrder(browser)).toEqual({
        [REVIEW]: [9, 4, 3, 1, 2],
        [YOURS]: [6, 5],
        Involved: [],
      });
      await expect(screen.getByRole("dialog", "Guide updated")).toBeVisible();
      await toastsGone(screen);
      await app.screenshot("risk-inbox-live-update");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
