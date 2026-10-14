import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { prScrolls } from "./prScrolls.ts";

const KEY = "github.com/budget/fixtures";

/**
 * The setup's controls at the app's own scale: every button and its text, the Generate
 * button beside the PR header's Review, and whether the block overflows its width.
 */
const setupScale = (browser: Browser) =>
  browser.evaluate(() => {
    const form = document.querySelector('form[aria-label="Start a guide"]');
    const header = document.querySelector('[aria-label="Pull request actions"] button');
    const buttons = [...(form?.querySelectorAll("button") ?? [])].filter(
      (button) => button.getBoundingClientRect().height > 0,
    );
    const generate = buttons.find((button) => button.type === "submit");
    return {
      tallest: Math.max(...buttons.map((button) => button.getBoundingClientRect().height)),
      fonts: [...new Set(buttons.map((button) => getComputedStyle(button).fontSize))],
      generate: generate?.getBoundingClientRect().height ?? null,
      header: header?.getBoundingClientRect().height ?? null,
      overflows: form === null ? null : form.scrollWidth > form.clientWidth,
    };
  });

const modifierOf = (browser: Browser) =>
  browser.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));

test("the Guide tab sets a guide up in one quiet block: agent, effort, a focus that is saved, Cmd+G and Generate", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("guide-setup");
  const claude = setUpFakeClaude("guide-setup");
  try {
    const run = startFakeInstance("guide-setup", fake, ["--claude", claude.file]);
    await emulateOsColorScheme(browser, "light");
    await browser.setViewport({ width: 1280, height: 800 });
    await app.open(run.openUrl);
    await screen.getByRole("link", /#3 Budget fixture 3/).tap({ timeout: 20_000 });
    // The PR's guide settings wait on a repository lookup. While they load, the focus can't
    // know whether it is saved, so it offers nothing rather than an "Add a focus" that swaps.
    await fake.latency(3_000, "core");
    await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
    const setup = screen.getByRole("form", "Start a guide");
    await expect(setup.getByRole("status", "Loading the focus")).toBeVisible({ timeout: 30_000 });
    await expect(setup.getByRole("button", "Add a focus")).toHaveCount(0);
    await fake.latency(0);
    await expect(screen.getByRole("heading", "No guide yet")).toBeVisible({ timeout: 30_000 });
    await expect(
      screen.getByText(/reads the 1 changed file and walks you through it:/),
    ).toBeVisible();
    const picker = setup.getByRole("button", /^Agent and model: /);
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(
      setup.getByRole("group", "Guide settings").getByRole("button", "No files skipped"),
    ).toBeVisible({ timeout: 30_000 });
    // The focus waits behind a quiet button until it is wanted.
    await expect(setup.getByRole("textbox")).toHaveCount(0);
    await expect(setup.getByRole("button", "Add a focus")).toBeVisible();
    // 12px controls, 24px tall, and Generate the size of the PR header's buttons.
    const scale = await setupScale(browser);
    expect(scale).toEqual({
      tallest: 24,
      fonts: ["12px"],
      generate: scale.header,
      header: 24,
      overflows: false,
    });
    expect(await prScrolls(browser)).toEqual({ page: false, view: false });
    await screenshotLightAndDark(app, browser, "setup-empty");

    await setup.getByRole("button", "Generate guide").hover();
    await expect(browser.locator('[data-slot="tooltip-popup"]')).toHaveText(
      /^Generate guide ?(⌘G|Ctrl G)$/,
    );
    await browser.mouse.move(640, 760);
    await expect(browser.locator('[data-slot="tooltip-popup"]')).toHaveCount(0);
    await browser.setViewport({ width: 800, height: 700 });
    expect((await setupScale(browser)).overflows).toBe(false);
    expect(await prScrolls(browser)).toEqual({ page: false, view: false });
    await screenshotLightAndDark(app, browser, "setup-800");
    await browser.setViewport({ width: 1280, height: 800 });

    // The model and its effort, as quiet choices.
    await picker.tap();
    await screen.getByRole("combobox", "Search models").fill("opus");
    await screen.getByRole("option", /Claude Opus 5\.5/).tap();
    await expect(setup.getByRole("button", "Agent and model: Claude Opus 5.5")).toBeVisible();
    await setup.getByRole("button", /^Claude Opus 5\.5 settings: /).tap();
    await screen.getByRole("menuitemradio", "High").tap();
    await expect(setup.getByRole("button", "Claude Opus 5.5 settings: High")).toBeVisible();

    // A focus: the field opens with the cursor in it, and Cmd+G starts from there.
    await setup.getByRole("button", "Add a focus").tap();
    const focus = setup.getByRole("textbox", "Guidance for this pull request");
    await expect(focus).toBeFocused();
    await focus.fill("Explain the click counter first");
    await expect(
      setup.getByRole("group", "Guide settings").getByRole("button", "Guidance: this PR"),
    ).toBeVisible();
    await screenshotLightAndDark(app, browser, "setup-focus");
    await browser.keyboard.press(`${await modifierOf(browser)}+g`);
    // The fake GitHub serves no clone, so the attempt fails while preparing.
    await expect(screen.getByRole("alert").first()).toContainText("GitHub refused", {
      timeout: 60_000,
    });
    expect(
      readRows(
        run.home,
        `SELECT provider, model, model_options FROM reviews WHERE pr_key = '${KEY}#3'`,
      ),
    ).toEqual([
      {
        provider: "claude",
        model: "claude-opus-5-5",
        model_options: expect.stringContaining('"value":"high"'),
      },
    ]);
    expect(
      readRows(
        run.home,
        `SELECT value FROM guide_config WHERE scope = 'pull-request:${KEY}#3' AND section = 'guidance'`,
      ),
    ).toEqual([{ value: '{"text":"Explain the click counter first","mode":"append"}' }]);

    // The failed state sets up again from what was saved, focus open, without a reload.
    const again = screen.getByRole("form", "Start a guide");
    await expect(again.getByRole("textbox", "Guidance for this pull request")).toHaveValue(
      "Explain the click counter first",
      { timeout: 30_000 },
    );
    await expect(again.getByRole("button", "Claude Opus 5.5 settings: High")).toBeVisible();
    await screenshotLightAndDark(app, browser, "setup-failed-saved-guidance");
    await again.getByRole("button", "Generate guide").tap();
    await expect
      .poll(
        () =>
          readRows(
            run.home,
            `SELECT COUNT(*) AS attempts FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '${KEY}#3'`,
          ),
        { timeout: 30_000 },
      )
      .toEqual([{ attempts: 2 }]);
    await expect(again.getByRole("alert")).toHaveCount(0);

    await browser.keyboard.press(`${await modifierOf(browser)}+Comma`);
    await screen.getByRole("navigation", "Settings sections").getByRole("link", "Agents").tap();
    await expect(
      screen.getByRole("region", "Agents").getByRole("button", /^Agent and model: /),
    ).toBeVisible({ timeout: 30_000 });
    await screenshotLightAndDark(app, browser, "settings-default-agent");
  } finally {
    stopFakeInstance("guide-setup", { keepHome: false });
    fake.stop();
  }
});

