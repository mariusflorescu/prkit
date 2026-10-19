import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOs from "node:os";
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

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** Where Claude keeps the session it started in `cwd`. */
export const claudeSessionFile = (cwd: string, session: string) =>
  NodePath.join(
    process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOs.homedir(), ".claude"),
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    `${session}.jsonl`,
  );

/** Where Codex, run in prkit's Codex home under `home`, keeps the thread `session`. */
export const codexThreadFile = (home: string, session: string) =>
  NodeFS.globSync(`codex/sessions/**/rollout-*-${session}.jsonl`, { cwd: home }).map((path) =>
    NodePath.join(home, path),
  )[0];

/** The server log's entries, each its header line and the fields printed under it. */
export const logEntries = (file: string) =>
  NodeFS.readFileSync(file, "utf8").split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\] )/);

/** The entries named `message` with this decision, logged after the question's turn began. */
export const decisionsAfter = (
  file: string,
  questionId: string,
  message: string,
  decision: string,
) => {
  const entries = logEntries(file);
  const start = entries.findIndex(
    (entry) => entry.includes("): Answering a question") && entry.includes(questionId),
  );
  return start === -1
    ? []
    : entries
        .slice(start + 1)
        .filter(
          (entry) => entry.includes(`): ${message} {`) && entry.includes(`decision: '${decision}'`),
        );
};

/** Two added lines in a row in a chapter's drawn diff, the first one's number and its file. */
export const twoAddedLines = (browser: Browser) =>
  browser.evaluate(() => {
    for (const card of document.querySelectorAll("[data-file-diff-card]")) {
      const root = card.querySelector("diffs-container")?.shadowRoot;
      const numbers = new Set(
        [
          ...(root?.querySelectorAll('[data-gutter] > [data-line-type="change-addition"]') ?? []),
        ].map((cell) => Number(cell.getAttribute("data-column-number"))),
      );
      const start = [...numbers].toSorted((a, b) => a - b).find((line) => numbers.has(line + 1));
      const path = card.getAttribute("data-path");
      if (start !== undefined && path !== null) return { path, start };
    }
    return null;
  });

/** Whether a card has answer text on screen yet. */
export const hasText = (browser: Browser, question: string) =>
  browser.evaluate(
    (text: string) =>
      ([...document.querySelectorAll("article[data-question-state]")]
        .find((card) => card.getAttribute("aria-label") === text)
        ?.querySelector(".pr-markdown")
        ?.textContent?.trim() ?? "") !== "",
    question,
  );

export const cardStates = (browser: Browser) =>
  browser.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("article[data-question-state]")].map((card) => [
        card.getAttribute("aria-label"),
        card.getAttribute("data-question-state"),
      ]),
    ),
  );

export const pinPlace = (browser: Browser) =>
  browser.evaluate(() => {
    const pin = document.querySelector("[data-ask-pin]");
    const overview = [...document.querySelectorAll("h1, h2, h3")].find(
      (heading) => heading.textContent?.trim() === "Overview",
    );
    const firstChapter = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Ask about this chapter",
    );
    const follows = (a: Element | null | undefined, b: Element | null | undefined) =>
      a !== null &&
      a !== undefined &&
      b !== null &&
      b !== undefined &&
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    return {
      afterOverview: follows(overview, pin),
      beforeChapters: follows(pin, firstChapter),
      inDiff: pin === null ? null : pin.closest("[data-path]") !== null,
    };
  });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
