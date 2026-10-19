import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { GenerateLocalGuideResult, LocalWaitResult } from "../apps/server/src/outside/schemas.ts";
import { evidenceFolder } from "./askJourney.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { handbook, localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const decodeGenerate = Schema.decodeSync(Schema.fromJsonString(GenerateLocalGuideResult));
const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));

const QUESTION = "Why do these lines change?";
const FIRST_CHUNK = "The stand-in agent answers.";
const HANDBOOK = "docs/handbook.md";

const { keep, keepLightAndDark } = evidenceFolder("ask-dock-lines");

type Page = { app: TestFixtures["app"]; screen: Screen; browser: Browser };

/** One end of picked lines: a changed line on the diff's old or new side. */
type End = { readonly side: "old" | "new"; readonly line: number };

/** Lines picked in a chapter's diff, from `start` to `end`, and how the dock's chip names them. */
type Picked = {
  readonly path: string;
  readonly start: End;
  readonly end: End;
  readonly label: string;
};

/** The number cell of a changed line, as a selector inside the diff's shadow root. */
const numberCell = ({ side, line }: End) =>
  `[data-gutter] > [data-column-number="${line}"][data-line-type="${side === "old" ? "change-deletion" : "change-addition"}"]`;

const Frame = Schema.Struct({
  top: Schema.NullOr(Schema.Number),
  bottom: Schema.NullOr(Schema.Number),
  ceiling: Schema.Number,
  floor: Schema.Number,
  dock: Schema.String,
  height: Schema.Number,
  field: Schema.Number,
  scroll: Schema.Number,
});
type Frame = typeof Frame.Type;
const decodeFrames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Frame)));

/**
 * From now on, records each painted frame: where the picked lines are drawn (`top` of the
 * higher end, `bottom` of the lower), the line under the pinned header they must stay below
 * (`ceiling`), the dock's top they must stay above (`floor`), the dock, and the scroll. A
 * ResizeObserver made after the dock's own runs after it in the same frame, so one watching a
 * probe resized every frame reads the frame as painted. Resolves once the first frame is read.
 */
