import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import {
  startFakeGitHub,
  startFakeInstance,
  startInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { FIXTURE_LOGIN, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import { emulateOsColorScheme, readPageTheme, setOsColorScheme } from "./osColorScheme.ts";
import { accountCount, choose, chooseOtherAccount } from "./pickers.ts";

/** Where row #1's parts sit, and how visible its sizes and its Generate guide action are. */
const rowLayout = (browser: Parameters<typeof emulateOsColorScheme>[0]) =>
  browser.evaluate(() => {
    const link = document.querySelector('main a[data-pr-number="1"]');
    const [main, sizes] = link === null ? [] : [...link.children];
    const button = link?.parentElement?.querySelector("button");
    const box = (node: Element | null | undefined) => {
      const rect = node?.getBoundingClientRect();
      return rect === undefined
        ? null
        : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    return {
      row: box(link),
      main: box(main),
      sizes: box(sizes),
      button: box(button),
      sizesOpacity: sizes === undefined ? null : getComputedStyle(sizes).opacity,
      buttonOpacity:
        button?.parentElement === null || button?.parentElement === undefined
          ? null
          : getComputedStyle(button.parentElement).opacity,
      focused: document.activeElement?.getAttribute("aria-label") ?? null,
    };
  });

test("the repository filter lists every repository the account sees and offers one's open pull requests when none needs you", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-repositories");
  try {
    const run = startFakeInstance("inbox-repositories", fake);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
      timeout: 20_000,
    });
    // Nobody opened the filter yet, so nothing listed repositories.
    expect((await fake.stats()).byKind["graphql:repositories"]).toBeUndefined();
    // One account: no account filter and no account on the rows. No PR open: no tab separator.
    await expect(screen.getByRole("combobox", "Filter by GitHub account")).toHaveCount(0);
    await expect(
      browser.locator('main a[data-pr-number] span[title="github.com/budget-test"]'),
    ).toHaveCount(0);
    const workspaceTabs = screen.getByRole("navigation", "Workspace tabs");
    await expect(workspaceTabs.getByRole("separator")).toHaveCount(0);
    await app.screenshot("one-account-no-tabs");

    await screen.getByRole("button", "Filter by repository: All repositories").tap();
    const search = screen.getByRole("combobox", "Search repositories");
    await expect(search).toBeVisible();
    await expect(screen.getByRole("option", "tools")).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("option", "fixtures 6 in your inbox")).toBeVisible();
    await expect(screen.getByRole("option", "attic")).toHaveCount(0);
    await expect(browser.locator('[data-slot="combobox-group-label"]')).toHaveText(["budget"]);
    await app.screenshot("repository-filter");
    await search.fill("too");
    await expect(screen.getByRole("option")).toHaveCount(1);
    await screen.getByRole("option", "tools").tap();

    await expect(screen.getByRole("button", "Filter by repository: budget/tools")).toBeVisible();
    await expect(screen.getByRole("heading", "Nothing in budget/tools needs you")).toBeVisible();
    await app.screenshot("repository-nothing-needs-you");
    await screen.getByRole("button", "Show open pull requests in budget/tools").tap();
    const open = screen.getByRole("region", "Open in budget/tools");
    await expect(open.getByRole("link", /#1 Tools fixture 1/)).toBeVisible({ timeout: 20_000 });
    await expect(open.getByRole("link", /#1 Tools fixture 1/)).toHaveAttribute(
      "data-account",
      "github.com/budget-test",
    );
    await app.screenshot("repository-open-pull-requests");

    await screen.getByRole("button", "Filter by repository: budget/tools").tap();
    await screen.getByRole("option", /^fixtures/).tap();
    await expect(screen.getByRole("link", /#3 Budget fixture 3/)).toBeVisible();
    const read = await fake.stats();
    expect(read.byKind["graphql:repositories"]).toBe(1);
    expect(read.byKind["graphql:repository-pulls"]).toBe(1);

    // The list is kept a day; Refresh list reads it again now.
    await screen.getByRole("button", "Filter by repository: budget/fixtures").tap();
    await screen.getByRole("button", "Refresh list").tap();
    await expect.poll(async () => (await fake.stats()).byKind["graphql:repositories"]).toBe(2);
    await browser.keyboard.press("Escape");

    await screen.getByRole("link", /#3 Budget fixture 3/).tap();
    await expect(screen.getByRole("navigation", "Pull request tabs")).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspaceTabs.getByRole("separator")).toBeVisible();
    await app.screenshot("one-pull-request-open");
  } finally {
    stopFakeInstance("inbox-repositories", { keepHome: false });
    fake.stop();
  }
});

/**
 * Scrolls the Inbox until its header condenses into the pinned filters row, then back. The
 * account filter is in that row only when the app found more than one account.
 */
const condenses = async ({
  app,
  screen,
  browser,
}: Pick<TestFixtures, "app" | "screen"> & { browser: Browser }) => {
  const accounts = await accountCount(screen, browser);
  const pinned = browser.locator("[data-collapse-pinned]");
  const motion = () =>
    browser.evaluate(
      () =>
        getComputedStyle(document.querySelector("[data-collapse-motion]") ?? document.body)
          .transform,
    );
  await expect(pinned).toHaveAttribute("data-collapsed", "false");
  await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
  await expect(screen.getByRole("button", "Refresh")).toHaveText("Refresh");
  await app.screenshot("inbox-expanded");

  await browser.locator("[data-inbox-scroll]").hover();
  await browser.mouse.wheel(0, 600);
  await expect(pinned).toHaveAttribute("data-collapsed", "true");
  await expect.poll(motion).toBe("matrix(1, 0, 0, 1, 0, 0)");
  const top = () =>
    browser.evaluate(
      () =>
        document.querySelector('[aria-label="Search pull requests"]')?.getBoundingClientRect()
          .top ?? -1,
    );
  const pinnedTop = await top();
  await expect(screen.getByRole("searchbox", "Search pull requests")).toBeVisible();
  await expect(screen.getByRole("combobox", "Filter by GitHub account")).toHaveCount(
    accounts > 1 ? 1 : 0,
  );
  await expect(screen.getByRole("button", /^Filter by repository: /)).toBeVisible();
  // The header's Refresh scrolled away; the pinned row's icon took its place.
  await expect(screen.getByRole("button", "Refresh")).toHaveText("");
  await app.screenshot(accounts > 1 ? "inbox-compact" : "inbox-compact-one-account");
  await browser.mouse.wheel(0, 600);
  await expect.poll(top).toBe(pinnedTop);

  await browser.mouse.wheel(0, -3000);
  await expect(pinned).toHaveAttribute("data-collapsed", "false");
  await expect.poll(motion).toBe("matrix(1, 0, 0, 1, 0, -4)");
  await expect(screen.getByRole("button", "Refresh")).toHaveText("Refresh");
};

test("the Inbox header condenses into one pinned row of filters when the list scrolls", async (fixtures) => {
  await openInbox(fixtures);
  await expect(fixtures.browser.locator("main a[data-pr-number]").first()).toBeVisible({
    timeout: 45_000,
  });
  await condenses(fixtures);
});

test("with one account the condensed row has no account filter", async (fixtures) => {
  const fake = await startFakeGitHub("inbox-condensed");
  try {
    const run = startFakeInstance("inbox-condensed", fake);
    // The fake's six pull requests fill a short window, so the list scrolls.
    await fixtures.browser.setViewport({ width: 1280, height: 420 });
    await fixtures.app.open(run.openUrl);
    await expect(fixtures.screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
      timeout: 20_000,
    });
    await condenses(fixtures);
  } finally {
    stopFakeInstance("inbox-condensed", { keepHome: false });
    fake.stop();
  }
});

/** The Inbox filters the server saved in this instance's home, as stored, without when. */
const savedFilters = (home: string) =>
  String(
    readRows(home, "SELECT json_remove(inbox_filters, '$.savedAt') AS filters FROM workspace")[0]
      ?.filters ?? "",
  );
/** When the server last saved the Inbox filters in this instance's home. */
const savedAt = (home: string) =>
  String(
    readRows(home, "SELECT json_extract(inbox_filters, '$.savedAt') AS at FROM workspace")[0]?.at ??
      "",
  );
/** Stores Inbox filters in a stopped instance's home, as an earlier run would have. */
const storeFilters = (home: string, filters: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.prepare("UPDATE workspace SET inbox_filters = ? WHERE id = 1").run(filters);
  } finally {
    db.close();
  }
};
const FIXTURES = { host: "github.com", owner: "budget", name: "fixtures" };
const KEPT_FILTERS = JSON.stringify({
  search: "fixture 3",
  account: null,
  repository: { ...FIXTURES, accountIds: ["github.com/budget-test"] },
  sort: "updated",
});

test(
  "the search and repository filter come back after a reload and a relaunch, and a repository that's gone drops out",
  {
    timeout: 120_000,
  },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub("inbox-saved");
    try {
      let run = startFakeInstance("inbox-saved", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      const search = screen.getByRole("searchbox", "Search pull requests");
      await search.fill("fixture 3");
      await choose(
        screen,
        screen.getByRole("button", "Filter by repository: All repositories"),
        /^fixtures/,
      );
      const kept = async () => {
        await expect(search).toHaveValue("fixture 3", { timeout: 20_000 });
        await expect(
          screen.getByRole("button", "Filter by repository: budget/fixtures"),
        ).toBeVisible();
        await expect(screen.getByRole("link", /#3 Budget fixture 3/)).toBeVisible({
          timeout: 20_000,
        });
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toHaveCount(0);
      };
      await kept();
      await expect.poll(() => savedFilters(run.home)).toBe(KEPT_FILTERS);
      await app.screenshot("filters-saved");

      // Restoring saves nothing: the filters already are what the server has.
      const before = savedAt(run.home);
      await browser.reload();
      await kept();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(savedAt(run.home)).toBe(before);
      await app.screenshot("filters-after-reload");

      // A relaunch serves the app on a new port, so nothing the page kept itself survives.
      stopFakeInstance("inbox-saved", { keepHome: true });
      run = startFakeInstance("inbox-saved", fake);
      await app.open(run.openUrl);
      await kept();
      await app.screenshot("filters-after-relaunch");

      // An account removed since the save: the Inbox lets go of its account filter and reads
      // the repository through the account still here.
      stopFakeInstance("inbox-saved", { keepHome: true });
      storeFilters(
        run.home,
        JSON.stringify({
          search: "fixture 3",
          account: "github.com/departed",
          repository: {
            ...FIXTURES,
            accountIds: ["github.com/departed", "github.com/budget-test"],
          },
          savedAt: new Date().toISOString(),
        }),
      );
      run = startFakeInstance("inbox-saved", fake);
      await app.open(run.openUrl);
      await kept();
      await expect.poll(() => savedFilters(run.home)).toBe(KEPT_FILTERS);

      // An archived repository leaves the list; once the list is read again, the filter lets go.
      await choose(
        screen,
        screen.getByRole("button", "Filter by repository: budget/fixtures"),
        "tools",
      );
      await expect(screen.getByRole("button", "Filter by repository: budget/tools")).toBeVisible();
      await fake.archive("tools");
      await screen.getByRole("button", "Filter by repository: budget/tools").tap();
      await screen.getByRole("button", "Refresh list").tap();
      await expect(
        screen.getByRole("button", "Filter by repository: All repositories"),
      ).toBeVisible({ timeout: 20_000 });
      await browser.keyboard.press("Escape");
      await browser.reload();
      await expect(search).toHaveValue("fixture 3", { timeout: 20_000 });
      await expect(
        screen.getByRole("button", "Filter by repository: All repositories"),
      ).toBeVisible();
      await app.screenshot("gone-repository-dropped");
    } finally {
      stopFakeInstance("inbox-saved", { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "the account filter comes back after a reload and a relaunch",
  { skip: NEEDS_FIXTURE, timeout: 180_000 },
  async ({ app, screen, browser }) => {
    // An instance of its own on the real accounts, since a relaunch restarts it. It reads each
    // account's inbox once; after the relaunch the Inbox answers from prkit's cache.
    const name = "inbox-saved-account";
    try {
      let run = startInstance(name);
      await app.open(run.openUrl);
      await expect(screen.getByLabel("Loading pull requests")).toHaveCount(0, { timeout: 45_000 });
      const other = await chooseOtherAccount(screen, browser, FIXTURE_LOGIN);
      if (other === undefined) return test.skip("Needs a second GitHub account.");
      const kept = async () => {
        await expect(screen.getByRole("combobox", "Filter by GitHub account")).toContainText(
          other.login,
          { timeout: 30_000 },
        );
        await expect(
          browser.locator(`main a[data-account]:not([data-account="${other.id}"])`),
        ).toHaveCount(0);
      };
      await kept();
      await expect.poll(() => savedFilters(run.home)).toContain(`"account":"${other.id}"`);
      await app.screenshot("account-filter-saved");

      await browser.reload();
      await kept();
      stopFakeInstance(name, { keepHome: true });
      run = startInstance(name);
      await app.open(run.openUrl);
      await kept();
      await app.screenshot("account-filter-after-relaunch");
    } finally {
      stopFakeInstance(name, { keepHome: false });
    }
  },
);

test("a row's Generate guide takes the place of its size and age, on hover and on focus", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-rows");
  try {
    const run = startFakeInstance("inbox-rows", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    const row = screen.getByRole("link", /#1 Budget fixture 1/);
    await expect(row).toBeVisible({ timeout: 20_000 });

    const resting = await rowLayout(browser);
    expect([resting.sizesOpacity, resting.buttonOpacity]).toEqual(["1", "0"]);
    await row.hover();
    await expect
      .poll(async () => {
        const hovered = await rowLayout(browser);
        return [hovered.sizesOpacity, hovered.buttonOpacity];
      })
      .toEqual(["0", "1"]);
    const hovered = await rowLayout(browser);
    // Nothing moves, and the action stays inside the column the sizes leave.
    expect({ row: hovered.row, main: hovered.main, sizes: hovered.sizes }).toEqual({
      row: resting.row,
      main: resting.main,
      sizes: resting.sizes,
    });
    const { main, sizes, button, row: rowBox } = hovered;
    if (main === null || sizes === null || button === null || rowBox === null)
      throw new Error("Row #1 is missing its title, sizes or action.");
    expect(button.left).toBeGreaterThanOrEqual(main.right);
    expect(button.right).toBeLessThanOrEqual(sizes.right + 0.5);
    expect(button.top).toBeGreaterThanOrEqual(rowBox.top);
    expect(button.bottom).toBeLessThanOrEqual(rowBox.bottom);
    await app.screenshot("row-action-light");

    await setOsColorScheme(browser, "dark");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(true);
    await row.hover();
    await app.screenshot("row-action-dark");

    // Keyboard focus shows the action too, and Tab reaches it.
    await screen.getByRole("heading", "Inbox").hover();
    await expect.poll(async () => (await rowLayout(browser)).buttonOpacity).toBe("0");
    await row.focus();
    await expect.poll(async () => (await rowLayout(browser)).buttonOpacity).toBe("1");
    await browser.keyboard.press("Tab");
    await expect
      .poll(async () => (await rowLayout(browser)).focused)
      .toBe("Generate guide for budget/fixtures #1");
    await app.screenshot("row-action-focus-dark");
  } finally {
    stopFakeInstance("inbox-rows", { keepHome: false });
    fake.stop();
  }
});

test("a filter hides the groups it empties, and unfiltered every group shows its count", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("inbox-groups");
  try {
    const run = startFakeInstance("inbox-groups", fake);
    await emulateOsColorScheme(browser, "dark");
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("region", "Involved")).toContainText("0");

    const search = screen.getByRole("searchbox", "Search pull requests");
    await search.fill("fixture 5");
    await expect(screen.getByRole("region", "Yours")).toBeVisible();
    await expect(screen.getByRole("region", "Needs your review")).toHaveCount(0);
    await expect(screen.getByRole("region", "Involved")).toHaveCount(0);
    await app.screenshot("filter-hides-empty-groups-dark");
    await setOsColorScheme(browser, "light");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(false);
    await app.screenshot("filter-hides-empty-groups-light");
    await search.fill("no pull request is called this");
    await expect(screen.getByRole("heading", "No matching pull requests")).toBeVisible();
    await expect(screen.getByRole("region", "Yours")).toHaveCount(0);
  } finally {
    stopFakeInstance("inbox-groups", { keepHome: false });
    fake.stop();
  }
});

test("a layer merged on GitHub leaves the Inbox while GitHub's search still finds it", async ({
  app,
  screen,
}) => {
  const fake = await startFakeGitHub("inbox-merged");
  try {
    const run = startFakeInstance("inbox-merged", fake);
    await app.open(run.openUrl);
    const needsReview = screen.getByRole("region", "Needs your review");
    await expect(needsReview.getByRole("link", /#1 Budget fixture 1 Stack 1\/2/)).toBeVisible({
      timeout: 20_000,
    });
    // Stack 900's bottom layer merges, and the next inbox read comes within the search's lag.
    await fake.merge(1);
    const before = (await fake.stats()).byKind["graphql:inbox"] ?? 0;
    await screen.getByRole("button", "Refresh").tap();
    await expect.poll(async () => (await fake.stats()).byKind["graphql:inbox"]).toBe(before + 1);
    expect((await fake.stats()).mergedInSearch).toBe(1);
    await expect(needsReview.getByRole("link", /#1 Budget fixture 1/)).toHaveCount(0);
    await expect(needsReview.getByRole("link", /#2 Budget fixture 2 Stack 2\/2/)).toBeVisible();
    await expect(needsReview.getByRole("link", /#3 Budget fixture 3/)).toBeVisible();
    await app.screenshot("merged-layer-left-inbox");
  } finally {
    stopFakeInstance("inbox-merged", { keepHome: false });
    fake.stop();
  }
});
