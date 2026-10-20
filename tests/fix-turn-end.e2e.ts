import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "@e2e-dev/web";
import * as Option from "effect/Option";
import { expect } from "e2e";

import { isAlive, readRun, repoRoot } from "../scripts/verify-run.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import {
  type FakeGitHub,
  startFakeGitHub,
  startFakeInstance,
  stopFakeInstance,
} from "./fakeGitHub.ts";
import { type Fixtures, sendLineToAgent } from "./fixActions.ts";
import { processGroup, processStart, readRows, stopAgentGroup } from "./fixturePr.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { outsideGit } from "./outsideGit.ts";

const keyOf = (number: number) => `github.com/budget/fixtures#${number}`;
const pull = (url: string, number: number, tab: string) =>
  `${url}/pr/github.com/budget/fixtures/${number}?account=github.com%2Fbudget-test&tab=${tab}`;
const FILE = "src/change-0.ts";
const WRITTEN = "Written by the stand-in agent.\n";
const REVISED = "Revised by the stand-in agent.\n";

/**
 * Each fix of a pull request, oldest first: its state and why, whether it finished, how many
 * times its activity says `note` (its status message when null), and the drafts it still holds.
 */
const endsOf = (home: string, number: number, note: string | null = null) =>
  readRows(
    home,
    `SELECT json_extract(t.status, '$._tag') AS state, json_extract(t.status, '$.reason') AS reason,
       t.finished_at IS NOT NULL AS finished,
       (SELECT COUNT(*) FROM fixer_activity a WHERE a.turn_id = t.id
          AND a.text = ${note === null ? "json_extract(t.status, '$.message')" : `'${note}'`}) AS said,
       (SELECT group_concat(c.state) FROM pending_comments c WHERE c.fixer_turn_id = t.id) AS held
     FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(number)}'
     ORDER BY t.created_at, t.rowid`,
  );
const statesOf = (home: string, number: number) =>
  endsOf(home, number).map((fix) => String(fix.state));
const draftsOf = (home: string, number: number) =>
  readRows(
    home,
    `SELECT state, fixer_turn_id AS turn FROM pending_comments WHERE pr_key = '${keyOf(number)}' ORDER BY rowid`,
  );
