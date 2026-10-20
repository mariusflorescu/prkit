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
import { type Fixtures, openSendToAgent, sendLineToAgent } from "./fixActions.ts";
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

const idOf = (home: string, number: number) =>
  String(
    readRows(
      home,
      `SELECT t.id FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id WHERE f.pr_key = '${keyOf(number)}'
       ORDER BY t.created_at, t.rowid LIMIT 1`,
    )[0]?.id,
  );
const checkoutOf = (home: string, number: number) =>
  NodePath.join(
    home,
    "fixes",
    String(readRows(home, `SELECT id FROM fixers WHERE pr_key = '${keyOf(number)}'`)[0]?.id),
  );

/** Writes a draft on the first commentable line of `file`, the `pending`th one on the pull request. */
const writeDraft = async (
  { screen, browser }: Fixtures,
  file: string,
  comment: string,
  pending: number,
) => {
  const line = screen
    .getByRole("region", file)
    .getByRole("button", /^Comment on line \d+$/)
    .first();
  await expect(line).toBeVisible({ timeout: 30_000 });
  await line.focus();
  await browser.keyboard.press("Enter");
  const composer = screen.getByRole("textbox", /^Comment on line \d+$/);
  await composer.fill(comment);
  await composer.press("Meta+Enter");
  await expect(screen.getByRole("button", `Review, ${pending} pending`).first()).toBeVisible({
    timeout: 30_000,
  });
};

/** What an older prkit recorded of #6's failed fix's processes when it couldn't make sure they ended. */
const LEFT_RUNNING = JSON.stringify({
  _tag: "unfinished",
  reason: "processes kept turning up",
  processes: [{ pid: 99999, started: "Mon Oct 19 09:00:00 2026", leader: true }],
});

/**
 * Leaves the database the way an older prkit's crash did: each ended fix still holds its drafts,
 * and the notes a failure and an empty fix wrote after the drafts are missing. The agent skipped
 * #4's second comment, #6's failed fix recorded processes it couldn't make sure of, and #2's fix
 * is stored the way a newer prkit would, which this one can't read.
 */
