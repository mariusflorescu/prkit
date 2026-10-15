import { type Browser, test } from "@e2e-dev/web";
import { expect, type Locator } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";

/** The open list's rows, once its fade-in is over: how many, the tallest, and the largest text. */
const listRows = async (browser: Browser) => {
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  return browser.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="option"]')].filter((row) =>
      row.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    );
    const fonts = rows.flatMap((row) =>
      [row, ...row.querySelectorAll("*")]
        .filter((node) =>
          [...node.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "",
          ),
        )
        .map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    );
    return {
      rows: rows.length,
      tallest: Math.max(...rows.map((row) => row.getBoundingClientRect().height)),
      largestText: Math.max(...fonts),
    };
  });
};

/** A picker's open list has `rows` rows, none taller than 30px, no text over 13px. */
const expectCompact = async (browser: Browser, rows: number) => {
  const measured = await listRows(browser);
  expect(measured.rows).toBe(rows);
  expect(measured.tallest).toBeLessThanOrEqual(30);
  expect(measured.largestText).toBeLessThanOrEqual(13);
};

/** How many native selects the page has once `loaded` shows and nothing is still loading. */
const nativeSelects = async (browser: Browser, loaded: Locator) => {
  await expect(loaded).toBeVisible({ timeout: 30_000 });
  await expect(browser.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  return browser.evaluate(() => document.querySelectorAll("select").length);
};

test("every picker lists compact rows, and the app uses no native select", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("compact-pickers", { secondAccount: true });
  const claude = setUpFakeClaude("compact-pickers");
  try {
    const run = startFakeInstance("compact-pickers", fake, ["--claude", claude.file]);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    expect(await nativeSelects(browser, screen.getByRole("link", /#3 Budget fixture 3/))).toBe(0);

    await screen.getByRole("combobox", "Filter by GitHub account").tap();
    await expect(screen.getByRole("option", "budget-second")).toBeVisible();
    await expectCompact(browser, 3);
    await screenshotLightAndDark(app, browser, "picker-accounts");
    await browser.keyboard.press("Escape");

    await screen.getByRole("button", "Filter by repository: All repositories").tap();
    await expect(screen.getByRole("option", "tools")).toBeVisible({ timeout: 20_000 });
    await expectCompact(browser, 3);
    await screenshotLightAndDark(app, browser, "picker-repositories");
    await browser.keyboard.press("Escape");

    await screen.getByRole("link", /#3 Budget fixture 3/).tap();
    const tabs = screen.getByRole("navigation", "Pull request tabs");
    // Each tab's own content, so a select it renders once loaded would be counted.
    for (const [tab, loaded] of [
      ["Conversation", screen.getByRole("article", "Comment by budget-test")],
      ["Files", screen.getByRole("region", "src/change-0.ts")],
      ["Guide", screen.getByRole("button", /^Agent and model: /)],
    ] as const) {
      await tabs.getByRole("link", tab).tap({ timeout: 20_000 });
      expect(await nativeSelects(browser, loaded)).toBe(0);
    }
    await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
    await expect(screen.getByRole("option", /Claude Fable 5\.1/)).toBeVisible();
    await expectCompact(browser, 4);
    await screenshotLightAndDark(app, browser, "picker-models");
    await browser.keyboard.press("Escape");

    const modifier = await browser.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await browser.keyboard.press(`${modifier}+Comma`);
    const sections = screen.getByRole("navigation", "Settings sections");
    for (const [section, loaded] of [
      ["Accounts", screen.getByRole("region", "GitHub accounts").getByText("Ready").first()],
      ["Agents", screen.getByRole("list", "Agents").getByRole("listitem", "Codex")],
      ["Appearance", screen.getByRole("radiogroup", "Theme")],
      ["Keyboard shortcuts", screen.getByRole("list", "General")],
      ["About", screen.getByRole("region", "About prkit").getByText(/^Build /)],
      ["Guides", screen.getByRole("list", "Automatic guides by account")],
    ] as const) {
      await sections.getByRole("link", section).tap();
      expect(await nativeSelects(browser, loaded)).toBe(0);
    }
    await screen.getByRole("button", /^Repository/).tap({ timeout: 30_000 });
    await expect(screen.getByRole("option").first()).toBeVisible({ timeout: 20_000 });
    await expectCompact(browser, 1);
    await screenshotLightAndDark(app, browser, "picker-guide-repositories");
    await browser.keyboard.press("Escape");
  } finally {
    stopFakeInstance("compact-pickers", { keepHome: false });
    fake.stop();
  }
});
