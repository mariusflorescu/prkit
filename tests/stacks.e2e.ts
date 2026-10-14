import { test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  FIXTURE_NAME,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  readRows,
} from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import { cleanupStackFixture, createStackFixture, squashMergeBottom } from "./stackFixture.ts";

test(
  "stacked PRs show their layer, sit bottom to top, and the strip and guide setup reach every layer",
  { timeout: 300_000, skip: NEEDS_FIXTURE },
  async ({ app, screen, browser }) => {
    const stamp = String(Date.now());
    const fixture = createStackFixture(stamp);
    try {
      const [bottom, middle, top] = fixture.numbers;
      if (bottom === undefined || middle === undefined || top === undefined)
        throw new Error("The stack fixture needs three layers.");
      await openInbox({ app, screen });
      // The inbox may be cached from before the fixture existed.
      await screen.getByRole("button", "Refresh").tap();
      await screen.getByRole("searchbox", "Search pull requests").fill(`Stack fixture ${stamp}`);
      const yours = screen.getByRole("region", "Yours");
      for (const [index, number] of fixture.numbers.entries())
        await expect(
          yours.getByRole("link", new RegExp(`#${number} .*Stack ${index + 1}/3`)),
        ).toBeVisible({ timeout: 60_000 });
      const rows = await yours.getByRole("link").allTextContents();
      expect(
        rows.map((row) => fixture.numbers.find((number) => row.includes(`#${number}`))),
      ).toEqual(fixture.numbers);
      await app.screenshot("inbox-stack-marks");

      await yours.getByRole("link", new RegExp(`#${middle} `)).tap();
      const strip = screen.getByRole("navigation", "Stack");
      await expect(strip).toBeVisible({ timeout: 60_000 });
      await expect(strip.getByRole("button")).toHaveCount(3);
      await expect(
        strip.getByRole("button", new RegExp(`^Layer 2 of 3: #${middle} `)),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        strip.getByRole("button", new RegExp(`^Layer 1 of 3: #${bottom} .*No guide$`)),
      ).toBeVisible();
      await app.screenshot("stack-strip");

      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
      const scope = screen.getByRole("radiogroup", "Write guides for");
      await expect(scope).toBeVisible({ timeout: 30_000 });
      await expect(scope.getByRole("radio", "This PR")).toHaveAttribute("aria-checked", "true");
      await scope.getByRole("radio", "Whole stack (3 PRs)").tap();
      await screen.getByRole("button", "Add a focus").tap();
      await expect(
        screen.getByRole("textbox", "Guidance for every chosen pull request"),
      ).toBeFocused();
      await expect(screen.getByRole("button", "Generate 3 guides")).toBeVisible();
      await scope.getByRole("radio", "Choose layers").tap();
      const layers = screen.getByRole("group", "Layers to write guides for");
      await expect(layers.getByRole("checkbox")).toHaveCount(3);
      await expect(layers.getByRole("checkbox", new RegExp(`^Layer 2: #${middle} `))).toBeChecked();
      await expect(screen.getByRole("button", "Generate 1 guide")).toBeVisible();
      await layers.getByRole("checkbox", new RegExp(`^Layer 1: #${bottom} `)).tap();
      await layers.getByRole("checkbox", new RegExp(`^Layer 3: #${top} `)).tap();
      await layers.getByRole("checkbox", new RegExp(`^Layer 2: #${middle} `)).tap();
      await expect(screen.getByRole("button", "Generate 2 guides")).toBeVisible();
      await app.screenshot("setup-choose-layers");
      await scope.getByRole("radio", "This PR").tap();
      await expect(screen.getByRole("textbox", "Guidance for this pull request")).toBeVisible();

      const modifier = await browser.evaluate(() =>
        /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
      );
      await browser.keyboard.press(`${modifier}+KeyK`);
      await screen.getByRole("searchbox", "Find a pull request").fill("generate guides for");
      await expect(
        screen.getByRole("button", /^Generate guides for the whole stack 3 PRs · default agent$/),
      ).toBeVisible();
      await app.screenshot("palette-whole-stack");
      await browser.keyboard.press("Escape");

      await strip.getByRole("button", new RegExp(`^Layer 3 of 3: #${top} `)).tap();
      await expect(browser).toHaveURL(new RegExp(`/${FIXTURE_NAME}/${top}\\?`));
      await expect(
        screen
          .getByRole("navigation", "Stack")
          .getByRole("button", new RegExp(`^Layer 3 of 3: #${top} `)),
      ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
      await expect(
        screen
          .getByRole("navigation", "Workspace tabs")
          .getByRole("link", new RegExp(`^Open ${FIXTURE_REPO} #${top}\\b`)),
      ).toBeVisible();
    } finally {
      expect.soft(cleanupStackFixture(fixture)).toEqual([]);
    }
  },
);

/**
 * A stack whose bottom layer was squash-merged on GitHub with `gh stack merge --squash`.
 * GitHub keeps the merged layer in the stack as layer 1 and rebases the next one onto
 * the trunk, so the open layers stay 2/3 and 3/3. Opens layer 2 from the inbox.
 */
const openSquashedStack = async (
  { app, screen }: Pick<TestFixtures, "app" | "screen">,
  fixture: ReturnType<typeof createStackFixture>,
  stamp: string,
) => {
  const [bottom, middle, top] = fixture.numbers;
  if (bottom === undefined || middle === undefined || top === undefined)
    throw new Error("The stack fixture needs three layers.");
  squashMergeBottom(fixture);
  await openInbox({ app, screen });
  await screen.getByRole("button", "Refresh").tap();
  await screen.getByRole("searchbox", "Search pull requests").fill(`Stack fixture ${stamp}`);
  const yours = screen.getByRole("region", "Yours");
  await expect(yours.getByRole("link", new RegExp(`#${middle} .*Stack 2/3`))).toBeVisible({
    timeout: 60_000,
  });
  await expect(yours.getByRole("link", new RegExp(`#${top} .*Stack 3/3`))).toBeVisible();
  await expect(yours.getByRole("link")).toHaveCount(2);
  await app.screenshot("squashed-inbox");
  await yours.getByRole("link", new RegExp(`#${middle} `)).tap();
  const strip = screen.getByRole("navigation", "Stack");
  await expect(
    strip.getByRole("button", new RegExp(`^Layer 1 of 3: #${bottom} .*, Merged, No guide$`)),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    strip.getByRole("button", new RegExp(`^Layer 2 of 3: #${middle} .*, Open, No guide$`)),
  ).toHaveAttribute("aria-current", "page");
  await app.screenshot("squashed-strip");
  await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
  const scope = screen.getByRole("radiogroup", "Write guides for");
  await expect(scope).toBeVisible({ timeout: 30_000 });
  return { bottom, middle, top, scope };
};

test(
  "a squash-merged bottom layer stays in the strip as merged, and the guide setup offers only the open layers",
  { timeout: 300_000, skip: NEEDS_FIXTURE },
  async ({ app, screen }) => {
    const stamp = String(Date.now());
    const fixture = createStackFixture(stamp);
    try {
      const { bottom, middle, top, scope } = await openSquashedStack(
        { app, screen },
        fixture,
        stamp,
      );
      await scope.getByRole("radio", "Whole stack (2 PRs)").tap();
      await expect(screen.getByRole("button", "Generate 2 guides")).toBeVisible();
      await scope.getByRole("radio", "Choose layers").tap();
      const layers = screen.getByRole("group", "Layers to write guides for");
      await expect(
        layers.getByRole("checkbox", new RegExp(`^Layer 1: #${bottom} `)),
      ).toBeDisabled();
      await expect(layers.getByRole("checkbox", new RegExp(`^Layer 2: #${middle} `))).toBeChecked();
      await layers.getByRole("checkbox", new RegExp(`^Layer 3: #${top} `)).tap();
      await expect(screen.getByRole("button", "Generate 2 guides")).toBeVisible();
      await app.screenshot("squashed-setup");
    } finally {
      expect.soft(cleanupStackFixture(fixture)).toEqual([]);
    }
  },
);

test(
  "Claude writes guides for the layers left after a squash merge, each covering only its own files",
  { tags: ["agent"], timeout: 1_200_000, skip: NEEDS_FIXTURE },
  async ({ app, screen }) => {
    test.skip(!AGENT_RUNS, AGENT_SKIP);
    const stamp = String(Date.now());
    const fixture = createStackFixture(stamp);
    try {
      const { middle, top, scope } = await openSquashedStack({ app, screen }, fixture, stamp);
      const [, middleLayer, topLayer] = fixture.layers;
      if (middleLayer === undefined || topLayer === undefined)
        throw new Error("The stack fixture needs three layers.");
      await scope.getByRole("radio", "Whole stack (2 PRs)").tap();
      await screen.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("sonnet");
      await screen
        .getByRole("option", /Claude Sonnet/)
        .first()
        .tap();
      await screen.getByRole("button", "Generate 2 guides").tap();
      const notice = screen.getByRole("region", "Notifications");
      await expect(notice).toContainText("Stack guides ready", { timeout: 1_080_000 });
      await expect(notice).toContainText("2 PRs");
      await app.screenshot("squashed-stack-guides-ready");
      const key = (number: number) => `github.com/${FIXTURE_REPO}#${number}`;
      expect(
        readRows(
          runForUrl(app.baseUrl).home,
          `SELECT r.pr_key AS key, a.outcome, a.base_ref AS base,
            (SELECT group_concat(CASE f.type WHEN 'text' THEN f.value ELSE json_extract(f.value, '$.path') END)
              FROM json_each(v.guide, '$.chapters') c, json_each(c.value, '$.files') f) AS files
          FROM review_revisions v JOIN reviews r ON r.id = v.review_id JOIN review_attempts a ON a.id = v.attempt_id
          ORDER BY r.pr_key`,
        ),
      ).toEqual([
        { key: key(middle), outcome: "accepted", base: fixture.trunk, files: middleLayer.path },
        { key: key(top), outcome: "accepted", base: middleLayer.branch, files: topLayer.path },
      ]);
    } finally {
      expect.soft(cleanupStackFixture(fixture)).toEqual([]);
    }
  },
);
