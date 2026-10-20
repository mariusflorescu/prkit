import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_LOGIN,
  FIXTURE_NAME,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  prPath,
} from "./fixturePr.ts";
import { readInboxRows } from "./inboxRows.ts";
import { openInbox } from "./openInbox.ts";
import { choose, chooseOtherAccount } from "./pickers.ts";

test(
  "the fixture stays in Yours through its account and filters recover",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    await openInbox({ app, screen });

    const search = screen.getByRole("searchbox", "Search pull requests");
    await search.fill(FIXTURE_NAME);
    const fixture = screen
      .getByRole("region", "Yours")
      .getByRole("link", /#1 Validate links and count clicks/);
    await expect(fixture).toContainText(FIXTURE_REPO, { timeout: 45_000 });
    await expect(fixture).toHaveAttribute("data-account", FIXTURE_ACCOUNT);
    await expect(
      browser.locator(
        `a[data-repository="${FIXTURE_REPO}"][data-pr-number="1"] span[title="${FIXTURE_ACCOUNT}"]`,
      ),
    ).toHaveText(FIXTURE_LOGIN);
    await app.screenshot("fixture-in-yours");

    const other = await chooseOtherAccount(screen, browser, FIXTURE_LOGIN);
    if (other !== undefined) {
      await expect(screen.getByRole("heading", "No matching pull requests")).toBeVisible();
      await search.clear();
      const first = screen.getByRole("region", "Yours").getByRole("link").first();
      await expect(first).toHaveAttribute("data-account", other.id);
      await expect(
        browser.locator(`a[data-account="${other.id}"] span[title="${other.id}"]`).first(),
      ).toHaveText(other.login);
      await app.screenshot("second-account");
    }

    await search.fill("prkit-no-matches-8ec2c02b");
    await expect(screen.getByRole("heading", "No matching pull requests")).toBeVisible();
    await app.screenshot("no-search-matches");
    await screen.getByRole("button", "Clear filters").tap();
    await search.fill(FIXTURE_NAME);
    await expect(fixture).toBeVisible();
    await fixture.tap();
    await expect(browser).toHaveURL(prPath(FIXTURE_REPO, 1, "conversation"));
    await expect(
      screen.getByRole("navigation", "Workspace tabs").getByRole("separator"),
    ).toBeVisible();
    await app.screenshot("tab-separator");
  },
);

test("every row on the real accounts has a size, and every review request a wait or the reason it has none", async ({
  app,
  screen,
  browser,
}) => {
  await openInbox({ app, screen });
  await expect(browser.locator("main a[data-pr-number]").first()).toBeVisible({ timeout: 45_000 });
  const groups = await readInboxRows(browser);
  const rows = groups.flatMap((group) => group.rows);
  for (const row of rows) {
    expect(row.chip).toMatch(/^(XS|S|M|L|XL)$/);
    expect(row.title).toMatch(
      /changed lines? \(\+\d+ -\d+\) in \d+ files?\..*About \d+ minutes? to read/,
    );
    expect(row.reading).toMatch(/^(\d+ min|[\d.]+ h\+?)$/);
  }
  const waiting = groups.find((group) => group.group === "Needs your review")?.rows ?? [];
  for (const row of waiting)
    expect(
      /^waiting (under a minute|\d+\+? (minute|hour|day|month)s?)$/.test(row.label) ||
        /draft|couldn't read|doesn't say|gave nothing/.test(row.title),
    ).toBe(true);
  await app.screenshot("real-accounts-triage");

  await choose(screen, screen.getByRole("combobox", "Sort pull requests"), "Waiting longest");
  await expect(screen.getByRole("combobox", "Sort pull requests")).toContainText("Waiting longest");
  const waited = (
    (await readInboxRows(browser)).find((group) => group.group === "Needs your review")?.rows ?? []
  ).filter((row) => row.label.startsWith("waiting") && !row.stacked);
  expect(waited.map((row) => row.at)).toEqual(
    waited.map((row) => row.at).toSorted((left, right) => Date.parse(left) - Date.parse(right)),
  );
  await app.screenshot("real-accounts-waiting-longest");
  await choose(screen, screen.getByRole("combobox", "Sort pull requests"), "Recently updated");
});

