import * as NodeFS from "node:fs";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { instancePaths } from "../scripts/verify-run.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, readPageTheme, setOsColorScheme } from "./osColorScheme.ts";
import { choose } from "./pickers.ts";

const ACCOUNT = "github.com/budget-test";
/** Pull requests shaped the way GitHub sends a normal user's inbox, beyond the fixtures'. */
const SHOWN = {
  10: { author: { type: "deleted" } },
  11: { author: { type: "Bot", login: "dependabot" } },
  12: { author: { type: "Mannequin", login: "old-octocat" } },
  13: { author: { type: "EnterpriseUserAccount", login: "octocat_acme" } },
  14: { deletedFork: true },
  15: { labels: [{ name: "colorless", color: "" }] },
  16: { labels: null },
  17: { archived: true },
} as const;
const MALFORMED = 18;
const REFUSED = 19;
const SAML = "Resource protected by organization SAML enforcement.";

const seed = async (fake: FakeGitHub) => {
  for (const [number, shape] of Object.entries(SHOWN)) await fake.odd(Number(number), shape);
  await fake.odd(MALFORMED, { malformed: true });
  await fake.odd(REFUSED, { refused: true });
  await fake.requestReview(12, { team: "budget/web" });
  await fake.checking(14);
};

const rowNumbers = (section: string) =>
  `[...document.querySelectorAll('main section[aria-label="${section}"] a[data-pr-number]')].map((link) => Number(link.getAttribute("data-pr-number")))`;
const overflows = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;

