import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { instancePaths } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  instanceHome,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { readRows } from "./fixturePr.ts";
import { emulateOsColorScheme, readPageTheme, setOsColorScheme } from "./osColorScheme.ts";

const NAME = "server-log";
const MALFORMED = 18;
/** One line of an older log, so the instance starts on a log that is just under its 5 MB cap. */
const FILLER = `timestamp=2026-10-01T00:00:00.000Z level=INFO fiber=#1 message="An earlier run's line"\n`;
const FILLER_LINES = Math.floor((5 * 1024 * 1024 - 2048) / FILLER.length);
/**
 * What must never reach the log: the fake GitHub's token (its gh prints
 * `fake-token-for-<login>@<dir>`), GitHub's token shapes, an Authorization header or a
 * bearer credential, prkit's own 64-hex secrets, and credentials in a URL.
 */
const SECRETS = [
  /fake-token-for-/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /authorization["']?\s*[:=]/i,
  /bearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /[?&]token=[0-9a-f]{8,}/,
  /\b[0-9a-f]{64}\b/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/,
];
const expectNoSecrets = (text: string, where: string) => {
  for (const secret of SECRETS) expect(text, `${where} holds ${secret}`).not.toMatch(secret);
};

test("the server keeps a rotated log in its home without a token, and Copy recent log hands it over", async ({
  app,
  screen,
  browser,
}) => {
  const fake = await startFakeGitHub(NAME);
  const logs = NodePath.join(instanceHome(NAME), "logs");
  const current = NodePath.join(logs, "server.log");
  const rotated = NodePath.join(logs, "server.log.1");
  try {
    NodeFS.mkdirSync(logs, { recursive: true });
    NodeFS.writeFileSync(current, FILLER.repeat(FILLER_LINES));
    await fake.odd(MALFORMED, { malformed: true });
    await fake.fail("graphql:inbox", 1, 502);
    const run = startFakeInstance(NAME, fake);
    await browser.addInitScript(() => {
      navigator.clipboard.writeText = async (text) => {
        sessionStorage.setItem("e2e-clipboard", text);
      };
    });
    await emulateOsColorScheme(browser, "light");
    await app.open(run.openUrl);

    const unavailable = screen.getByRole("alert").filter({ hasText: "HTTP 502" });
    await expect(unavailable).toBeVisible({ timeout: 30_000 });
    await unavailable.getByRole("button", "Retry").tap();
    await expect(browser.locator(`[data-inbox-left-out="github.com/budget-test"]`)).toBeVisible({
      timeout: 30_000,
    });

    const read = (path: string) =>
      NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
    await expect
      .poll(() => read(current), { timeout: 15_000 })
      .toContain("Left out a pull request prkit can't read");
    const log = read(current);
    expect(log).toContain("prkit server listening");
    expect(log).toMatch(/operation=PrkitInbox status=502/);
    expect(log).toMatch(/path=involved\.nodes\.\d+\.title/);
    expect(log).not.toContain("An earlier run's line");
    expect(NodeFS.statSync(current).size).toBeLessThan(5 * 1024 * 1024);
    const older = read(rotated);
    expect(older.startsWith(FILLER)).toBe(true);
    expect(older.length).toBe(FILLER.length * FILLER_LINES);
    expectNoSecrets(log, "server.log");
    expectNoSecrets(older, "server.log.1");

    await app.open(`${run.url}/settings/about`);
    const section = screen.getByRole("heading", "Server log");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("button", "Show log file")).toHaveCount(0);
    await screen.getByRole("button", "Copy recent log").tap();
    await expect(screen.getByRole("region", "Notifications")).toContainText(
      "Copied the recent log",
    );
    const copied = await browser.evaluate(() => sessionStorage.getItem("e2e-clipboard"));
    if (copied === null) throw new Error("Copy recent log put nothing on the clipboard.");
    expect(copied).toContain("Left out a pull request prkit can't read");
    expect(copied).toMatch(/operation=PrkitInbox status=502/);
    expect(copied.length).toBeLessThanOrEqual(300 * 1024);
    expect(copied.endsWith("\n")).toBe(true);
    expectNoSecrets(copied, "the copied log");
    await app.screenshot("about-light");

    await setOsColorScheme(browser, "dark");
    await expect.poll(async () => (await readPageTheme(browser)).dark).toBe(true);
    await app.screenshot("about-dark");
    await browser.setViewport({ width: 720, height: 720 });
    expect(
      await browser.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await app.screenshot("about-narrow");
  } finally {
    stopFakeInstance(NAME, { keepHome: false });
    fake.stop();
  }
});

/** A string only the pull request's code holds, so finding it in the log means code got there. */
const CANARY = "prkit_canary_code_5c1e9a";

test("a guide written on a pull request leaves none of its code in the log", async ({
  app,
  screen,
}) => {
  const name = "server-log-guide";
  const fake = await startFakeGitHub(name);
  const git = await cliFixture(fake, {
    base: { "src/canary.ts": "export const before = 1;\n" },
    head: { "src/canary.ts": `export const canary = "${CANARY}";\n` },
  });
  await fake.files(9, [
    {
      filename: "src/canary.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: `@@ -1 +1 @@\n-export const before = 1;\n+export const canary = "${CANARY}";`,
    },
  ]);
  const claude = setUpFakeClaude(name);
  const path = process.env.PATH;
  process.env.PATH = git.path;
  try {
    const run = startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]);
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    await app.open(run.openUrl);
    await app.open(
      `${run.url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`,
    );
    // An agent's own failing words can quote the code it read; they stay out of the log.
    claude.failingWith(`The stand-in agent gave up on export const canary = "${CANARY}";`);
    await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
    const state = () =>
      readRows(
        run.home,
        `SELECT json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = 'github.com/budget/fixtures#9'`,
      )[0]?.state;
    await expect.poll(state, { timeout: 120_000 }).toBe("failed");
    claude.failing(false);
    await screen.getByRole("button", "Retry").first().tap({ timeout: 30_000 });
    await expect.poll(state, { timeout: 120_000 }).toBe("watching");
    const file = NodePath.join(instancePaths(name).home, "logs", "server.log");
    await expect
      .poll(() => NodeFS.readFileSync(file, "utf8"), { timeout: 15_000 })
      .toContain("Agent turn finished");
    expect(NodeFS.readFileSync(file, "utf8")).toContain("Attempt failed");
    const [attempt] = readRows(
      run.home,
      `SELECT a.snapshot AS snapshot FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = 'github.com/budget/fixtures#9'`,
    );
    expect(String(attempt?.snapshot), "the agent read the canary's code").toContain(CANARY);
    const log = NodeFS.readFileSync(file, "utf8");
    expect(log).not.toContain(CANARY);
    expectNoSecrets(log, "server.log");
  } finally {
    if (path !== undefined) process.env.PATH = path;
    stopFakeInstance(name, { keepHome: false });
    fake.stop();
  }
});
