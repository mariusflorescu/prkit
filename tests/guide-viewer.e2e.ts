import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { choose } from "./pickers.ts";

declare global {
  interface Window {
    guideViewerErrors: Array<string>;
  }
}

test("production excludes the guide fixture preview", async ({ app, screen }) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await app.open("/dev/guide/vercel-ai-22182");
  await expect(screen.getByText("Not Found")).toBeVisible();
  await expect(screen.getByRole("combobox", "Guide fixture")).toHaveCount(0);
  await app.screenshot("guide-preview-excluded");
});

test("the DEV guide opens fixtures, switches flow and shows pinned notes", async ({
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
  const url = new URL("/dev/guide/vercel-ai-22182", devUrl);
  url.search = new URL(devUrl).search;
  await app.open(url.href);
  const picker = screen.getByRole("combobox", "Guide fixture");
  for (const [fixture, label] of [
    ["vercel-ai-22182", "Vercel AI #22182"],
    ["github-gh-stack-91", "gh-stack #91"],
    ["pingdotgg-t3code-16353", "T3 Code #16353"],
    ["pingdotgg-t3code-16782", "T3 Code #16782"],
  ] as const) {
    await choose(screen, picker, label);
    await expect(screen.getByRole("heading", "Overview")).toBeVisible();
    await expect(screen.getByRole("button", "Before")).toHaveAttribute("aria-pressed", "true");
    await app.screenshot(`${fixture}-before`);
    await screen.getByRole("button", "After").tap();
    await expect(screen.getByRole("button", "After")).toHaveAttribute("aria-pressed", "true");
    await app.screenshot(`${fixture}-after`);
    await browser.locator("[data-roadmap-row]").first().tap();
    const note = browser.locator("[data-guide-note][data-pinned]").first();
    await note.scrollIntoView();
    await expect(note).toBeVisible();
    await app.screenshot(`${fixture}-line-note`);
    await expect(await unexpectedErrors()).toEqual([]);
  }
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
