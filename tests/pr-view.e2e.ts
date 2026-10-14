import { test } from "@e2e-dev/web";
import * as NodeFS from "node:fs";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { FIXTURE_NAME, NEEDS_FIXTURE, prPath } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { prScrolls } from "./prScrolls.ts";

/** A public, merged PR with a bot review, line threads and checks, read through the fixture's account. */
const LARGE_PR = { repository: "pingdotgg/t3code", number: 16782 };
const LARGE_PR_TITLE = "feat(server,web,mobile): agents see snooze state and link to threads";

/**
 * Check rows whose status icon, name, link icon or status label leave the row's first line,
 * or whose status icon does not start at the container's heading edge.
 */
const misalignedChecks = (selector: string) => {
  const container = document.querySelector(selector);
  const edge = container?.querySelector("h2")?.getBoundingClientRect().left ?? Number.NaN;
  const middle = (node: Element | null | undefined) => {
    const rect = node?.getBoundingClientRect();
    return rect ? rect.top + rect.height / 2 : Number.NaN;
  };
  return [...(container?.querySelectorAll("li") ?? [])].flatMap((row) => {
    const [status, link] = row.querySelectorAll("svg");
    const name = row.querySelector("a > span, span.flex-1");
    const line = (name?.getBoundingClientRect().top ?? Number.NaN) + 10;
    const off = [middle(status), middle(link ?? status), middle(row.lastElementChild)].some(
      (y) => !(Math.abs(y - line) <= 1),
    );
    const left = status?.getBoundingClientRect().left ?? Number.NaN;
    return off || !(Math.abs(left - edge) <= 1) ? [row.textContent ?? ""] : [];
  });
};

test(
  "Conversation merges comments, reviews, commits and state events, with checks aligned",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    await app.open(run.openUrl);
    // A link from before Conversation existed still opens the PR, on Conversation.
    await app.open(`${run.url}${prPath(LARGE_PR.repository, LARGE_PR.number, "summary")}`);
    const tabs = screen.getByRole("navigation", "Pull request tabs");
    await expect(tabs).toBeVisible({ timeout: 45_000 });
    await expect(tabs.getByRole("link", "Conversation")).toHaveAttribute("aria-current", "page");
    // Fixes shows only once something went to the agent.
    await expect(tabs.getByRole("link")).toHaveText(["Conversation", "Files", "Guide"]);
    await tabs.getByRole("button", /^Open checks:/).tap();
    const checks = screen.getByRole("dialog", "Checks");
    await expect(checks).toContainText("Checks");
    expect(await browser.evaluate(misalignedChecks, '[role="dialog"]')).toEqual([]);
    await app.screenshot("checks-popover");
    await browser.keyboard.press("Escape");
    await expect(checks).toHaveCount(0);
    await tabs.getByRole("link", "Files").tap();
    await expect(browser.locator("[data-file-diff-card]").first()).toHaveAttribute(
      "data-path",
      "apps/server/src/mcp/toolkits/orchestrator/tools.ts",
      { timeout: 45_000 },
    );
    await app.screenshot("files-reading-order");
    await screen
      .getByRole("navigation", "Changed files")
      .getByRole("button", /^handlers.ts/)
      .tap();
    await expect
      .poll(() =>
        browser.evaluate(() => {
          const header = document
            .querySelector(
              '[data-path="apps/server/src/mcp/toolkits/project/handlers.ts"] [data-file-diff-header]',
            )
            ?.getBoundingClientRect();
          const pinned = document.querySelector("[data-collapse-pinned]")?.getBoundingClientRect();
          return header !== undefined && pinned !== undefined && header.top >= pinned.bottom - 1;
        }),
      )
      .toBe(true);
    await app.screenshot("file-tree-selection");
    await tabs.getByRole("link", "Conversation").tap();
    await expect(screen.getByRole("region", "Description")).toBeVisible();
    const activity = (selector: string) =>
      browser.locator(`section[aria-label="Activity"] ${selector}`);
    const commits = activity('[data-timeline-kind="commit"]');
    await expect(commits).toHaveCount(4, { timeout: 45_000 });
    await expect(commits.first()).toContainText(
      "fix(shared): thread links escape parentheses in ids",
    );
    await expect(activity('[data-timeline-kind="merged"]')).toContainText(
      "merged this pull request",
    );
    // Comments read in full on the rail; nothing hides behind a collapsed group.
    await expect(activity("details")).toHaveCount(0);
    // The header names the repository once, and checks come after the activity.
    expect(
      await browser.evaluate(() => {
        const header = document.querySelector("[data-pr-expanded-header]")?.textContent ?? "";
        const activity = document.querySelector('section[aria-label="Activity"]');
        const checks = document.querySelector('section[aria-label="Checks"]');
        return {
          repositoryNamed: header.split("pingdotgg/t3code").length - 1,
          checksAfterActivity:
            activity !== null &&
            checks !== null &&
            (activity.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        };
      }),
    ).toEqual({ repositoryNamed: 1, checksAfterActivity: true });
    await expect(activity('article[data-timeline-kind="review"]').first()).toContainText(
      "Commented",
    );
    await app.screenshot("conversation-newest-first");
    await screen.getByRole("button", "Newest first").tap();
    await expect(activity("ol > li").first()).toContainText(LARGE_PR_TITLE);
    await app.screenshot("conversation-oldest-first");
    await screen.getByRole("button", "Oldest first").tap();
    await browser.locator('section[aria-label="Checks"] summary').tap();
    await browser.locator('section[aria-label="Checks"]').scrollIntoView();
    expect(await browser.evaluate(misalignedChecks, 'section[aria-label="Checks"]')).toEqual([]);
    await app.screenshot("conversation-checks");
    await screen.getByRole("button", "Close pingdotgg/t3code #16782").tap();
  },
);

