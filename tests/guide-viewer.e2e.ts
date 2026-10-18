import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

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

/** Records window errors from the first load; returns the ones that aren't Pierre's warning. */
const watchErrors = async (browser: Browser) => {
  await browser.addInitScript(() => {
    window.guideViewerErrors = [];
    window.addEventListener("error", (event) => window.guideViewerErrors.push(event.message));
  });
  return () =>
    browser.evaluate(() =>
      window.guideViewerErrors.filter(
        (message) => message !== "ResizeObserver loop completed with undelivered notifications.",
      ),
    );
};

/** Taps a file:line chip, then reads where its line landed 100 ms and 1.5 s later. */
const lineOpener = (screen: Screen, browser: Browser) => async (path: string, line: number) => {
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
            ...(root?.querySelectorAll<HTMLElement>(
              "[data-gutter] > [data-selected-line][data-column-number]",
            ) ?? []),
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
  const unexpectedErrors = await watchErrors(browser);
  const openLine = lineOpener(screen, browser);

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

const riskFixtures = [
  {
    name: "low",
    label: "T3 Code #16353",
    level: "Low",
    reasons: [
      {
        text: "The new key only decides grouping and labels.",
        chapter: "identity-origin",
        at: { path: "packages/contracts/src/environment.ts", line: 259 },
      },
      { text: "gets the same data as before.", chapter: "resolver-origin", at: null },
    ],
    signals: [],
    chapters: ["Low", "Low", "Low", "Low", "Low", "Low"],
  },
  {
    name: "medium",
    label: "T3 Code #16782",
    level: "Medium",
    reasons: [
      {
        text: "Agents now see snooze state",
        chapter: "snooze-rule",
        at: { path: "apps/server/src/orchestration-v2/ThreadSettlementService.ts", line: 187 },
      },
      {
        text: "Every thread tool returns",
        chapter: "thread-tools",
        at: { path: "packages/contracts/src/orchestratorMcp.ts", line: 321 },
      },
    ],
    signals: [
      {
        chip: "Look closely: 5 files",
        popup: "Look closely",
        files: [
          "apps/server/src/mcp/OrchestratorMcpService.ts",
          "apps/server/src/mcp/toolkits/orchestrator/tools.ts",
          "apps/server/src/mcp/toolkits/project/handlers.ts",
          "apps/server/src/mcp/toolkits/project/tools.ts",
          "packages/contracts/src/orchestratorMcp.ts",
        ],
      },
    ],
    chapters: ["Low", "Medium", "Medium", "Low", "Low", "Low", "Low", "Not reviewed"],
  },
  {
    name: "high",
    label: "gh-stack #91",
    level: "High",
    reasons: [
      {
        text: "Scripts that pass --adopt",
        chapter: "init-flow",
        at: { path: "cmd/init.go", line: 120 },
      },
      {
        text: "Each new branch now starts",
        chapter: "init-flow",
        at: { path: "cmd/init.go", line: 317 },
      },
      { text: "Most init tests are rewritten", chapter: "tests", at: null },
    ],
    signals: [
      {
        chip: "Look closely: 2 files",
        popup: "Look closely",
        files: ["cmd/init.go", "cmd/init_test.go"],
      },
      { chip: "Large: 1,193 lines", popup: null, files: [] },
    ],
    chapters: ["High", "Low", "Medium"],
  },
] as const;

test("the DEV guide says how carefully to read, and every reason opens its evidence", async ({
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
  const unexpectedErrors = await watchErrors(browser);
  const openLine = lineOpener(screen, browser);
  const focused = () =>
    browser.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      return { chapter: active.dataset.chapterId ?? null, file: active.dataset.path ?? null };
    });
  const riskTags = (scope: string) => browser.locator(`${scope} [data-risk-tag]`).allTextContents();

  await browser.setViewport({ width: 1440, height: 900 });
  const url = new URL("/dev/guide/vercel-ai-22182", devUrl);
  url.search = new URL(devUrl).search;
  await app.open(url.href);
  const picker = screen.getByRole("combobox", "Guide fixture");
  const risk = screen.getByRole("region", "Risk");

  for (const fixture of riskFixtures) {
    await choose(screen, picker, fixture.label);
    await expect(risk).toBeVisible();
    await expect(risk.getByText(`Risk: ${fixture.level}`)).toBeVisible();
    await expect(risk.getByRole("listitem")).toHaveCount(fixture.reasons.length);
    for (const reason of fixture.reasons) {
      const row = risk.getByRole("listitem").filter({ hasText: reason.text });
      await risk.scrollIntoView();
      await row.getByRole("button", /^Open chapter \d+: /).tap();
      await expect.poll(focused).toEqual({ chapter: reason.chapter, file: null });
      if (reason.at === null) continue;
      await risk.scrollIntoView();
      const opened = await openLine(reason.at.path, reason.at.line);
      expect(opened.late).toMatchObject({ open: true, focused: true, selected: [reason.at.line] });
    }
    if (fixture.signals.length === 0)
      await expect(risk.getByText("None of prkit's checks fired.")).toBeVisible();
    for (const signal of fixture.signals) {
      await expect(risk.getByText(signal.chip)).toBeVisible();
      if (signal.popup === null) continue;
      for (const file of signal.files) {
        await risk.scrollIntoView();
        await risk.getByRole("button", signal.chip).tap();
        const popup = screen.getByRole("dialog", signal.popup);
        await expect(popup.getByRole("button", /^Open /)).toHaveCount(signal.files.length);
        if (fixture.name === "medium" && file === signal.files[0]) {
          await expect(popup.getByText("apps/server/src/mcp/ (Repository)")).toBeVisible();
          await app.screenshot("risk-medium-popover");
        }
        await popup.getByRole("button", `Open ${file}`).tap();
        await expect(popup).toBeHidden();
        await expect.poll(focused).toEqual({ chapter: null, file });
      }
    }
    await risk.scrollIntoView();
    await screenshotLightAndDark(app, browser, `risk-${fixture.name}-overview`);
    const words = fixture.chapters.map((word) => `Risk: ${word}`);
    await expect.poll(() => riskTags("[data-roadmap-row]")).toEqual(words);
    await expect.poll(() => riskTags("[data-chapter-meta]")).toEqual(words);
    expect(await unexpectedErrors()).toEqual([]);
  }

  await choose(screen, picker, "T3 Code #16782");
  await browser.locator("[data-roadmap-row]").last().scrollIntoView();
  await expect(
    browser.locator("[data-roadmap-row]").last().getByText("Risk: Not reviewed"),
  ).toBeVisible();
  await screenshotLightAndDark(app, browser, "risk-medium-roadmap");

  await choose(screen, picker, "gh-stack #91");
  const reasons = browser.locator('[data-chapter-id="init-flow"] [data-chapter-risk-reasons]');
  await reasons.scrollIntoView();
  await expect(reasons.getByRole("listitem")).toHaveCount(2);
  await screenshotLightAndDark(app, browser, "risk-high-chapter");
  const chapterLine = await openLine("cmd/init.go", 282);
  expect(chapterLine.late).toMatchObject({ open: true, focused: true, selected: [282] });
  const testsChapter = browser.locator('[data-chapter-id="tests"]');
  await testsChapter.scrollIntoView();
  await testsChapter.getByRole("button", "Open cmd/init_test.go").tap();
  await expect.poll(focused).toEqual({ chapter: null, file: "cmd/init_test.go" });

  await browser.setViewport({ width: 640, height: 900 });
  await risk.scrollIntoView();
  await expect(risk.getByText("Risk: High")).toBeVisible();
  await expect(risk.getByText("Large: 1,193 lines")).toBeVisible();
  await app.screenshot("risk-high-640");
  await screen.getByRole("heading", /^Chapters/).scrollIntoView();
  await expect(browser.locator("[data-roadmap-row] [data-risk-tag]").first()).toBeVisible();
  await expect(browser.locator("[data-roadmap-row] [data-kind-tag]").first()).toBeHidden();
  await app.screenshot("risk-high-640-roadmap");
  await browser.setViewport({ width: 1440, height: 900 });

  for (const label of [
    "Vercel AI #22182",
    "gh-stack #91, behavior diff",
    "Vercel AI #22182, stored before behavior diffs",
  ]) {
    await choose(screen, picker, label);
    await expect(screen.getByRole("heading", "Overview")).toBeVisible();
    await expect(risk).toHaveCount(0);
    await expect(browser.locator("[data-risk-tag]")).toHaveCount(0);
    await expect(browser.locator("[data-roadmap-risk]")).toHaveCount(0);
  }
  await app.screenshot("risk-stored-none");
  expect(await unexpectedErrors()).toEqual([]);
});
