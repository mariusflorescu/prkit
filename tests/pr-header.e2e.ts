import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

/** What lives on the page instead of in the ⋯ menu. */
const PAGE_ACTIONS = [
  "Open on GitHub",
  "Copy gh pr checkout",
  "Edit title and description",
  "Request reviewers",
  "Set labels",
];

/** The visible header's actions, by accessible name, in order. */
const headerActions = (browser: Browser, header: "expanded" | "compact") =>
  browser.evaluate(
    (selector: string) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `${selector} [aria-label="Pull request actions"] button`,
        ),
      ].map((button) => (button.getAttribute("aria-label") ?? button.innerText).trim()),
    header === "expanded" ? "[data-pr-expanded-header]" : "[data-pr-compact-header]",
  );

/** The open ⋯ menu's items, with ` (disabled)` after one that is blocked right now. */
const menuItems = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
      (item) =>
        `${(item.textContent ?? "").trim()}${item.hasAttribute("data-disabled") ? " (disabled)" : ""}`,
    ),
  );

/** Focuses the repository link without a pointer, so Tab starts at the top line. */
const focusTopLine = (browser: Browser) =>
  browser.evaluate(() => {
    document.querySelector<HTMLElement>("[data-pr-expanded-header] h2 a")?.focus();
    return true;
  });