test(
  "Files renders five patches and loads unchanged lines on expansion",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    await app.open(run.openUrl);
    await screen.getByRole("link", "Inbox").tap();
    await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
    const fixture = screen
      .getByRole("region", "Yours")
      .getByRole("link", /#1 Validate links and count clicks/);
    await expect(fixture).toBeVisible({ timeout: 45_000 });
    await fixture.tap();
    const tabs = screen.getByRole("navigation", "Pull request tabs");
    await expect(tabs).toBeVisible({ timeout: 45_000 });
    await tabs.getByRole("link", "Files").tap();
    const files = browser.locator("[data-file-diff-card]");
    await expect(files).toHaveCount(5, { timeout: 45_000 });
    for (const path of [
      "src/server.js",
      "src/shorten.js",
      "src/store.js",
      "src/validate.js",
      "test/validate.test.js",
    ]) {
      const file = screen.getByRole("region", path);
      await file.scrollIntoView();
      await expect(
        browser.locator(`[data-path="${path}"] diffs-container pre`).first(),
      ).toBeVisible();
    }
    const server = screen.getByRole("region", "src/server.js");
    await server.scrollIntoView();
    const code = browser.locator('[data-path="src/server.js"] diffs-container pre').first();
    await expect(code).toContainText("8 unmodified lines");
    await expect(code).not.toContainText('import { createServer } from "node:http"');
    await app.screenshot("files-patch-first");
    await browser.locator('[data-path="src/server.js"] [data-unmodified-lines]').first().tap();
    await expect(code).toContainText('import { createServer } from "node:http"', {
      timeout: 45_000,
    });
    await app.screenshot("files-expanded");
    await screen.getByRole("button", "Split").tap();
    await expect(screen.getByRole("button", "Split")).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", "Wrap").tap();
    await expect(screen.getByRole("button", "Wrap")).toHaveAttribute("aria-pressed", "true");
    await screen.getByRole("button", "Unified").tap();
    await screen.getByRole("button", "Hide file tree").tap();
    await expect(browser.locator("[data-file-tree]")).toHaveCount(0);
    await screen.getByRole("button", "Show file tree").tap();
    await expect(browser.locator("[data-file-tree]")).toBeVisible();
    await app.screenshot("files-preferences");
    const open = screen.getByRole("navigation", "Workspace tabs").getByRole("button");
    while ((await open.count()) > 0) await open.first().tap();
    await screen.getByRole("link", "Inbox").tap();
  },
);

