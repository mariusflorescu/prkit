import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, type TestFixtures } from "e2e";

import type { Fixtures } from "./fixActions.ts";

/** Folders outside any repository, so nothing here is read as prkit's own checkout. */
export const scratchRoot = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-local-guides-")));

/** The CLI an agent in a terminal runs, from `cwd`, with every call kept for the transcript. */
export const cliIn =
  (launcher: string, home: string, log: Array<string>) =>
  (cwd: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync(launcher, args, {
      cwd,
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
    });
    log.push(
      `$ (${NodePath.basename(cwd)}) prkit ${args.join(" ")}\nexit ${result.status}\n${result.stdout}${result.stderr}`,
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

/** Turns Outside agents on in Settings, at the level asked for. */
export const outsideAccess = async (
  { screen }: Pick<TestFixtures, "screen">,
  level: "Read only" | "Read and start work",
) => {
  await screen.getByRole("radio", level).tap();
  await expect(
    screen.getByText(
      level === "Read only" ? "Outside agents can read" : "Outside agents can read and start work",
      { exact: true },
    ),
  ).toBeVisible();
};

/** Opens the app, then turns Outside agents on at Read and start work, so the CLI can start guides. */
export const switchOn = async ({ app, screen, browser }: Fixtures, openUrl: string) => {
  await app.open(openUrl);
  await expect(screen.getByRole("link", /#1 Budget fixture 1/)).toBeVisible({ timeout: 30_000 });
  await browser.keyboard.press("Meta+Comma");
  await screen.getByRole("link", "Outside agents").tap();
  await screen.getByRole("switch", "Let my coding agents use prkit").tap();
  await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
  await outsideAccess({ screen }, "Read and start work");
};
