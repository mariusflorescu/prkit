import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { setUpFakeCodex } from "./fakeCodex.ts";
import { setUpFakeCursor } from "./fakeCursor.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, openSendToAgent, pickModel } from "./fixActions.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { pressShortcut } from "./shortcut.ts";

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

/** Every line a form says: its statuses and alerts, as shown. */
const wordsOf = (browser: Fixtures["browser"], form: string) =>
  browser.evaluate(
    (label: string) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `form[aria-label="${label}"] [role="status"], form[aria-label="${label}"] [role="alert"]`,
        ),
      ].map((node) => node.innerText),
    form,
  );

/** Notes where every element of a form sits, for `movedSinceMarked`. */
const markPlaces = (browser: Fixtures["browser"], form: string) =>
  browser.evaluate((label: string) => {
    const node = document.querySelector(`form[aria-label="${label}"]`);
    const all = node === null ? [] : [node, ...node.querySelectorAll("*")];
    for (const element of all) {
      const box = element.getBoundingClientRect();
      element.setAttribute("data-held-at", `${Math.round(box.left)},${Math.round(box.top)}`);
    }
    return all.length;
  }, form);

/** The elements `markPlaces` noted that are still in the form and sit somewhere else now. */
const movedSinceMarked = (browser: Fixtures["browser"], form: string) =>
  browser.evaluate((label: string) => {
    const node = document.querySelector(`form[aria-label="${label}"]`);
    const all = node === null ? [] : [node, ...node.querySelectorAll("[data-held-at]")];
    return all.flatMap((element) => {
      const box = element.getBoundingClientRect();
      const now = `${Math.round(box.left)},${Math.round(box.top)}`;
      const was = element.getAttribute("data-held-at") ?? "";
      return was === now
        ? []
        : [
            `${element.tagName.toLowerCase()} "${(element.textContent ?? "").slice(0, 48)}" ${was} -> ${now}`,
          ];
    });
  }, form);

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

const CURSOR_REASON =
  "Cursor fixes edit files only: Cursor can't ask before each command, so it never runs this repository's scripts.";
const AUTO_PUSH = /^prkit pushes the fix to .+ as soon as it's ready \(on for this repository\)\.$/;
const LONG_MODEL = "Stand-in with a model name far too long for one row of the picker";

/** Settings > Agents: installs the stand-in Cursor's support and signs in for prkit. */
const signInCursor = async (
  { screen, browser }: Fixtures,
  cursor: ReturnType<typeof setUpFakeCursor>,
) => {
  await pressShortcut(screen, browser, "Comma");
  await screen.getByRole("navigation", "Settings sections").getByRole("link", "Agents").tap();
  const card = screen
    .getByRole("region", "Agents")
    .getByRole("list", "Agents")
    .getByRole("listitem", "Cursor");
  const status = card.getByRole("status", "Cursor status");
  await card.getByRole("button", "Install Cursor support").tap({ timeout: 30_000 });
  await expect(status).toHaveText("Not signed in", { timeout: 60_000 });
  await card.getByRole("button", "Sign in with Cursor").tap();
  await expect(card.getByRole("status", "Signing in for prkit")).toBeVisible({ timeout: 30_000 });
  cursor.approveLogin();
  await expect(status).toHaveText(/^Signed in/, { timeout: 30_000 });
};

/**
 * Holds the PR's fix session read while `open` reaches a form, then checks that every line the
 * form says while held still reads the same once the read lands, and that nothing shown while
 * held has moved.
 */
const heldThenRead = async (
  page: Fixtures,
  home: string,
  label: string,
  open: () => Promise<ReturnType<Fixtures["screen"]["getByRole"]>>,
  shot: string,
) => {
  const { app, browser } = page;
  const hold = holdSessionReads(home);
  let held: ReadonlyArray<string> = [];
  try {
    const form = await open();
    await expect.poll(hold.reached, { timeout: 30_000 }).toBe(true);
    await expect(form.getByLabel("Loading push access")).toHaveCount(0, { timeout: 30_000 });
    await expect(form.getByLabel("Loading whether the agent runs scripts")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(form.getByRole("button", /^Agent and model: /)).toHaveCount(0);
    await shown(browser);
    held = await wordsOf(browser, label);
    await markPlaces(browser, label);
    await screenshotLightAndDark(app, browser, `${shot}-held`);
  } finally {
    hold.release();
  }
  const form = page.screen.getByRole("form", label);
  await expect(form.getByRole("button", "Agent and model: Stand-in 1")).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByRole("status", "Check scripts")).toHaveText(CURSOR_REASON, {
    timeout: 30_000,
  });
  await expect(form.getByText(AUTO_PUSH)).toBeVisible({ timeout: 30_000 });
  await shown(browser);
  const read = await wordsOf(browser, label);
  expect(
    held.filter((words) => !read.includes(words)),
    "no line reads one way while the session loads and another once it lands",
  ).toEqual([]);
  expect(await movedSinceMarked(browser, label), "nothing moves when the session lands").toEqual(
    [],
  );
  await screenshotLightAndDark(app, browser, `${shot}-read`);
  return form;
};

