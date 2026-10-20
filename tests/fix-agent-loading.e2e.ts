import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, openSendToAgent, pickModel } from "./fixActions.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const NUMBER = 4;
const KEY = `github.com/budget/fixtures#${NUMBER}`;
const FILE = "src/change-0.ts";
const SESSION_MODEL = "claude-fable-5-1";
const pull = (url: string, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${NUMBER}?account=github.com%2Fbudget-test&tab=${tab}`;

const turnsOf = (home: string) =>
  readRows(
    home,
    `SELECT t.kind, json_extract(t.status, '$._tag') AS state, t.model FROM fixer_turns t
     JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${KEY}' ORDER BY t.created_at, t.rowid`,
  ).map((turn) => ({ kind: turn.kind, state: turn.state, model: turn.model }));

const holdSessionReads = (home: string) => {
  const file = NodePath.join(home, "e2e-holds", "fix-session-read");
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.rmSync(`${file}.reached`, { force: true });
  NodeFS.writeFileSync(file, "");
  return {
    reached: () => NodeFS.existsSync(`${file}.reached`),
    release: () => NodeFS.rmSync(file, { force: true }),
  };
};

/** Clicks a form's submit button at once, without waiting for it the way a tap would. */
const clickSubmit = (browser: Fixtures["browser"], form: string) =>
  browser.evaluate((label: string) => {
    document
      .querySelector<HTMLButtonElement>(`form[aria-label="${label}"] button[type="submit"]`)
      ?.click();
    return null;
  }, form);

const layoutOf = (browser: Fixtures["browser"], form: string) =>
  browser.evaluate((label: string) => {
    const node = document.querySelector(`form[aria-label="${label}"]`);
    const submit = node?.querySelector('button[type="submit"]')?.getBoundingClientRect();
    return {
      submitTop: Math.round(submit?.top ?? -1),
      submitHeight: Math.round(submit?.height ?? -1),
      formHeight: Math.round(node?.getBoundingClientRect().height ?? -1),
    };
  }, form);

const shown = (browser: Fixtures["browser"]) =>
  expect
    .poll(() =>
      browser.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"]')].every(
          (popup) => getComputedStyle(popup).opacity === "1",
        ),
      ),
    )
    .toBe(true);

const openWithAgentsRead = async ({ app, screen }: Fixtures, url: string) => {
  await app.open(pull(url, "guide"));
  await expect(
    screen
      .getByRole("form", "Start a guide")
      .getByRole("button", "Agent and model: Claude Opus 5.5"),
  ).toBeVisible({ timeout: 30_000 });
};

