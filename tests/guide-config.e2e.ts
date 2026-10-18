import * as NodeFS from "node:fs";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type Locator, type TestFixtures } from "e2e";
import { chromium } from "playwright";

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
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
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

const EDITOR_WORDS = {
  ignore: { item: "Rule", add: "Add rule", save: "Save ignore rules" },
  sensitive: { item: "Path", add: "Add path", save: "Save look-closely paths" },
} as const;

const addRule = async (
  form: Locator,
  pattern: string,
  kind: keyof typeof EDITOR_WORDS = "ignore",
) => {
  const words = EDITOR_WORDS[kind];
  const count = await form.getByRole("textbox", new RegExp(`^${words.item} \\d+$`)).count();
  await form.getByRole("button", words.add).tap();
  await form.getByRole("textbox", `${words.item} ${count + 1}`).fill(pattern);
  await form.getByRole("button", words.save).tap();
  await expect(form.getByRole("button", words.save)).toBeHidden({ timeout: 15_000 });
};

const atNarrowWidth = async (browser: Browser, capture: () => Promise<void>) => {
  const size = await browser.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await browser.setViewport({ width: 640, height: 900 });
  await capture();
  await browser.setViewport(size);
};

const ignoreChip = (screen: Fixtures["screen"]) =>
  screen
    .getByRole("group", "Guide settings")
    .getByRole("button", /^(No files skipped|Skipping \d+ files?)$/);

