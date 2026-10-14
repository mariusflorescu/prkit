import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { FIXTURE_LOGIN, FIXTURE_REPO, NEEDS_FIXTURE, prPath, readRows } from "./fixturePr.ts";
import {
  closeReviewFixture,
  createReviewFixture,
  headSha,
  LIMITS_PATH,
  postedComments,
  pushOutdatingChange,
  reviewStates,
  threadStates,
} from "./reviewFixture.ts";

test(
  "review comments: drafts persist, post as one review, and outdated drafts stay drafts",
  { timeout: 420_000, skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const fixture = createReviewFixture(`${Date.now()}`);
    try {
      const run = runForUrl(app.baseUrl);
      const drafts = () =>
        readRows(
          run.home,
          `SELECT end_line AS line, state FROM pending_comments WHERE pr_key = 'github.com/${FIXTURE_REPO}#${fixture.number}' ORDER BY created_at`,
        );
      const prUrl = `${run.url}${prPath(FIXTURE_REPO, fixture.number, "files")}`;
      const line = (number: number) =>
        browser.locator(`[data-path="${LIMITS_PATH}"] [data-column-number="${number}"]`);
      const gutterButton = browser.locator(`[data-path="${LIMITS_PATH}"] [data-utility-button]`);
      const hoverLine = async (number: number) => {
        // The diff re-renders once highlighted, which can drop an early hover.
        await expect
          .poll(
            async () => {
              await line(number === 1 ? 2 : 1).hover();
              await line(number).hover();
              return gutterButton.count();
            },
            { timeout: 30_000 },
          )
          .toBe(1);
      };
      const commentOn = async (number: number, body: string) => {
        await hoverLine(number);
        await gutterButton.tap();
        await screen.getByRole("textbox", `Comment on line ${number}`).fill(body);
        await screen.getByRole("textbox", `Comment on line ${number}`).press("Meta+Enter");
        await expect(
          screen.getByRole("article", `Pending comment on ${LIMITS_PATH} line ${number}`),
        ).toBeVisible();
      };
      const finishReview = async (pending: number) => {
        await screen.getByRole("button", `Review, ${pending} pending`).first().tap();
        await expect(screen.getByRole("dialog", "Finish your review")).toBeVisible();
      };
      const reviewPosted = async (review: string) => {
        await expect(screen.getByRole("dialog", "Finish your review")).toBeHidden({
          timeout: 30_000,
        });
        await expect(screen.getByRole("button", review).first()).toBeVisible();
      };
      // A toast lasts five seconds, and a loaded machine can keep e2e from reading the
      // screen for longer. So the page records each toast, and the Review button's label
      // in the render that closes its popover, as they happen.
      const recordOutcomes = () =>
        browser.evaluate(() => {
          const toasts = new Map<Element, string>();
          const closedAs = new Array<string>();
          const textOf = (id: string | null) =>
            (id === null ? null : document.getElementById(id))?.textContent ?? "";
          new MutationObserver((records) => {
            for (const record of records) {
              const label = record.target instanceof Element ? record.target.ariaLabel : null;
              if (record.oldValue === "true" && label?.startsWith("Review")) closedAs.push(label);
            }
            for (const toast of document.querySelectorAll(
              '[aria-label="Notifications"] [role="dialog"]',
            ))
              toasts.set(
                toast,
                `${textOf(toast.getAttribute("aria-labelledby"))} | ${textOf(toast.getAttribute("aria-describedby"))}`,
              );
            sessionStorage.setItem(
              "e2e:review-outcomes",
              JSON.stringify({ toasts: [...toasts.values()], closedAs }),
            );
          }).observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributeFilter: ["aria-expanded"],
            attributeOldValue: true,
          });
          return null;
        });
      const outcomes = () =>
        browser.evaluate(() => JSON.parse(sessionStorage.getItem("e2e:review-outcomes") ?? "{}"));

      await app.open(run.openUrl);
      await app.open(prUrl);
      await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });

      await commentOn(3, "Is 16 enough for custom codes?");
      await line(15).dragTo(line(17));
      await screen
        .getByRole("textbox", "Comment on lines 15 to 17")
        .fill("checkCode reads the length twice.");
      await screen.getByRole("button", "Add review comment").tap();
      await expect(
        screen.getByRole("article", `Pending comment on ${LIMITS_PATH} lines 15 to 17`),
      ).toBeVisible();
      await app.screenshot("two-drafts");

      await app.open(prUrl);
      await expect(screen.getByRole("button", "Review, 2 pending").first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        screen.getByRole("article", `Pending comment on ${LIMITS_PATH} lines 15 to 17`),
      ).toBeVisible();
      expect(drafts()).toEqual([
        { line: 3, state: "draft" },
        { line: 17, state: "draft" },
      ]);

      await finishReview(2);
      // The fixture PR is the account's own, so GitHub only takes a comment on it.
      await expect(screen.getByRole("radio", "Approve")).toBeDisabled();
      await expect(screen.getByRole("radio", "Request changes")).toBeDisabled();
      await screen.getByRole("textbox", "Review summary").fill("Two questions inline.");
      await app.screenshot("finish-your-review");
      await recordOutcomes();
      await screen.getByRole("button", "Submit review").tap();
      await reviewPosted("Review");
      expect(await outcomes()).toEqual({
        toasts: ["Review submitted | 2 comments posted on GitHub."],
        closedAs: ["Review"],
      });
      await screen.getByRole("button", "Review").first().tap();
      await expect(screen.getByRole("dialog", "Finish your review")).toContainText(
        "No pending comments.",
      );
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("dialog", "Finish your review")).toBeHidden();
      const thread = screen.getByRole(
        "article",
        `Thread by ${FIXTURE_LOGIN} on ${LIMITS_PATH} line 3`,
      );
      await expect(thread).toBeVisible({ timeout: 30_000 });
      expect(reviewStates(fixture.number)).toEqual(["COMMENTED Two questions inline."]);
      expect(postedComments(fixture.number).toSorted()).toEqual([
        `${LIMITS_PATH}:15-17:RIGHT checkCode reads the length twice.`,
        `${LIMITS_PATH}:3-3:RIGHT Is 16 enough for custom codes?`,
      ]);
      expect(drafts()).toEqual([
        { line: 3, state: "published" },
        { line: 17, state: "published" },
      ]);

      await thread.getByRole("button", "Reply").tap();
      await thread.getByRole("textbox", `Reply to ${FIXTURE_LOGIN}`).fill("It matches the table.");
      // A line under a resting pointer keeps its comment button while the reply and the
      // resolve land.
      await hoverLine(1);
      await thread.getByRole("textbox", `Reply to ${FIXTURE_LOGIN}`).press("Meta+Enter");
      await expect(thread).toContainText("It matches the table.", { timeout: 30_000 });
      await expect(gutterButton).toHaveCount(1);
      await thread.getByRole("button", "Resolve conversation").tap();
      await hoverLine(1);
      await expect(thread).toContainText("Resolved · 2 comments", { timeout: 30_000 });
      await expect(gutterButton).toHaveCount(1);
      await app.screenshot("replied-and-resolved");
      expect(threadStates(fixture.number).toSorted()).toEqual([
        `${LIMITS_PATH}:17 resolved=false comments=1`,
        `${LIMITS_PATH}:3 resolved=true comments=2`,
      ]);

      await commentOn(7, "Should exactly 2048 characters pass?");
      await commentOn(9, "A regex over the scheme would read better.");
      const before = headSha(fixture.number);
      pushOutdatingChange(fixture.branch);
      await expect
        .poll(() => headSha(fixture.number), { timeout: 60_000, interval: 2_000 })
        .not.toBe(before);
      // This window still shows the old head; the server checks the new one before posting.
      await finishReview(2);
      await screen.getByRole("button", "Submit review").tap();
      await expect(screen.getByRole("dialog", "Finish your review")).toContainText(
        "Every draft is on lines that changed",
        { timeout: 30_000 },
      );
      await app.screenshot("submit-refused-on-moved-head");
      expect(drafts().slice(2)).toEqual([
        { line: 7, state: "draft" },
        { line: 9, state: "draft" },
      ]);
      await browser.keyboard.press("Escape");

      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("button", "Refresh")
        .tap();
      const outdated = screen.getByRole("region", `Outdated comments on ${LIMITS_PATH}`);
      await expect(outdated).toBeVisible({ timeout: 60_000 });
      await expect(outdated).toContainText("for (const scheme of BLOCKED_SCHEMES)");
      await expect(thread).toBeVisible();
      await app.screenshot("outdated-drafts");
      await outdated.getByRole("button", "Move to line 10").tap();
      await expect(
        screen.getByRole("article", `Pending comment on ${LIMITS_PATH} line 10`),
      ).toBeVisible();
      await finishReview(2);
      await screen.getByRole("button", "Submit review").tap();
      await reviewPosted("Review, 1 pending");
      expect(postedComments(fixture.number)).toContain(
        `${LIMITS_PATH}:10-10:RIGHT A regex over the scheme would read better.`,
      );
      expect(drafts().slice(2)).toEqual([
        { line: 7, state: "draft" },
        { line: 10, state: "published" },
      ]);
      expect(await outcomes()).toEqual({
        toasts: [
          "Review submitted | 2 comments posted on GitHub.",
          "Review submitted | 1 comment posted on GitHub. 1 outdated draft stays in prkit.",
        ],
        closedAs: ["Review", "Review", "Review, 2 pending", "Review, 1 pending"],
      });
      await app.screenshot("moved-draft-posted");
      await outdated
        .getByRole("article", `Pending comment on ${LIMITS_PATH} line 7`)
        .getByRole("button", "Delete pending comment")
        .tap();
      await expect(outdated).toBeHidden();
      await expect(screen.getByRole("button", "Review").first()).toBeVisible();
    } finally {
      closeReviewFixture(fixture);
    }
  },
);

