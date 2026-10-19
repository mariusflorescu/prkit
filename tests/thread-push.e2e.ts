import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { type FakeNote, setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { emulateOsColorScheme } from "./osColorScheme.ts";
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
 * label, whether it reads resolved, and its top and height on screen, or the outdated group that
 * holds it; the note's top and height. Recording starts again on `__pushFramesReset`.
 */
const FRAME_TRACE = `(() => {
  const seen = [];
  let last = "";
  window.__pushFrames = seen;
  window.__pushFramesReset = () => { seen.length = 0; last = ""; };
  const where = (node, scroller) => {
    const box = node.getBoundingClientRect();
    return Math.round(box.top - scroller.getBoundingClientRect().top) + "+" + Math.round(box.height);
  };
  const read = () => {
    const scroller = document.querySelector("[data-pr-scroll]");
    const file = document.querySelector('[data-path="${LIMITS}"]');
    if (scroller === null || file === null) return null;
    const card = [...document.querySelectorAll("article")].find(
      (node) => (node.getAttribute("aria-label") ?? "").startsWith("Thread by octocat") && node.checkVisibility(),
    );
    const group = document.querySelector('[data-outdated-comments] details > summary');
    const note = [...document.querySelectorAll("[data-guide-note]")].find(
      (node) => node.textContent.includes(${JSON.stringify(SLUG)}) && node.checkVisibility(),
    );
    const thread = card
      ? card.getAttribute("aria-label") + (card.textContent.includes("Resolved") ? " resolved" : " open") + " @" + where(card, scroller)
      : group
        ? "group " + group.textContent
        : "no thread";
    return thread + " | " + (note ? "note @" + where(note, scroller) : "no note");
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
const restart = (browser: Browser) =>
  browser.evaluate(() => {
    const reset = Reflect.get(window, "__pushFramesReset");
    if (typeof reset === "function") reset();
    return null;
  });

const reads = async (fake: FakeGitHub, kind: string) => (await fake.stats()).byKind[kind] ?? 0;
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

      const untouched = await push({
        "src/change-0.ts": 'export const change0 = "Second fixture 9";\n',
      });
      console.log(`untouched:\n${untouched.join("\n")}`);
      await fake.context(9, onCheck(14));
      const moved = await push({ [LIMITS]: MOVED });
      console.log(`moved:\n${moved.join("\n")}`);
      await fake.context(9, onCheck(14, true));
      const resolved = await push({
        "src/change-0.ts": 'export const change0 = "Third fixture 9";\n',
      });
      console.log(`resolved:\n${resolved.join("\n")}`);
      await fake.context(9, onCheck(null, true));
      const deleted = await push({ [LIMITS]: GONE });
      console.log(`deleted:\n${deleted.join("\n")}`);
      for (const recorded of [untouched, moved, resolved, deleted])
        expect(
          recorded.filter((frame) => frame.includes("no thread") || frame.includes("no note")),
        ).toEqual([]);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
