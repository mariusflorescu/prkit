import { type Browser, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { type Fixtures, sendLineToAgent } from "./fixActions.ts";
import { readRows } from "./fixturePr.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, readPageTheme, setOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";
import { holdWrites } from "./sqliteFaults.ts";

/** A row of buttons, found by a neighbour whose label never changes. */
type Row = { scope: string; neighbour: string };

/** The label and painted box of every button in the row. */
const rowOf = (browser: Browser, row: Row) =>
  browser.evaluate(({ scope, neighbour }: Row) => {
    const anchor = [...document.querySelectorAll(`${scope} button`)].find(
      (node) =>
        node instanceof HTMLElement &&
        node.checkVisibility() &&
        node.innerText.trim() === neighbour,
    );
    return [...(anchor?.parentElement?.children ?? [])]
      .filter((node) => node instanceof HTMLButtonElement)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          label: node.innerText.trim(),
          box: [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10) / 10),
        };
      });
  }, row);

const boxesOf = (buttons: Awaited<ReturnType<typeof rowOf>>) => buttons.map((button) => button.box);

/** Waits for every running animation and transition on the page to finish, a dialog's opening included. */
const settled = (browser: Browser) =>
  expect
    .poll(() =>
      browser.evaluate(
        () => document.getAnimations().filter((motion) => motion.playState === "running").length,
      ),
    )
    .toBe(0);

/**
 * Presses `idle` while another connection holds SQLite's write lock, so the save waits in flight
 * showing `pending` until prkit's 5 second busy timeout fails it. Keeps a frame of each moment,
 * then checks that no button in the row moved or changed size before, while it waited, and after
 * it failed, and that the button says what it is doing.
 */
const holdAndFail = async (
  { app, screen, browser }: Fixtures,
  home: string,
  {
    row,
    idle,
    pending,
    again = idle,
    failed,
    frame,
  }: { row: Row; idle: string; pending: string; again?: string; failed: string; frame: string },
) => {
  const scope = browser.locator(row.scope);
  await settled(browser);
  const before = await rowOf(browser, row);
  await app.screenshot(`${frame}-before`);
  const release = holdWrites(home);
  let during: typeof before = [];
  let said: string | null = null;
  try {
    await scope.getByRole("button", idle).tap();
    await expect(scope.getByRole("button", pending)).toBeVisible();
    during = await rowOf(browser, row);
    await app.screenshot(`${frame}-pending`);
    // Only the words on screen name the button: the reserved ones are not read out.
    await expect(scope.getByRole("button", pending)).toBeDisabled();
    await expect(scope.getByRole("button", idle)).toHaveCount(0);
    const alert = screen.getByRole("alert").filter({ hasText: failed });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    said = await alert.textContent();
  } finally {
    release();
  }
  await settled(browser);
  const after = await rowOf(browser, row);
  await app.screenshot(`${frame}-failed`);
  expect(before.map((button) => button.label)).toContain(idle);
  expect(during.map((button) => button.label)).toContain(pending);
  expect(boxesOf(during), `while it waits: ${JSON.stringify({ before, during })}`).toEqual(
    boxesOf(before),
  );
  expect(boxesOf(after), `after "${said}": ${JSON.stringify({ before, after })}`).toEqual(
    boxesOf(before),
  );
  await expect(scope.getByRole("button", again)).toBeEnabled();
};

/** The same held save in light, then in dark, from the failed state the first one leaves. */
const inLightAndDark = async (
  fixtures: Fixtures,
  home: string,
  options: Parameters<typeof holdAndFail>[2],
) => {
  await holdAndFail(fixtures, home, { ...options, frame: `${options.frame}-light` });
  await setOsColorScheme(fixtures.browser, "dark");
  await expect.poll(() => readPageTheme(fixtures.browser)).toMatchObject({ dark: true });
  await holdAndFail(fixtures, home, {
    ...options,
    idle: options.again ?? options.idle,
    frame: `${options.frame}-dark`,
  });
  await setOsColorScheme(fixtures.browser, "light");
  await expect.poll(() => readPageTheme(fixtures.browser)).toMatchObject({ dark: false });
};