test(
  "review comments: a refused review says so at once, while GitHub's other reads are slow",
  { timeout: 180_000 },
  async ({ app, screen }) => {
    const fake = await startFakeGitHub("review-refused");
    try {
      const run = startFakeInstance("review-refused", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/7?account=github.com%2Fbudget-test&tab=conversation`,
      );
      await expect(screen.getByRole("heading", "Budget fixture 7 from a fork")).toBeVisible({
        timeout: 30_000,
      });
      // REST is out of budget, so the submission fails on its first read; the GraphQL
      // reads that follow a failure outlast GitHub's 30 second timeout.
      await fake.limit("core", 600);
      await fake.latency(60_000, "graphql");
      await screen.getByRole("button", "Review").first().tap();
      await screen.getByRole("radio", "Approve").check();
      await screen.getByRole("button", "Approve").tap();
      await expect(screen.getByRole("dialog", "Finish your review").getByRole("alert")).toHaveText(
        /^GitHub's limit for budget-test is used up until .+\. Your drafts are still here\.$/,
        { timeout: 15_000 },
      );
      await app.screenshot("review-refused-at-once");
    } finally {
      stopFakeInstance("review-refused", { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "review comments: line numbers take comments from the keyboard",
  { timeout: 180_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub("review-keyboard");
    try {
      // A 5-second watcher tick, so a push reaches the open tab without a click.
      const run = startFakeInstance("review-keyboard", fake, ["--e2e", "--watch-interval", "5000"]);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`,
      );
      const file = screen.getByRole("region", "src/limits.ts");
      const line = (name: string) => file.getByRole("button", name);
      await expect(line("Comment on line 1")).toBeVisible({ timeout: 30_000 });
      await file.getByRole("button", "src/limits.ts").focus();
      await browser.keyboard.press("Tab");
      await expect(line("Comment on line 1")).toBeFocused();
      expect(
        await browser.evaluate(() => {
          const cell = document.activeElement?.shadowRoot?.activeElement;
          if (!(cell instanceof HTMLElement)) return null;
          const style = getComputedStyle(cell);
          return `${style.outlineStyle} ${style.outlineWidth}`;
        }),
      ).toBe("solid 2px");
      await app.screenshot("line-number-focused");

      await browser.keyboard.press("ArrowDown");
      await expect(line("Comment on old line 2")).toBeFocused();
      await browser.keyboard.press("ArrowDown");
      await expect(line("Comment on line 2")).toBeFocused();
      await browser.keyboard.press("Enter");
      const composer = screen.getByRole("textbox", "Comment on line 2");
      await expect(composer).toBeFocused();
      await browser.keyboard.type("Why double it?");
      await browser.keyboard.press("Meta+Enter");
      await expect(
        screen.getByRole("article", "Pending comment on src/limits.ts line 2"),
      ).toBeVisible();
      await expect(line("Comment on line 2")).toBeFocused();

      await browser.keyboard.press("ArrowDown");
      await browser.keyboard.press("Shift+ArrowDown");
      await expect(line("Comment on line 4")).toBeFocused();
      await app.screenshot("line-range-from-keyboard");
      await browser.keyboard.press(" ");
      await expect(screen.getByRole("textbox", "Comment on lines 3 to 4")).toBeFocused();
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("textbox", "Comment on lines 3 to 4")).toBeHidden();
      await expect(line("Comment on line 4")).toBeFocused();

      // Split: each side's line numbers are a tab stop, which keeps the line focused last.
      await screen.getByRole("button", "Split").tap();
      await expect(line("Comment on old line 1")).toBeVisible();
      await file.getByRole("button", "src/limits.ts").focus();
      await browser.keyboard.press("Tab");
      await expect(line("Comment on old line 1")).toBeFocused();
      await browser.keyboard.press("ArrowDown");
      await expect(line("Comment on old line 2")).toBeFocused();
      await browser.keyboard.press("Tab");
      await expect(line("Comment on line 4")).toBeFocused();
      await browser.keyboard.press("Home");
      await expect(line("Comment on line 1")).toBeFocused();
      await browser.keyboard.press("End");
      await expect(line("Comment on line 7")).toBeFocused();

      // A push redraws the diff under the focused line, and focus stays on it.
      const filesRead = async () => (await fake.stats()).byKind["rest:files"] ?? 0;
      const before = await filesRead();
      await fake.push(9);
      await expect.poll(filesRead, { timeout: 30_000 }).toBeGreaterThan(before);
      await expect(line("Comment on line 7")).toBeFocused();

      // A range picked with Shift ends when focus leaves the line numbers.
      await browser.keyboard.press("Shift+ArrowUp");
      await expect(line("Comment on line 6")).toBeFocused();
      await browser.keyboard.press("Tab");
      await browser.keyboard.press("Shift+Tab");
      await expect(line("Comment on line 6")).toBeFocused();
      await browser.keyboard.press("Enter");
      await expect(screen.getByRole("textbox", "Comment on line 6")).toBeFocused();
      await browser.keyboard.press("Escape");
      await expect(line("Comment on line 6")).toBeFocused();

      // Assistive tech presses the button with a click no pointer made (detail 0).
      expect(
        await browser.evaluate(
          () =>
            document.activeElement?.shadowRoot?.activeElement?.dispatchEvent(
              new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }),
            ) ?? null,
        ),
      ).toBe(true);
      await expect(screen.getByRole("textbox", "Comment on line 6")).toBeFocused();
      await browser.keyboard.press("Escape");
      await expect(line("Comment on line 6")).toBeFocused();

      expect(
        readRows(
          run.home,
          "SELECT start_side, start_line, end_side, end_line, state, body FROM pending_comments WHERE pr_key = 'github.com/budget/fixtures#9'",
        ),
      ).toEqual([
        {
          start_side: "new",
          start_line: 2,
          end_side: "new",
          end_line: 2,
          state: "draft",
          body: "Why double it?",
        },
      ]);
    } finally {
      stopFakeInstance("review-keyboard", { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "review comments: a comment being written survives a new push",
  { timeout: 180_000 },
  async ({ app, screen }) => {
    const fake = await startFakeGitHub("review-push");
    try {
      const run = startFakeInstance("review-push", fake);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
        timeout: 20_000,
      });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files`,
      );
      const file = screen.getByRole("region", "src/limits.ts");
      await file.getByRole("button", "Comment on line 1").tap();
      const composer = screen.getByRole("textbox", "Comment on line 1");
      await composer.fill("Half a thought");
      const filesRead = async () => (await fake.stats()).byKind["rest:files"] ?? 0;
      const before = await filesRead();
      await fake.push(9);
      await screen
        .getByRole("navigation", "Pull request tabs")
        .getByRole("button", "Refresh")
        .tap();
      await expect.poll(filesRead, { timeout: 30_000 }).toBeGreaterThan(before);
      await expect(file.getByRole("button", "Comment on line 1")).toBeVisible();
      await expect(composer).toHaveValue("Half a thought");
      await composer.press("Meta+Enter");
      await expect(
        screen.getByRole("article", "Pending comment on src/limits.ts line 1"),
      ).toBeVisible();
    } finally {
      stopFakeInstance("review-push", { keepHome: false });
      fake.stop();
    }
  },
);