test(
  "Conversation shows one repo heading, a bot's review threads with their code, and checks last",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    await app.open(run.openUrl);
    await app.open(`${run.url}${prPath(LARGE_PR.repository, LARGE_PR.number, "conversation")}`);
    const main = screen.getByRole("main");
    await expect(main.getByRole("heading", "pingdotgg/t3code #16782")).toHaveCount(1, {
      timeout: 45_000,
    });
    // The repository heading is the one link to GitHub.
    await expect(main.getByRole("link", "pingdotgg/t3code #16782")).toHaveAttribute(
      "href",
      "https://github.com/pingdotgg/t3code/pull/16782",
    );
    await expect(main.getByRole("link", "Open on GitHub")).toHaveCount(0);
    await app.screenshot("repo-header");
    const conversation = screen.getByRole("region", "Activity");
    await conversation.scrollIntoView();
    await expect(
      conversation.getByRole("article", "Review by macroscopeapp[bot]").first(),
    ).toBeVisible();
    // The bot's line comments sit in their review threads, with the code they are on.
    await expect(
      conversation.getByRole("article", /^Thread by macroscopeapp\[bot\] on /).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(conversation.getByRole("button", /bot comments/)).toHaveCount(0);
    await expect(browser.locator('section[aria-label="Activity"] details')).toHaveCount(0);
    await app.screenshot("bot-conversation");
    const checks = screen.getByRole("region", "Checks");
    await checks.scrollIntoView();
    await expect(browser.locator("[data-pr-conversation] > section").last()).toHaveAttribute(
      "aria-label",
      "Checks",
    );
    await app.screenshot("checks-last");
    await screen.getByRole("button", "Close pingdotgg/t3code #16782").tap();
  },
);

test(
  "the PR title scrolls away into a compact header with pinned tabs",
  { skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const run = runForUrl(app.baseUrl);
    await app.open(run.openUrl);
    await app.open(`${run.url}${prPath(LARGE_PR.repository, LARGE_PR.number, "conversation")}`);
    const pinned = browser.locator("[data-collapse-pinned]");
    await expect(pinned).toHaveAttribute("data-collapsed", "false", { timeout: 45_000 });
    await expect(screen.getByRole("heading", LARGE_PR_TITLE)).toBeVisible();
    await browser.evaluate(async () => {
      await document.fonts.ready;
      return true;
    });
    await app.screenshot("header-expanded");
    await browser.evaluate(() => {
      const started = performance.now();
      const tasks: Array<{ startTime: number; duration: number }> = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (entry.startTime >= started)
            tasks.push({ startTime: entry.startTime, duration: entry.duration });
        document.documentElement.dataset.headerLongTasks = JSON.stringify(tasks);
      });
      observer.observe({ type: "longtask" });
      document.documentElement.dataset.headerLongTasks = "[]";
      document.addEventListener("header-scroll-finished", () => observer.disconnect(), {
        once: true,
      });
      return true;
    });
    await browser.locator("[data-pr-scroll]").hover();
    await browser.mouse.wheel(0, 450);
    await expect(pinned).toHaveAttribute("data-collapsed", "true");
    await expect(browser.locator('[data-pr-compact-header][aria-hidden="false"]')).toBeVisible();
    await expect(screen.getByRole("navigation", "Pull request tabs")).toBeVisible();
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            getComputedStyle(document.querySelector("[data-collapse-motion]") ?? document.body)
              .transform,
        ),
      )
      .toBe("matrix(1, 0, 0, 1, 0, 0)");
    const top = await browser.evaluate(
      () =>
        document.querySelector('[aria-label="Pull request tabs"]')?.getBoundingClientRect().top ??
        -1,
    );
    await app.screenshot("header-compact");
    await browser.mouse.wheel(0, 400);
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            document.querySelector('[aria-label="Pull request tabs"]')?.getBoundingClientRect()
              .top ?? -1,
        ),
      )
      .toBe(top);
    await browser.mouse.wheel(0, -1800);
    await expect(pinned).toHaveAttribute("data-collapsed", "false");
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            getComputedStyle(document.querySelector("[data-collapse-motion]") ?? document.body)
              .transform,
        ),
      )
      .toBe("matrix(1, 0, 0, 1, 0, -4)");
    await app.screenshot("header-expanded-again");
    const tasks = await browser.evaluate(() => {
      document.dispatchEvent(new Event("header-scroll-finished"));
      return document.documentElement.dataset.headerLongTasks ?? "missing";
    });
    expect(tasks).toBe("[]");
    NodeFS.mkdirSync(".e2e/evidence/polish", { recursive: true });
    NodeFS.writeFileSync(".e2e/evidence/polish/header-scroll-e2e-long-tasks.json", tasks);
    await screen.getByRole("button", "Close pingdotgg/t3code #16782").tap();
  },
);