test("the Inbox shows every pull request GitHub sends and leaves out only the one prkit can't read, saying so", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("github-shapes");
  try {
    await seed(fake);
    NodeFS.rmSync(instancePaths("github-shapes").log, { force: true });
    const run = startFakeInstance("github-shapes", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    const involved = screen.getByRole("region", "Involved");
    await expect(involved.getByRole("link", /#10 Odd fixture 10/)).toBeVisible({ timeout: 30_000 });

    expect(await browser.evaluate<number[]>(rowNumbers("Involved"))).toEqual(
      Object.keys(SHOWN).map(Number).toReversed(),
    );
    expect((await browser.evaluate<number[]>(rowNumbers("Needs your review"))).toSorted()).toEqual([
      1, 2, 3,
    ]);
    expect((await browser.evaluate<number[]>(rowNumbers("Yours"))).toSorted()).toEqual([4, 5, 6]);
    await expect(involved.getByRole("link", /#10 Odd fixture 10/)).toContainText("deleted user");
    await expect(involved.getByRole("link", /#11 Odd fixture 11/)).toContainText("dependabot");
    await expect(involved.getByRole("link", /#12 Odd fixture 12/)).toContainText("old-octocat");
    await expect(involved.getByRole("link", /#13 Odd fixture 13/)).toContainText("octocat_acme");
    await expect(screen.getByRole("alert").filter({ hasText: "unreadable" })).toHaveCount(0);

    const notice = browser.locator(`[data-inbox-left-out="${ACCOUNT}"]`);
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(`Some pull requests couldn't be shown for ${ACCOUNT}.`);
    await expect(notice).toContainText("prkit couldn't read what GitHub sent.");
    await expect(notice).toContainText(`GitHub said: ${SAML}`);
    const link = screen.getByRole("link", `Open budget/fixtures#${MALFORMED} on GitHub`);
    await expect(link).toHaveAttribute(
      "href",
      `https://github.com/budget/fixtures/pull/${MALFORMED}`,
    );
    await expect(browser.locator(`a[data-pr-number="${MALFORMED}"]`)).toHaveCount(0);
    await expect(browser.locator(`a[data-pr-number="${REFUSED}"]`)).toHaveCount(0);
    await app.screenshot("inbox-light");
    await involved.scrollIntoView();
    await app.screenshot("inbox-involved-light");

    await setOsColorScheme(browser, "dark");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(true);
    await app.screenshot("inbox-involved-dark");
    await notice.scrollIntoView();
    await app.screenshot("inbox-dark");
    await setOsColorScheme(browser, "light");

    await browser.setViewport({ width: 720, height: 720 });
    await expect(notice).toBeVisible();
    expect(await browser.evaluate(overflows)).toBe(false);
    await app.screenshot("inbox-narrow");
    await browser.setViewport({ width: 1280, height: 720 });

    const log = NodeFS.readFileSync(instancePaths("github-shapes").log, "utf8");
    expect(log).toContain("Left out a pull request prkit can't read");
    expect(log).toMatch(/path: 'involved\.nodes\.\d+\.title'/);
    expect(log).toContain("GitHub refused a pull request in the inbox");
    expect(log).not.toContain(`Odd fixture ${MALFORMED}`);
    expect(log).not.toContain("GitHub returned an unreadable response");
  } finally {
    stopFakeInstance("github-shapes", { keepHome: false });
    fake.stop();
  }
});

test("a repository's open pull requests leave out only the one prkit can't read", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("github-shapes-repository");
  try {
    await seed(fake);
    await fake.inboxOnly("budget-test", []);
    const run = startFakeInstance("github-shapes-repository", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    await expect(screen.getByLabel("Loading pull requests")).toHaveCount(0, { timeout: 30_000 });
    await choose(
      screen,
      screen.getByRole("button", "Filter by repository: All repositories"),
      "fixtures",
    );
    await screen.getByRole("button", "Show open pull requests in budget/fixtures").tap();
    const open = screen.getByRole("region", "Open in budget/fixtures");
    await expect(open.getByRole("link", /#10 Odd fixture 10/)).toBeVisible({ timeout: 20_000 });
    expect(
      (await browser.evaluate<number[]>(rowNumbers("Open in budget/fixtures"))).toSorted(
        (a, b) => a - b,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, ...Object.keys(SHOWN).map(Number)]);
    const notice = browser.locator(
      `section[aria-label="Open in budget/fixtures"] [data-inbox-left-out="${ACCOUNT}"]`,
    );
    await expect(notice).toContainText(`Some pull requests couldn't be shown for ${ACCOUNT}.`);
    await expect(notice).toContainText(`GitHub said: ${SAML}`);
    await expect(
      open.getByRole("link", `Open budget/fixtures#${MALFORMED} on GitHub`),
    ).toBeVisible();
    await app.screenshot("repository-light");
  } finally {
    stopFakeInstance("github-shapes-repository", { keepHome: false });
    fake.stop();
  }
});

test("the pull request page reads a deleted author, a bot, a deleted fork, a team request, odd labels and an archived repository", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("github-shapes-page");
  try {
    await seed(fake);
    const run = startFakeInstance("github-shapes-page", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    const page = (number: number, tab: "conversation" | "files") =>
      `${run.url}/pr/github.com/budget/fixtures/${number}?account=${encodeURIComponent(ACCOUNT)}&tab=${tab}`;
    const settled = async () => {
      await expect(screen.getByRole("region", "Activity")).toBeVisible({ timeout: 20_000 });
      await expect(screen.getByText(/^Couldn't load/)).toHaveCount(0);
      await expect(screen.getByText(/unreadable/)).toHaveCount(0);
    };

    await app.open(page(10, "conversation"));
    await settled();
    await expect(screen.getByRole("heading", /Odd fixture 10/)).toBeVisible();
    await expect(screen.getByText("ghost").first()).toBeVisible();
    await app.screenshot("page-deleted-author");

    await app.open(page(11, "conversation"));
    await settled();
    await expect(screen.getByText("dependabot[bot]").first()).toBeVisible();

    await app.open(page(12, "conversation"));
    await settled();
    await expect(screen.getByText("budget/web").first()).toBeVisible();
    await app.screenshot("page-team-request");

    await app.open(page(14, "conversation"));
    await settled();
    await expect(screen.getByRole("heading", /Odd fixture 14/)).toBeVisible();
    await app.screenshot("page-deleted-fork");

    await app.open(page(15, "conversation"));
    await settled();
    await expect(screen.getByRole("region", "Labels").getByRole("listitem")).toHaveText([
      "colorless",
    ]);

    await app.open(page(17, "conversation"));
    await settled();
    await expect(screen.getByRole("heading", /Odd fixture 17/)).toBeVisible();
    await setOsColorScheme(browser, "dark");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(true);
    await app.screenshot("page-archived-dark");
  } finally {
    stopFakeInstance("github-shapes-page", { keepHome: false });
    fake.stop();
  }
});