/** Tabs forward until the focused element matches `selector`, as a keyboard user gets there. */
const tabTo = async (browser: Browser, selector: string) => {
  for (let presses = 0; presses < 40; presses++) {
    const there = await browser.evaluate(
      (match: string) => document.activeElement?.matches(match) ?? false,
      selector,
    );
    if (there) return;
    await browser.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${selector}.`);
};

/** The focused element's accessible description, from `aria-describedby`. */
const focusedDescription = (browser: Browser) =>
  browser.evaluate(() =>
    (document.activeElement?.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim(),
  );

/** Screenshots wait for a fade to end. */
const opacity = (browser: Browser, selector: string) =>
  browser.evaluate(
    (match: string) => getComputedStyle(document.querySelector(match) ?? document.body).opacity,
    selector,
  );

const STATES = [
  {
    name: "open-update",
    number: 4,
    title: "Budget fixture 4",
    header: ["Review", "Update branch", "Choose branch update method", "More pull request actions"],
    menu: ["Merge", "Convert to draft", "Close pull request"],
  },
  {
    name: "open-mergeable",
    number: 3,
    title: "Budget fixture 3",
    header: ["Review", "Merge (merge)", "Choose merge method", "More pull request actions"],
    menu: ["Convert to draft", "Close pull request"],
  },
  {
    name: "blocked-auto-merge",
    number: 8,
    title: "Timeline fixture 8",
    header: ["Review", "Enable auto-merge", "Choose merge method", "More pull request actions"],
    menu: ["Merge (disabled)", "Convert to draft", "Close pull request"],
  },
  {
    name: "fork",
    number: 7,
    title: "Budget fixture 7 from a fork",
    header: ["Review", "Merge (merge)", "Choose merge method", "More pull request actions"],
    menu: ["Approve workflows", "Convert to draft", "Close pull request"],
  },
  {
    name: "checking",
    number: 1,
    title: "Budget fixture 1",
    header: ["Review", "Merge (merge)", "Choose merge method", "More pull request actions"],
    menu: ["Convert to draft", "Close pull request"],
  },
  {
    name: "conflicting-draft",
    number: 2,
    title: "Budget fixture 2",
    header: ["Review", "Resolve conflicts", "More pull request actions"],
    menu: ["Ready for review", "Close pull request"],
  },
  {
    name: "draft",
    number: 5,
    title: "Budget fixture 5",
    header: ["Review", "Ready for review", "More pull request actions"],
    menu: ["Close pull request"],
  },
  { name: "merged", number: 6, title: "Budget fixture 6", header: ["Review", "Revert"], menu: [] },
  {
    name: "closed",
    number: 9,
    title: "Keyboard fixture 9",
    header: ["Review", "Reopen"],
    menu: [],
  },
] as const;

test(
  "the PR header shows each action once, only those that apply, the same when compact",
  { timeout: 300_000 },
  async ({ app, screen, browser }: Pick<TestFixtures, "app" | "screen"> & { browser: Browser }) => {
    const fake = await startFakeGitHub("pr-header");
    try {
      await fake.behind(4, 2);
      await fake.require(8);
      await fake.draft(5);
      await fake.merge(6);
      await fake.close(9);
      await fake.checking(1);
      await fake.draft(2);
      await fake.conflict(2);
      // A conversation long enough to scroll the title away.
      for (const state of STATES)
        for (let count = 0; count < 8; count++) await fake.comment(state.number);
      const run = startFakeInstance("pr-header", fake);
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      const tooltip = browser.locator('[data-slot="tooltip-popup"]');
      for (const state of STATES) {
        await app.open(
          `${run.url}/pr/github.com/budget/fixtures/${state.number}?account=github.com%2Fbudget-test&tab=conversation`,
        );
        const main = screen.getByRole("main");
        await expect(main.getByRole("heading", state.title)).toBeVisible({ timeout: 30_000 });
        expect(await headerActions(browser, "expanded")).toEqual(state.header);
        await browser.mouse.move(5, 5);
        await screenshotLightAndDark(app, browser, `${state.name}-header`);
        if (state.name === "checking") {
          // Blocked right now: it stays focusable, and the keyboard reaches its reason.
          const checking = "GitHub is still checking mergeability. Refresh in a moment.";
          await focusTopLine(browser);
          await tabTo(browser, '[data-pr-expanded-header] [aria-label="Merge (merge)"]');
          expect(
            await browser.evaluate(
              () => document.activeElement?.getAttribute("aria-disabled") ?? null,
            ),
          ).toBe("true");
          expect(await focusedDescription(browser)).toBe(checking);
          await expect(tooltip).toHaveText(checking);
          await app.screenshot("blocked-primary-focus");
          await browser.keyboard.press("Enter");
          await expect(screen.getByRole("dialog")).toHaveCount(0);
        }

        const more = main.getByRole("button", "More pull request actions");
        if (state.menu.length === 0) await expect(more).toHaveCount(0);
        else {
          await more.tap();
          await expect(screen.getByRole("menu")).toBeVisible();
          await expect.poll(() => opacity(browser, '[role="menu"]')).toBe("1");
          const items = await menuItems(browser);
          expect(items).toEqual(state.menu);
          // Each action once: nothing in the menu is also in the header or on the page.
          const names = items.map((item) => item.replace(" (disabled)", ""));
          for (const name of names) {
            expect(state.header.some((action) => action.startsWith(name))).toBe(false);
            expect(PAGE_ACTIONS.some((action) => name.startsWith(action))).toBe(false);
          }
          if (state.name === "blocked-auto-merge") {
            await screen.getByRole("menuitem", "Merge").hover();
            await expect(tooltip).toHaveText(
              "GitHub requires checks, approvals or an updated branch before merging.",
            );
          }
          await screenshotLightAndDark(app, browser, `${state.name}-menu`);
          await browser.keyboard.press("Escape");
          await expect(screen.getByRole("menu")).toHaveCount(0);
        }

        await browser.locator("[data-pr-scroll]").hover();
        await browser.mouse.wheel(0, 600);
        const compact = browser.locator('[data-pr-compact-header][aria-hidden="false"]');
        await expect(compact).toBeVisible();
        await expect
          .poll(() => opacity(browser, '[data-pr-compact-header][aria-hidden="false"]'))
          .toBe("1");
        expect(await headerActions(browser, "compact")).toEqual(state.header);
        await browser.mouse.move(5, 5);
        await screenshotLightAndDark(app, browser, `${state.name}-compact`);
        if (state.menu.length > 0) {
          await screen.getByRole("button", "More pull request actions").tap();
          await expect.poll(() => opacity(browser, '[role="menu"]')).toBe("1");
          expect(await menuItems(browser)).toEqual(state.menu);
          await screenshotLightAndDark(app, browser, `${state.name}-compact-menu`);
          await browser.keyboard.press("Escape");
        }
      }

      // Each page action has one home: the repository link, the copy button, the account.
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/3?account=github.com%2Fbudget-test&tab=conversation`,
      );
      const header = browser.locator("[data-pr-expanded-header]");
      const github = screen.getByRole("main").getByRole("link", "budget/fixtures #3");
      await expect(github).toHaveAttribute("href", "https://github.com/budget/fixtures/pull/3", {
        timeout: 30_000,
      });
      await expect(screen.getByRole("main").getByRole("link", "Open on GitHub")).toHaveCount(0);
      await expect(header.getByRole("button", "Back to inbox")).toHaveCount(0);
      const arrow = () => opacity(browser, "[data-pr-expanded-header] h2 a svg");
      expect(await arrow()).toBe("0");
      await github.hover();
      await expect.poll(arrow).toBe("1");
      await app.screenshot("github-link-hover");
      await screen.getByRole("button", "Copy gh pr checkout 3").hover();
      await expect(tooltip).toHaveText("gh pr checkout 3");
      await app.screenshot("checkout-tooltip");
      await expect(browser.locator("[data-reading-account]")).toHaveText("github.com/budget-test");
      const account = "[data-pr-expanded-header] button:has([data-reading-account])";
      await browser.locator(account).hover();
      await expect(tooltip).toHaveText("Read through github.com/budget-test");
      await app.screenshot("reading-account-tooltip");
      await browser.mouse.move(5, 5);
      await expect(tooltip).toHaveCount(0);
      await focusTopLine(browser);
      await tabTo(browser, account);
      await expect(tooltip).toHaveText("Read through github.com/budget-test");
      await browser.keyboard.press("Escape");
      await screen.getByRole("button", "Edit title and description").tap();
      const edit = screen.getByRole("dialog", "Edit pull request");
      await expect(edit.getByRole("textbox", "Title")).toHaveValue("Budget fixture 3");
      await expect(edit.getByRole("textbox", "Description")).toBeVisible();
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("button", "Edit reviewers")).toBeVisible();
      await expect(screen.getByRole("button", "Edit labels")).toBeVisible();
    } finally {
      stopFakeInstance("pr-header", { keepHome: false });
      fake.stop();
    }
  },
);