test(
  "on a Cursor session in a repository that pushes automatically, the push and scripts lines wait for the fix session, and nothing moves when it lands",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-form-notices";
    const page: Fixtures = { app, screen, browser };
    const cursor = setUpFakeCursor(name);
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const codex = setUpFakeCodex(name);
    const git = outsideGit(name);
    let home = "";
    try {
      const efforts = ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort }));
      codex.models([
        {
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1-Sol",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: efforts,
        },
        {
          model: "stand-in-long",
          displayName: LONG_MODEL,
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: efforts,
        },
      ]);
      await fake.gitHead(NUMBER, git.head(NUMBER));
      await fake.conflict(NUMBER);
      const run = git.start(() =>
        startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--codex",
          codex.file,
          "--cursor-manifest",
          cursor.manifest,
          "--e2e",
        ]),
      );
      home = run.home;
      await browser.setViewport({ width: 1280, height: 860 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await signInCursor(page, cursor);

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
      await pickModel(page, first, "stand-in", /Stand-in 1/);
      await first.getByRole("button", "Send 1 comment to agent").tap();
      await expect(first).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => turnsOf(home).map((turn) => turn.state), { timeout: 60_000 })
        .toEqual(["ready"]);
      expect(readRows(home, `SELECT instance_id FROM fixers WHERE pr_key = '${KEY}'`)).toEqual([
        { instance_id: "cursor" },
      ]);
      await app.open(pull(run.url, "fixes"));
      await screen
        .getByRole("article", "Fix 1 comment: Ready to review")
        .getByRole("button", "Discard")
        .tap();
      await expect
        .poll(() => turnsOf(home).map((turn) => turn.state), { timeout: 30_000 })
        .toEqual(["discarded"]);
      await screen.getByRole("button", "Repository settings").tap();
      const autoPush = screen.getByRole(
        "switch",
        "Push fixes automatically for github.com/budget/fixtures",
      );
      await autoPush.tap();
      await expect(autoPush).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
      await browser.keyboard.press("Escape");

      const resolve = await heldThenRead(
        page,
        home,
        "Resolve conflicts",
        async () => {
          await openWithAgentsRead(page, run.url);
          await screen.getByRole("button", "Resolve conflicts").tap();
          const form = screen.getByRole("form", "Resolve conflicts");
          await expect(form.getByRole("radio", /^Merge /)).toBeVisible({ timeout: 30_000 });
          return form;
        },
        "fix-form-notices-resolve",
      );
      await browser.keyboard.press("Escape");
      await expect(resolve).toHaveCount(0);

      const openSend = async () => {
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
        const form = screen.getByRole("form", "Send to agent");
        await expect(form.getByRole("checkbox").first()).toBeVisible({ timeout: 30_000 });
        return form;
      };
      const send = await heldThenRead(
        page,
        home,
        "Send to agent",
        openSend,
        "fix-form-notices-send",
      );
      await browser.keyboard.press("Escape");
      await expect(send).toHaveCount(0);

      await browser.setViewport({ width: 720, height: 860 });
      const narrow = await heldThenRead(
        page,
        home,
        "Send to agent",
        openSend,
        "fix-form-notices-send-narrow",
      );
      const picker = narrow.getByRole("button", "Agent and model: Stand-in 1");
      const rowOf = () =>
        browser.evaluate(() => {
          const trigger = [
            ...document.querySelectorAll('form[aria-label="Send to agent"] button'),
          ].find((button) =>
            (button.getAttribute("aria-label") ?? "").startsWith("Agent and model:"),
          );
          const label = [...(trigger?.querySelectorAll("span") ?? [])].at(-1);
          return {
            height: Math.round(trigger?.getBoundingClientRect().height ?? -1),
            top: Math.round(trigger?.getBoundingClientRect().top ?? -1),
            cut: label === undefined ? false : label.scrollWidth > label.clientWidth,
          };
        });
      await expect(picker).toBeVisible();
      const before = await rowOf();
      await pickModel(page, narrow, "far too long", /far too long/);
      await expect(narrow.getByRole("button", `Agent and model: ${LONG_MODEL}`)).toBeVisible();
      await shown(browser);
      expect(await rowOf(), "a long model name stays on the picker's one row, cut short").toEqual({
        ...before,
        cut: true,
      });
      await app.screenshot("fix-form-notices-long-model-narrow");
    } finally {
      if (home !== "")
        NodeFS.rmSync(NodePath.join(home, "e2e-holds", "fix-session-read"), { force: true });
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