const closelyChip = (screen: Fixtures["screen"]) =>
  screen.getByRole("group", "Guide settings").getByRole("button", /^Look closely/);

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

  test("look-closely paths layer like ignore rules, and the composer names the changed files they match", async ({
    app,
    screen,
    browser,
  }) => {
    await emulateOsColorScheme(browser, "light");
    await openSettings({ app, screen, browser });
    const global = screen.getByRole("form", "Global look-closely paths");
    await expect(global.getByRole("status")).toHaveText("No paths yet.");
    await expect(
      screen.getByRole("form", "Global ignore rules").getByRole("button", "Add the Tests preset"),
    ).toBeVisible();
    await expect(global.getByRole("button", /preset$/)).toHaveCount(0);

    await addRule(global, "src/server.js", "sensitive");
    await global.getByRole("button", "Add path").tap();
    await global.getByRole("textbox", "Path 2").fill("src/[");
    await global.getByRole("button", "Save look-closely paths").tap();
    await expect(global.getByRole("alert")).toHaveText("Close the `[` with a `]`.");
    await global.getByRole("textbox", "Path 2").fill("src/server.js");
    await global.getByRole("button", "Save look-closely paths").tap();
    await expect(global.getByRole("alert")).toHaveText([
      "This pattern is already in the list.",
      "This pattern is already in the list.",
    ]);
    await global.getByRole("button", "Discard").tap();
    await expect(global.getByRole("textbox", /^Path \d+$/)).toHaveCount(1);
    await expect(global.getByRole("alert")).toHaveCount(0);
    await global.scrollIntoView();
    await screenshotLightAndDark(app, browser, "risk-settings-global");

    await pickRepository({ screen });
    const repository = screen.getByRole("form", "Repository look-closely paths");
    await addRule(repository, "src/validate.js", "sensitive");
    await repository.getByRole("button", "1 inherited, all on").tap();
    await expect(repository.getByRole("listitem", "src/server.js, from Global")).toContainText(
      "Global · On",
    );
    await repository
      .getByRole("radiogroup", "src/server.js: inherit, on or off")
      .getByRole("radio", "Off")
      .tap();
    await repository.getByRole("button", "Save look-closely paths").tap();
    await expect(repository.getByRole("button", "1 inherited, 1 off")).toBeVisible();
    await repository.scrollIntoView();
    await screenshotLightAndDark(app, browser, "risk-settings-repository");
    await atNarrowWidth(browser, async () => {
      await repository.scrollIntoView();
      await screenshotLightAndDark(app, browser, "risk-settings-repository-narrow");
    });

    await openFixtureGuide({ app, screen });
    await expect(closelyChip(screen)).toHaveText("Look closely: 1 file", { timeout: 45_000 });
    await closelyChip(screen).tap();
    const popover = screen.getByRole("group", "Look-closely paths for this pull request");
    const matches = popover.getByRole("list", "Files that match look-closely paths");
    await expect(matches.getByRole("listitem")).toHaveText([
      "src/validate.js · src/validate.js (Repository)",
    ]);

    const own = popover.getByRole("form", "This pull request look-closely paths");
    await own.getByRole("button", "2 inherited, 1 off").tap();
    await expect(own.getByRole("listitem", "src/server.js, from Global")).toContainText(
      "Global · Off from Repository",
    );
    await own
      .getByRole("radiogroup", "src/server.js: inherit, on or off")
      .getByRole("radio", "On")
      .tap();
    await own.getByRole("button", "Save look-closely paths").tap();
    await expect(closelyChip(screen)).toHaveText("Look closely: 2 files");
    await expect(matches.getByRole("listitem", "src/server.js: look closely")).toContainText(
      "src/server.js (Global)",
    );

    await addRule(own, "test/", "sensitive");
    await expect(closelyChip(screen)).toHaveText("Look closely: 3 files");
    const tests = matches.getByRole("listitem", "test/validate.test.js: look closely");
    await expect(tests).toContainText("test/ (This pull request)");
    await expect(tests).toContainText("Your ignore rules skip it, so the guide won't look at it.");
    await expect(matches.getByRole("listitem", "src/server.js: look closely")).not.toContainText(
      "Your ignore rules skip it",
    );
    await matches.scrollIntoView();
    await screenshotLightAndDark(app, browser, "risk-settings-composer-popover");
    await atNarrowWidth(browser, async () => {
      await matches.scrollIntoView();
      await screenshotLightAndDark(app, browser, "risk-settings-composer-popover-narrow");
    });

    const home = runForUrl(app.baseUrl).home;
    const stored = (version: number, pattern: string, overrides = "") => ({
      version,
      value: expect.stringMatching(
        new RegExp(
          `^\\{"rules":\\[\\{"id":"[^"]+","pattern":"${pattern}"\\}\\],"overrides":\\[${overrides}\\]\\}$`,
        ),
      ),
    });
    const override = (value: string) => `\\{"itemId":"[^"]+","value":"${value}"\\}`;
    expect(
      readRows(
        home,
        "SELECT scope, version, value FROM guide_config WHERE section = 'sensitive' ORDER BY scope",
      ),
    ).toEqual([
      { scope: "global", ...stored(1, "src/server\\.js") },
      { scope: `pull-request:${FIXTURE_KEY}`, ...stored(2, "test/", override("on")) },
      {
        scope: expect.stringMatching(/^repository:github\.com\/\d+$/),
        ...stored(2, "src/validate\\.js", override("off")),
      },
    ]);

    await browser.reload();
    await expect(closelyChip(screen)).toHaveText("Look closely: 3 files", { timeout: 45_000 });
    await openSettings({ app, screen, browser });
    await expect(global.getByRole("textbox", "Path 1")).toHaveValue("src/server.js");
    await pickRepository({ screen });
    await expect(repository.getByRole("textbox", "Path 1")).toHaveValue("src/validate.js");
    await expect(repository.getByRole("button", "1 inherited, 1 off")).toBeVisible();
  });

  test("a look-closely save from a form another window already changed is refused, and Reload shows the latest", async ({
    app,
    screen,
    browser,
  }) => {
    const run = runForUrl(app.baseUrl);
    await emulateOsColorScheme(browser, "light");
    await openSettings({ app, screen, browser });
    const global = screen.getByRole("form", "Global look-closely paths");
    await global.getByRole("button", "Add path").tap();
    await global.getByRole("textbox", "Path 2").fill("docs/");

    const other = await chromium.launch({ headless: true, args: ["--use-mock-keychain"] });
    try {
      const page = await other.newPage();
      await page.goto(run.openUrl);
      await page.getByRole("link", { name: "Inbox", exact: true }).waitFor({ timeout: 30_000 });
      await page.goto(`${run.url}/settings/guides`);
      const form = page.getByRole("form", { name: "Global look-closely paths" });
      const save = form.getByRole("button", { name: "Save look-closely paths" });
      await form.getByRole("button", { name: "Add path" }).click({ timeout: 30_000 });
      await form.getByRole("textbox", { name: "Path 2" }).fill("migrations/");
      await save.click();
      await save.waitFor({ state: "hidden", timeout: 15_000 });
    } finally {
      await other.close();
    }

    await global.getByRole("button", "Save look-closely paths").tap();
    const problem = global.getByRole("alert");
    await expect(problem).toContainText("These settings changed since you opened them");
    await screenshotLightAndDark(app, browser, "risk-settings-conflict");
    await problem.getByRole("button", "Reload").tap();
    await expect(global.getByRole("textbox", /^Path \d+$/)).toHaveCount(2);
    await expect(global.getByRole("textbox", "Path 2")).toHaveValue("migrations/");
    await expect(global.getByRole("button", "Save look-closely paths")).toBeHidden();
    expect(
      readRows(
        run.home,
        "SELECT version FROM guide_config WHERE scope = 'global' AND section = 'sensitive'",
      ),
    ).toEqual([{ version: 2 }]);
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
    ).toEqual(["focus", "ignore", "sensitive"]);
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
        "task:first files:4 hand-over:streamed skipped:1 guidance:global guidance:pull-request focus-areas:security signals:none",
        "task:first files:4 hand-over:streamed skipped:1 guidance:pull-request focus-areas:security signals:none",
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
