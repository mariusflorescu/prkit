import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

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
import { emulateOsColorScheme, readPageTheme, screenshotLightAndDark } from "./osColorScheme.ts";

type Fixtures = Pick<TestFixtures, "app" | "screen"> & { browser: Browser };

const WIDTHS = [
  { label: "wide", width: 1280 },
  { label: "narrow", width: 760 },
] as const;

const database = (home: string) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
};

/**
 * Makes every write to one of prkit's tables fail inside its own SQLite, the way a full disk
 * or a damaged file would, until the returned function lets writes through again.
 */
const refuseWrites = (home: string, table: string) => {
  const events = ["insert", "update", "delete"];
  const exec = (statements: ReadonlyArray<string>) => {
    const db = database(home);
    try {
      for (const statement of statements) db.exec(statement);
    } finally {
      db.close();
    }
  };
  exec(
    events.map(
      (event) =>
        `CREATE TRIGGER e2e_refuse_${event} BEFORE ${event.toUpperCase()} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'e2e refuses writes to ${table}'); END`,
    ),
  );
  return () => exec(events.map((event) => `DROP TRIGGER IF EXISTS e2e_refuse_${event}`));
};

/**
 * Takes SQLite's write lock the way another process writing would, so prkit's next save waits
 * on it (up to its 5 second busy timeout) until the returned function lets go.
 */
const holdWrites = (home: string) => {
  const db = database(home);
  db.exec("BEGIN IMMEDIATE");
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
};

/** The last control that saves: the last match of `selector`, with `text` in it when given. */
type Mark = { selector: string; text?: string };

/**
 * The top of every control in Settings, from the first one down to the marked one, leaving out
 * the buttons of alerts. A save's error must not move any of them.
 */
const controlsDownTo = (browser: Browser, last: Mark) =>
  browser.evaluate(({ selector, text }: Mark) => {
    const end = [...document.querySelectorAll(selector)]
      .filter((node) => text === undefined || node.textContent?.includes(text))
      .at(-1);
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
      const end = [...document.querySelectorAll(selector)]
        .filter((node) => text === undefined || node.textContent?.includes(text))
        .at(-1);
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
 * Taps, waits for the save to fail with `message`, and checks that the error sits below the
 * controls with nothing above it moved, and that its Retry stands alone, with no "Try again".
 */
const failAndHold = async (
  { screen, browser }: Fixtures,
  { last, tap, message }: { last: Mark; tap: () => Promise<void>; message: string },
) => {
  const before = await controlsDownTo(browser, last);
  expect(before, `${last.selector} is on the page`).not.toBeNull();
  await tap();
  const alert = screen.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible({ timeout: 20_000 });
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
              });
              await expect(theme.getByRole("radio", "System")).toBeChecked();
              await expect(theme.getByRole("radio", "Dark")).toBeEnabled();
              expect(await readPageTheme(browser)).toMatchObject({ dark: false, choice: "system" });
              expect(setting(run.home, "appearance.theme")).toEqual([]);
              await screenshotLightAndDark(
                app,
                browser,
                `settings-failed-appearance-${width.label}`,
              );
            },
          );
        } finally {
          allow();
        }
        await theme.getByText("Light").tap();
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"light"']);
        await expect(screen.getByRole("alert").filter({ hasText: message })).toHaveCount(0);

        // While a save waits, the cards show the theme being saved and take no second pick.
        const release = holdWrites(run.home);
        try {
          await theme.getByText("Dark").tap();
          await expect(theme.getByRole("radio", "Dark")).toBeChecked();
          await expect(theme.getByRole("radio", "Light")).toBeDisabled();
          await app.screenshot("settings-failed-appearance-saving");
        } finally {
          release();
        }
        await expect(theme.getByRole("radio", "Light")).toBeEnabled({ timeout: 20_000 });
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"dark"']);

        // Retry sends the failed pick again.
        const refuse = refuseWrites(run.home, "settings");
        try {
          await failAndHold(fixtures, {
            last: cards,
            tap: () => theme.getByText("System").tap(),
            message,
          });
          await expect(theme.getByRole("radio", "Dark")).toBeChecked();
        } finally {
          refuse();
        }
        await screen
          .getByRole("alert")
          .filter({ hasText: message })
          .getByRole("button", "Retry")
          .tap();
        await expect(theme.getByRole("radio", "System")).toBeChecked();
        await expect(screen.getByRole("alert").filter({ hasText: message })).toHaveCount(0);
        await expect.poll(() => setting(run.home, "appearance.theme")).toEqual(['"system"']);
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
              });
              await expect(auto).toHaveAttribute("aria-checked", "false");
              await expect(auto).toBeEnabled();
              expect(setting(run.home, "guides.autoAccounts")).toEqual([]);
              await screenshotLightAndDark(
                app,
                browser,
                `settings-failed-auto-guides-${width.label}`,
              );
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
              });
              await expect(guidance).toHaveValue("Lead with the API changes.");
              await expect(save).toBeEnabled();
              expect(readRows(run.home, "SELECT value FROM guide_config")).toEqual([]);
              await screenshotLightAndDark(app, browser, `settings-failed-guidance-${width.label}`);
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
              });
              await expect(picker).toHaveAttribute("aria-label", label ?? "");
              await expect(picker).toBeEnabled();
              expect(setting(run.home, "guides.defaultAgent")).toEqual(stored);
              await screenshotLightAndDark(
                app,
                browser,
                `settings-failed-default-agent-${width.label}`,
              );
            },
          );
        } finally {
          allow();
        }

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
        const refuse = refuseWrites(run.home, "agent_instances");
        try {
          await codex.tap();
          await expect(screen.getByText("Couldn't change the agent", { exact: true })).toBeVisible({
            timeout: 20_000,
          });
          await expect(codex).toHaveAttribute("aria-checked", "false");
          expect(
            readRows(run.home, "SELECT enabled FROM agent_instances WHERE id = 'codex'"),
          ).toEqual([{ enabled: 0 }]);
        } finally {
          refuse();
        }
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
              });
              await expect(remove).toBeEnabled();
              expect(readRows(run.home, "SELECT path FROM github_config_dirs")).toEqual([
                { path: extra },
              ]);
              await screenshotLightAndDark(app, browser, `settings-failed-accounts-${width.label}`);
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