test("a stacked PR's setup writes this PR, the whole stack or chosen layers, with one focus for all", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub("guide-setup-stack");
  const claude = setUpFakeClaude("guide-setup-stack");
  try {
    const run = startFakeInstance("guide-setup-stack", fake, ["--claude", claude.file]);
    await emulateOsColorScheme(browser, "light");
    await browser.setViewport({ width: 1280, height: 800 });
    await app.open(run.openUrl);
    await screen.getByRole("link", /#2 Budget fixture 2/).tap({ timeout: 20_000 });
    await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Guide").tap();
    const setup = screen.getByRole("form", "Start a guide");
    const scope = setup.getByRole("radiogroup", "Write guides for");
    await expect(scope).toBeVisible({ timeout: 30_000 });
    await expect(scope.getByRole("radio", "This PR")).toHaveAttribute("aria-checked", "true");
    await expect(setup.getByRole("button", /^Agent and model: /)).toBeVisible({ timeout: 30_000 });
    await expect(setup.getByRole("button", "Generate guide")).toHaveAttribute(
      "aria-keyshortcuts",
      /^(Meta|Control)\+G$/,
    );
    await screenshotLightAndDark(app, browser, "setup-stacked");

    // Cmd+G always means this PR, so a stack scope's button carries no shortcut.
    await scope.getByRole("radio", "Whole stack (2 PRs)").tap();
    const generate = setup.getByRole("button", "Generate 2 guides");
    await expect(generate).toBeVisible();
    await expect(generate).not.toHaveAttribute("aria-keyshortcuts", /G/);
    await setup.getByRole("button", "Add a focus").tap();
    await setup
      .getByRole("textbox", "Guidance for every chosen pull request")
      .fill("Start from the bottom layer");
    await scope.getByRole("radio", "Choose layers").tap();
    const layers = setup.getByRole("group", "Layers to write guides for");
    await expect(layers.getByRole("checkbox")).toHaveCount(2);
    await expect(layers.getByRole("checkbox", /^Layer 2: #2 /)).toBeChecked();
    await expect(setup.getByRole("button", "Generate 1 guide")).toBeVisible();
    expect(await prScrolls(browser)).toEqual({ page: false, view: false });
    await screenshotLightAndDark(app, browser, "setup-stacked-layers");

    await scope.getByRole("radio", "Whole stack (2 PRs)").tap();
    await generate.tap();
    await expect(screen.getByRole("region", "Notifications")).toContainText(
      "Writing 2 stack guides",
      { timeout: 30_000 },
    );
    expect(
      readRows(
        run.home,
        `SELECT scope, value FROM guide_config WHERE section = 'guidance' ORDER BY scope`,
      ),
    ).toEqual(
      [1, 2].map((number) => ({
        scope: `pull-request:${KEY}#${number}`,
        value: '{"text":"Start from the bottom layer","mode":"append"}',
      })),
    );
  } finally {
    stopFakeInstance("guide-setup-stack", { keepHome: false });
    fake.stop();
  }
});
