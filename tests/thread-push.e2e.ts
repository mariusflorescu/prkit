import { type Browser, test } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { type FakeNote, setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const LIMITS = "src/limits.ts";
const FILES = "/pr/github.com/budget/fixtures/9?account=github.com%2Fbudget-test&tab=files";
const SLUG = "Why does a slug get its own limit here instead of in the shared config?";

/** PR 9's limits: check's return on line 10, the slug limit on line 3. */
const CHECKS = `export const limits = {
  url: 2048,
  slug: 64,
  title: 120,
};

export const schemes = ["http", "https"];

export function check(url: string) {
  return url.length <= limits.url;
}

export function short(slug: string) {
  return slug.length <= limits.slug;
}
`;
/** Four lines on top: check's return goes from 10 to 14, the slug limit from 3 to 7. */
const MOVED = `// Limits for links and slugs.
// Every value is a length in characters.
// Change them here and nowhere else.
// The checks below read them.
${CHECKS}`;
/** Check gone, so the line its thread is on with it. */
const GONE = MOVED.replace(
  "export function check(url: string) {\n  return url.length <= limits.url;\n}\n\n",
  "",
);

const question = (line: number, text: string): FakeNote => ({
  line,
  side: "additions",
  tone: "question",
  text,
});

const served = (patch: string) => ({
  filename: LIMITS,
  status: "modified",
  additions: patch.split("\n").filter((line) => line.startsWith("+")).length,
  deletions: patch.split("\n").filter((line) => line.startsWith("-")).length,
  patch,
});

/** GitHub's thread on check's return, at `line` now or outdated with `null`. */
const onCheck = (line: number | null, resolved = false) => ({
  checks: [],
  issues: [],
  threads: [
    {
      id: "thread-check",
      path: LIMITS,
      line,
      originalLine: 10,
      resolved,
      comments: [{ id: 2, login: "octocat", body: "Is 2048 enough for signed links?" }],
    },
  ],
});

/**
 * One entry each time a frame draws the thread card or the guide note differently: the card's
 * label, whether it reads resolved, and its top and height inside the file's card, or the outdated
 * group that holds it; the note's top and height inside the file's card. Where the file's card
 * itself sits goes to `__listTops`. Recording starts again on `__pushFramesReset`.
 */
const FRAME_TRACE = `(() => {
  const seen = [];
  const tops = [];
  let last = "";
  window.__pushFrames = seen;
  window.__listTops = tops;
  window.__pushFramesReset = () => { seen.length = 0; tops.length = 0; last = ""; };
  const read = () => {
    const file = document.querySelector('[data-file-diff-card][data-path="${LIMITS}"]');
    if (file === null) return null;
    const origin = file.getBoundingClientRect().top;
    const where = (node) => {
      const box = node.getBoundingClientRect();
      return Math.round(box.top - origin) + "+" + Math.round(box.height);
    };
    const card = [...file.querySelectorAll("article")].find(
      (node) => (node.getAttribute("aria-label") ?? "").startsWith("Thread by octocat") && node.checkVisibility(),
    );
    const group = file.querySelector("[data-outdated-comments] details > summary");
    const note = [...file.querySelectorAll("[data-guide-note]")].find(
      (node) => node.textContent.includes(${JSON.stringify(SLUG)}) && node.checkVisibility(),
    );
    const thread = card
      ? card.getAttribute("aria-label") + (card.textContent.includes("Resolved") ? " resolved" : " open") + " @" + where(card)
      : group
        ? "group " + group.textContent
        : "no thread";
    const top = Math.round(origin);
    if (tops[tops.length - 1] !== top) tops.push(top);
    return thread + " | " + (note ? "note @" + where(note) : "no note");
  };
  const tick = () => {
    const now = read();
    if (now !== null && now !== last) {
      seen.push(now);
      last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

const decodeFrames = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const frames = async (browser: Browser) =>
  decodeFrames(
    await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__pushFrames") ?? [])),
  );
const decodeTops = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Number)));
const listTops = async (browser: Browser) =>
  decodeTops(await browser.evaluate(() => JSON.stringify(Reflect.get(window, "__listTops") ?? [])));
const restart = (browser: Browser) =>
  browser.evaluate(() => {
    const reset = Reflect.get(window, "__pushFramesReset");
    if (typeof reset === "function") reset();
    return null;
  });

const reads = async (fake: FakeGitHub, kind: string) => (await fake.stats()).byKind[kind] ?? 0;

/** The file's card after a push, light and dark, and at 760 wide, then back as `settled` reads. */
const shots = async (app: TestFixtures["app"], browser: Browser, push: string, settled: string) => {
  await screenshotLightAndDark(app, browser, `after-${push}`);
  await browser.setViewport({ width: 760, height: 900 });
  await screenshotLightAndDark(app, browser, `after-${push}-narrow`);
  await browser.setViewport({ width: 1280, height: 900 });
  await expect.poll(async () => (await frames(browser)).at(-1)).toBe(settled);
};
/** GitHub's answers wait this long, so the threads' re-read after a push takes as long as it can on GitHub. */
const SLOW = 1_500;

test(
  "thread push: a thread and a guide note stay on screen through every frame of a push",
  { timeout: 480_000 },
  async ({ app, screen, browser }) => {
    const name = "thread-push";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const commit = async (files: Record<string, string>) => {
      const sha = git.commit(9, files);
      await fake.files(9, [served(git.patch(9, LIMITS))]);
      await fake.gitHead(9, sha);
    };
    /** Pushes, and resolves once the tab has the new head's files and the threads' re-read has answered. */
    const push = async (files: Record<string, string>) => {
      const filesRead = await reads(fake, "rest:files");
      const threadsRead = await reads(fake, "graphql:threads");
      await restart(browser);
      await commit(files);
      await expect
        .poll(() => reads(fake, "rest:files"), { timeout: 60_000 })
        .toBeGreaterThan(filesRead);
      await expect
        .poll(() => reads(fake, "graphql:threads"), { timeout: 60_000 })
        .toBeGreaterThan(threadsRead);
      await new Promise((resolve) => setTimeout(resolve, SLOW + 1_000));
      return frames(browser);
    };
    try {
      await commit({ [LIMITS]: CHECKS });
      await fake.context(9, onCheck(10));
      claude.notes({ [LIMITS]: [question(3, SLUG)] });
      const run = git.start(() =>
        startFakeInstance(name, fake, [
          "--claude",
          claude.file,
          "--e2e",
          "--watch-interval",
          "5000",
        ]),
      );
      await browser.addInitScript(FRAME_TRACE);
      await browser.setViewport({ width: 1280, height: 900 });
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
      await app.open(`${run.url}${FILES.replace("tab=files", "tab=guide")}`);
      await screen.getByRole("button", "Generate guide").tap({ timeout: 60_000 });
      await expect(screen.getByRole("combobox", "Guide revision")).toContainText("r1 · ", {
        timeout: 120_000,
      });
      await screen.getByRole("navigation", "Pull request tabs").getByRole("link", "Files").tap();
      const file = screen.getByRole("region", LIMITS);
      await expect(file.getByRole("article", `Thread by octocat on ${LIMITS} line 10`)).toBeVisible(
        {
          timeout: 30_000,
        },
      );
      await fake.latency(SLOW, "graphql");
      const settled = await frames(browser);
      const before = settled.at(-1) ?? "";
      expect(before).toMatch(
        /^Thread by octocat on src\/limits\.ts line 10 open @\d+\+\d+ \| note @\d+\+\d+$/,
      );
      /** The thread's and the note's top inside the file's card. */
      const tops = (frame: string) =>
        [...frame.matchAll(/@(\d+)\+\d+/g)].map((match) => Number(match[1]));
      const [threadTop = 0, noteTop = 0] = tops(before);

      // A push that leaves the file alone: nothing in the file changes in any frame, and the list
      // moves once, as the line about the guide notes' older commit arrives above it.
      const untouched = await push({
        "src/change-0.ts": 'export const change0 = "Second fixture 9";\n',
      });
      expect(untouched).toEqual([before]);
      expect(await listTops(browser)).toHaveLength(2);
      await shots(app, browser, "untouched", before);

      // Lines added above: the thread and the note move with their code once, in the frame the
      // new diff draws, and GitHub's answer moves nothing.
      await fake.context(9, onCheck(14));
      const moved = await push({ [LIMITS]: MOVED });
      expect(moved).toHaveLength(2);
      expect(moved[0]).toBe(before);
      const after = moved[1] ?? "";
      const [movedThread = 0, movedNote = 0] = tops(after);
      const shift = movedThread - threadTop;
      expect(shift).toBeGreaterThan(0);
      expect(movedNote - noteTop).toBe(shift);
      expect(after).toBe(
        before
          .replace("line 10", "line 14")
          .replace(`@${threadTop}+`, `@${movedThread}+`)
          .replace(`note @${noteTop}+`, `note @${movedNote}+`),
      );
      await shots(app, browser, "moved", after);

      // Resolved on GitHub meanwhile: the card says so where it is, at the same size.
      await fake.context(9, onCheck(14, true));
      const resolved = await push({
        "src/change-0.ts": 'export const change0 = "Third fixture 9";\n',
      });
      const closed = after.replace(" open @", " resolved @");
      expect(resolved).toEqual([after, closed]);
      await shots(app, browser, "resolved", closed);

      // Its line deleted: it goes to the outdated threads once, and the note stays.
      await fake.context(9, onCheck(null, true));
      const deleted = await push({ [LIMITS]: GONE });
      const outdated = `group Outdated (1 thread) | ${after.split(" | ")[1] ?? ""}`;
      expect(deleted).toEqual([closed, outdated]);
      await shots(app, browser, "deleted", outdated);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
