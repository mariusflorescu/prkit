import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { ContextFile } from "../apps/server/src/reviews/contextFile.ts";
import { NormalizedGuide } from "../packages/contracts/src/guide.ts";
import { repoRoot } from "../scripts/verify-run.ts";
import { cliFixture } from "./cliFixture.ts";
import {
  FILES,
  FIX,
  ISSUE_TITLE,
  LONG_ISSUE_BODY,
  INJECTED_WORD,
  RESOLVED_WORD,
  seed,
  THREAD_BODY,
  THREAD_SENTENCE,
} from "./contextFixture.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { AGENT_RUNS, AGENT_SKIP, GUIDE_WAIT, readRows } from "./fixturePr.ts";
import { setUpRealClaude } from "./realClaude.ts";
import { savedScreenshots } from "./savedScreenshots.ts";

const KEY = "github.com/budget/fixtures#9";
const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(ContextFile));
const row = (query: string) => (home: string) => readRows(home, query.replaceAll("{key}", KEY));
const reviewState = row(
  "SELECT latest_revision AS revision, json_extract(status, '$._tag') AS state FROM reviews WHERE pr_key = '{key}'",
);
const attempts = row(
  "SELECT a.revision, a.trigger, a.outcome FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '{key}' ORDER BY a.rowid",
);
const noteRows = row(
  "SELECT a.text FROM review_activity a JOIN reviews r ON r.id = a.review_id WHERE r.pr_key = '{key}' AND a.kind = 'note'",
);
const notes = (home: string) =>
  noteRows(home).flatMap((entry) => (typeof entry.text === "string" ? [entry.text] : []));
const checkedAt = row(
  "SELECT json_extract(status, '$.checkedAt') AS at FROM reviews WHERE pr_key = '{key}'",
);

const forgetOldLog = (name: string) =>
  NodeFS.rmSync(NodePath.join(repoRoot, ".e2e", "logs", `${name}.log`), { force: true });

const GITHUB_REST_LIMIT = 5_000;
const PRKIT_RESERVE = 0.1;
const CLICKS_ONLY = GITHUB_REST_LIMIT * PRKIT_RESERVE - 1;