test("Accounts validates directories and saves only user-added paths", async ({
  app,
  screen,
  browser,
}) => {
  const run = runForUrl(app.baseUrl);
  const addedPath = join(run.home, "added-gh-config");
  // Settings writes a directory under the home folder from `~`.
  const shownPath = addedPath.startsWith(`${homedir()}/`)
    ? `~${addedPath.slice(homedir().length)}`
    : addedPath;
  await mkdir(addedPath, { recursive: true });
  await writeFile(join(addedPath, "hosts.yml"), "{}\n");
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible();
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await expect(screen.getByRole("heading", "Settings")).toBeVisible();

  const main = screen.getByRole("main");
  await expect(main.getByText("Ready").first()).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText("Needs attention")).toHaveCount(0);
  await expect(main.getByRole("button", "Remove")).toHaveCount(0);
  await app.screenshot("accounts-ready");

  const field = screen.getByRole("textbox", "Add gh config directory");
  const add = screen.getByRole("button", "Add directory");
  await add.tap();
  await expect(screen.getByRole("alert")).toHaveText("Enter a gh config directory.");
  await field.fill(join(run.home, "missing-gh-config"));
  await add.tap();
  await expect(screen.getByRole("alert")).toHaveText(
    "This directory doesn't exist or can't be read. Check the path and try again.",
  );
  await app.screenshot("directory-not-found");
  await field.fill(run.home);
  await add.tap();
  await expect(screen.getByRole("alert")).toHaveText(
    "This directory has no hosts.yml. Choose a gh config directory where you've logged in.",
  );
  await app.screenshot("directory-without-hosts");

  await field.fill(addedPath);
  await add.tap();
  await expect(screen.getByText("GitHub directory added")).toBeVisible();
  await expect(screen.getByText(shownPath)).toBeVisible();
  await app.screenshot("directory-added");
  await screen.getByRole("button", "Remove").tap();
  await expect(screen.getByText("GitHub directory removed")).toBeVisible();
  await expect(screen.getByText(shownPath)).toHaveCount(0);
  await app.screenshot("directory-removed");
});

test("the Inbox shows its skeleton while GitHub is slow, and a broken account directory says why until it is fixed", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("account-states");
  try {
    const run = startFakeInstance("account-states", fake);
    await fake.latency(3000);
    await app.open(run.openUrl);
    const skeleton = screen.getByRole("status", "Loading pull requests");
    await expect(skeleton).toHaveAttribute("aria-busy", "true");
    await app.screenshot("inbox-loading");
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 20_000 });
    await expect(skeleton).toHaveCount(0);
    await fake.latency(0);

    const broken = join(fake.home, "broken-gh-config");
    await mkdir(broken, { recursive: true });
    const hosts = (login: string) =>
      writeFile(
        join(broken, "hosts.yml"),
        `github.com:\n  user: ${login}\n  users:\n    ${login}: {}\n  git_protocol: https\n`,
      );
    await hosts("ghost-user");
    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+Comma`);
    await screen.getByRole("textbox", "Add gh config directory").fill(broken);
    await screen.getByRole("button", "Add directory").tap();
    await expect(screen.getByText("GitHub directory added")).toBeVisible();
    const accounts = screen.getByRole("region", "GitHub accounts");
    const reason = `gh has an expired token for ghost-user in ${broken}. Run gh auth refresh with GH_CONFIG_DIR set to this directory, then refresh.`;
    await expect(accounts.getByRole("alert")).toContainText(reason);
    await expect(accounts.getByText("Needs attention")).toHaveCount(1);
    await app.screenshot("account-needs-attention");

    // The Inbox keeps the healthy account's rows next to the broken one's reason.
    await screen.getByRole("link", "Inbox").tap();
    const problem = screen.getByRole("alert");
    await expect(problem).toContainText(reason);
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
    await app.screenshot("inbox-account-error");

    // The user signs gh in again in that directory, then retries from the Inbox.
    await hosts("budget-third");
    await problem.getByRole("button", "Retry").tap();
    await expect(screen.getByRole("alert")).toHaveCount(0, { timeout: 20_000 });
    await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible();
    await app.screenshot("inbox-account-recovered");
    await browser.keyboard.press(`${modifier}+Comma`);
    await expect(accounts.getByText("budget-third")).toBeVisible();
    await expect(accounts.getByText("Needs attention")).toHaveCount(0);
    await expect(accounts.getByText("Ready")).toHaveCount(2);
    await app.screenshot("account-recovered");
    await accounts.getByRole("button", "Remove").tap();
    await expect(screen.getByText("GitHub directory removed")).toBeVisible();
    await expect(accounts.getByText("budget-third")).toHaveCount(0);
  } finally {
    stopFakeInstance("account-states", { keepHome: false });
    fake.stop();
  }
});
