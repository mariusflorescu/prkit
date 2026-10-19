import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import * as Schema from "effect/Schema";

import * as Results from "../apps/server/src/outside/paritySchemas.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { type Bridge, startBridge } from "./outsideBridge.ts";
import { pressShortcut } from "./shortcut.ts";

const NAME = "typical-duration";
const ACCOUNT = encodeURIComponent("github.com/budget-test");
const SONNET = "claude-sonnet-5-5";
const LINES = 1;

const guideTab = (base: string, number: number) =>
  `${base}/pr/github.com/budget/fixtures/${number}?account=${ACCOUNT}&tab=guide`;

const pickSonnet = async (screen: Screen) => {
  const setup = screen.getByRole("form", "Start a guide");
  await setup.getByRole("button", /^Agent and model: /).tap({ timeout: 30_000 });
  await screen.getByRole("combobox", "Search models").fill("sonnet");
  await screen.getByRole("option", /Claude Sonnet 5\.5/).tap();
  await expect(setup.getByRole("button", "Agent and model: Claude Sonnet 5.5")).toBeVisible();
};

const pickEffort = async (screen: Screen, browser: Browser, effort: string) => {
  const setup = screen.getByRole("form", "Start a guide");
  await setup.getByRole("button", /^Claude Sonnet 5\.5 settings: /).tap();
  await screen.getByRole("menuitemradio", new RegExp(`^${effort}`)).tap();
  await expect(setup.getByRole("button", `Claude Sonnet 5.5 settings: ${effort}`)).toBeVisible();
  await expect(browser.locator('[data-slot="menu-popup"]')).toHaveCount(0);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 2_000));

/**
 * From the next click on, notes whether the page changed with the estimate still on it, which
 * `toHaveCount(0)` can't tell: it waits out a stale line until the new answer removes it.
 */
const watchForEstimate = (browser: Browser) =>
  browser.evaluate(() => {
    let armed = false;
    Reflect.set(window, "estimateSeen", false);
    document.addEventListener("click", () => (armed = true), { once: true });
    new MutationObserver(() => {
      if (armed && document.querySelector("[data-typical-duration]") !== null)
        Reflect.set(window, "estimateSeen", true);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    return null;
  });

const estimateSeen = (browser: Browser) =>
  browser.evaluate(() => Reflect.get(window, "estimateSeen"));

const durationOf = async (bridge: Bridge, input: object) => {
  const answer = await bridge.call("read_guide_duration", input);
  expect(answer).toMatchObject({ isError: false });
  if (!("json" in answer)) throw new Error("read_guide_duration returned no structured result");
  return Schema.decodeUnknownSync(Results.DurationResult)(answer.json).duration;
};

test(
  "a guide's typical time counts only past guides by the same model at the same settings",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const fake = await startFakeGitHub(NAME);
    const claude = setUpFakeClaude(NAME);
    const git = outsideGit(NAME);
    let bridge: Bridge | null = null;
    try {
      for (const number of [4, 6])
        await fake.gitHead(
          number,
          git.commit(number, {
            "src/change-0.ts": `export const change0 = "Fixture ${number}";\n`,
          }),
        );
      const run = git.start(() => startFakeInstance(NAME, fake, ["--claude", claude.file]));
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      const estimate = browser.locator("[data-typical-duration]");

      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      for (const number of [4, 6]) {
        await app.open(guideTab(run.url, number));
        await pickSonnet(screen);
        await pickEffort(screen, browser, "High");
        await expect(estimate).toHaveCount(0);
        await screen.getByRole("button", "Generate guide").tap();
        await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
          timeout: 90_000,
        });
      }
      expect(
        readRows(
          run.home,
          "SELECT outcome, model, model_options FROM review_attempts ORDER BY rowid",
        ),
      ).toEqual([
        { outcome: "accepted", model: SONNET, model_options: '[{"id":"effort","value":"high"}]' },
        { outcome: "accepted", model: SONNET, model_options: '[{"id":"effort","value":"high"}]' },
      ]);

      await app.open(guideTab(run.url, 5));
      await pickSonnet(screen);
      await pickEffort(screen, browser, "High");
      await expect(estimate).toContainText("Usually under a minute for PRs this size", {
        timeout: 30_000,
      });
      await screenshotLightAndDark(app, browser, "typical-duration-setup");

      const setup = screen.getByRole("form", "Start a guide");
      await setup.getByRole("button", /^Claude Sonnet 5\.5 settings: /).tap();
      await watchForEstimate(browser);
      await screen.getByRole("menuitemradio", /^Medium/).tap();
      await expect(setup.getByRole("button", "Claude Sonnet 5.5 settings: Medium")).toBeVisible();
      await expect(estimate).toHaveCount(0);
      await settle();
      await expect(estimate).toHaveCount(0);
      expect(await estimateSeen(browser)).toBe(false);

      await pickEffort(screen, browser, "High");
      await expect(estimate).toContainText("Usually under a minute for PRs this size");

      await setup.getByRole("button", /^Agent and model: /).tap();
      await screen.getByRole("combobox", "Search models").fill("opus");
      await watchForEstimate(browser);
      await screen.getByRole("option", /Claude Opus 5\.5/).tap();
      await expect(setup.getByRole("button", "Agent and model: Claude Opus 5.5")).toBeVisible();
      await expect(estimate).toHaveCount(0);
      await settle();
      await expect(estimate).toHaveCount(0);
      expect(await estimateSeen(browser)).toBe(false);

      await app.open(run.openUrl);
      await pressShortcut(screen, browser, "Comma");
      await screen.getByRole("link", "Outside agents").tap();
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
      bridge = startBridge(run.home, "duration client");
      await bridge.initialize();
      const listed = await bridge.call("list_agents");
      expect(listed).toMatchObject({ isError: false });
      if (!("json" in listed)) throw new Error("list_agents returned no structured result");
      const agent = Schema.decodeUnknownSync(Results.AgentsResult)(listed.json).items.find(
        (entry) => entry.kind === "claude" && entry.ready,
      );
      if (agent === undefined) throw new Error("The stand-in agent should be ready");

      const high = await durationOf(bridge, {
        instance: agent.instance,
        model: SONNET,
        options: [{ id: "effort", value: "high" }],
        lines: LINES,
      });
      expect(high?.samples).toBe(2);
      expect(
        await durationOf(bridge, { instance: agent.instance, model: SONNET, lines: LINES }),
      ).toEqual(high);
      expect(
        await durationOf(bridge, {
          instance: agent.instance,
          model: SONNET,
          options: [{ id: "effort", value: "medium" }],
          lines: LINES,
        }),
      ).toBeNull();
    } finally {
      await bridge?.stop();
      stopFakeInstance(NAME, { keepHome: false });
      fake.stop();
    }
  },
);