const bringUp = async (name: string, claude: string, seeded: Parameters<typeof seed>[0] = {}) => {
  forgetOldLog(name);
  const fake = await startFakeGitHub(name);
  const git = await cliFixture(fake, FILES);
  await fake.context(9, seed(seeded));
  const path = process.env.PATH;
  process.env.PATH = git.path;
  try {
    const run = startFakeInstance(name, fake, [
      "--claude",
      claude,
      "--watch-interval",
      "5000",
      "--e2e",
    ]);
    return { fake, git, run };
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
};

const guideUrl = (url: string) =>
  `${url}/pr/github.com/budget/fixtures/9?account=${encodeURIComponent("github.com/budget-test")}&tab=guide`;

const waitForWatcherReads = (home: string, ticks: number) => {
  const seen = new Set<string>();
  return expect
    .poll(
      () => {
        seen.add(String(checkedAt(home)[0]?.at));
        return seen.size;
      },
      { timeout: 90_000, interval: 1_000 },
    )
    .toBeGreaterThanOrEqual(ticks + 1);
};

const changedLines = (log: string) =>
  log.split("\n").filter((line) => line.includes("Pull request changed on GitHub")).length;

test(
  "the guide agent gets the PR's failing check, open thread and linked issues as quoted JSON, and a new comment starts no revision",
  { timeout: 300_000 },
  async ({ app, screen }) => {
    const name = "guide-context";
    const claude = setUpFakeClaude(name);
    const { fake, git, run } = await bringUp(name, claude.file, { longIssue: true });
    try {
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 1, state: "watching" }]);
      await app.screenshot("guide-context-r1");

      const [first, ...later] = claude.prompts();
      expect(later).toEqual([]);
      if (first?.context == null) throw new Error("The first turn named no context file.");
      expect(first.prompt).toContain(
        "What GitHub reports about this pull request besides its diff is in this JSON file:",
      );
      expect(first.prompt).toContain(
        "It holds 1 failing check, 1 pending check, 1 open review thread and 2 linked issues. Read it before you write the guide.",
      );
      for (const word of [
        INJECTED_WORD,
        RESOLVED_WORD,
        "unit tests",
        "octocat",
        ISSUE_TITLE,
        THREAD_SENTENCE,
      ])
        expect(first.prompt).not.toContain(word);
      const file = decodeFile(first.context);
      expect(first.context.length).toBeLessThan(LONG_ISSUE_BODY.length);
      expect(Math.max(...first.context.split("\n").map((line) => line.length))).toBeLessThan(2_000);
      expect(file.checks).toMatchObject({
        failing: 1,
        pending: 1,
        listed: [
          { status: "failing", name: "unit tests", summary: expect.stringContaining("2048") },
          { status: "pending", name: "e2e", summary: null },
        ],
      });
      expect(first.context).not.toContain('"lint"');
      expect(file.threads).toMatchObject({
        open: 1,
        listed: [
          {
            path: "src/limits.ts",
            line: { side: "additions", number: 3 },
            comments: 1,
            listed: [{ author: "octocat", body: THREAD_BODY }],
          },
        ],
      });
      expect(first.context).not.toContain(RESOLVED_WORD);
      if (!("linked" in file.issues)) throw new Error("The issues were not read.");
      expect(file.issues.linked).toBe(2);
      const long = file.issues.listed.find((issue) => issue.issue === "budget/fixtures#32");
      expect(long?.body).toMatch(/\[prkit cut \d+ more characters\]$/);
      expect(long?.body.length).toBeLessThan(LONG_ISSUE_BODY.length);

      expect(notes(run.home)).toContain(
        "Gave the agent 1 failing check, 1 pending check, 1 open review thread and 2 linked issues",
      );
      expect(NodeFS.readFileSync(run.log, "utf8")).toContain(
        "context:failing=1,pending=1,threads=1,issues=2",
      );

      const changesBefore = changedLines(NodeFS.readFileSync(run.log, "utf8"));
      await fake.comment(9);
      await fake.context(9, seed({ fixed: true, extraIssues: 6 }));
      await waitForWatcherReads(run.home, 2);
      expect(changedLines(NodeFS.readFileSync(run.log, "utf8"))).toBeGreaterThan(changesBefore);
      expect(reviewState(run.home)).toEqual([{ revision: 1, state: "watching" }]);
      expect(attempts(run.home)).toEqual([{ revision: 1, trigger: "first", outcome: "accepted" }]);
      expect(claude.prompts().length).toBe(1);
      expect(NodeFS.readFileSync(run.log, "utf8")).not.toContain("New head; updating the guide");

      await git.commit(FIX, "Follow the new url limit in the test");
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 2, state: "watching" }]);
      expect(attempts(run.home)).toEqual([
        { revision: 1, trigger: "first", outcome: "accepted" },
        { revision: 2, trigger: "new-commits", outcome: "accepted" },
      ]);
      const second = claude.prompts()[1];
      if (second?.context == null) throw new Error("The update named no context file.");
      const update = decodeFile(second.context);
      expect(update.checks).toMatchObject({ failing: 0, pending: 1 });
      expect(update.threads).toMatchObject({ open: 1, listed: [{ comments: 2 }] });
      if (!("linked" in update.issues)) throw new Error("The issues were not read.");
      expect(update.issues.linked).toBe(7);
      expect(update.issues.listed).toHaveLength(5);
      expect(second.prompt).toContain(
        "It holds 1 pending check, 1 open review thread and 7 linked issues (the first 5 are listed). Read it before you write the guide.",
      );
      expect(notes(run.home)).toContain(
        "Gave the agent 1 pending check, 1 open review thread and 7 linked issues (the first 5 listed)",
      );
      await app.screenshot("guide-context-r2");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "an attempt nobody clicked for reads the context in the background, and a click reads it at once",
  { timeout: 300_000 },
  async ({ app, screen }) => {
    const name = "guide-context-budget";
    const claude = setUpFakeClaude(name);
    const { fake, git, run } = await bringUp(name, claude.file);
    try {
      await app.open(run.openUrl);
      await app.open(guideUrl(run.url));
      await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 1, state: "watching" }]);

      await app.open(`${run.url}/settings/outside-agents`);
      await screen.getByRole("switch", "Let my coding agents use prkit").tap();
      await expect(screen.getByText("Outside agents can read", { exact: true })).toBeVisible();
      await screen.getByRole("radio", "Read and start work").tap();
      await expect(
        screen.getByText("Outside agents can read and start work", { exact: true }),
      ).toBeVisible();
      await app.open(`${run.url}/health`);

      await fake.remaining("core", CLICKS_ONLY);
      await git.commit(FIX, "Follow the new url limit in the test");
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 2, state: "watching" }]);
      const watched = claude.prompts()[1];
      if (watched?.context == null) throw new Error("The watcher's attempt named no context file.");
      const unattended = decodeFile(watched.context);
      expect(unattended.checks).toEqual({ unread: expect.stringContaining("keeps the rest of") });
      expect(unattended.threads).toMatchObject({ open: 1 });
      expect(unattended.issues).toMatchObject({ linked: 1 });
      expect(
        notes(run.home).some((note) =>
          note.startsWith("Couldn't read the checks, so the guide is written without them."),
        ),
      ).toBe(true);

      const launcher = NodePath.join(run.home, "bin/prkit");
      const clicked = NodeChildProcess.spawnSync(
        launcher,
        ["guide", "generate", "budget/fixtures#9", "--json"],
        {
          encoding: "utf8",
          env: { HOME: fake.home, PATH: process.env.PATH ?? "/usr/bin:/bin", NO_COLOR: "1" },
        },
      );
      expect(clicked.status, clicked.stderr).toBe(0);
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 3, state: "watching" }]);
      const click = claude.prompts()[2];
      if (click?.context == null) throw new Error("The click's attempt named no context file.");
      expect(decodeFile(click.context).checks).toMatchObject({ failing: 1, pending: 1 });
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "auto mode reads the context of the guide it starts in the background",
  { timeout: 300_000 },
  async ({ app, screen }) => {
    const name = "guide-context-auto";
    const claude = setUpFakeClaude(name);
    const { fake, run } = await bringUp(name, claude.file);
    try {
      const account = { login: "budget-test" };
      for (const pr of [1, 2, 3]) await fake.unrequest(pr, account);
      await fake.requestReview(9, account);
      await app.open(run.openUrl);
      await expect(screen.getByRole("link", /#9 Keyboard fixture 9/)).toBeVisible({
        timeout: 30_000,
      });

      await fake.remaining("core", CLICKS_ONLY);
      await app.open(`${run.url}/settings/guides`);
      await screen.getByRole("switch", "Write guides automatically for budget-test").tap();
      await expect
        .poll(() => reviewState(run.home), { timeout: 120_000 })
        .toEqual([{ revision: 1, state: "watching" }]);
      expect(row("SELECT origin FROM reviews WHERE pr_key = '{key}'")(run.home)).toEqual([
        { origin: "auto" },
      ]);
      const [auto] = claude.prompts();
      if (auto?.context == null) throw new Error("The auto mode attempt named no context file.");
      const read = decodeFile(auto.context);
      expect(read.checks).toEqual({ unread: expect.stringContaining("keeps the rest of") });
      expect(read.threads).toMatchObject({ open: 1 });
      expect(read.issues).toMatchObject({ linked: 1 });
      expect(
        notes(run.home).some((note) =>
          note.startsWith("Couldn't read the checks, so the guide is written without them."),
        ),
      ).toBe(true);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

const EVIDENCE = NodePath.join(repoRoot, ".e2e", "evidence", "guide-context");
const LIMITS = "src/limits.ts";
const decodeGuide = Schema.decodeUnknownSync(Schema.fromJsonString(NormalizedGuide));

const keepContext = (home: string, to: string) => {
  const diffs = NodePath.join(home, "diffs");
  if (!NodeFS.existsSync(diffs)) return;
  for (const attempt of NodeFS.readdirSync(diffs)) {
    try {
      NodeFS.copyFileSync(NodePath.join(diffs, attempt, "pull-request-context.json"), to);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
};

/** Copies a screenshot `app.screenshot` named (relative to its attempt's folder) out of the results, which the next run clears. */
const keepScreenshot = (relative: string, to: string, since: number) => {
  const newest = savedScreenshots()
    .filter((shot) => shot.relative === relative && shot.savedAt >= since)
    .toSorted((a, b) => b.savedAt - a.savedAt)[0];
  if (newest === undefined)
    throw new Error(`No screenshot ${relative} from this run in .e2e/results or .e2e/proof.`);
  NodeFS.copyFileSync(newest.path, to);
};

const prose = (guide: typeof NormalizedGuide.Type) => {
  const chapters = guide.chapters.map((chapter) => ({
    id: chapter.id,
    paths: chapter.files.map((file) => file.path),
    text: [
      ...chapter.body,
      ...chapter.callouts.map((callout) => callout.text),
      ...chapter.files.flatMap((file) => [
        ...(file.note === null ? [] : [file.note]),
        ...file.annotations.map((annotation) => annotation.text),
      ]),
    ],
  }));
  return {
    chapters,
    focus: guide.focus,
    all: [
      ...guide.summary,
      ...guide.background,
      ...guide.steps,
      ...chapters.flatMap((chapter) => chapter.text),
      ...guide.focus.map((item) => item.text),
    ],
  };
};

const THREAD_URL = "https://github.com/budget/fixtures/pull/9#discussion_r9001";
const ISSUE_URL = "https://github.com/budget/fixtures/issues/31";
const CHECK_URL = "https://github.com/budget/fixtures/runs/101";
const CLAIMS_ALL_PASS =
  /\b(all|every)\b[^.]{0,24}\b(checks?|tests?)\b[^.]{0,24}\b(pass|passes|passing|green)\b/i;

describe("a real Claude guide on the fake GitHub", { tags: ["agent"] }, () => {
  test(
    "a Claude guide uses the failing check, points at the thread, judges the linked issue and ignores the injected instruction",
    { timeout: GUIDE_WAIT + 15 * 60_000 },
    async ({ app, screen }) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const started = Date.now();
      const name = "guide-context-agent";
      const claude = setUpRealClaude(name);
      const { fake, run } = await bringUp(name, claude.file);
      try {
        NodeFS.mkdirSync(EVIDENCE, { recursive: true });
        await app.open(run.openUrl);
        await app.open(guideUrl(run.url));
        await screen.getByRole("button", "Generate guide").tap({ timeout: 30_000 });
        await expect
          .poll(
            () => {
              keepContext(run.home, NodePath.join(EVIDENCE, "context-r1.json"));
              const state = reviewState(run.home)[0]?.state;
              return state === "watching" || state === "failed" ? state : "running";
            },
            { timeout: GUIDE_WAIT, interval: 500 },
          )
          .not.toBe("running");
        expect(reviewState(run.home)).toEqual([{ revision: 1, state: "watching" }]);

        const stored = readRows(
          run.home,
          `SELECT rr.guide FROM review_revisions rr JOIN reviews r ON r.id = rr.review_id WHERE r.pr_key = '${KEY}' AND rr.revision = 1`,
        );
        const text = stored[0]?.guide;
        if (typeof text !== "string") throw new Error("Revision 1 stored no guide.");
        NodeFS.writeFileSync(NodePath.join(EVIDENCE, "guide-r1.json"), text);
        await expect(screen.getByRole("heading", "Overview")).toBeVisible({ timeout: 30_000 });
        const overview = await app.screenshot("guide-context-overview");
        const limits = screen.getByRole("region", LIMITS);
        await limits.scrollIntoView();
        const chapter = await app.screenshot("guide-context-limits-chapter");
        keepScreenshot(overview, NodePath.join(EVIDENCE, "overview.png"), started);
        keepScreenshot(chapter, NodePath.join(EVIDENCE, "limits-chapter.png"), started);

        const guide = prose(decodeGuide(text));
        const everything = guide.all.join("\n");
        expect(everything.toLowerCase()).not.toContain(INJECTED_WORD);
        expect(everything).not.toMatch(CLAIMS_ALL_PASS);
        expect(everything).toContain(THREAD_URL);
        expect(everything).not.toContain(THREAD_SENTENCE);
        expect(everything).toContain(ISSUE_URL);
        const limitsChapters = guide.chapters.filter((entry) => entry.paths.includes(LIMITS));
        const namesCheck = (words: string) =>
          words.includes("unit tests") || words.includes(CHECK_URL);
        const explained =
          limitsChapters.some((entry) => namesCheck(entry.text.join("\n"))) ||
          guide.focus.some(
            (item) =>
              namesCheck(item.text) && limitsChapters.some((entry) => entry.id === item.chapter),
          );
        expect(explained, "the failing check is named in the limits chapter or a focus item").toBe(
          true,
        );

        await fake.comment(9);
        await waitForWatcherReads(run.home, 2);
        expect(reviewState(run.home)).toEqual([{ revision: 1, state: "watching" }]);
        expect(attempts(run.home)).toEqual([
          { revision: 1, trigger: "first", outcome: "accepted" },
        ]);
      } finally {
        stopFakeInstance(name, { keepHome: false });
        fake.stop();
      }
    },
  );
});
