import * as NodeFS from "node:fs";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import {
  FIXTURE_ACCOUNT,
  FIXTURE_LOGIN,
  FIXTURE_NAME,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  prPath,
} from "./fixturePr.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { openInbox } from "./openInbox.ts";
import { choose, chooseOtherAccount } from "./pickers.ts";

/** The account of each REST request the server log has for paths under `prefix`. */
const accountsReading = (log: string, prefix: string) =>
  [
    ...NodeFS.readFileSync(log, "utf8").matchAll(
      /GitHub request \{\n {2}accountId: '([^']+)',\n {2}operation: '[A-Z]+ ([^' ?]+)/g,
    ),
  ].flatMap(([, account, path]) => (path?.startsWith(prefix) ? [account] : []));

test(
  "open PRs switch, close, reopen, reorder and keep their tabs",
  { timeout: 180_000, skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    await app.open(runForUrl(app.baseUrl).openUrl);
    await expect(screen.getByRole("link", "Inbox")).toBeVisible();
    await expect(browser.locator('[aria-label="Loading open pull requests"]')).toBeHidden();
    const existingOpen = screen.getByRole("navigation", "Workspace tabs").getByRole("button");
    while ((await existingOpen.count()) > 0) await existingOpen.first().tap();
    await screen.getByRole("link", "Inbox").tap();
    const search = screen.getByRole("searchbox", "Search pull requests");
    await search.fill(FIXTURE_NAME);
    const fixture = screen
      .getByRole("region", "Yours")
      .getByRole("link", /#1 Validate links and count clicks/);
    await expect(fixture).toBeVisible({ timeout: 45_000 });
    await fixture.tap();
    await expect(screen.getByRole("heading", "Validate links and count clicks")).toBeVisible({
      timeout: 45_000,
    });
    await expect(screen.getByRole("region", "Description")).toContainText(
      "Short links could point at javascript:",
    );
    await expect(screen.getByRole("region", "Checks")).toContainText("All checks passed");
    await expect(screen.getByRole("region", "Reviewers")).toContainText("No reviewers");
    await expect(
      browser.locator('section[aria-label="Activity"] [data-timeline-kind="commit"]').first(),
    ).toBeVisible();
    await app.screenshot("fixture-conversation");

    await screen.getByRole("link", "Inbox").tap();
    await search.clear();
    const account = screen.getByRole("combobox", "Filter by GitHub account");
    const other = await chooseOtherAccount(screen, browser, FIXTURE_LOGIN);
    if (other === undefined)
      return test.skip("Needs a second GitHub account with a pull request of its own.");
    const second = screen.getByRole("region", "Yours").getByRole("link").first();
    await expect(second).toBeVisible();
    const secondHref = await second.getAttribute("href");
    await second.tap();
    await expect(browser.locator("[data-reading-account]")).toHaveText(other.id, {
      timeout: 45_000,
    });
    await app.screenshot("second-account-conversation");
    const run = runForUrl(app.baseUrl);
    await app.open(
      `${run.url}${secondHref?.replace(encodeURIComponent(other.id), encodeURIComponent(FIXTURE_ACCOUNT))}`,
    );
    await expect(browser.locator("[data-reading-account]")).toHaveText(other.id, {
      timeout: 45_000,
    });
    await expect(browser).toHaveURL(secondHref ?? "missing second account URL");
    await app.screenshot("stored-account-binding");
    // Every request for that PR went to GitHub through the account that found it.
    const [, , , owner, repo, number] = new URL(secondHref ?? "", run.url).pathname.split("/");
    const reads = accountsReading(run.log, `/repos/${owner}/${repo}/pulls/${number}`);
    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)]).toEqual([other.id]);

    await screen.getByRole("link", "Inbox").tap();
    await choose(screen, account, FIXTURE_LOGIN);
    const third = browser
      .locator(
        `main a[data-account="${FIXTURE_ACCOUNT}"]:not([data-repository="${FIXTURE_REPO}"][data-pr-number="1"])`,
      )
      .first();
    await expect(third).toBeVisible();
    const thirdHref = await third.getAttribute("href");
    await third.tap();
    const open = screen.getByRole("navigation", "Workspace tabs");
    const prTabs = browser.locator("[data-open-pr]");
    await expect(prTabs).toHaveCount(3);
    await app.screenshot("three-open-prs");
    await prTabs.last().hover();
    await expect(screen.getByRole("tooltip")).toContainText("#");
    await expect(screen.getByRole("tooltip")).toContainText(FIXTURE_ACCOUNT);
    await app.screenshot("tab-hover-tooltip");
    const modifierForSettings = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifierForSettings}+Comma`);
    await expect(screen.getByRole("heading", "Settings")).toBeVisible();
    await browser.keyboard.press(`${modifierForSettings}+w`);
    await expect(browser).toHaveURL(thirdHref ?? "missing third URL");

    await browser.evaluate(() => {
      const original = history.pushState.bind(history);
      const paths: string[] = [];
      history.pushState = (data, unused, url) => {
        paths.push(String(url));
        original(data, unused, url);
        document.documentElement.setAttribute("data-switch-history", JSON.stringify(paths));
      };
      return true;
    });
    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+2`);
    await expect(screen.getByRole("heading", "Validate links and count clicks")).toBeVisible();
    await browser.keyboard.press(`${modifier}+3`);
    await expect(browser).toHaveURL(secondHref ?? "missing second account URL");
    await browser.keyboard.press(`${modifier}+4`);
    await expect(browser).toHaveURL(thirdHref ?? "missing third URL");
    await browser.keyboard.press(`${modifier}+Shift+BracketLeft`);
    await expect(browser).toHaveURL(secondHref ?? "missing second account URL");
    await browser.keyboard.press(`${modifier}+Shift+BracketRight`);
    await expect(browser).toHaveURL(thirdHref ?? "missing third URL");
    const paths = await browser.evaluate(
      () => document.documentElement.getAttribute("data-switch-history") ?? "",
    );
    expect(paths).toContain("/pr/github.com/");
    expect(paths).not.toContain('"/"');
    await browser.keyboard.press(`${modifier}+Shift+BracketRight`);
    await expect(browser).toHaveURL("/");
    await browser.keyboard.press("Control+Shift+Tab");
    await expect(browser).toHaveURL(thirdHref ?? "missing third URL");
    await browser.keyboard.press("Control+Tab");
    await expect(browser).toHaveURL("/");

    await browser.keyboard.press(`${modifier}+3`);
    await browser.keyboard.press(`${modifier}+w`);
    await expect(prTabs).toHaveCount(2);
    await expect(browser).toHaveURL(thirdHref ?? "missing third URL");
    await app.screenshot("closed-middle-pr");
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect(prTabs).toHaveCount(3);
    await expect(browser).toHaveURL(secondHref ?? "missing second account URL");
    await app.screenshot("reopened-pr");

    await prTabs.last().focus();
    await browser.keyboard.press("Alt+ArrowLeft");
    await expect(prTabs.nth(1)).toHaveAttribute("data-account", other.id);
    const lastKey = await prTabs.last().getAttribute("data-open-pr");
    const positions = await browser.evaluate(() => {
      const nodes = document.querySelectorAll("[data-open-pr]");
      const first = nodes.item(0)?.getBoundingClientRect();
      const last = nodes.item(nodes.length - 1)?.getBoundingClientRect();
      return first && last
        ? {
            from: { x: last.x + last.width / 2, y: last.y + last.height / 2 },
            to: { x: first.x + first.width / 2, y: first.y + first.height / 2 },
          }
        : null;
    });
    if (!positions) throw new Error("PR tabs have no drag bounds");
    await browser.mouse.move(positions.from.x, positions.from.y);
    await browser.mouse.down();
    for (let step = 1; step <= 16; step++)
      await browser.mouse.move(
        positions.from.x + ((positions.to.x - positions.from.x) * step) / 16,
        positions.to.y,
      );
    await browser.mouse.up();
    await expect(prTabs.first()).toHaveAttribute("data-open-pr", lastKey ?? "missing dragged key");
    await prTabs.first().focus();
    await browser.keyboard.press("Alt+ArrowRight");
    await expect(prTabs.nth(1)).toHaveAttribute("data-open-pr", lastKey ?? "missing reordered key");
    await browser.keyboard.press("Alt+ArrowRight");
    await expect(prTabs.last()).toHaveAttribute("data-open-pr", lastKey ?? "missing reordered key");
    await browser.keyboard.press(`${modifier}+3`);
    await browser.locator("[data-pr-scroll]").hover();
    await browser.mouse.wheel(0, 200);
    await expect
      .poll(() =>
        browser.evaluate(() => document.querySelector("[data-pr-scroll]")?.scrollTop ?? 0),
      )
      .toBe(200);
    await browser.keyboard.press(`${modifier}+2`);
    await browser.keyboard.press(`${modifier}+3`);
    await expect
      .poll(() =>
        browser.evaluate(() => document.querySelector("[data-pr-scroll]")?.scrollTop ?? 0),
      )
      .toBe(200);
    await app.screenshot("conversation-scroll-remembered");
    await browser.keyboard.press(`${modifier}+2`);
    await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
    await browser.keyboard.press(`${modifier}+3`);
    await browser.keyboard.press(`${modifier}+2`);
    await expect(
      screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide"),
    ).toHaveAttribute("aria-current", "page");
    await app.screenshot("guide-tab-remembered");

    await open.getByRole("button", `Close ${FIXTURE_REPO} #1`).tap();
    await expect(prTabs).toHaveCount(2);
    await browser.keyboard.press(`${modifier}+k`);
    const dialog = screen.getByRole("dialog", "Find a pull request");
    await dialog.getByRole("searchbox", "Find a pull request").fill(`${FIXTURE_NAME}#1`);
    await dialog.getByRole("button", /Validate links and count clicks/).tap();
    await expect(dialog).toBeHidden();
    await expect(prTabs).toHaveCount(3);
    await browser.keyboard.press(`${modifier}+1`);
    await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
    await browser.keyboard.press(`${modifier}+w`);
    await expect(prTabs).toHaveCount(3);
    await app.screenshot("inbox-with-open-prs");
    await screen.getByRole("button", "Open a pull request").tap();
    await dialog
      .getByRole("searchbox", "Find a pull request")
      .fill(`https://github.com/${FIXTURE_REPO}/pull/2`);
    await dialog.getByRole("button", `Open through ${FIXTURE_ACCOUNT}`).tap();
    await expect(prTabs).toHaveCount(4);
    await app.screenshot("four-open-prs");
    for (const number of [1, 2, 3, 4]) {
      await browser.keyboard.press(`${modifier}+t`);
      await dialog
        .getByRole("searchbox", "Find a pull request")
        .fill(`https://github.com/pingdotgg/t3code/pull/${number}`);
      await dialog.getByRole("button", `Open through ${FIXTURE_ACCOUNT}`).tap();
      await expect(prTabs).toHaveCount(4 + number);
    }
    for (let position = 2; position <= 9; position++) {
      await browser.keyboard.press(`${modifier}+${position}`);
      await expect(prTabs.nth(position - 2)).toHaveAttribute("aria-current", "page");
    }
    await app.screenshot("number-shortcuts-through-nine");
    await prTabs.last().secondaryTap();
    await screen.getByRole("menuitem", "Close others").tap();
    await expect(prTabs).toHaveCount(1);
    await app.screenshot("close-others");
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect(prTabs).toHaveCount(2);
    await prTabs.first().secondaryTap();
    await screen.getByRole("menuitem", "Close to the right").tap();
    await expect(prTabs).toHaveCount(1);
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect(prTabs).toHaveCount(2);
    await prTabs.last().secondaryTap();
    await screen.getByRole("menuitem", "Close").tap();
    await expect(prTabs).toHaveCount(1);
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await expect(prTabs).toHaveCount(2);
    await browser.evaluate(() => {
      const tabs = document.querySelectorAll("[data-open-pr]");
      tabs
        .item(tabs.length - 1)
        ?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
      return true;
    });
    await expect(prTabs).toHaveCount(1);
    await browser.keyboard.press(`${modifier}+Shift+t`);
    await prTabs.first().secondaryTap();
    await screen.getByRole("menuitem", "Close all PRs").tap();
    await expect(prTabs).toHaveCount(0);

    while ((await open.getByRole("button").count()) > 0)
      await open.getByRole("button").first().tap();
    await expect(prTabs).toHaveCount(0);
    await expect(open.getByRole("link", "Inbox")).toBeVisible();
  },
);