describe("steady buttons", { tags: ["steady-buttons"] }, () => {
  test(
    "Settings: Save guidance keeps its size and Discard stays put while a save waits and after it fails",
    { timeout: 180_000 },
    async ({ app, screen, browser }) => {
      const name = "steady-settings";
      const fake = await startFakeGitHub(name);
      try {
        const run = startFakeInstance(name, fake);
        await emulateOsColorScheme(browser, "light");
        await browser.setViewport({ width: 1280, height: 720 });
        await app.open(run.openUrl);
        await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
        await browser.keyboard.press("Meta+Comma");
        await screen.getByRole("navigation", "Settings sections").getByRole("link", "Guides").tap();
        const guidance = screen.getByRole("textbox", "Global guidance");
        await expect(guidance).toBeEnabled({ timeout: 20_000 });
        await guidance.fill("Lead with the API changes.");
        await screen.getByRole("button", "Save guidance").scrollIntoView();
        await inLightAndDark({ app, screen, browser }, run.home, {
          row: { scope: 'form[aria-label="Global guidance"]', neighbour: "Discard" },
          idle: "Save guidance",
          pending: "Saving…",
          failed: "prkit couldn't save your guide settings.",
          frame: "steady-settings-guidance",
        });
        await screen.getByRole("button", "Save guidance").tap();
        await expect(screen.getByRole("button", "Save guidance")).toHaveCount(0, {
          timeout: 20_000,
        });
        expect(
          readRows(run.home, "SELECT value FROM guide_config")
            .map((row) => String(row.value))
            .join(),
        ).toContain("Lead with the API changes.");
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "Fixes tab: Push keeps its size and the buttons beside it stay put while a push waits and after it fails",
    { timeout: 300_000 },
    async ({ app, screen, browser }) => {
      const name = "steady-fixes";
      const fake = await startFakeGitHub(name);
      const claude = setUpFakeClaude(name);
      const git = outsideGit(name);
      const fixtures: Fixtures = { app, screen, browser };
      try {
        await fake.gitHead(4, git.head(4));
        const run = git.start(() => startFakeInstance(name, fake, ["--claude", claude.file]));
        await emulateOsColorScheme(browser, "light");
        await browser.setViewport({ width: 1280, height: 720 });
        await app.open(run.openUrl);
        claude.edits({ "src/change-0.ts": 'export const change0 = "Fixed by the agent";\n' });
        const pull = (tab: string) =>
          `${run.url}/pr/github.com/budget/fixtures/4?account=github.com%2Fbudget-test&tab=${tab}`;
        await sendLineToAgent(fixtures, pull("files"), "src/change-0.ts", "Name the change.");
        await expect
          .poll(
            () =>
              readRows(run.home, "SELECT json_extract(status, '$._tag') AS state FROM fixer_turns")
                .map((turn) => String(turn.state))
                .join(),
            { timeout: 60_000 },
          )
          .toBe("ready");
        await app.open(pull("fixes"));
        await expect(screen.getByRole("button", "Push")).toBeVisible({ timeout: 30_000 });
        await inLightAndDark(fixtures, run.home, {
          row: { scope: "main", neighbour: "Ask the agent to change" },
          idle: "Push",
          pending: "Pushing…",
          failed: "prkit couldn't",
          frame: "steady-fixes-push",
        });
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );

  test(
    "a local review: Remove keeps its size and Cancel stays put while a removal waits and after it fails",
    { timeout: 300_000 },
    async ({ app, screen, browser }) => {
      const name = "steady-local";
      const fake = await startFakeGitHub(name);
      const claude = setUpFakeClaude(name);
      const fixtures: Fixtures = { app, screen, browser };
      try {
        const fixture = localRepoFixture(scratchRoot());
        fixture.write("docs/handbook.md", handbook({ 15: "Limits are set per team." }));
        const run = startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--watch-interval",
          "600000",
        ]);
        const cli = cliIn(`${run.home}/bin/prkit`, fake.home, []);
        await emulateOsColorScheme(browser, "light");
        await browser.setViewport({ width: 1280, height: 860 });
        await switchOn(fixtures, run.openUrl);
        await dismissToasts(browser);
        expect(cli(fixture.repo, ["local", "guide", "--json"]).code).toBe(0);
        await screen.getByRole("link", /^Open the local review of /).tap();
        await expect(screen.getByRole("status", "Guide status")).toContainText("Ready", {
          timeout: 60_000,
        });
        await dismissToasts(browser);
        await screen.getByRole("button", "More local review actions").tap();
        await screen.getByRole("menuitem", "Remove local review…").tap();
        await expect(screen.getByRole("alertdialog")).toBeVisible();
        await inLightAndDark(fixtures, run.home, {
          row: { scope: '[role="alertdialog"]', neighbour: "Cancel" },
          idle: "Remove",
          pending: "Removing…",
          again: "Try again",
          failed: "prkit couldn't read or save the review.",
          frame: "steady-local-remove",
        });
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );
});