/** A folder holding a `ps` that fails, as when prkit can't list the machine's processes. */
const failingPs = (name: string) => {
  const bin = NodePath.join(repoRoot, ".e2e", "fake", `${name}-ps`);
  NodeFS.rmSync(bin, { recursive: true, force: true });
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return bin;
};
/** Runs `launch` with `bin` first on the PATH the server it starts keeps. */
const withPath = <A>(bin: string, launch: () => A) => {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  try {
    return launch();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
};

const strandDrafts = (home: string, turns: Record<number, string>) => {
  const db = new DatabaseSync(NodePath.join(home, "prkit.sqlite"));
  try {
    for (const turn of Object.values(turns))
      db.prepare(
        `UPDATE pending_comments SET state = 'sent-to-agent', fixer_turn_id = ?1
         WHERE id IN (SELECT json_extract(c.value, '$.source.draftId')
           FROM fixer_turns t, json_each(t.work, '$.comments') c WHERE t.id = ?1)`,
      ).run(turn);
    db.prepare(
      "UPDATE fixer_turns SET status = json_set(status, '$.reason', 'from-a-newer-prkit') WHERE id = ?",
    ).run(turns[2] ?? "");
    db.prepare("UPDATE fixer_turns SET unfinished_end = ? WHERE id = ?").run(
      LEFT_RUNNING,
      turns[6] ?? "",
    );
    db.prepare(
      "UPDATE fixer_turns SET report = json_set(report, '$.perComment[1].status', 'skipped') WHERE id = ?",
    ).run(turns[4] ?? "");
    db.prepare(
      `DELETE FROM fixer_activity WHERE (turn_id = ? AND kind = 'error')
         OR (turn_id = ? AND text = 'The agent changed nothing, so there is nothing to push')`,
    ).run(turns[6] ?? "", turns[9] ?? "");
  } finally {
    db.close();
  }
};

test(
  "drafts an older prkit left with ended fixes land once on this build's first start, where each fix's end sends them",
  { timeout: 360_000 },
  async ({ app, screen, browser }) => {
    const name = "fix-turn-end-stranded";
    const page: Fixtures = { app, screen, browser };
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const git = outsideGit(name, { pushes: true });
    const launch = () =>
      git.start(() => startFakeInstance(name, fake, ["--claude", claude.file, "--e2e"]));
    let home = "";
    try {
      git.commit(9, { "stand-in.md": WRITTEN });
      for (const number of [1, 2, 4, 6, 9]) await fake.gitHead(number, git.head(number));
      let run = launch();
      home = run.home;
      await emulateOsColorScheme(browser, "light");
      await app.open(run.openUrl);

      claude.failingWith("The stand-in agent gave up.");
      await sendLineToAgent(page, pull(run.url, 6, "files"), FILE, "Name the change.");
      await expect.poll(() => statesOf(run.home, 6), { timeout: 60_000 }).toEqual(["failed"]);
      claude.failing(false);
      // A later fix on #6 sends only a new comment, as Retry couldn't send the stranded one.
      await app.open(pull(run.url, 6, "files"));
      await writeDraft(page, FILE, "Say why it starts here.", 2);
      const later = await openSendToAgent(page, 2);
      await later.getByRole("checkbox").first().tap();
      await later.getByRole("button", "Send 1 comment to agent").tap();
      await expect
        .poll(() => statesOf(run.home, 6), { timeout: 60_000 })
        .toEqual(["failed", "ready"]);
      await sendLineToAgent(page, pull(run.url, 9, "files"), "src/limits.ts", "Name the limit.");
      await expect.poll(() => statesOf(run.home, 9), { timeout: 60_000 }).toEqual(["unchanged"]);
      for (const number of [1, 2]) {
        await sendLineToAgent(page, pull(run.url, number, "files"), FILE, "Name the change.");
        await expect.poll(() => statesOf(run.home, number), { timeout: 60_000 }).toEqual(["ready"]);
        await app.open(pull(run.url, number, "fixes"));
        await screen
          .getByRole("article", "Fix 1 comment: Ready to review")
          .getByRole("button", "Discard")
          .tap();
        await expect
          .poll(() => statesOf(run.home, number), { timeout: 30_000 })
          .toEqual(["discarded"]);
      }

      await app.open(pull(run.url, 4, "files"));
      await writeDraft(page, FILE, "Name the change.", 1);
      await writeDraft(page, FILE, "Say why it starts here.", 2);
      const send = await openSendToAgent(page, 2);
      await send.getByRole("button", "Send 2 comments to agent").tap();
      await expect.poll(() => statesOf(run.home, 4), { timeout: 60_000 }).toEqual(["ready"]);
      const sha = commitOf(run.home, 4);
      await app.open(pull(run.url, 4, "fixes"));
      const ready = screen.getByRole("article", "Fix 2 comments: Ready to review");
      await expect(ready.getByRole("button", "Push")).toBeEnabled({ timeout: 30_000 });
      await ready.getByRole("button", "Push").tap();
      await expect.poll(() => statesOf(run.home, 4), { timeout: 30_000 }).toEqual(["pushed"]);

      stopFakeInstance(name, { keepHome: true });
      const turns = Object.fromEntries(
        [1, 2, 4, 6, 9].map((number) => [number, idOf(home, number)]),
      );
      strandDrafts(home, turns);
      const laterFix = String(
        readRows(
          home,
          `SELECT t.id FROM fixer_turns t JOIN fixers f ON f.id = t.fixer_id
           WHERE f.pr_key = '${keyOf(6)}' AND json_extract(t.status, '$._tag') = 'ready'`,
        )[0]?.id,
      );
      // #6's later fix still has its result in the checkout the failed one shared.
      const kept = NodePath.join(checkoutOf(home, 6), "kept-by-the-later-fix.txt");
      NodeFS.writeFileSync(kept, "");

      // The first start can't list processes either, so no look at them could stand in for what
      // the older prkit recorded.
      const ps = failingPs(name);
      run = await relaunch(page, () => withPath(ps, launch));
      const pushed = `Pushed ${sha.slice(0, 7)} to feature-4`;
      const landed = () => {
        expect(endsOf(run.home, 6)[0]).toEqual({
          state: "failed",
          reason: "agent",
          finished: 1,
          said: 0,
          held: null,
        });
        expect(statesOf(run.home, 6)).toEqual(["failed", "ready"]);
        expect(
          readRows(run.home, `SELECT unfinished_end FROM fixer_turns WHERE id = '${turns[6]}'`),
        ).toEqual([{ unfinished_end: LEFT_RUNNING }]);
        expect(NodeFS.existsSync(kept)).toBe(true);
        expect(endsOf(run.home, 2)).toEqual([
          {
            state: "discarded",
            reason: "from-a-newer-prkit",
            finished: 1,
            said: 1,
            held: "sent-to-agent",
          },
        ]);
        expect(
          endsOf(run.home, 9, "The agent changed nothing, so there is nothing to push"),
        ).toEqual([{ state: "unchanged", reason: null, finished: 1, said: 0, held: null }]);
        expect(endsOf(run.home, 1)).toEqual([
          { state: "discarded", reason: "user", finished: 1, said: 1, held: null },
        ]);
        expect(endsOf(run.home, 4, pushed)).toEqual([
          { state: "pushed", reason: null, finished: 1, said: 1, held: null },
        ]);
        for (const number of [1, 9])
          expect(draftsOf(run.home, number)).toEqual([{ state: "draft", turn: null }]);
        expect(draftsOf(run.home, 6)).toEqual([
          { state: "draft", turn: null },
          { state: "sent-to-agent", turn: laterFix },
        ]);
        expect(
          readRows(
            run.home,
            `SELECT c.state, c.fixer_turn_id AS turn,
               c.id = json_extract(t.work, '$.comments[1].source.draftId') AS skipped
             FROM pending_comments c JOIN fixer_turns t ON t.id = '${turns[4]}'
             WHERE c.pr_key = '${keyOf(4)}' ORDER BY skipped`,
          ),
        ).toEqual([
          { state: "resolved-by-agent", turn: null, skipped: 0 },
          { state: "draft", turn: null, skipped: 1 },
        ]);
        expect(git.pushes()).toHaveLength(1);
        expect(heldCommits(run.home)).toEqual([`refs/prkit/fixes/${laterFix}`]);
      };
      landed();
      await app.open(pull(run.url, 4, "fixes"));
      await expect(screen.getByRole("article", "Fix 2 comments: Pushed")).toBeVisible({
        timeout: 30_000,
      });
      await expect(screen.getByRole("button", "Review, 1 pending").first()).toBeVisible();
      await screenshotLightAndDark(app, browser, "stranded-pushed-after-upgrade");

      stopFakeInstance(name, { keepHome: true });
      run = await relaunch(page, launch);
      landed();
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
    }
  },
);