test("the PR tab row holds icon-only controls: Refresh spins only while it reads, Files' toggles show only on Files, and a stack's guide setup fits", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("pr-tab-row");
  const claude = setUpFakeClaude("pr-tab-row");
  try {
    const run = startFakeInstance("pr-tab-row", fake, ["--claude", claude.file]);
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);
    await screen.getByRole("link", /#2 Budget fixture 2/).tap({ timeout: 20_000 });
    await expect(screen.getByRole("heading", "Budget fixture 2")).toBeVisible({ timeout: 20_000 });
    const tabs = screen.getByRole("navigation", "Pull request tabs");

    const refresh = tabs.getByRole("button", "Refresh");
    const refreshSpin = () =>
      browser.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('[aria-label="Pull request tabs"] [aria-label="Refresh"] svg') ??
              document.body,
          ).animationName,
      );
    await expect(refresh).toHaveText("");
    const tooltip = browser.locator('[data-slot="tooltip-popup"]');
    await refresh.hover();
    await expect(tooltip).toHaveText("Refresh");
    expect(await refreshSpin()).toBe("none");
    await screenshotLightAndDark(app, browser, "pr-refresh-idle");
    await fake.latency(5000);
    await refresh.tap();
    await expect(refresh).toBeDisabled();
    expect(await refreshSpin()).toBe("spin");
    await screenshotLightAndDark(app, browser, "pr-refresh-reading");
    await expect(refresh).toBeEnabled({ timeout: 30_000 });
    expect(await refreshSpin()).toBe("none");
    await fake.latency(0);

    const fileControls = ["Unified", "Split", "Wrap", "Hide file tree"];
    for (const name of fileControls) await expect(tabs.getByRole("button", name)).toHaveCount(0);
    await tabs.getByRole("link", "Files").tap();
    await expect(browser.locator("[data-file-diff-card]")).toHaveCount(1, { timeout: 20_000 });
    for (const name of fileControls) {
      const button = tabs.getByRole("button", name);
      await expect(button).toHaveText("");
      await button.hover();
      await expect(tooltip).toHaveText(name);
    }
    await expect(browser.locator("[data-pr-files]").getByText(/\d+ files?\b/)).toHaveCount(0);
    await screenshotLightAndDark(app, browser, "pr-files-tab-row");
    await tabs.getByRole("link", "Conversation").tap();
    for (const name of fileControls) await expect(tabs.getByRole("button", name)).toHaveCount(0);

    await tabs.getByRole("link", "Guide").tap();
    const scope = screen.getByRole("radiogroup", "Write guides for");
    await expect(scope).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("button", /^Agent and model: /)).toBeVisible({ timeout: 30_000 });
    expect(await prScrolls(browser)).toEqual({ page: false, view: false });
    await scope.getByRole("radio", "Choose layers").tap();
    await expect(screen.getByRole("group", "Layers to write guides for")).toBeVisible();
    expect(await prScrolls(browser)).toEqual({ page: false, view: false });
    await screenshotLightAndDark(app, browser, "guide-stack-scope");
  } finally {
    stopFakeInstance("pr-tab-row", { keepHome: false });
    fake.stop();
  }
});

test("Conversation shows a pull request's comments in full, and a new one after Refresh", async ({
  app,
  screen,
}) => {
  const fake = await startFakeGitHub("pr-comments");
  try {
    const run = startFakeInstance("pr-comments", fake);
    await app.open(run.openUrl);
    await screen.getByRole("link", /#3 Budget fixture 3/).tap({ timeout: 20_000 });
    const activity = screen.getByRole("region", "Activity");
    const comments = activity.getByRole("article", "Comment by budget-test");
    await expect(comments).toHaveCount(1, { timeout: 20_000 });
    await expect(comments.first()).toContainText("First comment on 3");
    await app.screenshot("pr-comment");

    await fake.comment(3);
    await screen.getByRole("navigation", "Pull request tabs").getByRole("button", "Refresh").tap();
    await expect(comments).toHaveCount(2, { timeout: 20_000 });
    await expect(activity).toContainText(/Comment \d+ from the fake/);
    await app.screenshot("pr-comment-after-refresh");
  } finally {
    stopFakeInstance("pr-comments", { keepHome: false });
    fake.stop();
  }
});