const recordFrames = (browser: Browser, picked: Picked) =>
  browser.evaluate(
    ({ path, cells }: { path: string; cells: readonly [string, string] }) =>
      new Promise<boolean>((resolve) => {
        const frames: Array<Record<string, number | string | null>> = [];
        Reflect.set(window, "__pickedFrames", frames);
        Reflect.set(window, "__pickedStop", false);
        const box = (root: ShadowRoot | null | undefined, cell: string) =>
          root?.querySelector(cell)?.getBoundingClientRect() ?? null;
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
        document.body.append(probe);
        const read = () => {
          const root = document.querySelector(
            `[data-file-diff-card][data-path="${path}"] diffs-container`,
          )?.shadowRoot;
          const dock = document.querySelector<HTMLElement>("[data-ask-dock]");
          const scroller =
            document.querySelector<HTMLElement>("[data-pr-scroll]") ??
            document.querySelector<HTMLElement>("[data-guide-scroll]");
          if (dock === null || scroller === null) return;
          const pinned = scroller.hasAttribute("data-pr-scroll")
            ? Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--pr-pinned-height"))
            : 0;
          const start = box(root, cells[0]);
          const end = box(root, cells[1]);
          const docked = dock.getBoundingClientRect();
          frames.push({
            top: start && end ? Math.min(start.top, end.top) : null,
            bottom: start && end ? Math.max(start.bottom, end.bottom) : null,
            ceiling: scroller.getBoundingClientRect().top + pinned,
            floor: docked.top,
            dock: dock.dataset.askDock ?? "",
            height: docked.height,
            field: dock.querySelector("textarea")?.getBoundingClientRect().bottom ?? 0,
            scroll: scroller.scrollTop,
          });
          if (frames.length === 1) resolve(true);
        };
        const observer = new ResizeObserver(read);
        observer.observe(probe);
        let wide = false;
        const tick = () => {
          if (Reflect.get(window, "__pickedStop") === true) {
            observer.disconnect();
            probe.remove();
            return;
          }
          wide = !wide;
          probe.style.width = wide ? "2px" : "1px";
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { path: picked.path, cells: [numberCell(picked.start), numberCell(picked.end)] as const },
  );

const framesSoFar = (browser: Browser) =>
  browser.evaluate(() => (Reflect.get(window, "__pickedFrames") ?? []).length);

/** Lets the page paint `count` more frames, then stops recording and returns every frame. */
const stopFrames = async (browser: Browser, count = 30) => {
  const now = await framesSoFar(browser);
  await expect.poll(() => framesSoFar(browser)).toBeGreaterThanOrEqual(now + count);
  return decodeFrames(
    await browser.evaluate(() => {
      Reflect.set(window, "__pickedStop", true);
      return JSON.stringify(Reflect.get(window, "__pickedFrames") ?? []);
    }),
  );
};

/** How many frames drew a picked line under the pinned header or the dock, or not at all, and the first. */
const hidden = (frames: ReadonlyArray<Frame>) => {
  const out = frames.filter(
    (frame) =>
      frame.top === null ||
      frame.bottom === null ||
      frame.top < frame.ceiling ||
      frame.bottom > frame.floor,
  );
  return out.length === 0
    ? "none"
    : `${out.length} of ${frames.length}, first ${JSON.stringify(out[0])}`;
};

const distinct = (frames: ReadonlyArray<Frame>, field: "scroll" | "height" | "field") => [
  ...new Set(frames.map((frame) => Math.round(frame[field]))),
];

/** Scrolls the page so the picked lines' lower end ends at `y` in the window, and says where it ended. */
const placeLines = (browser: Browser, picked: Picked, y: number) =>
  browser.evaluate(
    ({ path, cells, y }: { path: string; cells: readonly [string, string]; y: number }) => {
      const root = document.querySelector(
        `[data-file-diff-card][data-path="${path}"] diffs-container`,
      )?.shadowRoot;
      const ends = cells.map((cell) => root?.querySelector(cell));
      const scroller =
        document.querySelector("[data-pr-scroll]") ?? document.querySelector("[data-guide-scroll]");
      const bottom = () =>
        Math.max(...ends.map((end) => end?.getBoundingClientRect().bottom ?? Number.NaN));
      if (Number.isNaN(bottom()) || !scroller) return null;
      scroller.scrollBy({ top: bottom() - y, behavior: "instant" });
      return Math.round(bottom());
    },
    { path: picked.path, cells: [numberCell(picked.start), numberCell(picked.end)] as const, y },
  );

/** The dock's top now, and where its top will be open: 45% of the window's height, at least 15rem. */
const dockTops = (browser: Browser) =>
  browser.evaluate(() => {
    const dock = document.querySelector("[data-ask-dock]")?.getBoundingClientRect();
    return dock === undefined
      ? null
      : { now: dock.top, open: dock.bottom - Math.max(window.innerHeight * 0.45, 240) };
  });

/** The line number Pierre's Ask button sits on in a file's diff. */
const askButtonLine = (browser: Browser, path: string) =>
  browser.evaluate(
    (file: string) =>
      document
        .querySelector(`[data-file-diff-card][data-path="${file}"] diffs-container`)
        ?.shadowRoot?.querySelector("[data-gutter-utility-slot]")
        ?.closest("[data-column-number]")
        ?.getAttribute("data-column-number") ?? null,
    path,
  );

/** The line number that has focus inside a file's drawn diff, if one has. */
const focusedLine = (browser: Browser, path: string) =>
  browser.evaluate(
    (file: string) =>
      document
        .querySelector(`[data-file-diff-card][data-path="${file}"] diffs-container`)
        ?.shadowRoot?.activeElement?.getAttribute("data-column-number") ?? null,
    path,
  );

/** Puts keyboard focus on a file's line numbers where Tab reaches them, and says which line. */
const focusGutter = (browser: Browser, path: string) =>
  browser.evaluate((file: string) => {
    const stop = document
      .querySelector(`[data-file-diff-card][data-path="${file}"] diffs-container`)
      ?.shadowRoot?.querySelector<HTMLElement>('[data-gutter] > [tabindex="0"]');
    stop?.focus();
    return stop?.getAttribute("data-column-number") ?? null;
  }, path);

/** One end's line number cell, for e2e to scroll to, drag from and drag to. */
const endCell = (browser: Browser, { path }: Picked, end: End) =>
  browser.locator(`[data-path="${path}"] ${numberCell(end).replace("[data-gutter] > ", "")}`);

/** Drags across the picked lines' numbers, from start to end. */
const dragAcross = (browser: Browser, picked: Picked) =>
  endCell(browser, picked, picked.start).dragTo(endCell(browser, picked, picked.end));

/** Whether Pierre draws each end of the picked lines as picked. */
const endsHighlighted = (browser: Browser, picked: Picked) =>
  browser.evaluate(
    ({ path, cells }: { path: string; cells: readonly [string, string] }) => {
      const root = document.querySelector(
        `[data-file-diff-card][data-path="${path}"] diffs-container`,
      )?.shadowRoot;
      return cells.map(
        (cell) => root?.querySelector(cell)?.hasAttribute("data-selected-line") ?? false,
      );
    },
    { path: picked.path, cells: [numberCell(picked.start), numberCell(picked.end)] as const },
  );

/** The open dock's height, and how far its questions' region is from fitting what it holds. */
const dockFit = (browser: Browser) =>
  browser.evaluate(() => {
    const dock = document.querySelector("[data-ask-dock]");
    const region = dock?.querySelector('[role="region"][aria-label="Your questions"]');
    const content = region?.firstElementChild;
    if (!dock || !region || !content) return null;
    return {
      height: Math.round(dock.getBoundingClientRect().height),
      spare: Math.round(region.clientHeight - content.getBoundingClientRect().height),
      overflow: Math.round(region.scrollHeight - region.clientHeight),
    };
  });

/** An open dock with nothing asked yet is as tall as what it shows, light and dark. */
const checkEmptyDock = async ({ app, browser }: Page, dock: Surface["dock"], size: string) => {
  await dock.getByRole("textbox", "Your question").tap();
  await expect(dock).toHaveAttribute("data-ask-dock", "open");
  await expect(dock.getByRole("region", "Your questions")).toContainText(
    "Ask the agent that wrote this guide.",
  );
  await keepLightAndDark(app, browser, `${size}-empty-dock`);
  const fit = await dockFit(browser);
  if (fit === null) throw new Error(`${size}: the open dock has no questions region.`);
  expect(fit.spare, `${size}: the empty dock has no spare room`).toBeLessThanOrEqual(1);
  expect(fit.overflow, `${size}: the empty dock shows all it holds`).toBeLessThanOrEqual(1);
  await dock.getByRole("button", "Hide questions").tap();
};

/**
 * One page's way of asking about the picked lines: a PR opens the comment composer, whose Ask
 * button hands them to the dock, and a local guide asks about them right away. `pick` starts
 * recording frames right before the gesture that opens the dock.
 */
type Surface = {
  readonly dock: ReturnType<Screen["getByRole"]>;
  readonly picked: Picked;
  readonly pick: () => Promise<void>;
};

/** Picks the lines ending at `y` and returns every frame from the gesture that opens the dock. */
const askAboutPicked = async ({ browser }: Page, surface: Surface, y: number) => {
  const { picked, dock } = surface;
  await endCell(browser, picked, picked.end).scrollIntoView();
  expect(await placeLines(browser, picked, y)).toBe(Math.round(y));
  await surface.pick();
  await expect(
    dock.getByRole("form", "Ask a question").getByText(picked.label, { exact: true }),
  ).toBeVisible();
  await expect(dock).toHaveAttribute("data-ask-dock", "open");
  return stopFrames(browser);
};

/**
 * The first answer on an empty dock: lines picked where only a full dock would reach stay in
 * view in every frame as the answer grows the dock, the field never moves, and the dock only
 * grows, never past its full height.
 */
const checkGrowth = async (
  page: Page,
  surface: Surface,
  size: string,
  claude: ReturnType<typeof setUpFakeClaude>,
) => {
  const { app, browser } = page;
  const { dock } = surface;
  const field = dock.getByRole("textbox", "Your question");
  const tops = await dockTops(browser);
  if (tops === null) throw new Error("The dock isn't on the page.");
  await askAboutPicked(page, surface, tops.open + 40);
  await recordFrames(browser, surface.picked);
  claude.holdAnswers();
  await field.fill(QUESTION);
  await field.press("Meta+Enter");
  const answer = dock.getByRole("article", QUESTION);
  await expect(answer).toContainText(FIRST_CHUNK, { timeout: 60_000 });
  await keep(app, `${size}-streaming`);
  claude.releaseAnswers();
  await expect(answer).toContainText("Claude answered", { timeout: 60_000 });
  await keep(app, `${size}-answered`);
  const answering = await stopFrames(browser);
  const heights = answering.map((frame) => frame.height);
  expect(hidden(answering)).toBe("none");
  expect(distinct(answering, "field"), "the field stays where it is").toHaveLength(1);
  expect(
    heights.every((height, index) => index === 0 || height >= (heights[index - 1] ?? 0)),
    "the dock only grows while the answer comes in",
  ).toBe(true);
  expect(heights.at(-1) ?? 0, "the answer grew the dock").toBeGreaterThan(heights[0] ?? 0);
  expect(Math.max(...heights)).toBeLessThanOrEqual(Math.ceil(Math.max(720 * 0.45, 240)) + 1);
  await dock.getByRole("button", "Hide questions").tap();
};

/** Asks until the open dock is at its full height and scrolls its own questions. */
const fillDock = async ({ browser }: Page, dock: Surface["dock"]) => {
  const field = dock.getByRole("textbox", "Your question");
  await field.tap();
  for (const question of [
    "What else changes?",
    "Is anything left out?",
    "What should I read last?",
  ]) {
    const fit = await dockFit(browser);
    if (fit !== null && fit.overflow > 1) break;
    await field.fill(question);
    await field.press("Meta+Enter");
    await expect(dock.getByRole("article", question)).toContainText("Claude answered", {
      timeout: 60_000,
    });
  }
  expect((await dockFit(browser))?.overflow ?? 0, "the dock is full").toBeGreaterThan(1);
  const scrolled = await browser.evaluate(() => {
    const region = document.querySelector<HTMLElement>(
      '[data-ask-dock] [role="region"][aria-label="Your questions"]',
    );
    const scroller =
      document.querySelector("[data-pr-scroll]") ?? document.querySelector("[data-guide-scroll]");
    if (!region || !scroller) return null;
    const guide = scroller.scrollTop;
    const before = region.scrollTop;
    region.scrollTop = 0;
    return { moved: before - region.scrollTop, guide: scroller.scrollTop - guide };
  });
  expect(scrolled, "the full dock scrolls its own questions, not the guide").toEqual({
    moved: expect.any(Number),
    guide: 0,
  });
  expect(scrolled?.moved ?? 0).toBeGreaterThan(0);
  await dock.getByRole("button", "Hide questions").tap();
};

/** An answer streaming into a full dock moves nothing: not the dock, the field or the guide. */
const checkCappedStream = async (
  { browser }: Page,
  surface: Surface,
  claude: ReturnType<typeof setUpFakeClaude>,
) => {
  const { dock } = surface;
  const field = dock.getByRole("textbox", "Your question");
  await field.tap();
  await expect(dock).toHaveAttribute("data-ask-dock", "open");
  await recordFrames(browser, surface.picked);
  claude.holdAnswers();
  await field.fill("And the tests?");
  await field.press("Meta+Enter");
  const answer = dock.getByRole("article", "And the tests?");
  await expect(answer).toContainText(FIRST_CHUNK, { timeout: 60_000 });
  claude.releaseAnswers();
  await expect(answer).toContainText("Claude answered", { timeout: 60_000 });
  const frames = await stopFrames(browser);
  expect(distinct(frames, "height"), "the full dock keeps its height").toHaveLength(1);
  expect(distinct(frames, "field"), "the field stays where it is").toHaveLength(1);
  expect(distinct(frames, "scroll"), "the guide stays where it is").toHaveLength(1);
  await dock.getByRole("button", "Hide questions").tap();
};

/**
 * The checks both pages share, in one window size. Lines are picked at the very bottom, just
 * under where the open dock reaches, and above it. Lines the open dock would cover come just
 * above it in the very frame it opens, and stay put while an answer streams. Lines that still
 * fit stay exactly where they were. Lines the reader scrolled away from stay away.
 */
const checkDock = async (page: Page, surface: Surface, size: string) => {
  const { app, browser } = page;
  const { dock } = surface;
  const field = dock.getByRole("textbox", "Your question");
  const hide = dock.getByRole("button", "Hide questions");
  const tops = await dockTops(browser);
  if (tops === null) throw new Error("The dock isn't on the page.");

  const outcomes: Array<"covered" | "fits"> = [];
  for (const [at, y] of [
    ["bottom", tops.now - 24],
    ["under-open-dock", tops.open + 40],
    ["above-open-dock", tops.open - 48],
  ] as const) {
    const frames = await askAboutPicked(page, surface, y);
    if (at === "under-open-dock") await keepLightAndDark(app, browser, `${size}-${at}`);
    else await keep(app, `${size}-${at}`);
    const opened = frames.find((frame) => frame.dock === "open");
    expect(frames[0]?.dock, `${at}: the first frame is before the dock opens`).toBe("closed");
    if (opened === undefined) throw new Error(`${at}: no frame drew the open dock.`);
    const covered = (frames[0]?.bottom ?? 0) > opened.floor;
    expect(
      await endsHighlighted(browser, surface.picked),
      `${at}: the asked lines are picked`,
    ).toEqual([true, true]);
    expect(hidden(frames), at).toBe("none");
    if (covered) {
      expect(opened.floor - (opened.bottom ?? 0), at).toBeLessThanOrEqual(16);
      expect(distinct(frames, "scroll"), at).toHaveLength(2);
    } else expect(distinct(frames, "scroll"), at).toHaveLength(1);
    outcomes.push(covered ? "covered" : "fits");
    if (at === "under-open-dock") {
      // Moving around the open dock by pointer or keyboard leaves the guide where it is.
      await recordFrames(browser, surface.picked);
      await browser.evaluate(() => {
        document.querySelector<HTMLElement>("[data-ask-dock] textarea")?.blur();
        return true;
      });
      await field.tap();
      await expect(field).toBeFocused();
      await dock.getByRole("button", / instead$/).focus();
      await browser.keyboard.press("Tab");
      await expect(field).toBeFocused();
      const moving = await stopFrames(browser);
      expect(hidden(moving), `${at}, moving focus`).toBe("none");
      expect(distinct(moving, "scroll"), `${at}, moving focus`).toHaveLength(1);
    }

    await hide.tap();
  }
  expect(outcomes).toContain("covered");
  expect(outcomes).toContain("fits");

  await browser.evaluate(() => {
    const scroller =
      document.querySelector("[data-pr-scroll]") ?? document.querySelector("[data-guide-scroll]");
    scroller?.scrollBy({ top: -window.innerHeight, behavior: "instant" });
    return true;
  });
  await recordFrames(browser, surface.picked);
  await field.tap();
  await expect(dock).toHaveAttribute("data-ask-dock", "open");
  expect(distinct(await stopFrames(browser), "scroll")).toHaveLength(1);
  await hide.tap();
};

/**
 * Starts an instance whose stand-in Claude saves its sessions under the fake's home, so
 * answers fork the guide's session.
 */
const withSessions = <T>(home: string, start: () => T) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = NodePath.join(home, ".claude");
  try {
    return start();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
};

const startPrInstance = async (name: string) => {
  const fake = await startFakeGitHub(name);
  const claude = setUpFakeClaude(name);
  const git = outsideGit(name);
  await fake.gitHead(9, git.head(9));
  const run = git.start(() =>
    withSessions(fake.home, () =>
      startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]),
    ),
  );
  return { fake, claude, run };
};

test(
  "ask-dock-lines: on a PR's Guide tab, lines asked about stay in view as the dock opens and an answer streams",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "ask-dock-lines-pr";
    const { fake, claude, run } = await startPrInstance(name);
    const page = { app, screen, browser };
    try {
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 720 });
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(
        `${run.url}/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=guide`,
      );
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 120_000,
      });
      const dock = screen.getByRole("region", "Ask about this pull request");
      // The first file's lines, with the rest of the guide below them to scroll.
      const picked: Picked = {
        path: "src/change-0.ts",
        start: { side: "new", line: 30 },
        end: { side: "new", line: 31 },
        label: "src/change-0.ts 30-31",
      };
      const surface: Surface = {
        dock,
        picked,
        pick: async () => {
          await dragAcross(browser, picked);
          await expect(screen.getByRole("textbox", "Comment on lines 30 to 31")).toBeVisible();
          // The composer's buttons can sit under the closed dock: scroll just enough to see
          // them, as a reader would.
          await browser.evaluate(() => {
            const button = [...document.querySelectorAll("button")].find(
              (element) => element.textContent === "Ask about these lines",
            );
            const dock = document.querySelector("[data-ask-dock]");
            const below =
              (button?.getBoundingClientRect().bottom ?? 0) -
              (dock?.getBoundingClientRect().top ?? 0) +
              8;
            if (below > 0)
              document
                .querySelector("[data-pr-scroll]")
                ?.scrollBy({ top: below, behavior: "instant" });
            return true;
          });
          await recordFrames(browser, picked);
          await screen.getByRole("button", "Ask about these lines").tap();
        },
      };
      await checkEmptyDock(page, dock, "pr-1280");
      await browser.setViewport({ width: 720, height: 720 });
      await checkEmptyDock(page, dock, "pr-720");
      await browser.setViewport({ width: 1280, height: 720 });
      await checkGrowth(page, surface, "pr-1280", claude);
      await fillDock(page, dock);
      await checkCappedStream(page, surface, claude);
      await checkDock(page, surface, "pr-1280");

      // A comment opened from a line number by keyboard, while lines 30-31 are asked about, hands
      // focus back to that line when it closes, and the asked lines stay highlighted.
      expect(await focusGutter(browser, picked.path)).toBe("1");
      await browser.keyboard.press("ArrowDown");
      await browser.keyboard.press("ArrowDown");
      expect(await focusedLine(browser, picked.path)).toBe("3");
      await browser.keyboard.press("Enter");
      const composer = screen.getByRole("textbox", "Comment on line 3");
      await expect(composer).toBeFocused();
      await browser.keyboard.press("Escape");
      await expect(composer).toHaveCount(0);
      await expect.poll(() => focusedLine(browser, picked.path)).toBe("3");
      expect(await endsHighlighted(browser, picked)).toEqual([true, true]);
      await browser.setViewport({ width: 720, height: 720 });
      await checkDock(page, surface, "pr-720");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "ask-dock-lines: on a local review, lines asked about stay in view as the dock opens and an answer streams",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "ask-dock-lines-local";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const page = { app, screen, browser };
    try {
      const fixture = localRepoFixture(root);
      fixture.write(
        HANDBOOK,
        handbook({ 15: "Limits are set per team.", 16: "A team can raise its own limit." }),
      );
      claude.chapters([
        { title: "The handbook", files: [HANDBOOK] },
        { title: "The limits", files: ["src/limits.ts", "src/flags.ts", "src/retired.ts"] },
      ]);
      const run = withSessions(fake.home, () =>
        startFakeInstance(name, fake, ["--claude", claude.file]),
      );
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, []);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 720 });
      await switchOn(page, run.openUrl);
      await dismissToasts(browser);
      const started = decodeGenerate(cli(fixture.repo, ["local", "guide", "--json"]).stdout);
      const waited = decodeWait(
        cli(fixture.repo, ["local", "wait", "--timeout", "120", "--json"]).stdout,
      );
      expect(waited.status.state).toBe("ready");
      await app.open(`${run.url}/local/${started.status.key}`);
      await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 30_000 });
      const dock = screen.getByRole("region", "Ask about these changes");
      const local = (picked: Picked): Surface => ({
        dock,
        picked,
        pick: async () => {
          await recordFrames(browser, picked);
          await dragAcross(browser, picked);
        },
      });
      const surface = local({
        path: HANDBOOK,
        start: { side: "new", line: 15 },
        end: { side: "new", line: 16 },
        label: `${HANDBOOK} 15-16`,
      });
      await checkEmptyDock(page, dock, "local-1280");
      await browser.setViewport({ width: 720, height: 720 });
      await checkEmptyDock(page, dock, "local-720");
      await browser.setViewport({ width: 1280, height: 720 });
      await checkGrowth(page, surface, "local-1280", claude);
      await fillDock(page, dock);
      await checkCappedStream(page, surface, claude);
      await checkDock(page, surface, "local-1280");

      // Pierre keeps its Ask button on the last picked line while lines are picked, so hovering
      // another line leaves the button where it was. A tap on that line's number asks about it.
      const form = dock.getByRole("form", "Ask a question");
      const context = (line: number) =>
        browser.locator(
          `[data-path="${HANDBOOK}"] [data-column-number="${line}"][data-line-type="context"]`,
        );
      await dragAcross(browser, surface.picked);
      await expect(form.getByText(surface.picked.label, { exact: true })).toBeVisible();
      await context(18).hover();
      expect(await askButtonLine(browser, HANDBOOK)).toBe("16");
      await context(18).tap();
      await expect(form.getByText(`${HANDBOOK} 18`, { exact: true })).toBeVisible();
      await expect.poll(() => askButtonLine(browser, HANDBOOK)).toBe("18");
      await keep(app, "local-1280-another-line");
      await dock.getByRole("button", "Hide questions").tap();

      // In split view a pick from an old line to a new one can end higher than it starts.
      await screen.getByRole("button", "Split").tap();
      await checkDock(
        page,
        local({
          path: HANDBOOK,
          start: { side: "old", line: 16 },
          end: { side: "new", line: 15 },
          label: `${HANDBOOK} old 16-15`,
        }),
        "local-split",
      );
      await screen.getByRole("button", "Unified").tap();

      await browser.setViewport({ width: 720, height: 720 });
      await checkDock(page, surface, "local-720");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
