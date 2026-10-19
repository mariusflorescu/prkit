import { describe, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import {
  FIXTURE_LOGIN,
  FIXTURE_REPO,
  GUIDE_WAIT,
  NEEDS_FIXTURE,
  prPath,
  readRows,
} from "./fixturePr.ts";
import { choose, METHOD_LABELS } from "./pickers.ts";
import { runForUrl } from "../scripts/verify-run.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import {
  actionFixtureBranchExists,
  actionFixtureCommit,
  advanceFixtureBase,
  advanceFixtureHead,
  cleanupActionFixture,
  createActionFixture,
  fixtureAllowsAutoMerge,
  readActionFixture,
  requireBranchUpdates,
  setActionFixtureCheck,
} from "./prActionFixture.ts";

const openFixture = async (
  { app, screen }: Pick<TestFixtures, "app" | "screen">,
  fixture: ReturnType<typeof createActionFixture>,
) => {
  const run = runForUrl(app.baseUrl);
  await app.open(run.openUrl);
  await app.open(`${run.url}${prPath(FIXTURE_REPO, fixture.number, "conversation")}`);
  await expect(screen.getByRole("heading", fixture.title)).toBeVisible({ timeout: 45_000 });
};
const menuAction = async (screen: TestFixtures["screen"], name: string) => {
  await screen.getByRole("button", "More pull request actions").tap();
  await screen.getByRole("menuitem", name).tap();
};
// The app renders the server's mergeStateStatus as the Merge button: visible but disabled while
// GitHub is still working it out, enabled once it is mergeable. Reading the button costs nothing,
// but every Refresh is a real GitHub read, so look every second and refresh once per interval.
// GitHub can take well over a minute to recompute mergeability after Update branch.
const WAIT_BUDGET_MS = 150_000;
const REFRESH_EVERY_MS = 10_000;
const pollWithRefresh = async (
  screen: TestFixtures["screen"],
  what: string,
  ready: () => Promise<boolean>,
) => {
  const started = Date.now();
  let refreshes = 0;
  let lastRefresh = 0;
  await expect
    .poll(
      async () => {
        if (await ready()) return true;
        if (Date.now() - lastRefresh >= REFRESH_EVERY_MS) {
          lastRefresh = Date.now();
          refreshes += 1;
          await screen.getByRole("button", "Refresh").tap();
        }
        return false;
      },
      { timeout: WAIT_BUDGET_MS, interval: 1_000 },
    )
    .toBe(true);
  console.info(
    `[pr-actions] ${what} after ${Math.round((Date.now() - started) / 1000)}s, ${refreshes} refreshes`,
  );
};
const waitForMerge = (screen: TestFixtures["screen"]) =>
  pollWithRefresh(screen, "Merge became available", async () => {
    const merge = screen.getByRole("button", /^Merge \(/);
    return (await merge.isVisible()) && (await merge.isEnabled());
  });

test(
  "PR actions edit metadata, change lifecycle, update and squash merge then revert",
  { timeout: 420_000, skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    requireBranchUpdates();
    const fixture = createActionFixture(
      "squash",
      Array.from(
        { length: 30 },
        (_, index) =>
          `Fixture paragraph ${index + 1}. This disposable pull request proves actions in the compact header.`,
      ).join("\n\n"),
    );
    let revertNumber: number | null = null;
    try {
      await openFixture({ app, screen }, fixture);
      await app.screenshot("actions-expanded");
      await browser.locator("[data-pr-scroll]").hover();
      await browser.mouse.wheel(0, 450);
      await expect(browser.locator('[data-pr-compact-header][aria-hidden="false"]')).toBeVisible();
      await app.screenshot("actions-compact");
      await menuAction(screen, "Convert to draft");
      await expect(screen.getByRole("button", "Ready for review")).toBeVisible({ timeout: 45_000 });
      expect(readActionFixture(fixture.number).draft).toBe(true);
      await app.screenshot("draft-result");
      await browser.locator("[data-pr-scroll]").hover();
      await browser.mouse.wheel(0, -1500);
      await expect(browser.locator("[data-collapse-pinned]")).toHaveAttribute(
        "data-collapsed",
        "false",
      );
      await screen.getByRole("button", "Ready for review").tap();
      await waitForMerge(screen);
      expect(readActionFixture(fixture.number).draft).toBe(false);
      await app.screenshot("ready-result");
      await menuAction(screen, "Close pull request");
      const confirm = screen.getByRole("dialog");
      await expect(confirm.getByRole("button", "Confirm close")).toBeVisible();
      await app.screenshot("close-confirm");
      await confirm.getByRole("button", "Confirm close").tap();
      await expect(screen.getByRole("button", "Reopen")).toBeVisible({ timeout: 45_000 });
      expect(readActionFixture(fixture.number).state).toBe("closed");
      await app.screenshot("close-result");
      await screen.getByRole("button", "Reopen").tap();
      await waitForMerge(screen);
      expect(readActionFixture(fixture.number).state).toBe("open");
      await app.screenshot("reopen-result");
      await screen.getByRole("button", "Edit title and description").tap();
      const edit = screen.getByRole("dialog", "Edit pull request");
      await edit.getByRole("textbox", "Title").fill("");
      await edit.getByRole("button", "Save changes").tap();
      await expect(edit.getByRole("alert")).toContainText("Enter a title");
      await edit.getByRole("textbox", "Title").fill(`${fixture.title} edited`);
      await edit
        .getByRole("textbox", "Description")
        .fill("## Actions work\n\nEdited through prkit with **Markdown**.");
      await edit.getByRole("checkbox", "Preview Markdown").check();
      await app.screenshot("edit-preview");
      await edit.getByRole("button", "Save changes").tap();
      await expect(screen.getByRole("heading", `${fixture.title} edited`)).toBeVisible({
        timeout: 45_000,
      });
      expect(readActionFixture(fixture.number).body).toBe(
        "## Actions work\n\nEdited through prkit with **Markdown**.",
      );
      await app.screenshot("edit-result");
      await screen.getByRole("button", "Edit labels").tap();
      const labels = screen.getByRole("dialog", "Set labels");
      await labels.getByRole("combobox", "Search labels").fill("label-that-does-not-exist");
      await expect(labels.getByRole("status")).toContainText("No matches", { timeout: 45_000 });
      await app.screenshot("labels-empty-search");
      await labels.getByRole("combobox", "Search labels").fill("");
      await labels.getByRole("option", "bug").tap({ timeout: 45_000 });
      await expect(labels.getByRole("option", "bug")).toHaveAttribute("aria-selected", "true");
      await app.screenshot("labels-picker");
      await labels.getByRole("button", "Save labels").tap();
      await expect(screen.getByRole("region", "Labels")).toContainText("bug", { timeout: 45_000 });
      expect(readActionFixture(fixture.number).labels.map((label) => label.name)).toEqual(["bug"]);
      await app.screenshot("labels-result");
      await screen.getByRole("button", "Edit reviewers").tap();
      const reviewers = screen.getByRole("dialog", "Request reviewers");
      await reviewers.getByRole("option", `${FIXTURE_LOGIN} Author`).tap({ timeout: 45_000 });
      await app.screenshot("reviewer-picker");
      await reviewers.getByRole("button", "Request review").tap();
      await expect(reviewers.getByRole("alert")).toContainText(/author|review|request/i, {
        timeout: 45_000,
      });
      await expect(reviewers.getByRole("button", "Retry")).toBeVisible();
      await app.screenshot("reviewer-error");
      await reviewers.getByRole("button", "Cancel").tap();
      advanceFixtureBase(fixture);
      await screen.getByRole("button", "Refresh").tap();
      await expect(screen.getByRole("button", "Update branch")).toBeVisible({ timeout: 45_000 });
      const before = readActionFixture(fixture.number).head.sha;
      await screen.getByRole("button", "Update branch").tap();
      await app.screenshot("update-confirm");
      await confirm.getByRole("button", "Update branch").tap();
      await waitForMerge(screen);
      expect(readActionFixture(fixture.number).head.sha).not.toBe(before);
      await app.screenshot("update-result");
      await screen.getByRole("button", /^Merge \(/).tap();
      await choose(screen, confirm.getByRole("combobox", "Method"), METHOD_LABELS.squash);
      await confirm
        .getByRole("textbox", "Commit title")
        .fill(`Squash PR actions fixture ${fixture.slug}`);
      await confirm
        .getByRole("textbox", "Commit message")
        .fill("Edited merge message through prkit.");
      await confirm.getByRole("checkbox", "Delete branch after merge").check();
      await app.screenshot("squash-confirm");
      await confirm.getByRole("button", "Confirm merge").tap();
      await expect(screen.getByRole("button", "Revert")).toBeVisible({ timeout: 45_000 });
      const merged = readActionFixture(fixture.number);
      expect(merged.merged).toBe(true);
      expect(actionFixtureBranchExists(fixture.branch)).toBe(false);
      if (merged.merge_commit_sha === null) throw new Error("GitHub did not report a merge commit");
      expect(actionFixtureCommit(merged.merge_commit_sha).commit.message).toContain(
        "Edited merge message through prkit.",
      );
      await app.screenshot("merge-result");
      await screen.getByRole("button", "Revert").tap();
      await app.screenshot("revert-confirm");
      await confirm.getByRole("button", "Create revert pull request").tap();
      await expect
        .poll(
          async () =>
            (await browser.url()).includes(`/pr/github.com/${FIXTURE_REPO}/${fixture.number}?`)
              ? ""
              : await browser.url(),
          { timeout: 45_000 },
        )
        .not.toBe("");
      revertNumber = Number((await browser.url()).match(new RegExp(`${FIXTURE_REPO}/(\\d+)`))?.[1]);
      if (!Number.isSafeInteger(revertNumber) || revertNumber <= 0)
        throw new Error("The revert did not open a new PR tab");
      await app.screenshot("revert-result");
      await menuAction(screen, "Close pull request");
      await confirm.getByRole("button", "Confirm close").tap();
      await expect(screen.getByRole("button", "Reopen")).toBeVisible({ timeout: 45_000 });
      expect(readActionFixture(revertNumber).state).toBe("closed");
      await app.screenshot("revert-closed");
    } finally {
      if (revertNumber !== null) cleanupActionFixture(revertNumber);
      cleanupActionFixture(fixture.number);
    }
  },
);

for (const method of ["merge", "rebase"] as const) {
  test(
    `PR actions ${method} merge protects changed heads and saves repository preferences`,
    { timeout: 330_000 },
    async ({ app, screen, browser }) => {
      const fixture = createActionFixture(method);
      const fixtures = [fixture.number];
      try {
        await openFixture({ app, screen }, fixture);
        if (method === "merge") {
          setActionFixtureCheck(fixture.number, "pending");
          await screen.getByRole("button", "Refresh").tap();
          await expect(browser.locator('[data-checks-state="pending"]')).toBeVisible({
            timeout: 45_000,
          });
          await app.screenshot("checks-partial-pending");
          // Auto-merge is offered once, in the header or the menu, where the repository allows it.
          await screen.getByRole("button", "More pull request actions").tap();
          await expect(screen.getByRole("menuitem", "Close pull request")).toBeVisible();
          const offered =
            (await screen.getByRole("menuitem", "Enable auto-merge").count()) +
            (await screen.getByRole("button", "Enable auto-merge").count());
          expect(offered).toBe(fixtureAllowsAutoMerge() ? 1 : 0);
          await app.screenshot("auto-merge-menu");
          await screen.getByRole("menuitem", "Close pull request").press("Escape");
          setActionFixtureCheck(fixture.number, "failure");
          await screen.getByRole("button", "Refresh").tap();
          await expect(browser.locator('[data-checks-state="failing"]')).toBeVisible({
            timeout: 45_000,
          });
          await app.screenshot("checks-failing");
          setActionFixtureCheck(fixture.number, "success");
          await screen.getByRole("button", "Refresh").tap();
          await pollWithRefresh(screen, "checks passed", () =>
            browser.locator('[data-checks-state="passing"]').isVisible(),
          );
          await app.screenshot("checks-passing");
        }
        await waitForMerge(screen);
        await screen.getByRole("button", /^Merge \(/).tap();
        const confirm = screen.getByRole("dialog");
        await choose(screen, confirm.getByRole("combobox", "Method"), METHOD_LABELS[method]);
        if (method === "merge") {
          const captured = readActionFixture(fixture.number).head.sha;
          await expect(browser.locator("[data-pr-action-head]")).toHaveAttribute(
            "data-pr-action-head",
            captured,
          );
          advanceFixtureHead(fixture);
          await expect
            .poll(() => readActionFixture(fixture.number).head.sha, { timeout: 45_000 })
            .not.toBe(captured);
          await expect(browser.locator("[data-pr-action-head]")).toHaveAttribute(
            "data-pr-action-head",
            captured,
          );
          await confirm.getByRole("button", "Confirm merge").tap();
          await expect(confirm.getByRole("alert")).toContainText("changed after you opened", {
            timeout: 45_000,
          });
          expect(readActionFixture(fixture.number).merged).toBe(false);
          await app.screenshot("stale-head-refused");
          await confirm.getByRole("button", "Cancel").tap();
          await waitForMerge(screen);
          await screen.getByRole("button", /^Merge \(/).tap();
          await choose(screen, confirm.getByRole("combobox", "Method"), METHOD_LABELS[method]);
        }
        await app.screenshot(`${method}-confirm`);
        await confirm.getByRole("checkbox", "Delete branch after merge").check();
        await confirm.getByRole("button", "Confirm merge").tap();
        await expect(screen.getByRole("button", "Revert")).toBeVisible({ timeout: 45_000 });
        const merged = readActionFixture(fixture.number);
        expect(merged.merged).toBe(true);
        if (merged.merge_commit_sha === null)
          throw new Error("GitHub did not report a merge commit");
        expect(actionFixtureCommit(merged.merge_commit_sha).parents.length).toBe(
          method === "merge" ? 2 : 1,
        );
        await app.screenshot(`${method}-result`);
        expect(
          readRows(
            runForUrl(app.baseUrl).home,
            `SELECT merge_method FROM pull_request_action_preferences WHERE repository = 'github.com/${FIXTURE_REPO}'`,
          ),
        ).toEqual([{ merge_method: method }]);
        const remembered = createActionFixture(`${method}-preferences`);
        fixtures.push(remembered.number);
        await openFixture({ app, screen }, remembered);
        await waitForMerge(screen);
        await expect(screen.getByRole("button", `Merge (${method})`)).toBeVisible();
        await screen.getByRole("button", `Merge (${method})`).tap();
        await expect(confirm.getByRole("checkbox", "Delete branch after merge")).toBeChecked();
        await app.screenshot(`${method}-preferences-remembered`);
        await confirm.getByRole("button", "Cancel").tap();
      } finally {
        for (const number of fixtures.toReversed()) cleanupActionFixture(number);
      }
    },
  );
}

test(
  "PR actions rebase a behind fixture branch",
  { timeout: 270_000, skip: NEEDS_FIXTURE },
  async ({ app, screen }) => {
    requireBranchUpdates();
    const fixture = createActionFixture("update-rebase");
    try {
      advanceFixtureBase(fixture);
      await openFixture({ app, screen }, fixture);
      await expect(screen.getByRole("button", "Update branch")).toBeEnabled({ timeout: 45_000 });
      const before = readActionFixture(fixture.number).head.sha;
      await screen.getByRole("button", "Update branch").tap();
      const confirm = screen.getByRole("dialog", "Update branch");
      await choose(screen, confirm.getByRole("combobox", "Method"), "Rebase onto base");
      await app.screenshot("update-rebase-confirm");
      await confirm.getByRole("button", "Update branch").tap();
      await waitForMerge(screen);
      const updated = readActionFixture(fixture.number);
      expect(updated.head.sha).not.toBe(before);
      expect(actionFixtureCommit(updated.head.sha).parents.length).toBe(1);
      await app.screenshot("update-rebase-result");
    } finally {
      cleanupActionFixture(fixture.number);
    }
  },
);

test(
  "the watcher ends a real guide after a header merge",
  { tags: ["agent"], timeout: GUIDE_WAIT + 60_000, skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    test.skip(
      process.env.PRKIT_E2E_AGENT !== "1",
      "Spends the user's Claude subscription. Run with PRKIT_E2E_AGENT=1 --tag agent.",
    );
    const fixture = createActionFixture("watcher");
    try {
      await openFixture({ app, screen }, fixture);
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect(browser.locator('[data-review-status="watching"]')).toBeAttached({
        timeout: GUIDE_WAIT,
      });
      await app.screenshot("watcher-before-merge");
      await waitForMerge(screen);
      await screen.getByRole("button", /^Merge \(/).tap();
      await screen.getByRole("dialog").getByRole("button", "Confirm merge").tap();
      await expect(browser.locator('[data-review-status="done"]')).toBeAttached({
        timeout: 45_000,
      });
      const run = runForUrl(app.baseUrl);
      expect(
        readRows(
          run.home,
          `SELECT status FROM reviews WHERE pr_key = 'github.com/${FIXTURE_REPO}#${fixture.number}'`,
        ),
      ).toEqual([{ status: '{"_tag":"done","reason":"merged"}' }]);
      expect(readActionFixture(fixture.number).merged).toBe(true);
      await app.screenshot("watcher-merged-done");
    } finally {
      cleanupActionFixture(fixture.number);
    }
  },
);

// The fixture repository is private on a plan without auto-merge or branch protection, and
// nobody else may approve or fork it, so these journeys read the fake GitHub.
describe("PR actions against the fake GitHub", () => {
  const openFake = async (
    { app, screen }: Pick<TestFixtures, "app" | "screen">,
    url: string,
    number: number,
    title: string,
  ) => {
    await app.open(
      `${url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=conversation`,
    );
    await expect(screen.getByRole("heading", title)).toBeVisible({ timeout: 30_000 });
  };

  test(
    "auto-merge waits for the required check, merges when it passes, and turns off again",
    { timeout: 180_000 },
    async ({ app, screen }) => {
      const fake = await startFakeGitHub("auto-merge");
      try {
        await fake.require(5);
        await fake.require(6);
        const [five, six] = [await fake.pull(5), await fake.pull(6)];
        // The watcher notices the merge; five seconds instead of sixty.
        const run = startFakeInstance("auto-merge", fake, ["--watch-interval", "5000", "--e2e"]);
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
          timeout: 20_000,
        });
        await openFake({ app, screen }, run.url, 5, "Budget fixture 5");
        await screen.getByRole("button", "Enable auto-merge").tap();
        const confirm = screen.getByRole("dialog", "Enable auto-merge");
        await choose(screen, confirm.getByRole("combobox", "Method"), METHOD_LABELS.squash);
        await app.screenshot("auto-merge-confirm");
        await confirm.getByRole("button", "Enable auto-merge").tap();
        await expect(screen.getByRole("button", "Disable auto-merge")).toBeVisible({
          timeout: 30_000,
        });
        expect(await fake.writes()).toEqual([
          {
            kind: "enablePullRequestAutoMerge",
            input: { input: { pullRequestId: five.id, mergeMethod: "SQUASH" } },
          },
        ]);
        await app.screenshot("auto-merge-enabled");

        await fake.checks(5, "completed");
        await expect(screen.getByRole("button", "Revert")).toBeVisible({ timeout: 30_000 });
        await app.screenshot("auto-merge-merged");

        await openFake({ app, screen }, run.url, 6, "Budget fixture 6");
        await screen.getByRole("button", "Enable auto-merge").tap();
        await screen
          .getByRole("dialog", "Enable auto-merge")
          .getByRole("button", "Enable auto-merge")
          .tap();
        await expect(screen.getByRole("button", "Disable auto-merge")).toBeVisible({
          timeout: 30_000,
        });
        await screen.getByRole("button", "Disable auto-merge").tap();
        await expect(screen.getByRole("button", "Enable auto-merge")).toBeVisible({
          timeout: 30_000,
        });
        await app.screenshot("auto-merge-disabled");
        // The second PR starts from the method the first one saved for the repository.
        expect((await fake.writes()).slice(1)).toEqual([
          {
            kind: "enablePullRequestAutoMerge",
            input: { input: { pullRequestId: six.id, mergeMethod: "SQUASH" } },
          },
          { kind: "disablePullRequestAutoMerge", input: { id: six.id } },
        ]);
      } finally {
        stopFakeInstance("auto-merge", { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "a second person approves a fork's pull request and its waiting workflows; the author can do neither",
    { timeout: 180_000 },
    async ({ app, screen }) => {
      const fake = await startFakeGitHub("approvals");
      try {
        const run = startFakeInstance("approvals", fake);
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({
          timeout: 20_000,
        });

        await openFake({ app, screen }, run.url, 1, "Budget fixture 1");
        await screen.getByRole("button", "Review").first().tap();
        await expect(screen.getByRole("radio", "Approve")).toBeDisabled();
        await expect(
          screen.getByText("This is your pull request, so GitHub only lets you comment on it."),
        ).toBeVisible();
        await app.screenshot("own-pull-request-no-approve");
        await screen.getByRole("button", "Cancel").tap();
        // Only a fork's workflows wait for approval, so its own PR's menu leaves it out.
        await screen.getByRole("button", "More pull request actions").tap();
        await expect(screen.getByRole("menuitem", "Close pull request")).toBeVisible();
        await expect(screen.getByRole("menuitem", "Approve workflows")).toHaveCount(0);
        await app.screenshot("own-pull-request-no-workflow-approval");
        await screen.getByRole("menuitem", "Close pull request").press("Escape");

        await openFake({ app, screen }, run.url, 7, "Budget fixture 7 from a fork");
        const { head, runs } = await fake.pull(7);
        const [waiting] = runs;
        if (waiting === undefined) throw new Error("The fake's PR 7 has no workflow run waiting.");
        await screen.getByRole("button", "Review").first().tap();
        await screen.getByRole("radio", "Approve").check();
        await screen.getByRole("textbox", "Review summary").fill("Read every change. Approving.");
        await app.screenshot("approve-form");
        await screen.getByRole("button", "Approve").tap();
        const notifications = screen.getByRole("region", "Notifications");
        await expect(notifications).toContainText("Review submitted", { timeout: 30_000 });
        await expect(screen.getByRole("region", "Reviewers")).toContainText("budget-test", {
          timeout: 30_000,
        });
        await expect(
          screen.getByRole("region", "Reviewers").getByRole("image", "Approved"),
        ).toBeVisible();
        await app.screenshot("approved");
        expect(await fake.writes()).toEqual([
          {
            kind: "POST pulls/7/reviews",
            input: {
              commit_id: head,
              event: "APPROVE",
              body: "Read every change. Approving.",
              comments: [],
            },
          },
        ]);

        await screen.getByRole("button", "More pull request actions").tap();
        await screen.getByRole("menuitem", "Approve workflows").tap();
        const confirm = screen.getByRole("dialog", "Approve workflows");
        await expect(confirm).toContainText(
          `Allow fork workflows to run for commit ${head.slice(0, 7)}.`,
        );
        await app.screenshot("approve-workflows-confirm");
        await confirm.getByRole("button", "Approve workflows").tap();
        await expect(notifications).toContainText("Approve workflows completed", {
          timeout: 30_000,
        });
        expect((await fake.writes()).slice(1)).toEqual([
          { kind: `POST actions/runs/${waiting}/approve`, input: {} },
        ]);
        await app.screenshot("approve-workflows-done");

        // Nothing waits any more: a second approval says so and sends nothing.
        await screen.getByRole("button", "More pull request actions").tap();
        await screen.getByRole("menuitem", "Approve workflows").tap();
        await screen
          .getByRole("dialog", "Approve workflows")
          .getByRole("button", "Approve workflows")
          .tap();
        await expect(
          screen.getByRole("dialog", "Approve workflows").getByRole("alert"),
        ).toContainText("No workflows for this pull request head are waiting for approval.", {
          timeout: 30_000,
        });
        expect(await fake.writes()).toHaveLength(2);
        await app.screenshot("approve-workflows-none-waiting");
      } finally {
        stopFakeInstance("approvals", { keepHome: false });
        fake.stop();
      }
    },
  );
});
