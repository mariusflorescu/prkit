import * as NodeFS from "node:fs";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type Locator, type TestFixtures } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import {
  AGENT_RUNS,
  AGENT_SKIP,
  FIXTURE_NAME,
  FIXTURE_REPO,
  NEEDS_FIXTURE,
  openFixtureGuide,
  readRows,
} from "./fixturePr.ts";
import { openInbox } from "./openInbox.ts";
import { pickGuideRepository } from "./pickers.ts";

const FIXTURE_KEY = `github.com/${FIXTURE_REPO}#1`;

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const shortcut = async ({ browser }: { browser: Browser }, key: string) => {
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+${key}`);
};

/** Settings > Guides, after the inbox loaded: the repository picker lists the inbox's repositories. */
const openSettings = async ({ app, screen, browser }: Fixtures) => {
  await openInbox({ app, screen });
  await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
  await expect(
    screen.getByRole("region", "Yours").getByRole("link", /#1 Validate links and count clicks/),
  ).toBeVisible({ timeout: 45_000 });
  await shortcut({ browser }, "Comma");
  await openGuidesSection({ screen });
};

const openGuidesSection = async ({ screen }: Pick<Fixtures, "screen">) => {
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "Guides").tap();
  await expect(screen.getByRole("form", "Global ignore rules")).toBeVisible({ timeout: 30_000 });
};

const pickRepository = async ({ screen }: Pick<Fixtures, "screen">) => {
  await pickGuideRepository(screen, FIXTURE_REPO);
  await expect(screen.getByRole("form", "Repository ignore rules")).toBeVisible({
    timeout: 30_000,
  });
};

const addRule = async (form: Locator, pattern: string) => {
  const count = await form.getByRole("textbox", /^Rule \d+$/).count();
  await form.getByRole("button", "Add rule").tap();
  await form.getByRole("textbox", `Rule ${count + 1}`).fill(pattern);
  await form.getByRole("button", "Save ignore rules").tap();
  await expect(form.getByRole("button", "Save ignore rules")).toBeHidden({ timeout: 15_000 });
};

const ignoreChip = (screen: Fixtures["screen"]) =>
  screen
    .getByRole("group", "Guide settings")
    .getByRole("button", /^(No files skipped|Skipping \d+ files?)$/);

describe("guide settings", { serial: true, skip: NEEDS_FIXTURE }, () => {
  test("a repository negation keeps a file a Global rule skips, and the preview says why", async ({
    app,
    screen,
    browser,
  }) => {
    await openSettings({ app, screen, browser });
    await addRule(screen.getByRole("form", "Global ignore rules"), "test/");
    await pickRepository({ screen });
    await addRule(screen.getByRole("form", "Repository ignore rules"), "!test/validate.test.js");
    await app.screenshot("settings-repository-negation");
    const home = runForUrl(app.baseUrl).home;
    expect(readRows(home, "SELECT scope, version, value FROM guide_config ORDER BY scope")).toEqual(
      [
        {
          scope: "global",
          version: 1,
          value: expect.stringMatching(
            /^\{"rules":\[\{"id":"[^"]+","pattern":"test\/"\}\],"overrides":\[\]\}$/,
          ),
        },
        {
          scope: expect.stringMatching(/^repository:github\.com\/\d+$/),
          version: 1,
          value: expect.stringMatching(
            /^\{"rules":\[\{"id":"[^"]+","pattern":"!test\/validate\.test\.js"\}\],"overrides":\[\]\}$/,
          ),
        },
      ],
    );

    await openFixtureGuide({ app, screen });
    await expect(ignoreChip(screen)).toHaveText("No files skipped", { timeout: 45_000 });
    await ignoreChip(screen).tap();
    const popover = screen.getByRole("group", "Ignore rules for this pull request");
    await expect(popover.getByRole("listitem", "test/validate.test.js: reviewed")).toContainText(
      "kept by !test/validate.test.js (Repository)",
    );
    await popover.getByRole("button", "Why test/validate.test.js").tap();
    await expect(
      popover.getByRole("list", "Rules matching test/validate.test.js").getByRole("listitem"),
    ).toHaveText([
      "test/ (Global) · overridden by a later rule",
      "!test/validate.test.js (Repository) · decides: keeps",
    ]);
    await app.screenshot("composer-preview-negation");
  });

  test("a repository switches a Global rule off, and the pull request switches it back on", async ({
    app,
    screen,
    browser,
  }) => {
    await openSettings({ app, screen, browser });
    await pickRepository({ screen });
    const repository = screen.getByRole("form", "Repository ignore rules");
    await repository.getByRole("button", "Remove rule !test/validate.test.js").tap();
    await repository.getByRole("button", "1 inherited, all on").tap();
    await repository
      .getByRole("radiogroup", "test/: inherit, on or off")
      .getByRole("radio", "Off")
      .tap();
    await repository.getByRole("button", "Save ignore rules").tap();
    await expect(repository.getByRole("button", "1 inherited, 1 off")).toBeVisible();

    await openFixtureGuide({ app, screen });
    await expect(ignoreChip(screen)).toHaveText("No files skipped", { timeout: 45_000 });
    await ignoreChip(screen).tap();
    const popover = screen.getByRole("group", "Ignore rules for this pull request");
    await expect(popover.getByRole("listitem", "test/validate.test.js: reviewed")).toContainText(
      "kept (the rules that match are off)",
    );
    const own = popover.getByRole("form", "This pull request ignore rules");
    await own.getByRole("button", "1 inherited, 1 off").tap();
    await expect(own.getByRole("listitem", "test/, from Global")).toContainText(
      "Global · Off from Repository",
    );
    await own.getByRole("radiogroup", "test/: inherit, on or off").getByRole("radio", "On").tap();
    await own.getByRole("button", "Save ignore rules").tap();
    await expect(ignoreChip(screen)).toHaveText("Skipping 1 file");
    await expect(popover.getByRole("listitem", "test/validate.test.js: skipped")).toContainText(
      "skipped by test/ (Global)",
    );
    await popover.getByRole("button", "Why test/validate.test.js").tap();
    await expect(
      popover.getByRole("list", "Rules matching test/validate.test.js").getByRole("listitem"),
    ).toHaveText(["test/ (Global) · decides: skips (switched on at This pull request)"]);
    await app.screenshot("composer-preview-switched-back-on");

    // A pull request rule that skips everything blocks generation and names the rules.
    await addRule(own, "*");
    await expect(ignoreChip(screen)).toHaveText("Skipping 5 files");
    await browser.keyboard.press("Escape");
    await expect(screen.getByRole("alert", "Generation blocked")).toContainText(
      "Rules that decided: `*` (This pull request).",
    );
    await expect(screen.getByRole("button", "Generate guide")).toBeDisabled();
    await expect(
      screen.getByText(
        "Your ignore rules skip all 5 changed files, so your agent has nothing to read.",
      ),
    ).toBeVisible();
    await app.screenshot("composer-everything-skipped");
    await ignoreChip(screen).tap();
    await own.getByRole("button", "Remove rule *").tap();
    await own.getByRole("button", "Save ignore rules").tap();
    await expect(ignoreChip(screen)).toHaveText("Skipping 1 file");
    await expect(screen.getByRole("alert", "Generation blocked")).toBeHidden();
    await expect(
      screen.getByText(/^Your agent reads 4 of the 5 changed files and walks you through them:/),
    ).toBeVisible();
  });

  test("a rename is reviewed while either of its paths is kept", async ({
    app,
    screen,
    browser,
  }) => {
    await openSettings({ app, screen, browser });
    await pickRepository({ screen });
    await addRule(screen.getByRole("form", "Repository ignore rules"), "src/");
    await openInbox({ app, screen });
    await screen.getByRole("searchbox", "Search pull requests").fill(FIXTURE_NAME);
    await screen
      .getByRole("region", "Yours")
      .getByRole("link", /Move the store into lib/)
      .tap({ timeout: 45_000 });
    await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
    await expect(ignoreChip(screen)).toHaveText("No files skipped", { timeout: 45_000 });
    await ignoreChip(screen).tap();
    const popover = screen.getByRole("group", "Ignore rules for this pull request");
    const moved = popover.getByRole("listitem", "lib/store.js: reviewed");
    await expect(moved).toContainText("renamed from src/store.js");
    await expect(moved).toContainText("New path: kept (no rule matched)");
    await expect(moved).toContainText("Old path: skipped by src/ (Repository)");
    await app.screenshot("composer-rename-either-side");
    await addRule(popover.getByRole("form", "This pull request ignore rules"), "lib/");
    await expect(popover.getByRole("listitem", "lib/store.js: skipped")).toContainText(
      "Skipped: both paths are skipped.",
    );
    await app.screenshot("composer-rename-both-sides");
  });

  test("focus areas and guidance layer, and a pull request can switch off or replace what it inherits", async ({
    app,
    screen,
    browser,
  }) => {
    await openSettings({ app, screen, browser });
    const globalFocus = screen.getByRole("form", "Global focus areas");
    await globalFocus.getByRole("button", "Add the Security focus area").tap();
    await globalFocus.getByRole("button", "Save focus areas").tap();
    await expect(globalFocus.getByRole("button", "Save focus areas")).toBeHidden();
    const globalGuidance = screen.getByRole("form", "Global guidance");
    await globalGuidance.getByRole("textbox", "Global guidance").fill("Keep chapters very short");
    await globalGuidance.getByRole("button", "Save guidance").tap();
    await expect(globalGuidance.getByRole("button", "Save guidance")).toBeHidden();
    await pickRepository({ screen });
    const repositoryFocus = screen.getByRole("form", "Repository focus areas");
    await repositoryFocus.getByRole("button", "Add focus area").tap();
    await repositoryFocus.getByRole("textbox", "Label of focus area 1").fill("Migrations");
    await repositoryFocus
      .getByRole("textbox", "Question of focus area 1")
      .fill("Can these migrations run twice safely?");
    await repositoryFocus.getByRole("button", "Save focus areas").tap();
    await expect(repositoryFocus.getByRole("button", "Save focus areas")).toBeHidden();
    await app.screenshot("settings-focus-and-guidance");

    await openFixtureGuide({ app, screen });
    const chips = screen.getByRole("group", "Guide settings");
    await expect(chips.getByRole("button", "2 focus areas")).toBeVisible({ timeout: 45_000 });
    await chips.getByRole("button", "2 focus areas").tap();
    const focus = screen.getByRole("form", "This pull request focus areas");
    await focus.getByRole("button", "2 inherited, all on").tap();
    await focus
      .getByRole("radiogroup", "Migrations: inherit, on or off")
      .getByRole("radio", "Off")
      .tap();
    await focus.getByRole("button", "Save focus areas").tap();
    await expect(chips.getByRole("button", "1 focus area")).toBeVisible();
    await browser.keyboard.press("Escape");

    await expect(chips.getByRole("button", "Guidance: Global")).toBeVisible();
    await screen.getByRole("button", "Add a focus").tap();
    await screen
      .getByRole("textbox", "Guidance for this pull request")
      .fill("Explain the validation logic in depth");
    await expect(chips.getByRole("button", "Guidance: Global + this PR")).toBeVisible();
    await chips.getByRole("button", "Guidance: Global + this PR").tap();
    await screen
      .getByRole("radiogroup", "How this pull request's guidance combines with the guidance above")
      .getByRole("radio", "Replace the guidance above")
      .tap();
    await expect(screen.getByRole("listitem", "Global guidance, replaced")).toBeVisible();
    await expect(chips.getByRole("button", "Guidance: this PR")).toBeVisible();
    await app.screenshot("composer-guidance-replace");
    const home = runForUrl(app.baseUrl).home;
    expect(
      readRows(
        home,
        `SELECT section, value FROM guide_config WHERE scope = 'pull-request:${FIXTURE_KEY}' ORDER BY section`,
      ).map((row) => row.section),
    ).toEqual(["focus", "ignore"]);
  });
});

describe("guide settings with the user's agent", { tags: ["agent"], skip: NEEDS_FIXTURE }, () => {
  test(
    "an attempt keeps the settings it started with; changed settings write the next one fresh",
    { timeout: 1_500_000 },
    async ({ app, screen, browser }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const run = runForUrl(app.baseUrl);
      await openSettings({ app, screen, browser });
      await addRule(screen.getByRole("form", "Global ignore rules"), "test/");
      const globalFocus = screen.getByRole("form", "Global focus areas");
      await globalFocus.getByRole("button", "Add the Security focus area").tap();
      await globalFocus.getByRole("button", "Save focus areas").tap();
      await expect(globalFocus.getByRole("button", "Save focus areas")).toBeHidden();
      const globalGuidance = screen.getByRole("form", "Global guidance");
      await globalGuidance.getByRole("textbox", "Global guidance").fill("Keep chapters very short");
      await globalGuidance.getByRole("button", "Save guidance").tap();
      await expect(globalGuidance.getByRole("button", "Save guidance")).toBeHidden();
      await pickRepository({ screen });
      const repositoryFocus = screen.getByRole("form", "Repository focus areas");
      await repositoryFocus.getByRole("button", "Add the Migrations and data focus area").tap();
      await repositoryFocus.getByRole("button", "Save focus areas").tap();
      await expect(repositoryFocus.getByRole("button", "Save focus areas")).toBeHidden();

      await openFixtureGuide({ app, screen });
      const chips = screen.getByRole("group", "Guide settings");
      await chips.getByRole("button", "2 focus areas").tap({ timeout: 45_000 });
      const focus = screen.getByRole("form", "This pull request focus areas");
      await focus.getByRole("button", "2 inherited, all on").tap();
      await focus
        .getByRole("radiogroup", "Migrations and data: inherit, on or off")
        .getByRole("radio", "Off")
        .tap();
      await focus.getByRole("button", "Save focus areas").tap();
      await expect(chips.getByRole("button", "1 focus area")).toBeVisible();
      await browser.keyboard.press("Escape");
      await screen.getByRole("button", "Add a focus").tap();
      await screen
        .getByRole("textbox", "Guidance for this pull request")
        .fill("Explain the validation logic in depth");
      await expect(ignoreChip(screen)).toHaveText("Skipping 1 file");
      await screen.getByRole("button", "Generate guide").tap();
      await expect(browser.locator('[data-review-status="writing"]')).toBeAttached({
        timeout: 60_000,
      });

      // Edit Global while the attempt runs: this attempt keeps what it froze.
      await shortcut({ browser }, "Comma");
      await openGuidesSection({ screen });
      const editing = screen.getByRole("form", "Global guidance");
      await editing
        .getByRole("textbox", "Global guidance")
        .fill("Keep chapters very short. Use plain words.", { timeout: 30_000 });
      await editing.getByRole("button", "Save guidance").tap();
      await expect(editing.getByRole("button", "Save guidance")).toBeHidden();
      await screen
        .getByRole("navigation", "Workspace tabs")
        .getByRole("button", "Close Settings")
        .tap();

      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 660_000,
      });
      const areas = screen.getByRole("region", "Your focus areas");
      await expect(areas.getByRole("listitem")).toHaveCount(1);
      await expect(areas.getByRole("listitem")).toHaveAccessibleName(/^Security: /);
      await expect(browser.locator("[data-guide-view]")).toContainText(
        "Skipped by your ignore rules",
      );
      await expect(browser.locator("[data-revision-settings]")).toHaveText(
        "Written with 1 focus area · skipped 1 file",
      );
      await expect(
        screen.getByRole("status", "Settings changed since this revision"),
      ).toBeVisible();
      await app.screenshot("agent-r1-frozen-settings");

      const [first] = readRows(
        run.home,
        "SELECT a.config, a.config_hash, a.outcome FROM review_attempts a ORDER BY a.rowid LIMIT 1",
      );
      expect(first?.outcome).toBe("accepted");
      expect(String(first?.config)).toContain(
        '"text":"Keep chapters very short","replacedBy":null',
      );
      const [session] = readRows(
        run.home,
        `SELECT session_id FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
      );

      // This PR's guidance replaces Global's; the next attempt is written in a fresh session.
      await screen.getByRole("button", "Generate again with other settings").tap();
      const again = screen.getByRole("form", "Start a guide");
      await again
        .getByRole("group", "Guide settings")
        .getByRole("button", "Guidance: Global + this PR")
        .tap({ timeout: 30_000 });
      await screen
        .getByRole(
          "radiogroup",
          "How this pull request's guidance combines with the guidance above",
        )
        .getByRole("radio", "Replace the guidance above")
        .tap();
      // Its trigger closes the nested popover without closing the setup's.
      await again
        .getByRole("group", "Guide settings")
        .getByRole("button", "Guidance: this PR")
        .tap();
      await again.getByRole("button", "Generate again").tap();
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r2 · ", {
        timeout: 660_000,
      });
      await expect(browser.locator("[data-revision-settings]")).toHaveText(
        "Written with 1 focus area · skipped 1 file",
      );
      await app.screenshot("agent-r2-replaced-guidance");
      const log = NodeFS.readFileSync(run.log, "utf8");
      const composed = [...log.matchAll(/Composed the prompt \{[^}]*sections: '([^']*)'/g)].map(
        (match) => match[1],
      );
      expect(composed).toEqual([
        "task:first files:4 hand-over:streamed skipped:1 guidance:global guidance:pull-request focus-areas:security",
        "task:first files:4 hand-over:streamed skipped:1 guidance:pull-request focus-areas:security",
      ]);
      expect(log).toContain(
        "Guide settings changed since the last revision; starting a fresh session",
      );
      const [after] = readRows(
        run.home,
        `SELECT session_id FROM reviews WHERE pr_key = '${FIXTURE_KEY}'`,
      );
      expect(after?.session_id).not.toBe(session?.session_id);
    },
  );
});
