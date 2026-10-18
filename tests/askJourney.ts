import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { repoRoot } from "../scripts/verify-run.ts";
import { readPageTheme, setOsColorScheme } from "./osColorScheme.ts";

const RESULTS = NodePath.join(repoRoot, ".e2e", "results");

/** Screenshots saved with the run's evidence, each also kept in `.e2e/evidence/<folder>/` (`dir`). */
export const evidenceFolder = (folder: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "evidence", folder);

  /** Saves a screenshot with the run's evidence and keeps a copy as `<dir>/<name>.png`. */
  const keep = async (app: TestFixtures["app"], name: string) => {
    // The runner names the file relative to the attempt's own folder, so find the newest of that name.
    const saved = await app.screenshot(name);
    const [newest] = NodeFS.globSync(`*/attempt-*/${saved}`, { cwd: RESULTS })
      .map((path) => NodePath.join(RESULTS, path))
      .toSorted((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs);
    // A run with `--output` saves elsewhere, and an older run's file of the same name must not stand in.
    if (newest === undefined || NodeFS.statSync(newest).mtimeMs < Date.now() - 60_000)
      throw new Error(
        `The screenshot ${saved} wasn't saved under .e2e/results; run without --output.`,
      );
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.copyFileSync(newest, NodePath.join(dir, `${name}.png`));
  };

  /** `<name>-light` and `<name>-dark` of the same screen, through the emulated OS appearance. */
  const keepLightAndDark = async (app: TestFixtures["app"], browser: Browser, name: string) => {
    await keep(app, `${name}-light`);
    await setOsColorScheme(browser, "dark");
    await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: true });
    await keep(app, `${name}-dark`);
    await setOsColorScheme(browser, "light");
    await expect.poll(() => readPageTheme(browser)).toMatchObject({ dark: false });
  };

  return { dir, keep, keepLightAndDark };
};

/** The file whose card has focus, its selected new-side line, and whether that line sits above the dock. */
export const revealedLine = (browser: Browser) =>
  browser.evaluate(() => {
    const card =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.matches("[data-file-diff-card]")
        ? document.activeElement
        : null;
    const root = card?.querySelector("diffs-container")?.shadowRoot;
    const cell = root?.querySelector<HTMLElement>("[data-gutter] > [data-selected-line]");
    const box = cell?.getBoundingClientRect();
    const dock = document.querySelector("[data-ask-dock]")?.getBoundingClientRect();
    return {
      path: card?.getAttribute("data-path") ?? null,
      line: cell?.getAttribute("data-column-number") ?? null,
      shown: box !== undefined && dock !== undefined && box.top > 0 && box.bottom <= dock.top,
    };
  });
