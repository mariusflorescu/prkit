import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, readPageTheme, setOsColorScheme } from "./osColorScheme.ts";

/** Every event row on the rail as a reader sees it, oldest first: no avatar letter, no time. */
const eventSentences = () =>
  [
    ...document.querySelectorAll(
      'section[aria-label="Activity"] li[data-timeline-kind]:not([data-timeline-kind="commit"])',
    ),
  ].map((row) => {
    const copy = row.cloneNode(true);
    if (!(copy instanceof Element)) return "";
    for (const hidden of copy.querySelectorAll("[aria-hidden], time")) hidden.remove();
    return (copy.textContent ?? "").replaceAll(/\s+/g, " ").trim();
  });

/** WCAG contrast of each label chip's name against its wash over the surface behind it. */
const chipContrast = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return [];
  const paint = (colors: string[]) => {
    context.clearRect(0, 0, 1, 1);
    for (const color of colors) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
  };
  const luminance = (rgb: number[]) => {
    const [r = 0, g = 0, b = 0] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const surface = (element: Element | null): string => {
    if (element === null) return "white";
    const color = getComputedStyle(element).backgroundColor;
    return color === "rgba(0, 0, 0, 0)" ? surface(element.parentElement) : color;
  };
  return [...document.querySelectorAll('[data-pr-conversation] span[style*="--label"]')].map(
    (chip) => {
      const style = getComputedStyle(chip);
      const under = surface(chip.parentElement);
      const [light, dark] = [
        luminance(paint([under, style.backgroundColor])),
        luminance(paint([under, style.backgroundColor, style.color])),
      ].toSorted((a, b) => b - a);
      return {
        label: chip.textContent,
        ratio: Math.round((((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)) * 10) / 10,
      };
    },
  );
};

test("Conversation shows label, reviewer, title, assignee, base and reference events like GitHub, leaving out what GitHub withholds", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("timeline-events");
  try {
    const run = startFakeInstance("timeline-events", fake);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    await app.open(
      `${run.url}/pr/github.com/budget/fixtures/8?account=github.com%2Fbudget-test&tab=conversation`,
    );
    const activity = screen.getByRole("region", "Activity");
    await expect(activity.getByRole("button", "Newest first")).toBeVisible({ timeout: 20_000 });
    await activity.getByRole("button", "Newest first").tap();
    await expect(browser.locator('[data-timeline-kind="labels"]').first()).toBeVisible();
    expect(await browser.evaluate(eventSentences)).toEqual([
      "budget-test added bug and ui labels",
      "budget-test requested a review from octocat and budget/reviewers",
      "budget-test changed the title Timeline fixture Timeline fixture 8",
      "budget-test self-assigned this",
      "octocat assigned teammate and unassigned budget-test",
      "budget-test changed the base branch from release to main",
      "teammate mentioned this in Tools fixture 1 budget/tools#1",
      "budget-test added docs and removed ui labels",
      "budget-test removed the request for review from octocat",
      "octocat marked this as a duplicate of Budget fixture 3 #3",
      "budget-test added wontfix label",
      "budget-test removed wontfix label",
      "budget-test marked this pull request as draft",
      "budget-test marked this pull request as ready for review",
      "budget-test force-pushed the branch from c0ffee1 to decafba",
      "deleted user added stale label",
    ]);
    const commits = browser.locator(
      'section[aria-label="Activity"] li[data-timeline-kind="commit"]',
    );
    await expect(commits).toHaveCount(1);
    await expect(commits).toContainText("Start fixture 8");

    for (const [row, at] of [
      ['[data-timeline-kind="labels"]', "2026-03-02T10:01:00Z"],
      ['[data-timeline-kind="renamed"]', "2026-03-02T10:20:00Z"],
      ['[data-timeline-kind="cross-referenced"]', "2026-03-02T11:10:00Z"],
    ] as const) {
      const time = browser.locator(`section[aria-label="Activity"] ${row} time`).first();
      await expect(time).toHaveAttribute("datetime", at);
      await expect(time).toHaveText(/^\d+d ago$/);
      await expect(time).toHaveAttribute(
        "title",
        await browser.evaluate((iso: string) => new Date(iso).toLocaleString(), at),
      );
    }
    await expect(activity.getByRole("link", "Tools fixture 1 budget/tools#1")).toHaveAttribute(
      "href",
      "https://github.com/budget/tools/pull/1",
    );

    const labels = screen.getByRole("region", "Labels");
    await expect(labels.getByRole("listitem")).toHaveText(["bug", "docs", "stale"]);
    const lightChips = await browser.evaluate(chipContrast);
    expect(lightChips.map((chip) => chip.label)).toEqual([
      "bug",
      "docs",
      "stale",
      "bug",
      "ui",
      "docs",
      "ui",
      "wontfix",
      "wontfix",
      "stale",
    ]);
    for (const chip of lightChips)
      expect(chip.ratio, `${chip.label} on light`).toBeGreaterThanOrEqual(4.5);
    await app.screenshot("timeline-events-light");
    await activity.getByRole("listitem").nth(9).scrollIntoView();
    await app.screenshot("timeline-events-light-end");

    await setOsColorScheme(browser, "dark");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(true);
    const darkChips = await browser.evaluate(chipContrast);
    expect(darkChips.map((chip) => chip.label)).toEqual(lightChips.map((chip) => chip.label));
    for (const chip of darkChips)
      expect(chip.ratio, `${chip.label} on dark`).toBeGreaterThanOrEqual(4.5);
    await app.screenshot("timeline-events-dark-end");
    await labels.scrollIntoView();
    await app.screenshot("timeline-events-dark");
    console.log(JSON.stringify({ light: lightChips, dark: darkChips }));
  } finally {
    stopFakeInstance("timeline-events", { keepHome: false });
    fake.stop();
  }
});
