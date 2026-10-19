import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, describe, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { holdWrites, refuseWrites } from "./sqliteFaults.ts";
import { emulateOsColorScheme, readPageTheme, screenshotLightAndDark } from "./osColorScheme.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const WIDTHS = [
  { label: "wide", width: 1280 },
  { label: "narrow", width: 760 },
] as const;

/** The last control that saves: the last match of `selector` outside an alert, with `text` in it when given. */
type Mark = { selector: string; text?: string };

/**
 * The top of every control in Settings, from the first one down to the marked one, leaving out
 * the buttons of alerts. A save's error must not move any of them.
 */
const controlsDownTo = (browser: Browser, last: Mark) =>
  browser.evaluate(({ selector, text }: Mark) => {
    const end = [...document.querySelectorAll(selector)].findLast(
      (node) =>
        node.closest('[role="alert"]') === null &&
        (text === undefined || node.textContent?.includes(text) === true),
    );
    if (end === undefined) return null;
    return [
      ...document.querySelectorAll(
        'main :is(button, input, textarea, [role="switch"], [role="combobox"])',
      ),
    ]
      .filter((control) => control.closest('[role="alert"]') === null)
      .filter(
        (control) =>
          control === end ||
          (control.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      )
      .map((control) => Math.round(control.getBoundingClientRect().top));
  }, last);

/** Whether the alert saying `said` starts below the marked control. */
const alertBelow = (browser: Browser, last: Mark, said: string) =>
  browser.evaluate(
    ({ selector, text, message }: Mark & { message: string }) => {
      const end = [...document.querySelectorAll(selector)].findLast(
        (node) =>
          node.closest('[role="alert"]') === null &&
          (text === undefined || node.textContent?.includes(text) === true),
      );
      const alert = [...document.querySelectorAll('main [role="alert"]')].find((node) =>
        node.textContent?.includes(message),
      );
      if (end === undefined || alert === undefined) return null;
      return alert.getBoundingClientRect().top >= end.getBoundingClientRect().bottom;
    },
    { ...last, message: said },
  );

const setting = (home: string, key: string) =>
  readRows(home, `SELECT value FROM settings WHERE key = '${key}'`).map((row) => row.value);

const launch = async (
  name: string,
  { app, screen, browser }: Fixtures,
  extra: ReadonlyArray<string> = [],
) => {
  const fake = await startFakeGitHub(name);
  const run = startFakeInstance(name, fake, extra);
  await emulateOsColorScheme(browser, "light");
  await browser.setViewport({ width: 1280, height: 720 });
  await app.open(run.openUrl);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  return { fake, run };
};

const stop = (name: string, fake: FakeGitHub) => {
  stopFakeInstance(name, { keepHome: false });
  fake.stop();
};

const openSection = async ({ screen, browser }: Fixtures, section: string) => {
  const modifier = await browser.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await browser.keyboard.press(`${modifier}+Comma`);
  await screen.getByRole("navigation", "Settings sections").getByRole("link", section).tap();
};

/**
 * Taps, waits for the save to fail with `message`, keeps light and dark frames of it, and checks
 * that the error sits below the controls with nothing above it moved, and that its Retry stands
 * alone, with no "Try again".
 */
const failAndHold = async (
  { app, screen, browser }: Fixtures,
  {
    last,
    tap,
    message,
    frame,
  }: { last: Mark; tap: () => Promise<void>; message: string; frame: string },
) => {
  const before = await controlsDownTo(browser, last);
  expect(before, `${last.selector} is on the page`).not.toBeNull();
  await tap();
  const alert = screen.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  // Kept before anything is checked, so a run against an older build keeps its frames too.
  await screenshotLightAndDark(app, browser, frame);
  await expect
    .poll(() => controlsDownTo(browser, last), { message: "nothing moves when the error shows" })
    .toEqual(before);
  expect(await alertBelow(browser, last, message), "the error sits below the controls").toBe(true);
  await expect(alert.getByRole("button", "Retry")).toBeVisible();
  await expect(alert).not.toContainText("Try again");
};

/** Each width in turn, from a fresh page, so every failure starts with no error showing. */
const atEachWidth = async (
  { browser }: Fixtures,
  ready: () => Promise<void>,
  body: (width: (typeof WIDTHS)[number]) => Promise<void>,
) => {
  for (const width of WIDTHS) {
    await browser.setViewport({ width: width.width, height: 720 });
    await browser.reload();
    await ready();
    await body(width);
  }
  await browser.setViewport({ width: 1280, height: 720 });
};

describe("settings failed saves", { tags: ["settings-failed-saves"] }, () => {
  test(
    "a theme that fails to save stays on what prkit holds, says why below the cards, and Retry saves it",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "settings-failed-appearance";
      const fixtures = { app, screen, browser };
      const { fake, run } = await launch(name, fixtures);
      const theme = screen.getByRole("radiogroup", "Theme");
      const cards = { selector: '[role="radiogroup"][aria-label="Theme"] input' };
      const message = "prkit couldn't save your appearance.";
      try {
        await openSection(fixtures, "Appearance");
        const allow = refuseWrites(run.home, "settings");
        try {
          await atEachWidth(
            fixtures,
            () => expect(theme.getByRole("radio", "System")).toBeChecked({ timeout: 20_000 }),
            async (width) => {
              await failAndHold(fixtures, {
                last: cards,
                tap: () => theme.getByText("Dark").tap(),
                message,
                frame: `settings-failed-appearance-${width.label}`,
              });
              await expect(theme.getByRole("radio", "System")).toBeChecked();
              await expect(theme.getByRole("radio", "Dark")).toBeEnabled();
              expect(await readPageTheme(browser)).toMatchObject({ dark: false, choice: "system" });
              expect(setting(run.home, "appearance.theme")).toEqual([]);
            },
          );
        } finally {
          allow();
        }
        await theme.getByText("Light").tap();
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"light"']);
        await expect(screen.getByRole("alert").filter({ hasText: message })).toHaveCount(0);

        // While a save waits, the cards show the theme being saved, dimmed, and take no second pick.
        // The hold ends well inside prkit's 5 second busy timeout, so the save then succeeds.
        const release = holdWrites(run.home);
        let saving: { dark: boolean; dimmed: string | null } | null = null;
        try {
          await theme.getByText("Dark").tap();
          await expect(theme.getByRole("radio", "Dark")).toBeChecked();
          // A click on Light right away, without waiting for the cards like a tap would.
          saving = await browser.evaluate(() => {
            const radio = (value: string) =>
              document.querySelector<HTMLInputElement>(`input[name="theme"][value="${value}"]`);
            radio("light")?.closest("label")?.click();
            return {
              dark: radio("dark")?.checked ?? false,
              dimmed: radio("light")?.getAttribute("aria-disabled") ?? null,
            };
          });
          await app.screenshot("settings-failed-appearance-saving");
        } finally {
          release();
        }
        expect(saving, "the pick shows, dimmed, and a second one is refused").toEqual({
          dark: true,
          dimmed: "true",
        });
        await expect(theme.getByRole("radio", "Light")).toHaveAttribute("aria-disabled", "false", {
          timeout: 20_000,
        });
        await expect(theme.getByRole("radio", "Dark")).toBeChecked();
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"dark"']);

        // The arrow keys walk the cards, and focus stays on each pick once it saves.
        const focused = () =>
          browser.evaluate(() =>
            document.activeElement instanceof HTMLInputElement
              ? document.activeElement.value
              : null,
          );
        await theme.getByText("Dark").tap();
        for (const next of ["light", "system"]) {
          await browser.keyboard.press("ArrowLeft");
          await expect.poll(() => setting(run.home, "appearance.theme")).toEqual([`"${next}"`]);
          await expect.poll(focused).toBe(next);
        }

        // Retry sends the failed pick again.
        const refuse = refuseWrites(run.home, "settings");
        try {
          await failAndHold(fixtures, {
            last: cards,
            tap: () => theme.getByText("Dark").tap(),
            message,
            frame: "settings-failed-appearance-retry",
          });
          await expect(theme.getByRole("radio", "System")).toBeChecked();
        } finally {
          refuse();
        }
        await screen
          .getByRole("alert")
          .filter({ hasText: message })
          .getByRole("button", "Retry")
          .tap();
        await expect(theme.getByRole("radio", "Dark")).toBeChecked();
        await expect(screen.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"dark"']);
      } finally {
        stop(name, fake);
      }
    },
  );

  test(
    "an automatic guides switch and guidance that fail to save say why below them, and nothing moves",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "settings-failed-guides";
      const fixtures = { app, screen, browser };
      const { fake, run } = await launch(name, fixtures);
      const guides = screen.getByRole("region", "Guides");
      const auto = guides.getByRole("switch", /^Write guides automatically for /);
      const guidance = guides.getByRole("textbox", "Global guidance");
      const save = guides.getByRole("button", "Save guidance");
      const message = "prkit couldn't save your guide settings.";
      try {
        await openSection(fixtures, "Guides");
        const allowSettings = refuseWrites(run.home, "settings");
        try {
          await atEachWidth(
            fixtures,
            () => expect(auto).toHaveAttribute("aria-checked", "false", { timeout: 20_000 }),
            async (width) => {
              await failAndHold(fixtures, {
                last: { selector: '[aria-label="Automatic guides by account"] [role="switch"]' },
                tap: () => auto.tap(),
                message,
                frame: `settings-failed-auto-guides-${width.label}`,
              });
              await expect(auto).toHaveAttribute("aria-checked", "false");
              await expect(auto).toBeEnabled();
              expect(setting(run.home, "guides.autoAccounts")).toEqual([]);
            },
          );
        } finally {
          allowSettings();
        }

        // Guidance is a draft with its own Save: a failed save keeps the words, still unsaved.
        const allowConfig = refuseWrites(run.home, "guide_config");
        try {
          await atEachWidth(
            fixtures,
            () => expect(guidance).toBeEnabled({ timeout: 20_000 }),
            async (width) => {
              await guidance.fill("Lead with the API changes.");
              await save.scrollIntoView();
              await failAndHold(fixtures, {
                last: { selector: 'form[aria-label="Global guidance"] :is(button, textarea)' },
                tap: () => save.tap(),
                message,
                frame: `settings-failed-guidance-${width.label}`,
              });
              await expect(guidance).toHaveValue("Lead with the API changes.");
              await expect(save).toBeEnabled();
              expect(readRows(run.home, "SELECT value FROM guide_config")).toEqual([]);
            },
          );
        } finally {
          allowConfig();
        }
        await guides
          .getByRole("alert")
          .filter({ hasText: message })
          .getByRole("button", "Retry")
          .tap();
        await expect(save).toHaveCount(0, { timeout: 20_000 });
        await expect(guidance).toHaveValue("Lead with the API changes.");
        expect(
          readRows(run.home, "SELECT value FROM guide_config")
            .map((row) => String(row.value))
            .join(),
        ).toContain("Lead with the API changes.");
      } finally {
        stop(name, fake);
      }
    },
  );

  test(
    "a default agent or agent switch that fails to save stays on what prkit holds and says why",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "settings-failed-agents";
      const fixtures = { app, screen, browser };
      const claude = setUpFakeClaude(name);
      const { fake, run } = await launch(name, fixtures, ["--claude", claude.file]);
      const agents = screen.getByRole("region", "Agents");
      const picker = agents.getByRole("button", /^Agent and model: /);
      const codex = agents.getByRole("switch", "Codex on");
      const message = "prkit couldn't save your guide settings.";
      try {
        await openSection(fixtures, "Agents");
        await expect(picker).toBeEnabled({ timeout: 30_000 });
        const label = await picker.getAttribute("aria-label");
        const stored = setting(run.home, "guides.defaultAgent");
        const allow = refuseWrites(run.home, "settings");
        try {
          await atEachWidth(
            fixtures,
            () => expect(picker).toHaveAttribute("aria-label", label ?? "", { timeout: 30_000 }),
            async (width) => {
              await picker.scrollIntoView();
              await failAndHold(fixtures, {
                last: { selector: '[aria-label^="Agent and model: "]' },
                tap: async () => {
                  await picker.tap();
                  await screen.getByRole("combobox", "Search models").fill("haiku");
                  await screen.getByRole("option", /Haiku/).first().tap();
                },
                message,
                frame: `settings-failed-default-agent-${width.label}`,
              });
              await expect(picker).toHaveAttribute("aria-label", label ?? "");
              await expect(picker).toBeEnabled();
              expect(setting(run.home, "guides.defaultAgent")).toEqual(stored);
              // The default agent ends the page, so its error can start at the window's bottom edge.
              await screen.getByRole("alert").filter({ hasText: message }).scrollIntoView();
              await screenshotLightAndDark(
                app,
                browser,
                `settings-failed-default-agent-${width.label}-scrolled`,
              );
            },
          );
        } finally {
          allow();
        }

        // From the top of a fresh page: at the end of a scrolled page, a card that shrinks clamps the
        // scroll, and Chrome's scroll anchoring scrolls back on the next growth, error or not.
        await browser.reload();
        await expect(codex).toBeEnabled({ timeout: 30_000 });
        // An agent's switch shows the change being saved while it waits, and prkit's answer after.
        await expect(codex).toHaveAttribute("aria-checked", "true");
        const release = holdWrites(run.home);
        try {
          await codex.tap();
          await expect(codex).toHaveAttribute("aria-checked", "false");
          await expect(codex).toBeDisabled();
        } finally {
          release();
        }
        await expect(screen.getByText("Turned off Codex", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        await expect(codex).toHaveAttribute("aria-checked", "false");
        await expect(codex).toBeEnabled();
        const agentMessage = "prkit couldn't save that agent.";
        const enabled = () =>
          readRows(run.home, "SELECT enabled FROM agent_instances WHERE id = 'codex'");
        const refuse = refuseWrites(run.home, "agent_instances");
        try {
          await failAndHold(fixtures, {
            last: { selector: '[role="switch"][aria-label="Codex on"]' },
            tap: () => codex.tap(),
            message: agentMessage,
            frame: "settings-failed-agent-switch",
          });
          await expect(codex).toHaveAttribute("aria-checked", "false");
          expect(enabled()).toEqual([{ enabled: 0 }]);
        } finally {
          refuse();
        }
        // Retry sends the switch again, showing it while it waits.
        const retrying = holdWrites(run.home);
        try {
          await agents
            .getByRole("alert")
            .filter({ hasText: agentMessage })
            .getByRole("button", "Retry")
            .tap();
          await expect(codex).toHaveAttribute("aria-checked", "true");
        } finally {
          retrying();
        }
        await expect.poll(enabled, { timeout: 20_000 }).toEqual([{ enabled: 1 }]);
        await expect(agents.getByRole("alert").filter({ hasText: agentMessage })).toHaveCount(0);

        // Reset to default asks first; a reset that fails leaves the dialog's buttons where they were.
        const card = agents.getByRole("list", "Agents").getByRole("listitem", "Codex");
        await card.getByRole("button", "Reset to default").tap();
        const confirm = screen.getByRole("alertdialog", "Reset Codex to default?");
        await expect(confirm).toBeVisible();
        const dialogButtons = () =>
          browser.evaluate(() =>
            [...document.querySelectorAll('[role="alertdialog"] button')]
              .filter((button) => button.closest('[role="alert"]') === null)
              .map((button) => {
                const box = button.getBoundingClientRect();
                return [Math.round(box.left), Math.round(box.top)];
              }),
          );
        // Measured once the dialog's opening scale has settled.
        await browser.evaluate(async () => {
          const dialog = document.querySelector('[role="alertdialog"]');
          await Promise.all(dialog?.getAnimations().map((animation) => animation.finished) ?? []);
          return null;
        });
        const beforeReset = await dialogButtons();
        const refuseReset = refuseWrites(run.home, "agent_instances");
        try {
          await confirm.getByRole("button", "Reset").tap();
          await expect(confirm.getByRole("alert")).toHaveText("prkit couldn't remove that agent.", {
            timeout: 20_000,
          });
          expect(await dialogButtons(), "the dialog's buttons stay put").toEqual(beforeReset);
          await app.screenshot("settings-failed-agent-reset");
        } finally {
          refuseReset();
        }
        await confirm.getByRole("button", "Cancel").tap();
        await expect(confirm).toBeHidden();

        // Edit is a draft with its own Save: a failed save keeps the words, with Retry below.
        await expect(screen.getByText(/^Turned (on|off) Codex$/)).toHaveCount(0, {
          timeout: 20_000,
        });
        await card.getByRole("button", "Edit").tap();
        const editor = card.getByRole("form", "Edit Codex");
        await editor.getByRole("textbox", "Label").fill("Codex work");
        await editor.getByRole("button", "Save").scrollIntoView();
        const refuseEdit = refuseWrites(run.home, "agent_instances");
        try {
          await failAndHold(fixtures, {
            last: { selector: 'form[aria-label="Edit Codex"] button' },
            tap: () => editor.getByRole("button", "Save").tap(),
            message: agentMessage,
            frame: "settings-failed-agent-edit",
          });
          await expect(editor.getByRole("textbox", "Label")).toHaveValue("Codex work");
          await editor.getByRole("alert").scrollIntoView();
          await screenshotLightAndDark(app, browser, "settings-failed-agent-edit-scrolled");
        } finally {
          refuseEdit();
        }
        await editor.getByRole("alert").getByRole("button", "Retry").tap();
        await expect(screen.getByText("Saved Codex work", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        expect(readRows(run.home, "SELECT label FROM agent_instances WHERE id = 'codex'")).toEqual([
          { label: "Codex work" },
        ]);

        // A switch's Retry after an Edit saved meanwhile turns it off and keeps the Edit.
        const renamed = agents.getByRole("switch", "Codex work on");
        const refuseSwitch = refuseWrites(run.home, "agent_instances");
        try {
          await renamed.tap();
          await expect(agents.getByRole("alert").filter({ hasText: agentMessage })).toBeVisible({
            timeout: 20_000,
          });
        } finally {
          refuseSwitch();
        }
        const work = agents.getByRole("list", "Agents").getByRole("listitem", "Codex work");
        await work.getByRole("button", "Edit").tap();
        const workEditor = work.getByRole("form", "Edit Codex work");
        await workEditor.getByRole("textbox", "Label").fill("Codex day");
        await workEditor.getByRole("button", "Save").tap();
        await expect(screen.getByText("Saved Codex day", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        await agents
          .getByRole("alert")
          .filter({ hasText: agentMessage })
          .getByRole("button", "Retry")
          .tap();
        await expect(screen.getByText("Turned off Codex day", { exact: true })).toBeVisible({
          timeout: 20_000,
        });
        expect(
          readRows(run.home, "SELECT label, enabled FROM agent_instances WHERE id = 'codex'"),
        ).toEqual([{ label: "Codex day", enabled: 0 }]);
      } finally {
        stop(name, fake);
      }
    },
  );

  test(
    "a gh config directory that fails to be removed stays listed, says why below the list, and Retry removes it",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "settings-failed-accounts";
      const fixtures = { app, screen, browser };
      const { fake, run } = await launch(name, fixtures);
      const accounts = screen.getByRole("region", "GitHub accounts");
      const remove = accounts.getByRole("button", "Remove");
      const extra = NodePath.join(fake.home, "extra-gh");
      // A gh config directory nobody is logged in to yet: it lists no accounts but can be added.
      NodeFS.mkdirSync(extra, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(extra, "hosts.yml"), "");
      const message = "Couldn't remove this directory.";
      try {
        await openSection(fixtures, "Accounts");
        await accounts.getByRole("textbox", "Add gh config directory").fill("~/extra-gh");
        await accounts.getByRole("button", "Add directory").tap();
        await expect(remove).toBeVisible({ timeout: 20_000 });
        const allow = refuseWrites(run.home, "github_config_dirs");
        try {
          await atEachWidth(
            fixtures,
            () => expect(remove).toBeEnabled({ timeout: 20_000 }),
            async (width) => {
              await failAndHold(fixtures, {
                last: { selector: "main button", text: "Remove" },
                tap: () => remove.tap(),
                message,
                frame: `settings-failed-accounts-${width.label}`,
              });
              await expect(remove).toBeEnabled();
              expect(readRows(run.home, "SELECT path FROM github_config_dirs")).toEqual([
                { path: extra },
              ]);
            },
          );
        } finally {
          allow();
        }
        await accounts
          .getByRole("alert")
          .filter({ hasText: message })
          .getByRole("button", "Retry")
          .tap();
        await expect(remove).toHaveCount(0, { timeout: 20_000 });
        expect(readRows(run.home, "SELECT path FROM github_config_dirs")).toEqual([]);
      } finally {
        stop(name, fake);
      }
    },
  );
});