test(
  "Send to agent and Resolve conflicts show and send no agent until the pull request's fix session is read",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-agent-loading";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    let home = "";
    try {
      await fake.gitHead(NUMBER, git.head(NUMBER));
      await fake.conflict(NUMBER);
      const run = git.start(() =>
        startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]),
      );
      home = run.home;
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });

      await app.open(pull(run.url, "files"));
      const line = screen
        .getByRole("region", FILE)
        .getByRole("button", /^Comment on line \d+$/)
        .first();
      await expect(line).toBeVisible({ timeout: 30_000 });
      await line.focus();
      await browser.keyboard.press("Enter");
      const composer = screen.getByRole("textbox", /^Comment on line \d+$/);
      await composer.fill("Name the change.");
      await composer.press("Meta+Enter");
      const first = await openSendToAgent(page, 1);
      await pickModel(page, first, "fable", /Claude Fable 5\.1/);
      await expect(first.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible();
      await first.getByRole("button", "Send 1 comment to agent").tap();
      await expect(first).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => turnsOf(home), { timeout: 60_000 })
        .toEqual([{ kind: "fix", state: "ready", model: SESSION_MODEL }]);
      await app.open(pull(run.url, "fixes"));
      await screen
        .getByRole("article", "Fix 1 comment: Ready to review")
        .getByRole("button", "Discard")
        .tap();
      const discarded = { kind: "fix", state: "discarded", model: SESSION_MODEL };
      await expect.poll(() => turnsOf(home), { timeout: 30_000 }).toEqual([discarded]);

      const resolveHold = holdSessionReads(home);
      try {
        await openWithAgentsRead(page, run.url);
        await screen.getByRole("button", "Resolve conflicts").tap();
        const resolve = screen.getByRole("form", "Resolve conflicts");
        await expect(resolve.getByRole("button", "Resolve with the agent")).toBeVisible({
          timeout: 30_000,
        });
        await expect.poll(resolveHold.reached, { timeout: 30_000 }).toBe(true);
        await shown(browser);
        await app.screenshot("fix-agent-loading-resolve-held");
        await clickSubmit(browser, "Resolve conflicts");
        await expect
          .poll(
            async () =>
              (await resolve.count()) === 0 ||
              (await resolve.getByLabel("Loading agents").count()) === 1,
            { timeout: 30_000 },
          )
          .toBe(true);
        expect(turnsOf(home), "no resolution starts before the session's agent is read").toEqual([
          discarded,
        ]);
        await expect(resolve.getByRole("alert")).toHaveCount(0);
        await expect(resolve.getByRole("button", "Resolve with the agent")).toBeDisabled();
        await expect(resolve.getByRole("button", /^Agent and model: /)).toHaveCount(0);
      } finally {
        resolveHold.release();
      }
      const resolve = screen.getByRole("form", "Resolve conflicts");
      await expect(resolve.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible({
        timeout: 30_000,
      });
      await shown(browser);
      await app.screenshot("fix-agent-loading-resolve-ready");
      await browser.keyboard.press("Escape");
      await expect(resolve).toHaveCount(0);

      const sendHold = holdSessionReads(home);
      let held: Awaited<ReturnType<typeof layoutOf>> | null = null;
      try {
        await openWithAgentsRead(page, run.url);
        await screen
          .getByRole("navigation", "Pull request tabs")
          .getByRole("link", /^Files/)
          .tap();
        await expect(screen.getByRole("region", FILE)).toBeVisible({ timeout: 30_000 });
        await screen.getByRole("button", "Review, 1 pending").first().tap();
        await screen
          .getByRole("group", "Where your comments go")
          .getByRole("button", "Send to agent")
          .tap();
        const send = screen.getByRole("dialog", "Send to agent");
        await expect(send.getByRole("button", "Send 1 comment to agent")).toBeVisible({
          timeout: 30_000,
        });
        await expect.poll(sendHold.reached, { timeout: 30_000 }).toBe(true);
        await expect(send.getByLabel("Loading push access")).toHaveCount(0, { timeout: 30_000 });
        await expect(send.getByLabel("Loading whether the agent runs scripts")).toHaveCount(0, {
          timeout: 30_000,
        });
        await shown(browser);
        held = await layoutOf(browser, "Send to agent");
        await screenshotLightAndDark(app, browser, "fix-agent-loading-send-held");
        await clickSubmit(browser, "Send to agent");
        await expect
          .poll(
            async () =>
              (await send.count()) === 0 || (await send.getByLabel("Loading agents").count()) === 1,
            { timeout: 30_000 },
          )
          .toBe(true);
        expect(turnsOf(home), "no fix starts before the session's agent is read").toEqual([
          discarded,
        ]);
        await expect(send.getByRole("alert")).toHaveCount(0);
        await expect(send.getByRole("button", "Send 1 comment to agent")).toBeDisabled();
        await expect(send.getByRole("button", /^Agent and model: /)).toHaveCount(0);
        await browser.setViewport({ width: 720, height: 860 });
        await shown(browser);
        await app.screenshot("fix-agent-loading-send-held-narrow");
        await browser.setViewport({ width: 1280, height: 860 });
      } finally {
        sendHold.release();
      }
      const send = screen.getByRole("dialog", "Send to agent");
      await expect(send.getByRole("button", "Agent and model: Claude Fable 5.1")).toBeVisible({
        timeout: 30_000,
      });
      expect(
        await layoutOf(browser, "Send to agent"),
        "nothing moves when the agent shows",
      ).toEqual(held);
      await screenshotLightAndDark(app, browser, "fix-agent-loading-send-ready");
      await send.getByRole("button", "Send 1 comment to agent").tap();
      await expect(send).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => turnsOf(home), { timeout: 60_000 })
        .toEqual([discarded, { kind: "fix", state: "ready", model: SESSION_MODEL }]);
      expect(
        claude.runs().map((ran) => ran.model),
        "every turn ran on the session's model",
      ).toEqual([SESSION_MODEL, SESSION_MODEL]);
    } finally {
      if (home !== "")
        NodeFS.rmSync(NodePath.join(home, "e2e-holds", "fix-session-read"), { force: true });
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