const commitOf = (home: string, number: number) =>
  String(
    readRows(
      home,
      `SELECT t.commit_sha AS sha FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
       WHERE f.pr_key = '${keyOf(number)}' ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
    )[0]?.sha,
  );

const heldCommits = (home: string) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      `--git-dir=${NodePath.join(home, "repos", "github.com", "budget", "fixtures.git")}`,
      "for-each-ref",
      "--format=%(refname)",
      "refs/prkit/fixes",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line !== "");

/** While it stands, prkit's server waits right after it stores a fix's end (`e2eHold.ts`). */
const holdEnds = (home: string, on: boolean) => {
  const file = NodePath.join(home, "e2e-holds", "fix-turn-end");
  NodeFS.rmSync(`${file}.reached`, { force: true });
  if (on) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "");
  } else NodeFS.rmSync(file, { force: true });
};
const endHeld = (home: string) =>
  NodeFS.existsSync(NodePath.join(home, "e2e-holds", "fix-turn-end.reached"));

const kill = async (run: { serverPid: number; pid: number }) => {
  process.kill(run.serverPid, "SIGKILL");
  await expect.poll(() => isAlive(run.pid), { timeout: 15_000 }).toBe(false);
};

const relaunch = async <R extends { readonly openUrl: string }>(
  page: Fixtures,
  launch: () => R,
) => {
  const run = launch();
  await page.app.open(run.openUrl);
  await expect(page.screen.getByRole("link", "Inbox")).toBeVisible({ timeout: 30_000 });
  return run;
};

test(
  "a fix that failed gets its draft back once after a crash right after the failure is stored, and Retry runs it",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-failed";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    try {
      await fake.gitHead(4, git.head(4));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);

      holdEnds(run.home, true);
      claude.failingWith("The stand-in agent gave up.");
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Name the change.");
      await expect.poll(() => endHeld(run.home), { timeout: 60_000 }).toBe(true);
      expect(statesOf(run.home, 4)).toEqual(["failed"]);
      await kill(run);
      holdEnds(run.home, false);
      claude.failing(false);

      run = await relaunch(page, launch);
      const failed = () => {
        expect(endsOf(run.home, 4)[0]).toEqual({
          state: "failed",
          reason: "agent",
          finished: 1,
          said: 1,
          held: null,
        });
      };
      failed();
      expect(draftsOf(run.home, 4)).toEqual([{ state: "draft", turn: null }]);
      await app.open(pull(run.url, 4, "fixes"));
      const card = screen.getByRole("article", "Fix 1 comment: Failed");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(screen.getByRole("button", "Review, 1 pending").first()).toBeVisible();
      await app.screenshot("failed-after-restart");

      await card.getByRole("button", "Retry").tap();
      await expect
        .poll(() => statesOf(run.home, 4), { timeout: 60_000 })
        .toEqual(["failed", "ready"]);
      expect(draftsOf(run.home, 4).map((draft) => draft.state)).toEqual(["sent-to-agent"]);

      stopFakeInstance(name, { keepHome: true });
      run = await relaunch(page, launch);
      failed();
      expect(statesOf(run.home, 4)).toEqual(["failed", "ready"]);
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

/** While it stands, giving drafts back fails the way a full disk or a busy database would. */
const failDraftReturns = (home: string, on: boolean) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    db.exec(
      on
        ? `CREATE TRIGGER e2e_fail_draft_returns BEFORE UPDATE OF state ON pending_comments
           WHEN new.state = 'draft' BEGIN SELECT RAISE(ABORT, 'e2e: no drafts back'); END`
        : "DROP TRIGGER e2e_fail_draft_returns",
    );
  } finally {
    db.close();
  }
};

test(
  "a fix whose end fails to save stays as it was, and the next start fails it with its draft back once",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-unsaved";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    let failing = false;
    try {
      await fake.gitHead(4, git.head(4));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);

      failDraftReturns(run.home, true);
      failing = true;
      claude.failingWith("The stand-in agent gave up.");
      const logFrom = NodeFS.statSync(run.log).size;
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Name the change.");
      await expect
        .poll(
          () =>
            NodeFS.readFileSync(run.log)
              .subarray(logFrom)
              .toString("utf8")
              .includes("Couldn't record the fix turn's failure"),
          { timeout: 60_000 },
        )
        .toBe(true);
      expect(endsOf(run.home, 4, "The stand-in agent gave up.")).toEqual([
        { state: "running", reason: null, finished: 0, said: 0, held: "sent-to-agent" },
      ]);
      failDraftReturns(run.home, false);
      failing = false;
      claude.failing(false);

      stopFakeInstance(name, { keepHome: true });
      run = await relaunch(page, launch);
      expect(endsOf(run.home, 4)).toEqual([
        { state: "failed", reason: "interrupted", finished: 1, said: 1, held: null },
      ]);
      expect(draftsOf(run.home, 4)).toEqual([{ state: "draft", turn: null }]);
    } finally {
      if (home !== "" && failing) failDraftReturns(home, false);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "a fix that changed nothing, and a change that left nothing to push, get their drafts back once after a crash right after it is stored",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-unchanged";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    try {
      // #6's branch already has what the agent writes. #9's has it with the line a change adds,
      // so its fix takes that line out and asking for a change puts it back.
      git.commit(6, { "stand-in.md": WRITTEN });
      git.commit(9, { "stand-in.md": `${WRITTEN}${REVISED}` });
      for (const number of [6, 9]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);
      await sendLineToAgent(page, pull(run.url, 9, "files"), "src/limits.ts", "Name the limit.");
      await expect.poll(() => statesOf(run.home, 9), { timeout: 60_000 }).toEqual(["ready"]);
      expect(heldCommits(run.home)).toHaveLength(1);

      holdEnds(run.home, true);
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["unchanged"]);
      await app.open(pull(run.url, 9, "fixes"));
      await screen
        .getByRole("article", "Fix 1 comment: Ready to review")
        .getByRole("button", "Ask the agent to change")
        .tap();
      await screen.getByRole("textbox", "What should the agent change?").fill("Say why.");
      await screen
        .getByRole("form", "Ask the agent to change")
        .getByRole("button", "Send to the agent")
        .tap();
      await expect.poll(() => statesOf(run.home, 9), { timeout: 60_000 }).toEqual(["unchanged"]);
      await kill(run);
      holdEnds(run.home, false);

      run = await relaunch(page, launch);
      const unchanged = () => {
        expect(
          endsOf(run.home, 6, "The agent changed nothing, so there is nothing to push"),
        ).toEqual([{ state: "unchanged", reason: null, finished: 1, said: 1, held: null }]);
        expect(endsOf(run.home, 9, "After the change, the fix changes nothing")).toEqual([
          { state: "unchanged", reason: null, finished: 1, said: 1, held: null },
        ]);
        for (const number of [6, 9])
          expect(draftsOf(run.home, number)).toEqual([{ state: "draft", turn: null }]);
        expect(heldCommits(run.home)).toEqual([]);
      };
      unchanged();
      await app.open(pull(run.url, 6, "fixes"));
      await expect(screen.getByRole("article", "Fix 1 comment: No changes")).toContainText(
        "Your drafts are back.",
        { timeout: 30_000 },
      );
      await expect(screen.getByRole("button", "Review, 1 pending").first()).toBeVisible();
      await screenshotLightAndDark(app, browser, "unchanged-after-restart");

      stopFakeInstance(name, { keepHome: true });
      run = await relaunch(page, launch);
      unchanged();
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

test(
  "a push and a resolution with nothing to resolve finish once after a crash right after they are stored, with nothing pushed twice",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-pushed";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name, { pushes: true });
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    try {
      for (const number of [1, 4]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);
      await sendLineToAgent(page, pull(run.url, 4, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 4), { timeout: 60_000 }).toEqual(["ready"]);
      const sha = commitOf(run.home, 4);
      expect(heldCommits(run.home)).toHaveLength(1);

      holdEnds(run.home, true);
      // #1 merges with its base cleanly, so its resolution ends with nothing to resolve.
      await fake.conflict(1);
      await app.open(pull(run.url, 1, "conversation"));
      await screen.getByRole("button", "Resolve conflicts").first().tap({ timeout: 60_000 });
      await screen.getByRole("button", "Resolve with the agent").tap({ timeout: 30_000 });
      await expect.poll(() => statesOf(run.home, 1), { timeout: 60_000 }).toEqual(["discarded"]);
      await app.open(pull(run.url, 4, "fixes"));
      const ready = screen.getByRole("article", "Fix 1 comment: Ready to review");
      await expect(ready.getByRole("button", "Push")).toBeEnabled({ timeout: 30_000 });
      await ready.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 4), { timeout: 30_000 }).toEqual(["pushed"]);
      expect(git.branch(4)).toBe(sha);
      await kill(run);
      holdEnds(run.home, false);

      run = await relaunch(page, launch);
      const finished = () => {
        expect(endsOf(run.home, 4, `Pushed ${sha.slice(0, 7)} to feature-4`)).toEqual([
          { state: "pushed", reason: null, finished: 1, said: 1, held: null },
        ]);
        expect(draftsOf(run.home, 4)).toEqual([{ state: "resolved-by-agent", turn: null }]);
        expect(endsOf(run.home, 1)).toEqual([
          { state: "discarded", reason: "upstream", finished: 1, said: 1, held: null },
        ]);
        expect(git.pushes()).toHaveLength(1);
        expect(git.branch(4)).toBe(sha);
        expect(heldCommits(run.home)).toEqual([]);
      };
      finished();
      await app.open(pull(run.url, 4, "fixes"));
      const pushed = screen.getByRole("article", "Fix 1 comment: Pushed");
      await expect(pushed).toBeVisible({ timeout: 30_000 });
      await expect(pushed.getByRole("button", "Push")).toHaveCount(0);
      await app.screenshot("pushed-after-restart");

      stopFakeInstance(name, { keepHome: true });
      run = await relaunch(page, launch);
      finished();
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);

/** Starts the instance without waiting for it to answer, for a start that holds before it can. */
const startHeld = (name: string, fake: FakeGitHub, extra: ReadonlyArray<string>) =>
  NodeChildProcess.spawn(
    process.execPath,
    [
      "scripts/verify-app.ts",
      "start",
      "--name",
      name,
      "--detach",
      "--github-api",
      fake.url,
      "--gh-home",
      fake.home,
      ...extra,
    ],
    { cwd: repoRoot, stdio: "ignore" },
  );

test(
  "a start cut off right after it fails a fix the last run left working gives the draft back once on the next start",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-startup";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name);
    const extra = ["--claude", claude.file, "--e2e"];
    const launch = () => git.start(() => startFakeInstance(name, fake, extra));
    let agent: { pid: number; startedAt: string } | null = null;
    let home = "";
    try {
      await fake.gitHead(6, git.head(6));
      let run = launch();
      home = run.home;
      await app.open(run.openUrl);
      claude.hold();
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["running"]);
      const query = `SELECT t.agent_pid AS pid FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
        WHERE f.pr_key = '${keyOf(6)}' AND t.agent_pid IS NOT NULL`;
      await expect.poll(() => readRows(run.home, query).length, { timeout: 30_000 }).toBe(1);
      const pid = Number(readRows(run.home, query)[0]?.pid);
      agent = { pid, startedAt: processStart(pid) };

      // prkit dies while the agent writes. The next start fails the fix and holds right after it
      // stores that, and dies there too.
      await kill(run);
      holdEnds(run.home, true);
      const starting = git.start(() => startHeld(name, fake, extra));
      await expect.poll(() => endHeld(run.home), { timeout: 60_000 }).toBe(true);
      expect(statesOf(run.home, 6)).toEqual(["failed"]);
      const held = Option.getOrThrowWith(readRun(name), () => new Error("No run file."));
      await kill(held);
      await expect.poll(() => starting.exitCode !== null, { timeout: 30_000 }).toBe(true);
      holdEnds(run.home, false);

      run = await relaunch(page, launch);
      expect(endsOf(run.home, 6)).toEqual([
        { state: "failed", reason: "interrupted", finished: 1, said: 1, held: null },
      ]);
      expect(draftsOf(run.home, 6)).toEqual([{ state: "draft", turn: null }]);
      expect(processGroup(agent.pid)).toEqual([]);
      await app.open(pull(run.url, 6, "fixes"));
      await expect(screen.getByRole("article", "Fix 1 comment: Failed")).toBeVisible({
        timeout: 30_000,
      });
      await expect(screen.getByRole("button", "Review, 1 pending").first()).toBeVisible();
    } finally {
      if (home !== "") holdEnds(home, false);
      stopFakeInstance(name, { keepHome: false });
      claude.release();
      if (agent !== null) stopAgentGroup(agent.pid, agent.startedAt);
      fake.stop();
    }
  },
);
