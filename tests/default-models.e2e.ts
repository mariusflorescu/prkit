import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { type FakeCodexModel, setUpFakeCodex } from "./fakeCodex.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, latestTurn, sendLineToAgent } from "./fixActions.ts";
import { readRows } from "./fixturePr.ts";
import { screenshotLightAndDark, emulateOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { pressShortcut } from "./shortcut.ts";

const FILE = "src/change-0.ts";
const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const pull = (url: string, number: number, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=${tab}`;

const efforts = (...ids: ReadonlyArray<string>) =>
  ids.map((reasoningEffort) => ({ reasoningEffort }));
const ALL = efforts("low", "medium", "high", "xhigh", "max");
const listed = (
  model: string,
  displayName: string,
  defaultReasoningEffort: string,
  options: { isDefault?: boolean; efforts?: FakeCodexModel["supportedReasoningEfforts"] } = {},
): FakeCodexModel => ({
  model,
  displayName,
  isDefault: options.isDefault === true,
  defaultReasoningEffort,
  supportedReasoningEfforts: options.efforts ?? ALL,
});

const rigUp = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const codex = setUpFakeCodex(name);
  const git = outsideGit(name);
  for (const number of [4, 6, 9]) await fake.gitHead(number, git.head(number));
  const launch = () =>
    git.start(() =>
      startFakeInstance(name, fake, ["--claude", claude.file, "--codex", codex.file]),
    );
  return { fake, claude, codex, launch };
};

const openAgents = async ({ screen, browser }: Pick<Fixtures, "screen" | "browser">) => {
  await pressShortcut(screen, browser, "Comma");
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "Agents").tap();
  const agents = screen.getByRole("region", "Agents");
  await expect(agents.getByRole("list", "Agents")).toBeVisible({ timeout: 30_000 });
  return agents;
};

const openSetup = async (
  { app, screen }: Pick<Fixtures, "app" | "screen">,
  url: string,
  number: number,
) => {
  await app.open(pull(url, number, "guide"));
  const setup = screen.getByRole("form", "Start a guide");
  await expect(setup).toBeVisible({ timeout: 30_000 });
  return setup;
};

const generate = async (
  { screen }: Pick<Fixtures, "screen">,
  setup: ReturnType<Fixtures["screen"]["getByRole"]>,
) => {
  await setup.getByRole("button", "Generate guide").tap();
  await expect(screen.getByRole("heading", "Every change")).toBeVisible({ timeout: 90_000 });
};

const open = async ({ app, screen }: Pick<Fixtures, "app" | "screen">, url: string) => {
  await app.open(url);
  await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
};

const turnClaudeOff = async (agents: ReturnType<Fixtures["screen"]["getByRole"]>) => {
  const list = agents.getByRole("list", "Agents");
  await list.getByRole("switch", "Claude on").tap();
  await expect(list.getByRole("listitem", "Claude").getByRole("status")).toHaveText("Off");
};

test(
  "with nothing saved, a guide starts on Claude Opus 5.5 at Extra High",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "default-models-claude";
    const { fake, claude, launch } = await rigUp(name);
    const page: Fixtures = { app, screen, browser };
    try {
      const run = launch();
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await open(page, run.openUrl);

      const agents = await openAgents(page);
      await expect(agents.getByRole("button", "Agent and model: Claude Opus 5.5")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        agents.getByRole("button", "Claude Opus 5.5 settings: Extra High"),
      ).toBeVisible();
      await screenshotLightAndDark(app, browser, "default-models-settings-default-agent");

      const setup = await openSetup(page, run.url, 9);
      await expect(setup.getByRole("button", "Agent and model: Claude Opus 5.5")).toBeVisible({
        timeout: 30_000,
      });
      await expect(setup.getByRole("button", "Claude Opus 5.5 settings: Extra High")).toBeVisible();

      await setup.getByRole("button", /^Agent and model: /).tap();
      await expect(screen.getByRole("option", /Claude Opus 5\.5/)).toContainText("Default");
      await expect(screen.getByRole("option", /Claude Fable 5\.1/)).not.toContainText("Default");
      await screenshotLightAndDark(app, browser, "default-models-model-picker");
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("combobox", "Search models")).toHaveCount(0);

      await setup.getByRole("button", /^Claude Opus 5\.5 settings: /).tap();
      await expect(screen.getByRole("menuitemradio", /^Extra High/)).toContainText("Default");
      await expect(screen.getByRole("menuitemradio", /^Extra High/)).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(screen.getByRole("menuitemradio", /^Medium/)).not.toContainText("Default");
      await screenshotLightAndDark(app, browser, "default-models-effort-menu");
      await browser.keyboard.press("Escape");
      await expect(screen.getByRole("menuitemradio", /^Extra High/)).toHaveCount(0);

      await generate(page, setup);
      expect(claude.runs().at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });

      await screen.getByRole("link", "Inbox").tap();
      await screen.getByRole("link", /#4 /).hover();
      await screen.getByRole("button", "Generate guide for budget/fixtures #4").tap();
      await expect
        .poll(
          () =>
            readRows(
              run.home,
              `SELECT json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '${keyOf(4)}'`,
            ),
          { timeout: 90_000 },
        )
        .toEqual([{ state: "watching" }]);
      expect(claude.runs()).toHaveLength(2);
      expect(claude.runs().at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });

      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => latestTurn(run.home)?.state, { timeout: 90_000 }).toBe("ready");
      expect(claude.runs()).toHaveLength(3);
      expect(claude.runs().at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "Codex alone starts on GPT-6.1-Sol at Extra High, even when its list pages and another model leads",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "default-models-codex";
    const { fake, codex, launch } = await rigUp(name);
    const page: Fixtures = { app, screen, browser };
    try {
      codex.models([
        listed("gpt-6-luna", "GPT-6-Luna", "medium", { isDefault: true }),
        listed("gpt-6.1-sol", "GPT-6.1-Sol", "low"),
      ]);
      codex.pageSize(1);
      const run = launch();
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await open(page, run.openUrl);
      await turnClaudeOff(await openAgents(page));

      const setup = await openSetup(page, run.url, 9);
      await expect(setup.getByRole("button", "Agent and model: GPT-6.1-Sol")).toBeVisible({
        timeout: 30_000,
      });
      await expect(setup.getByRole("button", "GPT-6.1-Sol settings: Extra High")).toBeVisible();
      await screenshotLightAndDark(app, browser, "default-models-codex-setup");

      await generate(page, setup);
      expect(codex.runs().at(-1)).toMatchObject({ model: "gpt-6.1-sol", effort: "xhigh" });
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "a Codex login that lacks GPT-6.1-Sol, or its Extra High, keeps Codex's own default",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "default-models-luna";
    const { fake, codex, launch } = await rigUp(name);
    const page: Fixtures = { app, screen, browser };
    try {
      codex.models([
        listed("gpt-6-luna", "GPT-6-Luna", "medium", { isDefault: true }),
        listed("gpt-6-sol", "GPT-6-Sol", "medium"),
      ]);
      const run = launch();
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await open(page, run.openUrl);
      await turnClaudeOff(await openAgents(page));

      const setup = await openSetup(page, run.url, 9);
      await expect(setup.getByRole("button", "Agent and model: GPT-6-Luna")).toBeVisible({
        timeout: 30_000,
      });
      await expect(setup.getByRole("button", "GPT-6-Luna settings: Medium")).toBeVisible();
      await generate(page, setup);
      expect(codex.runs().at(-1)).toMatchObject({ model: "gpt-6-luna", effort: "medium" });

      codex.models([
        listed("gpt-6-luna", "GPT-6-Luna", "medium", { isDefault: true }),
        listed("gpt-6.1-sol", "GPT-6.1-Sol", "low", { efforts: efforts("low", "medium", "high") }),
      ]);
      const checked = await openAgents(page);
      await checked.getByRole("button", "Check again").tap();
      await checked.getByRole("button", /^Agent and model: /).tap();
      await expect(screen.getByRole("option", /GPT-6\.1-Sol/)).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("option", /GPT-6\.1-Sol/)).not.toContainText("Default");
      await expect(screen.getByRole("option", /GPT-6-Luna/)).toContainText("Default");
      await browser.keyboard.press("Escape");
      const again = await openSetup(page, run.url, 6);
      await expect(again.getByRole("button", "Agent and model: GPT-6-Luna")).toBeVisible({
        timeout: 30_000,
      });
      await expect(again.getByRole("button", "GPT-6-Luna settings: Medium")).toBeVisible();
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "a saved default still wins, and keeps winning after prkit restarts",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "default-models-saved";
    const { fake, claude, launch } = await rigUp(name);
    const page: Fixtures = { app, screen, browser };
    try {
      let run = launch();
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await open(page, run.openUrl);

      const agents = await openAgents(page);
      await agents.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
      await screen.getByRole("combobox", "Search models").fill("fable");
      await screen.getByRole("option", /Claude Fable 5\.1/).tap();
      await expect(agents.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible();
      await expect(agents.getByRole("button", "Claude Fable 5.1 settings: Medium")).toBeVisible();
      await expect
        .poll(() =>
          readRows(run.home, "SELECT value FROM settings WHERE key = 'guides.defaultAgent'"),
        )
        .toEqual([{ value: '{"instance":"claude","model":"claude-fable-5-1","options":[]}' }]);

      const setup = await openSetup(page, run.url, 9);
      await expect(setup.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible({
        timeout: 30_000,
      });
      await expect(setup.getByRole("button", "Claude Fable 5.1 settings: Medium")).toBeVisible();
      await generate(page, setup);
      expect(claude.runs().at(-1)).toMatchObject({ model: "claude-fable-5-1", effort: "medium" });

      stopFakeInstance(name, { keepHome: true });
      run = launch();
      await open(page, run.openUrl);
      const restarted = await openAgents(page);
      await expect(restarted.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        restarted.getByRole("button", "Claude Fable 5.1 settings: Medium"),
      ).toBeVisible();
      const again = await openSetup(page, run.url, 6);
      await expect(again.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible({
        timeout: 30_000,
      });
      await generate(page, again);
      expect(claude.runs()).toHaveLength(2);
      expect(claude.runs().at(-1)).toMatchObject({ model: "claude-fable-5-1", effort: "medium" });
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