test(
  "an inaccessible PR names the account and lets the reader retry or close it",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    await app.open(run.openUrl);
    await expect(screen.getByRole("link", "Inbox")).toBeVisible();
    await expect(browser.locator('[aria-label="Loading open pull requests"]')).toBeHidden();
    const close = screen.getByRole("navigation", "Workspace tabs").getByRole("button", /Close/);
    while ((await close.count()) > 0) await close.first().tap();
    await app.open(`${run.url}${prPath("prkit-no-access-8ec2/prkit", 1, "conversation")}`);
    const alert = screen.getByRole("alert");
    await expect(alert).toContainText(`no access through account ${FIXTURE_ACCOUNT}`, {
      timeout: 45_000,
    });
    await alert.getByRole("button", "Retry").tap();
    await expect(alert).toContainText(`no access through account ${FIXTURE_ACCOUNT}`);
    await app.screenshot("account-access-error");
    await screen.getByRole("button", "Close prkit-no-access-8ec2/prkit #1").tap();
    await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
  },
);

test(
  "the palette finds a PR by its words and its branch, with one account or several",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    await openInbox({ app, screen });
    // The palette searches the inbox, so the fixture must have loaded into it.
    await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
    await expect(
      screen.getByRole("region", "Yours").getByRole("link", /#1 Validate links and count clicks/),
    ).toBeVisible({ timeout: 45_000 });
    await screen.getByRole("searchbox", "Search pull requests").clear();
    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+k`);
    const dialog = screen.getByRole("dialog", "Find a pull request");
    const query = dialog.getByRole("searchbox", "Find a pull request");
    await query.fill(`${FIXTURE_NAME}#1`);
    const fixtureRow = dialog.getByRole("button", /Validate links and count clicks/);
    await expect(fixtureRow).toContainText("Inbox");
    await expect(fixtureRow).toContainText("feat/validate-and-count");
    for (const words of [`${FIXTURE_NAME} validate`, "feat/valid", "count clicks feat/validate"]) {
      await query.fill(words);
      await expect(fixtureRow).toBeVisible();
    }
    await app.screenshot("palette-branch-search");
    // An exact head branch comes first.
    await query.fill("feat/validate-and-count");
    await expect(browser.locator("[data-command-result]").first()).toContainText(
      "Validate links and count clicks",
    );
    await browser.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  },
);

