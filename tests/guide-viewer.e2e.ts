import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { choose } from "./pickers.ts";

declare global {
  interface Window {
    guideViewerErrors: Array<string>;
  }
}

const graphFixtures = [
  ["vercel-ai-22182", "Vercel AI #22182"],
  ["github-gh-stack-91", "gh-stack #91"],
  ["pingdotgg-t3code-16353", "T3 Code #16353"],
  ["pingdotgg-t3code-16782", "T3 Code #16782"],
] as const;

test("production excludes the guide fixture preview", async ({ app, screen }) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await app.open("/dev/guide/vercel-ai-22182");
  await expect(screen.getByText("Not Found")).toBeVisible();
  await expect(screen.getByRole("combobox", "Guide fixture")).toHaveCount(0);
  await app.screenshot("guide-preview-excluded");
});

test("the DEV guide shows each before/after, opens lines from a behavior diff and shows pinned notes", async ({
  app,
  screen,
  browser,
}) => {
  const devUrl = process.env.PRKIT_GUIDE_URL;
  if (!devUrl) {
    test.skip(
      "Set PRKIT_GUIDE_URL to the isolated Vite preview URL; production excludes this route.",
    );
    return;
  }
  await emulateOsColorScheme(browser, "light");
  await browser.addInitScript(() => {
    window.guideViewerErrors = [];
    window.addEventListener("error", (event) => window.guideViewerErrors.push(event.message));
  });
  const unexpectedErrors = () =>
    browser.evaluate(() =>
      window.guideViewerErrors.filter(
        (message) => message !== "ResizeObserver loop completed with undelivered notifications.",
      ),
    );
  const openLine = async (path: string, line: number) => {
    await screen.getByRole("button", `Open ${path} line ${line}`).tap();
    return browser.evaluate(
      async (target: { path: string; line: number }) => {
        const read = () => {
          const card = document.querySelector<HTMLElement>(
            `[data-file-diff-card][data-path="${target.path}"]`,
          );
          const root = card?.querySelector("diffs-container")?.shadowRoot;
          const cell = [
            ...(root?.querySelectorAll<HTMLElement>(
              `[data-gutter] > [data-column-number="${target.line}"]`,
            ) ?? []),
          ].find((candidate) => {
            const code = candidate.closest("code");
            return (
              code !== null &&
              !code.hasAttribute("data-deletions") &&
              (code.hasAttribute("data-additions") ||
                candidate.dataset.lineType !== "change-deletion")
            );
          });
          return {
            open: card?.dataset.open === "true",
            focused: card !== null && document.activeElement === card,
            selected: [
              ...(root?.querySelectorAll<HTMLElement>("[data-gutter] > [data-selected-line]") ??
                []),
            ].map((selected) => Number(selected.dataset.columnNumber)),
            top: cell ? Math.round(cell.getBoundingClientRect().top) : null,
            height: window.innerHeight,
            pageScroll: document.scrollingElement?.scrollTop ?? 0,
          };
        };
        // Each read waits for the next painted frame: alignment runs before paint.
        const at = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)).then(
            () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
          );
        await at(100);
        const early = read();
        await at(1400);
        return { early, late: read() };
      },
      { path, line },
    );
  };

  await browser.setViewport({ width: 1440, height: 900 });
  const url = new URL("/dev/guide/vercel-ai-22182", devUrl);
  url.search = new URL(devUrl).search;
  await app.open(url.href);
  const picker = screen.getByRole("combobox", "Guide fixture");
  const card = screen.getByRole("region", "Before and after");

  for (const [fixture, label] of graphFixtures) {
    await choose(screen, picker, label);
    await expect(screen.getByRole("heading", "Overview")).toBeVisible();
    await expect(card.getByRole("list", "Legend")).toBeVisible();
    await expect(card.getByText("~ changed")).toBeVisible();
    await expect(browser.locator("[data-flow-node]").first()).toBeVisible();
    await expect(card.getByRole("button", "Before")).toHaveCount(0);
    await expect(card.getByRole("button", "After")).toHaveCount(0);
    if (fixture === "github-gh-stack-91") {
      await expect(browser.locator('[data-flow-node][data-status="added"]').first()).toBeVisible();
      await expect(
        browser.locator('[data-flow-node][data-status="removed"]').first(),
      ).toBeVisible();
    }
    await card.scrollIntoView();
    await screenshotLightAndDark(app, browser, `${fixture}-overview`);
    await browser.locator("[data-roadmap-row]").first().tap();
    const note = browser.locator("[data-guide-note][data-pinned]").first();
    await note.scrollIntoView();
    await expect(note).toBeVisible();
    await app.screenshot(`${fixture}-line-note`);
    await expect(await unexpectedErrors()).toEqual([]);
  }

  await choose(screen, picker, "gh-stack #91, behavior diff");
  await expect(card.getByText("context")).toBeVisible();
  await expect(card.getByRole("button", "Open cmd/init.go line 154")).toHaveText("init.go:154");
  await screenshotLightAndDark(app, browser, "behavior-diff-overview");
  const chapterToggle = browser.locator('[data-chapter-id="init-flow"] [data-chapter-toggle]');
  await chapterToggle.scrollIntoView();
  await chapterToggle.tap();
  await expect(chapterToggle).toHaveAttribute("aria-expanded", "false");
  await expect(screen.getByRole("region", "cmd/init.go")).toHaveCount(0);
  await card.scrollIntoView();

  const first = await openLine("cmd/init.go", 154);
  await expect(chapterToggle).toHaveAttribute("aria-expanded", "true");
  await expect(screen.getByRole("region", "cmd/init.go")).toHaveAttribute("data-open", "true");
  expect(first.late).toMatchObject({ open: true, focused: true, selected: [154], pageScroll: 0 });
  expect(first.late.top).not.toBeNull();
  expect(first.late.top ?? -1).toBeGreaterThan(0);
  expect(first.late.top ?? Infinity).toBeLessThan(first.late.height);
  expect(first.early.top).toBe(first.late.top);
  await app.screenshot("behavior-diff-jump-154");

  const second = await openLine("cmd/init.go", 272);
  expect(second.late).toMatchObject({ open: true, focused: true, selected: [272], pageScroll: 0 });
  expect(second.late.top ?? -1).toBeGreaterThan(0);
  expect(second.late.top ?? Infinity).toBeLessThan(second.late.height);
  expect(second.early.top).toBe(second.late.top);
  await screenshotLightAndDark(app, browser, "behavior-diff-jump-272");
  await expect(await unexpectedErrors()).toEqual([]);

  for (const width of [760, 640]) {
    await browser.setViewport({ width, height: 900 });
    await card.scrollIntoView();
    await expect(card.getByRole("button", "Open cmd/init.go line 272")).toBeVisible();
    await app.screenshot(`behavior-diff-${width}`);
  }
  const narrow = await openLine("cmd/init.go", 154);
  expect(narrow.late).toMatchObject({ open: true, selected: [154], pageScroll: 0 });
  expect(narrow.late.top ?? -1).toBeGreaterThan(0);
  expect(narrow.late.top ?? Infinity).toBeLessThan(narrow.late.height);
  expect(narrow.early.top).toBe(narrow.late.top);
  await app.screenshot("behavior-diff-640-jump-154");
  await browser.setViewport({ width: 1440, height: 900 });

  await choose(screen, picker, "Vercel AI #22182, stored before behavior diffs");
  await expect(card.getByRole("list", "Legend")).toBeVisible();
  await expect(card.getByText("~ changed")).toBeVisible();
  await card.scrollIntoView();
  await expect(browser.locator("[data-flow-node]").first()).toBeVisible();
  await app.screenshot("vercel-ai-22182-stored-overview");
  await expect(await unexpectedErrors()).toEqual([]);

  await screen.getByRole("button", "Split").tap();
  await expect(screen.getByRole("button", "Split")).toHaveAttribute("aria-pressed", "true");
  await screen.getByRole("button", "Wrap").tap();
  await expect(screen.getByRole("button", "Wrap")).toHaveAttribute("aria-pressed", "true");
  await screen.getByRole("button", "Unified").tap();
  await app.screenshot("guide-diff-preferences");
  await expect(await unexpectedErrors()).toEqual([]);
  const warnings = await browser.evaluate(() => window.guideViewerErrors.length);
  if (warnings > 0) console.warn(`Recorded ${warnings} Pierre gutter ResizeObserver warnings.`);
});