test("three open PRs come back after a relaunch, in their order and with the same one active", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("relaunch-tabs");
  try {
    const first = startFakeInstance("relaunch-tabs", fake);
    await app.open(first.openUrl);
    for (const number of [5, 3, 4]) {
      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("link", new RegExp(`#${number} Budget fixture ${number}`)).tap({
        timeout: 20_000,
      });
      await expect(screen.getByRole("heading", `Budget fixture ${number}`)).toBeVisible({
        timeout: 20_000,
      });
    }
    const prTabs = browser.locator("[data-open-pr]");
    const tabState = () =>
      browser.evaluate(() => ({
        order: [...document.querySelectorAll("[data-open-pr]")].map((tab) =>
          tab.getAttribute("data-open-pr"),
        ),
        active:
          document
            .querySelector('[data-open-pr][aria-current="page"]')
            ?.getAttribute("data-open-pr") ?? null,
      }));
    await screen.getByRole("link", "Open budget/fixtures #3 Budget fixture 3").tap();
    await expect(screen.getByRole("heading", "Budget fixture 3")).toBeVisible();
    const expected = {
      order: [
        "github.com/budget/fixtures#5",
        "github.com/budget/fixtures#3",
        "github.com/budget/fixtures#4",
      ],
      active: "github.com/budget/fixtures#3",
    };
    expect(await tabState()).toEqual(expected);
    await app.screenshot("tabs-before-relaunch");

    // Only the server can bring them back: the page's own storage goes with the old instance.
    await browser.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    });
    stopFakeInstance("relaunch-tabs", { keepHome: true });
    const second = startFakeInstance("relaunch-tabs", fake);
    await app.open(second.openUrl);
    await expect(screen.getByRole("heading", "Budget fixture 3")).toBeVisible({ timeout: 20_000 });
    await expect(prTabs).toHaveCount(3);
    expect(await tabState()).toEqual(expected);
    await expect(browser).toHaveURL(/\/pr\/github\.com\/budget\/fixtures\/3\?/);
    await app.screenshot("tabs-after-relaunch");
  } finally {
    stopFakeInstance("relaunch-tabs", { keepHome: false });
    fake.stop();
  }
});
